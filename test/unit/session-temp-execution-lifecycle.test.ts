import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  SandboxRuntimeBoundary,
  type SandboxRuntimeTransport,
} from "../../src/sandbox-runtime-boundary.js";
import { SandboxRunner, type SpawnLike } from "../../src/runner.js";
import { RuntimeController } from "../../src/runtime.js";

describe("session temporary-directory execution lifecycle", () => {
  it("does not deadlock when the runner's final violation request poisons the service", async () => {
    let temporaryDirectory = "";
    const poison = new Error("literal runner final-request poison");
    poison.name = "SandboxRuntimeServicePoisonError";
    const transport: SandboxRuntimeTransport = {
      request: async <T>(operation: string) => {
        if (operation === "wrap") {
          return {
            argv: ["/bin/sh", "-c", "exit 0"],
            env: {
              PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
              LANG: "C",
              LC_ALL: "C",
              TMPDIR: temporaryDirectory,
              TMP: temporaryDirectory,
              TEMP: temporaryDirectory,
            },
          } as T;
        }
        if (operation === "violationsForCommand") throw poison;
        return undefined as T;
      },
      notify: () => undefined,
      close: async () => undefined,
    };
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {},
      createTransport: async (launch) => {
        temporaryDirectory = launch.env.TMPDIR!;
        return transport;
      },
    });
    const runner = new SandboxRunner(boundary, readyRuntime(), { platform: "linux" });

    await boundary.open("/tmp");
    await initializeBoundary(boundary);
    try {
      const outcome = await runner.run({
        invocationId: "literal-final-request-command",
        command: "exit 0",
        commandText: "literal final request command",
        cwd: "/tmp",
        env: {},
        timeoutMs: 2_000,
      }).catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("literal runner final-request poison");
      await waitFor(async () => !(await pathExists(temporaryDirectory)));
      await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await boundary.reset().catch(() => undefined);
    }
  }, 5_000);

  it("retains the session while a real SandboxRunner command survives service poison and cleans only after process settlement", async () => {
    let temporaryDirectory = "";
    let child: ChildProcess | undefined;
    let childClosed = false;
    let delayedGroup = 0;
    let supervisionStarted = false;
    let settleDescendantSupervision!: () => void;
    const descendantSupervision = new Promise<void>((resolve) => {
      settleDescendantSupervision = resolve;
    });
    const poison = new Error("literal concurrent service poison");
    poison.name = "SandboxRuntimeServicePoisonError";
    const transport: SandboxRuntimeTransport = {
      request: async <T>(operation: string) => {
        if (operation === "wrap") {
          return {
            argv: ["/bin/sh", "-c", "while :; do sleep 1; done"],
            env: {
              PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
              LANG: "C",
              LC_ALL: "C",
              TMPDIR: temporaryDirectory,
              TMP: temporaryDirectory,
              TEMP: temporaryDirectory,
            },
          } as T;
        }
        if (operation === "linuxGlobPatternWarnings") throw poison;
        return undefined as T;
      },
      notify: () => undefined,
      close: async () => undefined,
    };
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {},
      createTransport: async (launch) => {
        temporaryDirectory = launch.env.TMPDIR!;
        return transport;
      },
    });
    const runtime = readyRuntime();
    const spawn: SpawnLike = (command, args, options) => {
      child = nodeSpawn(command, args, options);
      child.once("close", () => { childClosed = true; });
      return child;
    };
    const runner = new SandboxRunner(boundary, runtime, {
      spawn,
      platform: "darwin",
      killProcess: (pid, signal) => {
        if (pid < 0 && signal === "SIGKILL") {
          delayedGroup = pid;
          return true;
        }
        return process.kill(pid, signal);
      },
      createDescendantSupervisor: () => ({
        terminateAndWait: async () => {
          supervisionStarted = true;
          await descendantSupervision;
        },
      }),
    });

    await boundary.open("/tmp");
    await initializeBoundary(boundary);
    const running = runner.run({
      invocationId: "literal-active-command",
      command: "while :; do sleep 1; done",
      commandText: "literal active command",
      cwd: "/tmp",
      env: {},
      timeoutMs: 30_000,
    });
    const observed = running.catch((error: unknown) => error);

    try {
      await waitFor(() => child?.pid !== undefined);
      await expect(boundary.getLinuxGlobPatternWarnings()).rejects.toThrow(
        "literal concurrent service poison",
      );

      expect(delayedGroup).toBe(-(child!.pid!));
      expect(processIsAlive(child!.pid!)).toBe(true);
      await expect(access(temporaryDirectory)).resolves.toBeUndefined();

      process.kill(delayedGroup, "SIGKILL");
      await waitFor(() => childClosed && supervisionStarted);
      await expect(access(temporaryDirectory)).resolves.toBeUndefined();
      settleDescendantSupervision();
      const executionError = await observed;
      expect(executionError).toBeInstanceOf(Error);
      expect((executionError as Error).message).toBe(
        "Sandbox Runtime boundary is poisoned: literal concurrent service poison",
      );
      await waitFor(async () => !(await pathExists(temporaryDirectory)));
      await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      settleDescendantSupervision();
      if (child?.pid !== undefined && processIsAlive(child.pid)) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      }
      await observed;
      await boundary.reset().catch(() => undefined);
    }
  }, 10_000);
});

async function initializeBoundary(boundary: SandboxRuntimeBoundary): Promise<void> {
  await boundary.initialize({
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: { denyRead: [], allowWrite: ["/tmp"], denyWrite: [] },
  });
}

function readyRuntime(): RuntimeController {
  const runtime = new RuntimeController();
  runtime.beginInitialization();
  runtime.markReady({} as never);
  return runtime;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for concrete lifecycle transition");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
