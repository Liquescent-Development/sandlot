import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SandboxRuntimeBoundary,
  type SandboxRuntimeBoundaryOptions,
} from "../../src/sandbox-runtime-boundary.js";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("forked Sandbox Runtime transport", () => {
  it("times out a hung reset, closes with TERM then KILL, and reaps the service", async () => {
    const fixture = await createFixtureService(`
      process.on("message", (message) => {
        if (message?.type === "request" && message.operation !== "reset") {
          process.send?.({ type: "response", id: message.id, ok: true, value: undefined });
        }
      });
    `);
    const boundary = createBoundary(fixture.path);
    await boundary.open(fixture.root);
    const pid = await fixture.pid();

    const started = Date.now();
    const error = await boundary.reset().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/reset.*timed out|timed out.*reset/i);
    expect(Date.now() - started).toBeLessThan(300);
    await expect(readFile(fixture.termMarker, "utf8")).resolves.toBe("SIGTERM");
    await expectProcessGone(pid);
  }, 3_000);

  it.each([
    ["malformed", `{ type: "response", id: message.id, ok: "yes" }`],
    ["unknown ID", `{ type: "response", id: message.id + 1, ok: true, value: [] }`],
  ])("rejects a %s response promptly and closes the poisoned service", async (_label, response) => {
    const fixture = await createFixtureService(`
      process.on("message", (message) => {
        if (message?.type === "request") process.send?.(${response});
      });
    `);
    const boundary = createBoundary(fixture.path);
    await boundary.open(fixture.root);
    const pid = await fixture.pid();

    const started = Date.now();
    const error = await boundary.getLinuxGlobPatternWarnings().catch((reason: unknown) => reason);
    await boundary.reset().catch(() => undefined);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/protocol/i);
    expect(Date.now() - started).toBeLessThan(300);
    await expectProcessGone(pid);
  }, 3_000);

  it("fails closed on a duplicate response ID", async () => {
    const fixture = await createFixtureService(`
      let first = true;
      process.on("message", (message) => {
        if (message?.type !== "request") return;
        process.send?.({ type: "response", id: message.id, ok: true, value: [] });
        if (first) {
          first = false;
          setTimeout(() => process.send?.({ type: "response", id: message.id, ok: true, value: [] }), 10);
        }
      });
    `);
    const boundary = createBoundary(fixture.path);
    await boundary.open(fixture.root);

    await expect(boundary.getLinuxGlobPatternWarnings()).resolves.toEqual([]);
    await delay(30);
    await expect(boundary.cleanupAfterCommand()).rejects.toThrow(/protocol.*duplicate|duplicate.*response/i);
    await boundary.reset().catch(() => undefined);
  });

  it("poisons and kills the service on timeout so late state cannot commit or be reused", async () => {
    const fixture = await createFixtureService(`
      let cleanupCount = 0;
      process.on("message", (message) => {
        if (message?.type !== "request") return;
        if (message.operation === "cleanupAfterCommand" && cleanupCount++ === 0) {
          setTimeout(() => process.send?.({ type: "response", id: message.id, ok: true, value: undefined }), 90);
          return;
        }
        process.send?.({ type: "response", id: message.id, ok: true, value: undefined });
      });
    `);
    const boundary = createBoundary(fixture.path);
    await boundary.open(fixture.root);
    const pid = await fixture.pid();

    await expect(boundary.cleanupAfterCommand()).rejects.toThrow(/cleanupAfterCommand.*timed out|timed out.*cleanupAfterCommand/i);
    await delay(120);
    await expect(boundary.cleanupAfterCommand()).rejects.toThrow(/poisoned|unavailable|closed/i);
    await expect(boundary.open(fixture.root)).rejects.toThrow(/poisoned/i);
    await expectProcessGone(pid);
  });

  it("poisons a hung configuration transition and refuses every later request", async () => {
    const fixture = await createFixtureService(`
      process.on("message", (message) => {
        if (message?.type === "request" && message.operation !== "updateConfig") {
          process.send?.({ type: "response", id: message.id, ok: true, value: undefined });
        }
      });
    `);
    const boundary = createBoundary(fixture.path);
    await boundary.open(fixture.root);
    const pid = await fixture.pid();

    await expect(boundary.updateConfig({
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    })).rejects.toThrow(/updateConfig.*timed out|timed out.*updateConfig/i);
    await expect(boundary.getLinuxGlobPatternWarnings()).rejects.toThrow(/poisoned/i);
    await expectProcessGone(pid);
  });

  it("poisons and reaps a service that exits during an owned request", async () => {
    const fixture = await createFixtureService(`
      process.on("message", (message) => {
        if (message?.type === "request") process.exit(23);
      });
    `);
    const boundary = createBoundary(fixture.path);
    await boundary.open(fixture.root);
    const pid = await fixture.pid();

    await expect(boundary.getLinuxGlobPatternWarnings()).rejects.toThrow(/exited unexpectedly/i);
    await expect(boundary.cleanupAfterCommand()).rejects.toThrow(/poisoned/i);
    await expectProcessGone(pid);
  });

  it("settles an aborted request as an abort and removes its signal listener", async () => {
    const fixture = await createFixtureService(`
      process.on("message", (message) => {
        if (message?.type === "request" && (message.operation === "initialize" || message.operation === "reset")) {
          process.send?.({ type: "response", id: message.id, ok: true, value: undefined });
        }
      });
    `);
    const boundary = createBoundary(fixture.path);
    await boundary.open(fixture.root);
    await initializeBoundary(boundary);
    const temporaryDirectory = await fixture.temporaryDirectory();
    await expect(access(temporaryDirectory)).resolves.toBeUndefined();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    const request = boundary.wrapWithSandboxArgv("true", undefined, undefined, controller.signal, fixture.root);
    await delay(20);
    controller.abort();

    await expect(request).rejects.toThrow(/^aborted$/i);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await boundary.reset();
  });

  it("bounds pending requests before allocating another operation", async () => {
    const fixture = await createFixtureService(`
      process.on("message", () => undefined);
    `);
    const boundary = createBoundary(fixture.path);
    await boundary.open(fixture.root);
    const requests = Array.from({ length: 65 }, () => boundary.cleanupAfterCommand().catch((error: unknown) => error));

    const overflow = await Promise.race([requests[64], delay(150).then(() => "still-pending")]);
    await boundary.reset().catch(() => undefined);
    await Promise.all(requests);

    expect(overflow).toBeInstanceOf(Error);
    expect((overflow as Error).message).toMatch(/pending.*limit|too many.*request/i);
  }, 3_000);

  it("rejects an oversized request before it reaches the service", async () => {
    const receivedRoot = await mkdtemp(join(tmpdir(), "sandlot-ipc-received-"));
    fixtureRoots.push(receivedRoot);
    const receivedMarker = join(receivedRoot, "received");
    const fixture = await createFixtureService(`
      process.on("message", (message) => {
        if (message?.operation === "wrap") writeFileSync(${JSON.stringify(receivedMarker)}, "wrap");
        if (message?.type === "request") {
          process.send?.({ type: "response", id: message.id, ok: true, value: { argv: ["/bin/bash"], env: {} } });
        }
      });
    `);
    const boundary = createBoundary(fixture.path);
    await boundary.open(fixture.root);
    await initializeBoundary(boundary);

    await expect(boundary.wrapWithSandboxArgv("x".repeat(2 * 1024 * 1024), undefined, undefined, undefined, fixture.root))
      .rejects.toThrow(/message.*large|request.*size/i);
    await expect(readFile(receivedMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await boundary.reset().catch(() => undefined);
  });
});

