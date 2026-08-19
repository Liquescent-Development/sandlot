import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TERMINATE_GRACE_MS = 100;

export interface ProbeOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly terminateGraceMs?: number;
}

export function runProbe(
  command: string,
  args: readonly string[],
  options: ProbeOptions = {},
): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  requirePositiveInteger(timeoutMs, "probe timeoutMs");
  requirePositiveInteger(maxOutputBytes, "probe maxOutputBytes");
  requirePositiveInteger(terminateGraceMs, "probe terminateGraceMs");

  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let stderrTruncated = false;
    let settled = false;
    let closeObserved = false;
    let forcedReason: string | undefined;
    let escalationComplete = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let closeFallbackTimer: NodeJS.Timeout | undefined;

    const finish = (reason: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      if (closeFallbackTimer !== undefined) clearTimeout(closeFallbackTimer);
      resolve(reason);
    };

    const finishForcedWhenSafe = (): void => {
      if (forcedReason === undefined || !escalationComplete || !closeObserved) return;
      finish(forcedReason);
    };

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      const remaining = maxOutputBytes - capturedBytes;
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        stderr.push(captured);
        capturedBytes += captured.length;
      }
      if (buffer.length > remaining) stderrTruncated = true;
    });
    child.once("error", (error) => finish(error.message));
    child.once("close", (code, signal) => {
      closeObserved = true;
      if (forcedReason !== undefined) {
        finishForcedWhenSafe();
        return;
      }
      const diagnostic = renderStderr(stderr, stderrTruncated, maxOutputBytes);
      finish(code === 0 ? undefined : diagnostic || `exit ${String(code)} signal ${String(signal)}`);
    });

    const timeoutTimer = setTimeout(() => {
      forcedReason = `probe timed out after ${timeoutMs}ms`;
      terminateChildTree(child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        terminateChildTree(child, "SIGKILL");
        escalationComplete = true;
        finishForcedWhenSafe();
        if (!settled) closeFallbackTimer = setTimeout(() => finish(forcedReason), terminateGraceMs);
      }, terminateGraceMs);
    }, timeoutMs);
  });
}

function terminateChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the group has already disappeared.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Kill delivery is best-effort after timeout.
  }
}

function renderStderr(chunks: readonly Buffer[], truncated: boolean, limit: number): string {
  const diagnostic = Buffer.concat(chunks).toString("utf8").trim();
  if (!truncated) return diagnostic;
  return `${diagnostic}\n[stderr truncated at ${limit} bytes]`;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}
