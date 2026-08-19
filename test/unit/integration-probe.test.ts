import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProbe } from "../integration/probe.js";

describe("integration prerequisite probe", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("terminates a timed-out probe's descendant tree before it can mutate the host", async () => {
    root = await mkdtemp(join(tmpdir(), "sandlot-probe-test-"));
    const delayedMarker = join(root, "descendant-completed");
    const descendantSource = [
      "const { writeFileSync } = require('node:fs');",
      `setTimeout(() => writeFileSync(${JSON.stringify(delayedMarker)}, 'late'), 250);`,
    ].join("");
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
      "setInterval(() => undefined, 1000);",
    ].join("");

    const reason = await runProbe(process.execPath, ["-e", parentSource], {
      timeoutMs: 75,
      terminateGraceMs: 25,
      maxOutputBytes: 1_024,
    });

    expect(reason).toBe("probe timed out after 75ms");
    await expectPathAbsentFor(delayedMarker, 400);
  });

  it("caps oversized stderr while preserving a diagnostic truncation marker", async () => {
    const reason = await runProbe(
      process.execPath,
      ["-e", "process.stderr.write('x'.repeat(4096)); process.exitCode = 7;"],
      { timeoutMs: 1_000, terminateGraceMs: 25, maxOutputBytes: 128 },
    );

    expect(reason).toMatch(/^x+\n\[stderr truncated at 128 bytes\]$/);
    expect(Buffer.byteLength(reason!)).toBeLessThanOrEqual(170);
  });
});

async function expectPathAbsentFor(path: string, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      throw new Error(`timed-out probe descendant wrote ${path}`);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    await delay(20);
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
