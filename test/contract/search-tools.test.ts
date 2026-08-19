import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { SearchWorkerClient } from "../../src/helpers/search-worker.js";
import { SearchWorkerError } from "../../src/helpers/search-worker.js";
import { createSandlotFindTool, createSandlotGrepTool } from "../../src/tools/search.js";
import { RuntimeController } from "../../src/runtime.js";

describe("Sandlot search adapters", () => {
  it("routes ready find and grep through worker calls with dynamic cwd, generation, signal, and derived worker IDs", async () => {
    const harness = createHarness();
    const signal = new AbortController().signal;
    const find = createSandlotFindTool(harness.dependencies);
    const grep = createSandlotGrepTool(harness.dependencies);

    await expect(find.execute("find-call", { pattern: "*.ts", limit: 2 }, signal, undefined, { cwd: "/second" } as never))
      .resolves.toMatchObject({ content: [{ type: "text", text: "a.ts" }] });
    await expect(grep.execute("grep-call", { pattern: "needle", literal: true, context: 0 }, signal, undefined, { cwd: "/second" } as never))
      .resolves.toMatchObject({ content: [{ type: "text", text: "a.ts:2: needle" }] });

    expect(harness.client.find).toHaveBeenCalledWith("*.ts", "/second", expect.any(Object), expect.objectContaining({ expectedGeneration: 1, signal }));
    expect(harness.client.grep).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/second", pattern: "needle", literal: true }), expect.objectContaining({ expectedGeneration: 1, signal }));
    const findContext = harness.client.find.mock.calls[0]?.[3] as { nextInvocationId: () => string };
    expect(findContext.nextInvocationId()).toBe("find-call");
  });

  it.each(["idle", "initializing", "failed", "shutting-down"])("fails closed in %s without constructing a local search backend", async (state) => {
    const harness = createHarness();
    transition(harness.runtime, state);
    const localFind = vi.fn();
    const localGrep = vi.fn();
    const find = createSandlotFindTool({ ...harness.dependencies, createLocalFindTool: localFind });
    const grep = createSandlotGrepTool({ ...harness.dependencies, createLocalGrepTool: localGrep });
    await expect(find.execute("blocked-find", { pattern: "*" }, undefined, undefined, { cwd: "/repo" } as never)).rejects.toThrow(/not ready/);
    await expect(grep.execute("blocked-grep", { pattern: "x" }, undefined, undefined, { cwd: "/repo" } as never)).rejects.toThrow(/not ready/);
    expect(localFind).not.toHaveBeenCalled();
    expect(localGrep).not.toHaveBeenCalled();
    expect(harness.client.find).not.toHaveBeenCalled();
    expect(harness.client.grep).not.toHaveBeenCalled();
  });

  it("uses Pi local factories only after explicit user disable", async () => {
    const harness = createHarness();
    harness.runtime.beginShutdown(); harness.runtime.finishShutdown(); harness.runtime.markDisabled();
    const localFind = vi.fn(() => ({ execute: vi.fn(async () => ({ content: [{ type: "text", text: "local find" }], details: undefined })) }));
    const localGrep = vi.fn(() => ({ execute: vi.fn(async () => ({ content: [{ type: "text", text: "local grep" }], details: undefined })) }));
    await expect(createSandlotFindTool({ ...harness.dependencies, createLocalFindTool: localFind }).execute("local-find", { pattern: "*" }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toMatchObject({ content: [{ text: "local find" }] });
    await expect(createSandlotGrepTool({ ...harness.dependencies, createLocalGrepTool: localGrep }).execute("local-grep", { pattern: "x" }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toMatchObject({ content: [{ text: "local grep" }] });
    expect(harness.client.find).not.toHaveBeenCalled();
    expect(harness.client.grep).not.toHaveBeenCalled();
  });

  it("does not use host spawn or filesystem probes for enabled model paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandlot-search-tools-"));
    try {
      await writeFile(join(directory, "host-only.txt"), "host secret");
      const harness = createHarness();
      await createSandlotFindTool(harness.dependencies).execute("worker-only", { pattern: "*.txt", path: directory }, undefined, undefined, { cwd: "/repo" } as never);
      expect(harness.client.find).toHaveBeenCalled();
      expect(harness.hostSpawn).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps Pi-compatible 2,000-character lines and 50 KiB output bounded in the adapter", async () => {
    const harness = createHarness();
    const long = "x".repeat(2_001);
    harness.client.grep.mockResolvedValueOnce({ matches: [{ path: "long.ts", line: 1, text: long, kind: "match" }], matchLimitReached: false });
    await expect(createSandlotGrepTool(harness.dependencies).execute("long", { pattern: "x" }, undefined, undefined, { cwd: "/repo" } as never))
      .resolves.toMatchObject({ content: [{ text: expect.stringContaining("... [truncated]") }], details: { linesTruncated: true } });

    harness.client.grep.mockResolvedValueOnce({
      matches: Array.from({ length: 100 }, (_, index) => ({ path: "big.ts", line: index + 1, text: "y".repeat(800), kind: "match" as const })),
      matchLimitReached: false,
    });
    const result = await createSandlotGrepTool(harness.dependencies).execute("bytes", { pattern: "y" }, undefined, undefined, { cwd: "/repo" } as never);
    expect(result.details).toMatchObject({ truncation: { truncated: true, maxBytes: 50 * 1024 } });
    expect(Buffer.byteLength(result.content[0]?.text ?? "")).toBeLessThan(52 * 1024);
  });

  it("propagates cancellation through the per-call worker context without local routing", async () => {
    const harness = createHarness();
    harness.client.grep.mockImplementationOnce((_request: unknown, context: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const controller = new AbortController();
    const pending = createSandlotGrepTool(harness.dependencies).execute("cancel", { pattern: "x" }, controller.signal, undefined, { cwd: "/repo" } as never);
    await vi.waitFor(() => expect(harness.client.grep).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow("Operation aborted");
  });

  it("rejects promptly when an enabled grep client ignores cancellation", async () => {
    const harness = createHarness();
    let settle!: () => void;
    harness.client.grep.mockImplementationOnce(() => new Promise((resolve) => { settle = () => resolve({ matches: [], matchLimitReached: false }); }));
    const controller = new AbortController();
    const pending = createSandlotGrepTool(harness.dependencies).execute("noncooperative", { pattern: "x" }, controller.signal, undefined, { cwd: "/repo" } as never);
    await vi.waitFor(() => expect(harness.client.grep).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow("Operation aborted");
    settle();
  });

  it("preserves an exact worker find limit instead of inferring truncation from list length", async () => {
    const harness = createHarness();
    harness.client.find.mockResolvedValueOnce({ paths: ["a.ts", "b.ts"], limitReached: false });
    const exact = await createSandlotFindTool(harness.dependencies).execute("exact", { pattern: "*.ts", limit: 2 }, undefined, undefined, { cwd: "/repo" } as never);
    expect(exact.details).toBeUndefined();
    harness.client.find.mockResolvedValueOnce({ paths: ["a.ts", "b.ts"], limitReached: true });
    const over = await createSandlotFindTool(harness.dependencies).execute("over", { pattern: "*.ts", limit: 2 }, undefined, undefined, { cwd: "/repo" } as never);
    expect(over.details).toMatchObject({ resultLimitReached: 2 });
  });

  it("keeps model search data in strict JSON stdin, never in the fixed worker command", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, value: { paths: [], limitReached: false } }), stderr: "" }));
    const client = new SearchWorkerClient({ run } as never, {
      cwd: "/trusted-runner-cwd",
      env: { SANDLOT_SEARCH_RG_PATH: "/untrusted/inherited-rg" },
      nodePath: process.execPath,
      workerPath: fileURLToPath(new URL("../../src/helpers/search-worker.ts", import.meta.url)),
      rgPath: await findRg(),
    });
    await client.find("$(host-injection) *.ts", "/model/path with spaces", { ignore: ["ignored $(x)"], limit: 2 }, {
      expectedGeneration: 9,
      signal: undefined,
      nextInvocationId: () => "search-json",
    });
    const request = run.mock.calls[0]?.[0] as { command: string; stdin: string; env: NodeJS.ProcessEnv; maxOutputBytes: number };
    expect(request.command).not.toContain("host-injection");
    expect(request.command).not.toContain("model/path");
    expect(JSON.parse(request.stdin)).toMatchObject({ operation: "find", cwd: "/model/path with spaces", pattern: "$(host-injection) *.ts" });
    expect(request.env.SANDLOT_SEARCH_RG_PATH).toBe(await findRg());
    expect(request.maxOutputBytes).toBe(12 * 1024 * 1024);
  });

  it("reconfigures the canonical trusted ripgrep executable between sessions", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ version: 1, ok: true, value: { paths: [], limitReached: false } }),
      stderr: "",
    }));
    const firstRg = await findRg();
    const secondRg = await realpath(process.execPath);
    const client = new SearchWorkerClient({ run } as never, {
      cwd: "/trusted",
      env: {},
      nodePath: process.execPath,
      workerPath: fileURLToPath(new URL("../../src/helpers/search-worker.ts", import.meta.url)),
      rgPath: firstRg,
    });
    const context = () => ({ expectedGeneration: 1, signal: undefined, nextInvocationId: () => "search" });
    await client.find("*.ts", "/workspace", { ignore: [], limit: 1 }, context());

    (client as SearchWorkerClient & { configureRgPath(path: string): void }).configureRgPath(secondRg);
    await client.find("*.ts", "/workspace", { ignore: [], limit: 1 }, context());

    expect(run.mock.calls.map(([request]) => request.env.SANDLOT_SEARCH_RG_PATH)).toEqual([firstRg, secondRg]);
  });

  it("derives real client worker IDs across a single find call's exists and search requests", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, value: { paths: [], limitReached: false } }), stderr: "" }));
    const client = new SearchWorkerClient({ run } as never, {
      cwd: "/trusted",
      env: {}, nodePath: process.execPath,
      workerPath: fileURLToPath(new URL("../../src/helpers/search-worker.ts", import.meta.url)), rgPath: await findRg(),
    });
    const runtime = new RuntimeController(); runtime.beginInitialization(); runtime.markReady({} as never);
    const signal = new AbortController().signal;
    await createSandlotFindTool({ runtime, client }).execute("find-call", { pattern: "*.ts" }, signal, undefined, { cwd: "/model" } as never);
    expect(run.mock.calls.map(([request]) => request.invocationId)).toEqual(["find-call", "find-call:1"]);
    expect(run.mock.calls.map(([request]) => request.expectedGeneration)).toEqual([1, 1]);
    expect(run.mock.calls.map(([request]) => request.signal)).toEqual([signal, signal]);
  });

  it.each([
    ["nonzero", { exitCode: 2, stdout: "", stderr: "" }, /exited with code 2/],
    ["stderr", { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, value: { paths: [], limitReached: false } }), stderr: "noise" }, /wrote to stderr/],
    ["trailing JSON", { exitCode: 0, stdout: `${JSON.stringify({ version: 1, ok: true, value: { paths: [], limitReached: false } })}{}`, stderr: "" }, /invalid worker response JSON/],
    ["wrong version", { exitCode: 0, stdout: JSON.stringify({ version: 2, ok: true, value: { paths: [], limitReached: false } }), stderr: "" }, /unsupported worker protocol version/],
    ["wrong success shape", { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, paths: [] }), stderr: "" }, /success response/],
    ["wrong value shape", { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, value: { paths: "not-array", limitReached: false } }), stderr: "" }, /invalid find response/],
    ["oversized response", { exitCode: 0, stdout: "x".repeat(12 * 1024 * 1024 + 1), stderr: "" }, /response exceeds/],
  ])("rejects %s worker transport/protocol failures", async (_name, response, message) => {
    const client = await fakeClient(async () => response);
    await expect(client.find("*", "/model", { ignore: [], limit: 1 }, callContext("bad"))).rejects.toThrow(message);
  });

  it("rejects malformed worker error envelopes before exposing an operational error", async () => {
    const client = await fakeClient(async () => ({ exitCode: 0, stdout: JSON.stringify({ version: 1, ok: false, error: { code: "EFAIL" } }), stderr: "" }));
    await expect(client.find("*", "/model", { ignore: [], limit: 1 }, callContext("bad-error"))).rejects.toThrow(/error.*message/i);
  });

  it("returns false only for sandboxed ENOENT/ENOTDIR exists responses", async () => {
    for (const code of ["ENOENT", "ENOTDIR"]) {
      const client = await fakeClient(async () => workerError(code));
      await expect(client.exists("/missing", callContext(code))).resolves.toBe(false);
    }
    for (const code of ["EACCES", "RG_FAILED"]) {
      const client = await fakeClient(async () => workerError(code));
      await expect(client.exists("/blocked", callContext(code))).rejects.toEqual(expect.objectContaining({ name: "SearchWorkerError", code }));
    }
  });
});