function createBoundary(servicePath: string): SandboxRuntimeBoundary {
  return new SandboxRuntimeBoundary({
    nodePath: process.execPath,
    servicePath,
    platform: "darwin",
    hostEnvironment: {},
    transportTimeouts: {
      operations: {
        cleanupAfterCommand: 40,
        updateConfig: 40,
        linuxGlobPatternWarnings: 200,
        reset: 40,
        wrap: 400,
      },
      termGraceMs: 40,
      killWaitMs: 100,
    },
  } as SandboxRuntimeBoundaryOptions);
}

async function initializeBoundary(boundary: SandboxRuntimeBoundary): Promise<void> {
  await boundary.initialize({
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  });
}

async function createFixtureService(body: string): Promise<{
  root: string;
  path: string;
  termMarker: string;
  pid(): Promise<number>;
  temporaryDirectory(): Promise<string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "sandlot-ipc-service-"));
  fixtureRoots.push(root);
  const path = join(root, "service.mjs");
  const pidPath = join(root, "pid");
  const termMarker = join(root, "term");
  const temporaryDirectoryPath = join(root, "temporary-directory");
  await writeFile(path, `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    writeFileSync(${JSON.stringify(temporaryDirectoryPath)}, String(process.env.TMPDIR));
    process.on("SIGTERM", () => writeFileSync(${JSON.stringify(termMarker)}, "SIGTERM"));
    ${body}
    setTimeout(() => process.exit(0), 600);
  `);
  return {
    root,
    path,
    termMarker,
    pid: async () => Number(await waitForFile(pidPath)),
    temporaryDirectory: async () => waitForFile(temporaryDirectoryPath),
  };
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for fixture file ${path}`);
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (isNoSuchProcess(error)) return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`fixture service process ${pid} remained alive`);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isNoSuchProcess(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === "ESRCH";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
