import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const workerPath = resolve("dist/helpers/search-worker.js");
const fileWorkerPath = resolve("dist/helpers/file-worker.js");
const WORKER_PROCESS_TIMEOUT_MS = 15_000;
const WORKER_TEST_TIMEOUT_MS = WORKER_PROCESS_TIMEOUT_MS * 2 + 10_000;
let directory: string;
let rgPath: string;

beforeAll(async () => {
  rgPath = await findRg();
  directory = await mkdtemp(join(tmpdir(), "sandlot-search-worker-"));
  await mkdir(join(directory, "src"), { recursive: true });
  await mkdir(join(directory, "nested"), { recursive: true });
  await mkdir(join(directory, "nested", ".git"), { recursive: true });
  await mkdir(join(directory, ".git"), { recursive: true });
  await writeFile(join(directory, ".gitignore"), "ignored.ts\n");
  await writeFile(join(directory, ".hidden.ts"), "Needle hidden\n");
  await writeFile(join(directory, ".git", "excluded.ts"), "Needle git\n");
  await writeFile(join(directory, "ignored.ts"), "Needle ignored\n");
  await writeFile(join(directory, "src", "a.ts"), "before\nNeedle one\nafter\n");
  await writeFile(join(directory, "src", "b.ts"), "needle two\n");
  await writeFile(join(directory, "nested", "data.json"), '{"needle": true}\n');
  await writeFile(join(directory, "nested", ".git", "excluded.ts"), "Needle nested git\n");
});

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("search worker process", { timeout: WORKER_TEST_TIMEOUT_MS }, () => {
  it("finds hidden TypeScript files, honors gitignore and explicit ignores, sorts relative POSIX paths, and detects a limit", async () => {
    const result = await runWorker({ version: 1, operation: "find", cwd: directory, pattern: "*.ts", ignore: ["src/b.ts"], limit: 1 });
    expect(result).toEqual({ version: 1, ok: true, value: { paths: [".hidden.ts"], limitReached: true } });
  });

  it("supports recursive JSON find patterns and a file root", async () => {
    await expect(runWorker({ version: 1, operation: "find", cwd: directory, pattern: "**/*.json", ignore: [], limit: 9 }))
      .resolves.toEqual({ version: 1, ok: true, value: { paths: ["nested/data.json"], limitReached: false } });
    await expect(runWorker({ version: 1, operation: "grep", cwd: join(directory, "src", "a.ts"), pattern: "Needle", literal: true, ignoreCase: false, context: 0, limit: 9 }))
      .resolves.toMatchObject({ version: 1, ok: true, value: { matches: [{ path: "a.ts", line: 2, text: "Needle one", kind: "match" }], matchLimitReached: false } });
  });

  it("excludes nested .git contents as well as the root repository metadata", async () => {
    const result = await runWorker({ version: 1, operation: "find", cwd: directory, pattern: "**/*.ts", ignore: [], limit: 20 }) as { value: { paths: string[] } };
    expect(result.value.paths).not.toContain(".git/excluded.ts");
    expect(result.value.paths).not.toContain("nested/.git/excluded.ts");
  });

  it("returns structured grep records for literal/case/context modes and no match", async () => {
    const insensitive = await runWorker({ version: 1, operation: "grep", cwd: join(directory, "src"), pattern: "needle", literal: true, ignoreCase: true, context: 1, limit: 9 });
    expect(insensitive).toMatchObject({
      version: 1, ok: true, value: {
        matches: expect.arrayContaining([
          { path: "a.ts", line: 1, text: "before", kind: "context" },
          { path: "a.ts", line: 2, text: "Needle one", kind: "match" },
          { path: "a.ts", line: 3, text: "after", kind: "context" },
          { path: "b.ts", line: 1, text: "needle two", kind: "match" },
        ]),
      },
    });
    await expect(runWorker({ version: 1, operation: "grep", cwd: directory, pattern: "absent", literal: true, ignoreCase: false, context: 0, limit: 9 }))
      .resolves.toEqual({ version: 1, ok: true, value: { matches: [], matchLimitReached: false } });
  });

  it("treats invalid regex as an operational failure and malformed input as a nonzero protocol failure", async () => {
    await expect(runWorker({ version: 1, operation: "grep", cwd: directory, pattern: "[", literal: false, ignoreCase: false, context: 0, limit: 9 }))
      .resolves.toMatchObject({ version: 1, ok: false, error: { code: expect.any(String) } });
    const raw = await runRaw('{"version":1,"operation":"find","cwd":"/tmp","pattern":"*","ignore":[],"limit":1,"extra":true}');
    expect(raw.exitCode).not.toBe(0);
    expect(raw.stderr).toBe("");
    expect(JSON.parse(raw.stdout)).toMatchObject({ version: 1, ok: false, error: { code: "PROTOCOL_ERROR" } });
  });

  it.each(["malformed-match", "path-bytes", "lines-bytes"])("fails closed on %s ripgrep result records", async (mode) => {
    const result = await runFakeWorker(mode, { version: 1, operation: "grep", cwd: directory, pattern: "x", literal: false, ignoreCase: false, context: 0, limit: 1 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 1, ok: false, error: { code: expect.any(String) } });
  });

  it("globally bounds multi-file grep at limit plus one evidence and converts boundary matches to context", async () => {
    const result = await runFakeWorker("global-boundary", { version: 1, operation: "grep", cwd: directory, pattern: "x", literal: true, ignoreCase: false, context: 1, limit: 1 });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      ok: true,
      value: {
        matchLimitReached: true,
        matches: [
          { path: "a.ts", line: 1, text: "one", kind: "match" },
          { path: "a.ts", line: 2, text: "two", kind: "context" },
        ],
      },
    });
  });

  it("terminates rg after find limit plus one evidence and waits for its close", async () => {
    const marker = join(directory, "intentional-stop.txt");
    const result = await runFakeWorker("intentional-stop", { version: 1, operation: "find", cwd: directory, pattern: "*", ignore: [], limit: 1 }, { SANDLOT_FAKE_MARKER: marker });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, value: { paths: ["a.ts"], limitReached: true } });
    await expect(readFile(marker, "utf8")).resolves.toBe("stopped");
  });

  it("rejects a boundary-stopped rg that reports stderr and a non-success close", async () => {
    const result = await runFakeWorker("intentional-stop-error", { version: 1, operation: "find", cwd: directory, pattern: "*", ignore: [], limit: 1 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 1, ok: false, error: { code: "RG_FAILED", message: expect.stringContaining("late failure") } });
  });

  it("rejects whitespace-only stderr after intentional boundary termination", async () => {
    const result = await runFakeWorker("intentional-stop-whitespace", { version: 1, operation: "find", cwd: directory, pattern: "*", ignore: [], limit: 1 });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 1, ok: false, error: { code: "RG_FAILED" } });
  });

  it("arms a short timeout only after descendant readiness and reaps the descendant", async () => {
    const marker = join(directory, "timed-out-descendant.txt");
    const pidFile = join(directory, "timed-out-descendant.pid");
    const hangingEntry = join(directory, "hanging-worker.mjs");
    await writeFile(hangingEntry, `import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
setTimeout(() => {
  const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`
  const { appendFileSync, writeFileSync } = require("node:fs");
  const marker = process.argv[1];
  const pidFile = process.argv[2];
  writeFileSync(pidFile, String(process.pid));
  writeFileSync(marker, "started\\n");
  const heartbeat = setInterval(() => appendFileSync(marker, "beat\\n"), 50);
  setTimeout(() => { clearInterval(heartbeat); process.exit(0); }, 5000);
`)}, process.env.SANDLOT_FAKE_MARKER, process.env.SANDLOT_FAKE_PID_FILE], { stdio: "ignore" });
  descendant.unref();
  const readiness = setInterval(() => {
    if (!existsSync(process.env.SANDLOT_FAKE_MARKER) || !existsSync(process.env.SANDLOT_FAKE_PID_FILE)) return;
    clearInterval(readiness);
    process.stdout.write("descendant-ready\\n");
  }, 10);
}, 300);
setInterval(() => undefined, 1000);
`);

    await expect(runEntry(hangingEntry, "", {
      SANDLOT_FAKE_MARKER: marker,
      SANDLOT_FAKE_PID_FILE: pidFile,
    }, { timeoutMs: 100, readyToken: "descendant-ready\n", readinessTimeoutMs: 2_000 }))
      .rejects.toThrow("search worker process timed out after 100ms");
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    expect(descendantPid).toBeGreaterThan(0);
    await expect(readFile(marker, "utf8")).resolves.toMatch(/^started\n(?:beat\n)*$/);
    await expectProcessAbsent(descendantPid, 2_000);
  });

  it("bounds readiness failure and closes the unready worker group", async () => {
    const unreadyEntry = join(directory, "unready-worker.mjs");
    await writeFile(unreadyEntry, "setInterval(() => undefined, 1000);\n");

    await expect(runEntry(unreadyEntry, "", {}, {
      timeoutMs: 100,
      readyToken: "never-ready\n",
      readinessTimeoutMs: 250,
    })).rejects.toThrow("search worker did not become ready after 250ms");
  });

  it("rejects file/search worker requests at the wrong fixed worker entry point", async () => {
    const search = await runRaw(JSON.stringify({ version: 1, operation: "read", path: join(directory, "src", "a.ts") }));
    expect(search.exitCode).not.toBe(0);
    expect(JSON.parse(search.stdout)).toMatchObject({ ok: false, error: { code: "PROTOCOL_ERROR" } });
    const file = await runEntry(fileWorkerPath, JSON.stringify({ version: 1, operation: "find", cwd: directory, pattern: "*", ignore: [], limit: 1 }));
    expect(file.exitCode).not.toBe(0);
    expect(JSON.parse(file.stdout)).toMatchObject({ ok: false, error: { code: "PROTOCOL_ERROR" } });
  });
});