function createHarness() {
  const runtime = new RuntimeController();
  runtime.beginInitialization(); runtime.markReady({} as never);
  const client = {
    exists: vi.fn(async () => true),
    find: vi.fn(async () => ({ paths: ["a.ts"], limitReached: false })),
    grep: vi.fn(async () => ({ matches: [{ path: "a.ts", line: 2, text: "needle", kind: "match" as const }], matchLimitReached: false })),
  } as unknown as SearchWorkerClient & { find: ReturnType<typeof vi.fn>; grep: ReturnType<typeof vi.fn> };
  const hostSpawn = vi.fn();
  return { runtime, client, hostSpawn, dependencies: { runtime, client, hostSpawn } };
}

function transition(runtime: RuntimeController, state: string): void {
  runtime.beginShutdown(); runtime.finishShutdown();
  if (state === "initializing") runtime.beginInitialization();
  if (state === "failed") { runtime.beginInitialization(); runtime.markFailed(new Error("failed")); }
  if (state === "shutting-down") { runtime.beginInitialization(); runtime.markReady({} as never); runtime.beginShutdown(); }
}

async function findRg(): Promise<string> {
  const candidates = process.platform === "darwin"
    ? ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"]
    : ["/usr/bin/rg", "/usr/local/bin/rg", "/snap/bin/rg"];
  for (const candidate of candidates) {
    try { return await realpath(candidate); } catch { /* next fixed candidate */ }
  }
  throw new Error("ripgrep is required for Sandlot search client contract");
}

async function fakeClient(run: (request: unknown) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>): Promise<SearchWorkerClient> {
  return new SearchWorkerClient({ run } as never, {
    cwd: "/trusted",
    env: {},
    nodePath: process.execPath,
    workerPath: fileURLToPath(new URL("../../src/helpers/search-worker.ts", import.meta.url)),
    rgPath: await findRg(),
  });
}

function callContext(id: string) {
  return { expectedGeneration: 1, signal: undefined, nextInvocationId: () => id };
}

function workerError(code: string) {
  return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: false, error: { code, message: code } }), stderr: "" };
}
