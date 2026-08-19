import { access, stat } from "node:fs/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createSecurityHarness, type SecurityHarness } from "./harness.js";
import { describeIntegration } from "./preflight.js";

describeIntegration("real Sandbox Runtime process-tree enforcement", () => {
  let harness: SecurityHarness | undefined;

  beforeEach(async () => { harness = await createSecurityHarness(); });
  afterEach(async () => { await harness?.dispose(); });

  it("strips a host sentinel from the sandbox child environment", async () => {
    const result = await harness!.run(
      `if env | grep -q '^${harness!.sentinelName}='; then printf leaked; else printf absent; fi`,
    );

    expect(result).toMatchObject({ exitCode: 0, stdout: "absent" });
  });

  it("inherits outside-write denial in a shell descendant", async () => {
    const escaped = `${harness!.outside}/descendant-escape.txt`;
    const result = await harness!.runWithId(
      `bash -c ${quote(`printf escaped > ${quote(escaped)}`)}`,
      "descendant-denial",
    );

    expect(result.exitCode).not.toBe(0);
    // SRT 0.0.73 matches a denial to CMD64 only when both log lines share one
    // log-stream chunk, so a split record can permanently lose attribution.
    // Deterministic runner tests cover a delayed attributable denial's notice.
    await expect(access(escaped)).rejects.toThrow();
  });

  it("cancellation terminates the complete descendant process group", async () => {
    // Linux SRT unshares the PID namespace, so sandbox `$!` values cannot be
    // interpreted by the host. Workspace activity is namespace-independent.
    const heartbeat = `${harness!.workspace}/descendant-heartbeat`;
    const delayedCompletion = `${harness!.workspace}/descendant-completed`;
    const heartbeatCommand = `while :; do printf . >> ${quote(heartbeat)}; sleep 0.05; done`;
    const delayedCommand = `sleep 0.7; printf completed > ${quote(delayedCompletion)}`;
    const active = harness!.start(
      `bash -c ${quote(heartbeatCommand)} >/dev/null 2>&1 & `
      + `bash -c ${quote(delayedCommand)} >/dev/null 2>&1 & wait`,
    );
    await waitForFileSize(heartbeat, 2);

    active.abort();
    await expect(active.result).rejects.toThrow(/aborted/);
    await waitForFileQuiescence(heartbeat, 300, 2_000);
    await expectPathAbsentFor(delayedCompletion, 800);
  });
});

async function waitForFileSize(path: string, minimumBytes: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).size >= minimumBytes) return;
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${path} to reach ${minimumBytes} bytes`);
}

async function waitForFileQuiescence(path: string, quietMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = (await stat(path)).size;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await delay(25);
    const currentSize = (await stat(path)).size;
    if (currentSize !== lastSize) {
      lastSize = currentSize;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) return;
  }
  throw new Error(`descendant heartbeat ${path} continued after cancellation`);
}

async function expectPathAbsentFor(path: string, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      throw new Error(`descendant completed delayed write after cancellation: ${path}`);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    await delay(25);
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