async function runWorker(request: unknown): Promise<unknown> {
  const result = await runRaw(JSON.stringify(request));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function runRaw(stdin: string, environment: NodeJS.ProcessEnv = {}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return runEntry(workerPath, stdin, environment);
}

interface EntryTimeoutOptions {
  readonly timeoutMs: number;
  readonly readyToken: string;
  readonly readinessTimeoutMs: number;
}

function runEntry(entry: string, stdin: string, environment: NodeJS.ProcessEnv = {}, timeoutOptions: number | EntryTimeoutOptions = WORKER_PROCESS_TIMEOUT_MS): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const timeoutMs = typeof timeoutOptions === "number" ? timeoutOptions : timeoutOptions.timeoutMs;
    const readyToken = typeof timeoutOptions === "number" ? undefined : Buffer.from(timeoutOptions.readyToken);
    const readinessTimeoutMs = typeof timeoutOptions === "number" ? undefined : timeoutOptions.readinessTimeoutMs;
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, SANDLOT_SEARCH_RG_PATH: rgPath, ...environment },
    });
    const processGroupId = child.pid;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let spawned = false;
    let awaitingReadiness = readyToken !== undefined;
    let timedOutDuringReadiness = false;
    let timedOutAfterMs = timeoutMs;
    let childError: Error | undefined;
    let terminationError: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const expire = (durationMs: number, duringReadiness: boolean): void => {
      if (settled || timedOut) return;
      timedOut = true;
      timedOutAfterMs = durationMs;
      timedOutDuringReadiness = duringReadiness;
      terminationError = terminateOwnedProcessGroup(child, processGroupId);
    };
    const armTimeout = (durationMs: number, duringReadiness: boolean): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = setTimeout(() => expire(durationMs, duringReadiness), durationMs);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      callback();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (settled || timedOut || !awaitingReadiness || readyToken === undefined) return;
      if (!Buffer.concat(stdout).includes(readyToken)) return;
      awaitingReadiness = false;
      armTimeout(timeoutMs, false);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("spawn", () => { spawned = true; });
    child.on("error", (error) => {
      if (!spawned) {
        settle(() => reject(error));
        return;
      }
      childError ??= error;
    });
    child.on("close", (exitCode) => settle(() => {
      if (timedOut) {
        const detail = terminationError === undefined ? "" : `; ${terminationError.message}`;
        const message = timedOutDuringReadiness
          ? `search worker did not become ready after ${timedOutAfterMs}ms`
          : `search worker process timed out after ${timedOutAfterMs}ms`;
        reject(new Error(`${message}${detail}`));
        return;
      }
      if (childError !== undefined) {
        reject(childError);
        return;
      }
      if (awaitingReadiness) {
        reject(new Error("search worker closed before its readiness token"));
        return;
      }
      resolveResult({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    }));
    armTimeout(readinessTimeoutMs ?? timeoutMs, readinessTimeoutMs !== undefined);
    child.stdin.end(stdin);
  });
}

