import {
  createEditTool,
  createLsTool,
  createLsToolDefinition,
  createReadTool,
  createReadToolDefinition,
  createWriteTool,
  createWriteToolDefinition,
  getPackageDir,
  createEditToolDefinition,
  initTheme,
  type EditOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FileWorkerClient, FileWorkerError } from "../../src/helpers/file-worker.js";
import {
  createFileOperations,
  createSandlotEditTool,
  createSandlotLsTool,
  createSandlotReadTool,
  createSandlotWriteTool,
  PinnedPiImageProcessor,
  pinnedPiImageProcessor,
  resolvePinnedPiImagePaths,
  type FileToolDependencies,
  type ImageProcessorWorkerLike,
} from "../../src/tools/files.js";
import { RuntimeController } from "../../src/runtime.js";

describe("Sandlot Pi filesystem adapters", () => {
  beforeAll(() => {
    pinnedPiImageProcessor.bind(resolvePinnedPiImagePaths().imageProcessorPath);
  });

  it("resolves the pinned Pi image processor and its delayed Photon module before ready", async () => {
    const paths = resolvePinnedPiImagePaths();

    expect(await realpath(paths.piPackageRoot)).toBe(await realpath(getPackageDir()));
    expect(paths.piVersion).toBe("0.84.2");
    expect(paths.hostAnchored).toBe(true);
    expect(paths.imageModuleCount).toBe(7);
    expect(await realpath(paths.imageProcessorPath)).toMatch(/pi-coding-agent\/dist\/utils\/image-process\.js$/);
    expect(await realpath(paths.photonEntryPath)).toMatch(/photon-node\/photon_rs\.js$/);
    expect(await realpath(paths.photonWasmPath)).toMatch(/photon-node\/photon_rs_bg\.wasm$/);
  });

  it("gives exact remediation when the pinned host Pi image graph is incomplete", async () => {
    const incompletePiRoot = await realpath(await mkdtemp(join(tmpdir(), "sandlot-incomplete-pi-")));
    try {
      expect(() => resolvePinnedPiImagePaths(incompletePiRoot)).toThrow(
        /Pinned host Pi package metadata.*unavailable.*reinstall.*pi-coding-agent@0\.84\.2/i,
      );
    } finally {
      await rm(incompletePiRoot, { recursive: true, force: true });
    }
  });

  it("imports the exact validated image module after its lexical alias is swapped", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sandlot-image-binding-")));
    try {
      const trustedRoot = join(root, "trusted");
      const writableRoot = join(root, "workspace");
      const alias = join(writableRoot, "image-process.mjs");
      const trustedModule = join(trustedRoot, "image-process.mjs");
      const attackerModule = join(writableRoot, "attacker.mjs");
      await Promise.all([mkdir(trustedRoot), mkdir(writableRoot)]);
      await Promise.all([
        writeFile(trustedModule, 'export async function processImage() { return { ok: true, data: "safe", mimeType: "image/png", hints: ["trusted"] }; }'),
        writeFile(attackerModule, 'export async function processImage() { return { ok: true, data: "owned", mimeType: "image/png", hints: ["attacker"] }; }'),
      ]);
      await symlink(trustedModule, alias);
      const validatedPath = await realpath(alias);
      const createWorker = vi.fn((options: { moduleUrl: string }) => {
        const worker = new FakeImageProcessorWorker();
        queueMicrotask(() => {
          worker.emit("message", {
            ok: true,
            value: { ok: true, data: "safe", mimeType: "image/png", hints: ["trusted"] },
          });
          worker.emit("exit", 0);
        });
        return worker;
      });
      const processor = new PinnedPiImageProcessor(createWorker);
      processor.bind(validatedPath);
      await rm(alias);
      await symlink(attackerModule, alias);

      await expect(processor.process(Buffer.from("image"), "image/png")).resolves.toEqual({
        ok: true,
        data: "safe",
        mimeType: "image/png",
        hints: ["trusted"],
      });
      expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({ moduleUrl: pathToFileURL(validatedPath).href }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates a non-cooperative image worker on abort and owns it until termination completes", async () => {
    const worker = new FakeImageProcessorWorker();
    let terminated!: () => void;
    worker.terminate.mockImplementationOnce(() => new Promise<number>((resolve) => { terminated = () => resolve(1); }));
    const processor = new PinnedPiImageProcessor(() => worker);
    processor.bind("/trusted/image-process.js");
    const controller = new AbortController();
    const pending = processor.process(Buffer.from("image"), "image/png", { signal: controller.signal });

    controller.abort();
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    terminated();
    await expect(pending).rejects.toThrow("Operation aborted");
    await expect(processor.abortAll()).resolves.toBeUndefined();
  });

  it("maps binary read, access, and image MIME operations to the file worker", async () => {
    // Catches the production mutation that turns binary reads into UTF-8 text,
    // skips Pi's access guard, or omits FileWorkerClient.mime from image reads.
    const fixture = createFixture({ "/repo/image.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    const operations = createFileOperations(fixture.client);

    await expect(operations.read.access("/repo/image.png")).resolves.toBeUndefined();
    await expect(operations.read.readFile("/repo/image.png")).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(operations.read.detectImageMimeType?.("/repo/image.png")).resolves.toBe("image/png");
    const stat = await operations.ls.stat("/repo");
    expect(stat.isDirectory()).toBe(true);
    expect(fixture.calls).toEqual(expect.arrayContaining([
      ["access", "/repo/image.png", "read"],
      ["read", "/repo/image.png"],
      ["mime", "/repo/image.png"],
    ]));
  });

  it("reads image MIME and bytes atomically from one worker file descriptor", async () => {
    const fixture = createFixture({ "/repo/image.png": VALID_PNG });
    const tool = createSandlotReadTool(readyDependencies(fixture.client));

    await expect(tool.execute("atomic-image", { path: "image.png" }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toBeDefined();

    expect(fixture.rawClient.readImage).toHaveBeenCalledOnce();
    expect(fixture.rawClient.mime).not.toHaveBeenCalled();
    expect(fixture.rawClient.read).not.toHaveBeenCalled();
  });

  it("forwards Pi's complete execution context to a fresh read factory", async () => {
    // Catches invoking Pi's AgentTool with four arguments: non-vision image
    // guidance is context-dependent and must match a direct Pi definition.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WQAAAABJRU5ErkJggg==", "base64");
    const actualFixture = createFixture({ "/repo/picture.png": png });
    const expectedFixture = createFixture({ "/repo/picture.png": png });
    const context = { cwd: "/repo", model: { input: ["text"] } } as never;
    const actual = createSandlotReadTool(readyDependencies(actualFixture.client));
    const expected = createReadToolDefinition("/repo", { operations: createFileOperations(expectedFixture.client).read });

    const expectedResult = await expected.execute("image-call", { path: "picture.png" }, undefined, undefined, context);
    await expect(actual.execute("image-call", { path: "picture.png" }, undefined, undefined, context))
      .resolves.toEqual(expectedResult);
    expect(actualFixture.rawClient.readImage.mock.calls[0]?.[1]).toMatchObject({
      expectedGeneration: 3,
      signal: undefined,
      nextInvocationId: expect.any(Function),
    });
  });

  it("keeps registered read content, offset/limit details, and image behavior identical to Pi's factory", async () => {
    // Catches replacing Pi's read factory, which would drift offset/limit,
    // truncation, or image result behavior from the installed Pi release.
    const fixture = createFixture({
      "/repo/notes.txt": Buffer.from("one\ntwo\nthree\nfour\n"),
      "/repo/picture.png": VALID_PNG,
    });
    const dependencies = readyDependencies(fixture.client);
    const expected = createReadTool("/repo", { operations: createFileOperations(fixture.client).read });
    const actual = createSandlotReadTool(dependencies);

    await expect(actual.execute("read-1", { path: "notes.txt", offset: 2, limit: 2 }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toEqual(await expected.execute("read-1", { path: "notes.txt", offset: 2, limit: 2 }, undefined, undefined));
    await expect(actual.execute("read-image", { path: "picture.png" }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toEqual(await expected.execute("read-image", { path: "picture.png" }, undefined, undefined));
  });

  it("uses the dynamic execution cwd rather than the registration cwd", async () => {
    // Catches binding a tool to process.cwd() at registration, causing a Pi
    // session opened in another workspace to read the wrong absolute path.
    const fixture = createFixture({ "/second/workspace/a.txt": Buffer.from("dynamic cwd") });
    const result = await createSandlotReadTool(readyDependencies(fixture.client)).execute(
      "dynamic-read", { path: "a.txt" }, undefined, undefined, { cwd: "/second/workspace" } as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "dynamic cwd" }]);
    expect(fixture.calls).toContainEqual(["readImage", "/second/workspace/a.txt"]);
  });

  it("uses only the lexical model path when a host-only Unicode filename variant exists", async () => {
    // Catches Pi's resolveReadPathAsync host probe selecting its curly-quote
    // macOS variant before Sandlot reaches contextual sandbox operations.
    const directory = await mkdtemp(join(tmpdir(), "sandlot-read-lexical-"));
    const requested = join(directory, "capture's.txt");
    const hostOnlyVariant = join(directory, "capture’s.txt");
    await writeFile(hostOnlyVariant, "host-only");
    try {
      const fixture = createFixture({ [requested]: Buffer.from("worker-visible") });
      const tool = createSandlotReadTool(readyDependencies(fixture.client));

      await expect(tool.execute("unicode-path", { path: "@capture's.txt" }, undefined, undefined, { cwd: directory } as never))
        .resolves.toMatchObject({ content: [{ type: "text", text: "worker-visible" }] });
      expect(fixture.rawClient.access).toHaveBeenCalledWith(requested, "read", expect.any(Object));
      expect(fixture.calls.some((call) => call.includes(hostOnlyVariant))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an already-aborted read without a worker request", async () => {
    // Catches starting Pi host path resolution or a worker request after the
    // signal has already been cancelled.
    const fixture = createFixture({ "/repo/file.txt": Buffer.from("never") });
    const controller = new AbortController();
    controller.abort();

    await expect(createSandlotReadTool(readyDependencies(fixture.client)).execute(
      "aborted-read", { path: "file.txt" }, controller.signal, undefined, { cwd: "/repo" } as never,
    )).rejects.toThrow("Operation aborted");
    expect(fixture.calls).toEqual([]);
  });

  it("translates an in-flight worker cancellation to Pi's Operation aborted error", async () => {
    // Catches leaking runner's internal `aborted` text when cancellation occurs
    // after Pi has entered the sandboxed access/MIME/read sequence.
    const fixture = createFixture({ "/repo/file.txt": Buffer.from("never") });
    fixture.rawClient.access.mockImplementationOnce((_path: string, _mode: string, context: { signal?: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const controller = new AbortController();
    const pending = createSandlotReadTool(readyDependencies(fixture.client)).execute(
      "inflight-read", { path: "file.txt" }, controller.signal, undefined, { cwd: "/repo" } as never,
    );
    await vi.waitFor(() => expect(fixture.rawClient.access).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toThrow("Operation aborted");
    expect(fixture.rawClient.read).not.toHaveBeenCalled();
  });

  it("never reports cancellation while non-cooperative image processing is still running", async () => {
    const fixture = createFixture({ "/repo/picture.png": VALID_PNG });
    let settleImage!: () => void;
    const processImage = vi.fn(() => new Promise<{
      ok: true; data: string; mimeType: string; hints: string[];
    }>((resolve) => {
      settleImage = () => resolve({ ok: true, data: VALID_PNG.toString("base64"), mimeType: "image/png", hints: [] });
    }));
    const controller = new AbortController();
    const tool = createSandlotReadTool({
      ...readyDependencies(fixture.client),
      processImage,
    } as FileToolDependencies);
    const pending = tool.execute("pending-image", { path: "picture.png" }, controller.signal, undefined, { cwd: "/repo" } as never);
    const completion = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(processImage).toHaveBeenCalledOnce());
    controller.abort();

    const promptOutcome = await Promise.race([
      completion,
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);
    expect(promptOutcome).toBe("timeout");
    settleImage();
    await expect(completion).resolves.toBe("Operation aborted");
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.rawClient.readImage).toHaveBeenCalledOnce();
  });

  it("rejects an image result when its runtime generation changes during host processing", async () => {
    const fixture = createFixture({ "/repo/picture.png": VALID_PNG });
    let generation = 3;
    const tool = createSandlotReadTool({
      client: fixture.client,
      runtime: { snapshot: () => ({ state: "ready", generation }) } as never,
      processImage: vi.fn(async () => {
        generation = 4;
        return { ok: true, data: "safe", mimeType: "image/png", hints: [] };
      }),
    });

    await expect(tool.execute("stale-image", { path: "picture.png" }, undefined, undefined, { cwd: "/repo" } as never))
      .rejects.toThrow(/stale generation/i);
  });

  it("rejects before its first model-path worker operation when the captured generation is replaced", async () => {
    // Catches a ready read recapturing state at access time, which would let a
    // replacement generation own a model path operation from the old Pi call.
    const runtime = new RuntimeController();
    runtime.beginInitialization();
    runtime.markReady({} as never);
    const requests: Array<Record<string, unknown>> = [];
    const client = new FileWorkerClient({
      async run(request: Record<string, unknown>) {
        requests.push(request);
        const lease = runtime.acquire(String(request.invocationId), request.expectedGeneration as number);
        runtime.release(lease);
        return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, value: null }), stderr: "" };
      },
    } as never, { cwd: "/repo", env: {} });
    let firstSnapshot = true;
    const tool = createSandlotReadTool({
      client,
      runtime: {
        snapshot: () => {
          const snapshot = runtime.snapshot();
          if (firstSnapshot) {
            firstSnapshot = false;
            queueMicrotask(() => {
              runtime.beginShutdown();
              runtime.finishShutdown();
              runtime.beginInitialization();
              runtime.markReady({} as never);
            });
          }
          return snapshot;
        },
      } as never,
    });

    await expect(tool.execute("replaced-read", { path: "file.txt" }, undefined, undefined, { cwd: "/repo" } as never))
      .rejects.toThrow(/stale generation/i);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ invocationId: "replaced-read", expectedGeneration: 1 });
  });

  it("keeps Pi text offset, limit, and default truncation output identical with independent fixtures", async () => {
    // Catches divergence in Sandlot's owned text executor from Pi's continuation
    // and truncation notices after removing Pi's host path resolver.
    const text = Array.from({ length: 2_005 }, (_, index) => `line-${index + 1}`).join("\n");
    const actualFixture = createFixture({ "/repo/long.txt": Buffer.from(text) });
    const expectedFixture = createFixture({ "/repo/long.txt": Buffer.from(text) });
    const actual = createSandlotReadTool(readyDependencies(actualFixture.client));
    const expected = createReadToolDefinition("/repo", { operations: createFileOperations(expectedFixture.client).read });

    const expectedLimited = await expected.execute("limit", { path: "long.txt", offset: 2, limit: 3 }, undefined, undefined, { cwd: "/repo" } as never);
    const expectedTruncated = await expected.execute("truncate", { path: "long.txt" }, undefined, undefined, { cwd: "/repo" } as never);
    await expect(actual.execute("limit", { path: "long.txt", offset: 2, limit: 3 }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toEqual(expectedLimited);
    await expect(actual.execute("truncate", { path: "long.txt" }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toEqual(expectedTruncated);
  });

  it("maps write to recursive parent creation and preserves Pi's write result", async () => {
    // Catches a write adapter that does not create parent directories through
    // the worker before Pi asks it to write nested paths.
    const fixture = createFixture();
    const expectedFixture = createFixture();
    const actual = createSandlotWriteTool(readyDependencies(fixture.client));
    const expected = createWriteTool("/repo", { operations: createFileOperations(expectedFixture.client).write });

    const expectedResult = await expected.execute("write-1", { path: "new/nested/file.txt", content: "hello" }, undefined, undefined);
    await expect(actual.execute("write-1", { path: "new/nested/file.txt", content: "hello" }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toEqual(expectedResult);
    expect(fixture.calls).toEqual(expect.arrayContaining([
      ["mkdir", "/repo/new/nested", true],
      ["write", "/repo/new/nested/file.txt", "hello", true],
    ]));
  });

  it("delegates single and multiple exact replacements plus no-match errors to Pi's edit factory", async () => {
    // Catches reimplementing replacement matching in Sandlot instead of using
    // Pi's edit factory, including its multiple-edit and no-match semantics.
    const initial = { "/repo/edit.txt": Buffer.from("alpha\nbeta\ngamma\n") };
    const fixture = createFixture(initial);
    const expectedFixture = createFixture(initial);
    const actual = createSandlotEditTool(readyDependencies(fixture.client));
    const expected = createEditTool("/repo", { operations: createFileOperations(expectedFixture.client).edit });
    const edits = [{ oldText: "alpha", newText: "one" }, { oldText: "gamma", newText: "three" }];

    const expectedResult = await expected.execute("edit-1", { path: "edit.txt", edits }, undefined, undefined);
    await expect(actual.execute("edit-1", { path: "edit.txt", edits }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toEqual(expectedResult);
    await expect(actual.execute("edit-miss", { path: "edit.txt", edits: [{ oldText: "missing", newText: "x" }] }, undefined, undefined, { cwd: "/repo" } as never))
      .rejects.toThrow(/Could not find the exact text/i);
    expect(fixture.files.get("/repo/edit.txt")?.toString()).toBe("one\nbeta\nthree\n");
    expect(fixture.calls).toContainEqual(["access", "/repo/edit.txt", "write"]);
  });

  it("uses Pi's mutation queue so two parallel edits to one file do not overlap", async () => {
    // Catches bypassing createEditTool(), which would bypass Pi's global
    // withFileMutationQueue and permit conflicting sandbox writes.
    const fixture = createFixture({ "/repo/queue.txt": Buffer.from("one two") }, { writeDelay: true });
    const tool = createSandlotEditTool(readyDependencies(fixture.client));
    const first = tool.execute("edit-a", { path: "queue.txt", edits: [{ oldText: "one", newText: "ONE" }] }, undefined, undefined, { cwd: "/repo" } as never);
    const second = tool.execute("edit-b", { path: "queue.txt", edits: [{ oldText: "two", newText: "TWO" }] }, undefined, undefined, { cwd: "/repo" } as never);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fixture.maxConcurrentWrites).toBe(1);
    expect(fixture.files.get("/repo/queue.txt")?.toString()).toBe("ONE TWO");
  });

  it("suppresses Pi's speculative host-file edit preview while retaining its native renderer", async () => {
    // Catches exposing upstream computeEditsDiff(), which calls host fs/promises
    // on the model path before Sandlot has entered the file worker.
    const directory = await mkdtemp(join(tmpdir(), "sandlot-edit-preview-"));
    const path = join(directory, "model-controlled.txt");
    await writeFile(path, "old");
    try {
      const tool = createSandlotEditTool(readyDependencies(createFixture().client));
      const component = tool.renderCall?.(
        { path, edits: [{ oldText: "old", newText: "new" }] },
        simpleTheme as never,
        { state: {}, cwd: directory, argsComplete: true, invalidate: vi.fn() } as never,
      ) as { preview?: unknown; previewPending?: boolean };
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(component.preview).toBeUndefined();
      expect(component.previewPending).not.toBe(true);
      const executionFixture = createFixture({ "/repo/edit.txt": Buffer.from("old") });
      const executionTool = createSandlotEditTool(readyDependencies(executionFixture.client));
      const result = await executionTool.execute(
        "edit-render", { path: "edit.txt", edits: [{ oldText: "old", newText: "new" }] }, undefined, undefined, { cwd: "/repo" } as never,
      );
      expect(result.details?.diff).toContain("-1 old");
      initTheme();
      expect(() => executionTool.renderResult?.(
        result,
        { expanded: true } as never,
        simpleTheme as never,
        { state: {}, args: { path: "edit.txt", edits: [{ oldText: "old", newText: "new" }] }, cwd: "/repo", isError: false } as never,
      )).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves Pi ls dotfiles, directory suffixes, entry caps, and truncation details", async () => {
    // Catches replacing Pi's ls factory and losing its sorting, suffix,
    // entry-limit, or result-details behavior.
    const initial = {
      "/repo/list/.hidden": Buffer.from("h"),
      "/repo/list/adir/child": Buffer.from("c"),
      "/repo/list/z.txt": Buffer.from("z"),
    };
    const fixture = createFixture(initial);
    const expectedFixture = createFixture(initial);
    const actual = createSandlotLsTool(readyDependencies(fixture.client));
    const expected = createLsTool("/repo", { operations: createFileOperations(expectedFixture.client).ls });

    const expectedResult = await expected.execute("ls-1", { path: "list", limit: 2 }, undefined, undefined);
    await expect(actual.execute("ls-1", { path: "list", limit: 2 }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toEqual(expectedResult);
    const listed = await actual.execute("ls-full", { path: "list" }, undefined, undefined, { cwd: "/repo" } as never);
    expect(listed.content[0]).toMatchObject({ text: expect.stringContaining(".hidden") });
    expect(listed.content[0]).toMatchObject({ text: expect.stringContaining("adir/") });
  });

  it("propagates structured worker failures and fails closed when runtime is not ready", async () => {
    // Catches catch-to-local fallback after a worker protocol/operation failure
    // or after a failed runtime initialization.
    const fixture = createFixture({ "/repo/nope.txt": Buffer.from("x") });
    fixture.rawClient.readImage.mockRejectedValueOnce(new FileWorkerError("EACCES", "policy denied"));
    const localRead = vi.fn((): ReadOperations => ({ readFile: vi.fn(), access: vi.fn() }));
    const ready = createSandlotReadTool({ ...readyDependencies(fixture.client), createLocalReadOperations: localRead });

    await expect(ready.execute("worker-error", { path: "nope.txt" }, undefined, undefined, { cwd: "/repo" } as never))
      .rejects.toThrow("policy denied");
    expect(localRead).not.toHaveBeenCalled();

    const failed = createSandlotReadTool({
      ...readyDependencies(fixture.client),
      runtime: { snapshot: () => ({ state: "failed" }) } as never,
      createLocalReadOperations: localRead,
    });
    await expect(failed.execute("failed", { path: "nope.txt" }, undefined, undefined, { cwd: "/repo" } as never))
      .rejects.toThrow("Sandlot runtime is not ready (failed)");
    expect(localRead).not.toHaveBeenCalled();
  });

  it("never routes any ready file tool's worker error to its local backend", async () => {
    // Catches a per-tool catch-to-local branch hidden behind successful ready
    // initialization; all four protected tools must retain worker errors.
    const cases = [
      { name: "read", create: createSandlotReadTool, input: { path: "file.txt" }, fail: "access" },
      { name: "write", create: createSandlotWriteTool, input: { path: "file.txt", content: "x" }, fail: "mkdir" },
      { name: "edit", create: createSandlotEditTool, input: { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] }, fail: "access" },
      { name: "ls", create: createSandlotLsTool, input: { path: "." }, fail: "exists" },
    ] as const;

    for (const testCase of cases) {
      const fixture = createFixture({ "/repo/file.txt": Buffer.from("old") });
      fixture.rawClient[testCase.fail].mockImplementationOnce(async () => {
        throw new FileWorkerError("EACCES", `${testCase.name} denied`);
      });
      const local = localFactories();
      const tool = testCase.create({ ...readyDependencies(fixture.client), ...local.factories } as FileToolDependencies);

      await expect(tool.execute(`ready-error-${testCase.name}`, testCase.input as never, undefined, undefined, { cwd: "/repo" } as never))
        .rejects.toThrow(/EACCES|denied/);
      expect(Object.values(local.factories).every((factory) => factory.mock.calls.length === 0)).toBe(true);
    }
  });

  it("carries one Pi read call's generation, signal, and derived IDs through every worker request", async () => {
    // Catches building file operations outside execute or allocating a fresh
    // context per access/mime/read operation, which breaks reload safety.
    const requests: Array<Record<string, unknown>> = [];
    const runner = {
      async run(request: Record<string, unknown>) {
        requests.push(request);
        const operation = JSON.parse(String(request.stdin)).operation;
        const value = operation === "access"
          ? null
          : { encoding: "base64", data: "b2s=", mimeType: null };
        return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, value }), stderr: "" };
      },
    };
    const client = new FileWorkerClient(runner as never, { cwd: "/repo", env: {} });
    const controller = new AbortController();
    const tool = createSandlotReadTool({
      client,
      runtime: { snapshot: () => ({ state: "ready", generation: 41 }) } as never,
      processImage: processImageForTest,
    });

    await expect(tool.execute("pi-read", { path: "file.txt" }, controller.signal, undefined, { cwd: "/repo" } as never))
      .resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
    expect(requests.map((request) => request.invocationId)).toEqual(["pi-read", "pi-read:1"]);
    expect(requests.every((request) => request.expectedGeneration === 41 && request.signal === controller.signal)).toBe(true);
  });

  it("uses separately constructed Pi local operations only after explicit user disable", async () => {
    // Catches any local-filesystem fallback outside disabled-by-user, which
    // would turn an unavailable sandbox boundary into host filesystem access.
    const fixture = createFixture({ "/repo/local.txt": Buffer.from("sandbox") });
    const localReadFile = vi.fn(async () => Buffer.from("local only"));
    const localRead = vi.fn((): ReadOperations => ({ access: vi.fn(async () => {}), readFile: localReadFile }));
    const tool = createSandlotReadTool({
      ...readyDependencies(fixture.client),
      runtime: { snapshot: () => ({ state: "disabled-by-user" }) } as never,
      createLocalReadOperations: localRead,
    });

    await expect(tool.execute("local", { path: "local.txt" }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toMatchObject({ content: [{ type: "text", text: "local only" }] });
    expect(localRead).toHaveBeenCalledTimes(1);
    expect(localReadFile).toHaveBeenCalledWith("/repo/local.txt");
    expect(fixture.calls).toEqual([]);
  });

  it("routes every file tool fail-closed outside ready and uses only its matching local backend when disabled", async () => {
    // Catches a state-routing mutation that makes just one built-in file tool
    // fall back to host IO after failure, or selects another tool's backend.
    const cases = [
      { name: "read", create: createSandlotReadTool, input: { path: "file.txt" }, local: "createLocalReadOperations" },
      { name: "write", create: createSandlotWriteTool, input: { path: "file.txt", content: "local" }, local: "createLocalWriteOperations" },
      { name: "edit", create: createSandlotEditTool, input: { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] }, local: "createLocalEditOperations" },
      { name: "ls", create: createSandlotLsTool, input: { path: "." }, local: "createLocalLsOperations" },
    ] as const;

    for (const testCase of cases) {
      const fixture = createFixture({ "/repo/file.txt": Buffer.from("old") });
      const local = localFactories();
      const dependencies = { ...readyDependencies(fixture.client), ...local.factories } as FileToolDependencies;
      for (const state of ["idle", "initializing", "failed", "shutting-down"] as const) {
        const tool = testCase.create({ ...dependencies, runtime: { snapshot: () => ({ state }) } as never });
        await expect(tool.execute(`blocked-${testCase.name}-${state}`, testCase.input as never, undefined, undefined, { cwd: "/repo" } as never))
          .rejects.toThrow(`Sandlot runtime is not ready (${state})`);
      }
      expect(Object.values(local.factories).every((factory) => factory.mock.calls.length === 0)).toBe(true);
      expect(fixture.calls).toEqual([]);

      const disabled = testCase.create({ ...dependencies, runtime: { snapshot: () => ({ state: "disabled-by-user" }) } as never });
      await expect(disabled.execute(`local-${testCase.name}`, testCase.input as never, undefined, undefined, { cwd: "/repo" } as never))
        .resolves.toBeDefined();
      for (const [name, factory] of Object.entries(local.factories)) {
        expect(factory.mock.calls.length).toBe(name === testCase.local ? 1 : 0);
      }
      expect(fixture.calls).toEqual([]);
    }
  });

  it("preserves Pi-native registration metadata without advertising session or environment features", () => {
    // Catches hand-authored tool definitions that drift schema, prompts, or
    // renderers from Pi's supported factory metadata.
    const fixture = createFixture();
    const local = localFactories();
    const cases = [
      [createSandlotReadTool, createReadToolDefinition, "read"],
      [createSandlotWriteTool, createWriteToolDefinition, "write"],
      [createSandlotEditTool, createEditToolDefinition, "edit"],
      [createSandlotLsTool, createLsToolDefinition, "ls"],
    ] as const;
    for (const [createSandlot, createPi, kind] of cases) {
      const allOperations = createFileOperations(fixture.client);
      const expected = createPi(process.cwd(), { operations: allOperations[kind] } as never);
      const actual = createSandlot({ ...readyDependencies(fixture.client), ...local.factories } as FileToolDependencies);
      expect({
        name: actual.name, label: actual.label, description: actual.description,
        promptSnippet: actual.promptSnippet, promptGuidelines: actual.promptGuidelines,
        parameters: actual.parameters,
      }).toEqual({
        name: expected.name, label: expected.label, description: expected.description,
        promptSnippet: expected.promptSnippet, promptGuidelines: expected.promptGuidelines,
        parameters: expected.parameters,
      });
      expect(actual.renderCall).toBeTypeOf("function");
      if (kind !== "write") expect(actual.renderResult).toBeTypeOf("function");
    }
    expect(Object.values(local.factories).every((factory) => factory.mock.calls.length === 0)).toBe(true);
    expect(fixture.calls).toEqual([]);
  });
});

function readyDependencies(client: FileWorkerClient): FileToolDependencies {
  return {
    client,
    runtime: { snapshot: () => ({ state: "ready", generation: 3 }) } as never,
    processImage: processImageForTest,
  };
}

async function processImageForTest(bytes: Buffer, mimeType: string) {
  const moduleUrl = pathToFileURL(resolvePinnedPiImagePaths().imageProcessorPath).href;
  const module = await import(moduleUrl) as {
    processImage(bytes: Buffer, mimeType: string, options: { autoResizeImages: boolean }): Promise<unknown>;
  };
  return module.processImage(bytes, mimeType, { autoResizeImages: true }) as never;
}

function createFixture(initial: Record<string, Buffer> = {}, options: { writeDelay?: boolean } = {}) {
  const files = new Map(Object.entries(initial));
  const calls: unknown[][] = [];
  let activeWrites = 0;
  let maxConcurrentWrites = 0;
  const directories = new Set<string>(["/", "/repo"]);
  for (const path of files.keys()) addParents(path, directories);
  const client = {
    read: vi.fn(async (path: string) => {
      calls.push(["read", path]);
      const value = files.get(path);
      if (value === undefined) throw new FileWorkerError("ENOENT", `missing ${path}`);
      return Buffer.from(value);
    }),
    readImage: vi.fn(async (path: string) => {
      calls.push(["readImage", path]);
      const value = files.get(path);
      if (value === undefined) throw new FileWorkerError("ENOENT", `missing ${path}`);
      return { bytes: Buffer.from(value), mimeType: path.endsWith(".png") ? "image/png" as const : undefined };
    }),
    access: vi.fn(async (path: string, mode: "read" | "write") => {
      calls.push(["access", path, mode]);
      if (!files.has(path)) throw new FileWorkerError("ENOENT", `missing ${path}`);
    }),
    mime: vi.fn(async (path: string) => {
      calls.push(["mime", path]);
      return path.endsWith(".png") ? "image/png" : undefined;
    }),
    write: vi.fn(async (path: string, content: string, createParents: boolean) => {
      calls.push(["write", path, content, createParents]);
      activeWrites++;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      if (options.writeDelay) await new Promise((resolve) => setTimeout(resolve, 5));
      if (createParents) addParents(path, directories);
      files.set(path, Buffer.from(content));
      activeWrites--;
    }),
    mkdir: vi.fn(async (path: string, recursive: boolean) => {
      calls.push(["mkdir", path, recursive]);
      directories.add(path);
      addParents(path, directories);
    }),
    exists: vi.fn(async (path: string) => {
      calls.push(["exists", path]);
      return directories.has(path) || files.has(path);
    }),
    stat: vi.fn(async (path: string) => {
      calls.push(["stat", path]);
      if (directories.has(path)) return { kind: "directory" as const };
      if (files.has(path)) return { kind: "file" as const };
      throw new FileWorkerError("ENOENT", `missing ${path}`);
    }),
    readdir: vi.fn(async (path: string) => {
      calls.push(["readdir", path]);
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = new Set<string>();
      for (const candidate of [...files.keys(), ...directories]) {
        if (candidate.startsWith(prefix)) {
          const entry = candidate.slice(prefix.length).split("/")[0];
          if (entry) entries.add(entry);
        }
      }
      return [...entries];
    }),
  };
  return {
    client: client as unknown as FileWorkerClient,
    rawClient: client,
    calls,
    files,
    get maxConcurrentWrites() { return maxConcurrentWrites; },
  };
}

function addParents(path: string, directories: Set<string>): void {
  const parts = path.split("/").filter(Boolean);
  for (let index = 1; index < parts.length; index++) directories.add(`/${parts.slice(0, index).join("/")}`);
}

function localFactories() {
  const createLocalReadOperations = vi.fn((): ReadOperations => ({
    access: async () => {}, readFile: async () => Buffer.from("old"),
  }));
  const createLocalWriteOperations = vi.fn((): WriteOperations => ({
    mkdir: async () => {}, writeFile: async () => {},
  }));
  const createLocalEditOperations = vi.fn((): EditOperations => ({
    access: async () => {}, readFile: async () => Buffer.from("old"), writeFile: async () => {},
  }));
  const createLocalLsOperations = vi.fn((): LsOperations => ({
    exists: async () => true,
    stat: async () => ({ isDirectory: () => true }),
    readdir: async () => [],
  }));
  return { factories: { createLocalReadOperations, createLocalWriteOperations, createLocalEditOperations, createLocalLsOperations } };
}

const simpleTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const VALID_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WQAAAABJRU5ErkJggg==", "base64");

class FakeImageProcessorWorker extends EventEmitter implements ImageProcessorWorkerLike {
  readonly terminate = vi.fn(async () => 1);
}