function terminateOwnedProcessGroup(child: ReturnType<typeof spawn>, processGroupId: number | undefined): Error | undefined {
  if (processGroupId === undefined || !Number.isSafeInteger(processGroupId) || processGroupId <= 0 || processGroupId === process.pid) {
    const fallbackError = terminateDirectChild(child);
    const detail = fallbackError === undefined ? "" : `; ${fallbackError.message}`;
    return new Error(`search worker did not expose a safe owned process-group id${detail}`);
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
    return undefined;
  } catch (error) {
    const fallbackError = terminateDirectChild(child);
    if (isErrno(error, "ESRCH") && fallbackError === undefined) return undefined;
    const detail = fallbackError === undefined ? "" : `; ${fallbackError.message}`;
    return new Error(`failed to terminate search worker process group: ${error instanceof Error ? error.message : String(error)}${detail}`);
  }
}

function terminateDirectChild(child: ReturnType<typeof spawn>): Error | undefined {
  try {
    if (child.kill("SIGKILL") || child.exitCode !== null || child.signalCode !== null) return undefined;
    return new Error("direct worker termination was not delivered");
  } catch (error) {
    return new Error(`direct worker termination failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function expectProcessAbsent(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isErrno(error, "ESRCH")) return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`descendant process ${pid} remained alive after ${timeoutMs}ms`);
}

async function runFakeWorker(mode: string, request: unknown, environment: NodeJS.ProcessEnv = {}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const fakeRg = join(directory, `fake-rg-${mode}.mjs`);
  await writeFile(fakeRg, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nconst mode = process.env.SANDLOT_FAKE_MODE;\nconst out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");\nif (mode === "malformed-match") out({ type: "match", data: { path: { text: "a.ts" }, line_number: 1 } });\nif (mode === "path-bytes") out({ type: "match", data: { path: { bytes: "YS50cw==" }, lines: { text: "x\\n" }, line_number: 1 } });\nif (mode === "lines-bytes") out({ type: "match", data: { path: { text: "a.ts" }, lines: { bytes: "eA==" }, line_number: 1 } });\nif (mode === "global-boundary") { out({ type: "match", data: { path: { text: "a.ts" }, lines: { text: "one\\n" }, line_number: 1 } }); out({ type: "match", data: { path: { text: "a.ts" }, lines: { text: "two\\n" }, line_number: 2 } }); out({ type: "end", data: { path: { text: "a.ts" } } }); }\nif (mode === "intentional-stop" || mode === "intentional-stop-error" || mode === "intentional-stop-whitespace") { process.on("SIGTERM", () => { if (mode === "intentional-stop-error") { process.stderr.write("late failure\\n", () => process.exit(2)); return; } if (mode === "intentional-stop-whitespace") { process.stderr.write(" \\n\\t", () => process.exit(0)); return; } writeFileSync(process.env.SANDLOT_FAKE_MARKER, "stopped"); process.exit(0); }); process.stdout.write("a.ts\\nb.ts\\n"); setInterval(() => undefined, 1000); }\n`);
  await chmod(fakeRg, 0o755);
  return runRaw(JSON.stringify(request), { SANDLOT_SEARCH_RG_PATH: fakeRg, SANDLOT_FAKE_MODE: mode, ...environment });
}

async function findRg(): Promise<string> {
  const candidates = process.platform === "darwin"
    ? ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"]
    : ["/usr/bin/rg", "/usr/local/bin/rg", "/snap/bin/rg"];
  for (const candidate of candidates) {
    try { return await realpath(candidate); } catch { /* next fixed candidate */ }
  }
  throw new Error("ripgrep is required for Sandlot search worker contracts");
}
