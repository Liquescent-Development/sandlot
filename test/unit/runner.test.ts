import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  SandboxRunner,
  type ChildProcessLike,
  type RunRequest,
  type SandboxManagerLike,
  type SpawnLike,
} from "../../src/runner.js";
import { RuntimeController } from "../../src/runtime.js";

describe("SandboxRunner", () => {
  it("rejects an operation captured before a runtime replacement before wrapping", async () => {
    // Catches accepting an expected generation only after the worker has been
    // wrapped/spawned, which lets an old Pi file call enter a new sandbox.
    const harness = createRunnerHarness();
    const capturedGeneration = harness.runtime.snapshot().generation;
    harness.runtime.beginShutdown();
    harness.runtime.finishShutdown();
    harness.runtime.beginInitialization();
    harness.runtime.markReady({} as never);

    expect(() => harness.runner.run(harness.request({ expectedGeneration: capturedGeneration })))
      .toThrow(/stale generation/i);
    expect(harness.manager.wrapWithSandboxArgv).not.toHaveBeenCalled();
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("rejects a later worker child after runtime replacement from one captured file call", async () => {
    // Catches rechecking only ready state between file-worker access/read/write
    // requests, which would continue the call inside a replacement generation.
    const harness = createRunnerHarness();
    const capturedGeneration = harness.runtime.snapshot().generation;
    const first = harness.runner.run(harness.request({ invocationId: "pi-file", expectedGeneration: capturedGeneration }));
    await harness.spawned();
    harness.child.emitClose(0);
    await expect(first).resolves.toMatchObject({ exitCode: 0 });

    harness.runtime.beginShutdown();
    harness.runtime.finishShutdown();
    harness.runtime.beginInitialization();
    harness.runtime.markReady({} as never);

    expect(() => harness.runner.run(harness.request({ invocationId: "pi-file:1", expectedGeneration: capturedGeneration })))
      .toThrow(/stale generation/i);
    expect(harness.manager.wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
  });

  it("spawns wrapped argv without a host shell using only the fixed outer environment", async () => {
    const harness = createRunnerHarness({ argv: ["/bin/sh", "-c", "wrapped"], env: { PATH: "/usr/bin:/bin", LANG: "C" } });
    const pending = harness.runner.run(harness.request({
      stdin: "input",
      env: { PATH: "/writable/bin", BASH_ENV: "/writable/preload.sh", SAFE_CHILD_VALUE: "inside-only" },
    }));
    await harness.spawned();

    expect(harness.manager.wrapWithSandboxArgv).toHaveBeenCalledWith(
      "echo ok",
      undefined,
      undefined,
      expect.any(AbortSignal),
      "/work",
      {
        commandId: "tool-1",
        commandText: "echo ok",
        childEnvironment: {
          PATH: "/writable/bin",
          BASH_ENV: "/writable/preload.sh",
          SAFE_CHILD_VALUE: "inside-only",
        },
      },
    );
    expect(harness.spawn).toHaveBeenCalledWith("/bin/sh", ["-c", "wrapped"], {
      shell: false,
      cwd: "/work",
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(harness.child.stdinText).toBe("input");

    harness.child.emitClose(0);

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual([]);
  });

  it("streams stdout and stderr and appends command violations exactly once", async () => {
    const harness = createRunnerHarness(undefined, [
      { line: "deny file-read /secret" },
      { line: "deny network example.invalid" },
    ]);
    const pending = harness.runner.run(harness.request({ maxOutputBytes: 1_024 }));
    await harness.spawned();

    harness.child.stdout.write(Buffer.from("out"));
    harness.child.stderr.write(Buffer.from("err"));
    harness.child.emitClose(7);

    const result = await pending;
    const streamed = Buffer.concat(harness.onData.mock.calls.map(([chunk]) => chunk)).toString();

    expect(result).toEqual({
      exitCode: 7,
      stdout: "out",
      stderr: "err\nBlocked by Sandlot: read file /secret\nBlocked by Sandlot: network access example.invalid",
    });
    expect(streamed).toBe("outerr\nBlocked by Sandlot: read file /secret\nBlocked by Sandlot: network access example.invalid");
    expect(streamed.match(/Blocked by Sandlot: read file/g)).toHaveLength(1);
    expect(streamed).not.toContain("<sandbox_violations>");
    expect(harness.violationStore.getViolationsForCommand).toHaveBeenCalledOnce();
    expect(harness.violationStore.getViolationsForCommand).toHaveBeenCalledWith("tool-1");
  });

  it("awaits violations returned across an asynchronous runtime boundary", async () => {
    const harness = createRunnerHarness();
    const collectViolations = vi.fn(async () => [{ line: "deny file-read /boundary-secret" }]);
    Object.assign(harness.manager, { collectViolations });
    const pending = harness.runner.run(harness.request({ maxOutputBytes: 1_024 }));
    await harness.spawned();

    harness.child.emitClose(9);

    await expect(pending).resolves.toEqual({
      exitCode: 9,
      stdout: "",
      stderr: "Blocked by Sandlot: read file /boundary-secret",
    });
    expect(collectViolations).toHaveBeenCalledWith("tool-1");
  });

  it("settles a failed close until a delayed material violation appears", async () => {
    const wait = vi.fn(async () => undefined);
    const harness = createRunnerHarness(undefined, [], { violationSettleMs: 50, wait });
    let reads = 0;
    harness.violationStore.getViolationsForCommand.mockImplementation(() => {
      reads++;
      return reads === 1 ? [] : [{ line: "deny file-write-create /outside/delayed" }];
    });
    const pending = harness.runner.run(harness.request({ maxOutputBytes: 1_024 }));
    await harness.spawned();
    harness.child.emitClose(7);

    await expect(pending).resolves.toEqual({
      exitCode: 7,
      stdout: "",
      stderr: "Blocked by Sandlot: create file /outside/delayed",
    });
    expect(wait).toHaveBeenCalledOnce();
    expect(harness.violationStore.getViolationsForCommand).toHaveBeenCalledTimes(2);
  });

  it("does not settle a successful close with no material violation", async () => {
    const wait = vi.fn(async () => undefined);
    const harness = createRunnerHarness(undefined, [], { violationSettleMs: 50, wait });
    const pending = harness.runner.run(harness.request({ maxOutputBytes: 1_024 }));
    await harness.spawned();
    harness.child.emitClose(0);

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(wait).not.toHaveBeenCalled();
  });

  it("begins a zero-exit material violation notice without a leading separator and accounts for it in limits", async () => {
    const harness = createRunnerHarness(undefined, [{ line: "deny http-request https://example.invalid" }]);
    const pending = harness.runner.run(harness.request({ maxOutputBytes: 1_024 }));
    await harness.spawned();
    harness.child.emitClose(0);

    await expect(pending).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "Blocked by Sandlot: HTTP request https://example.invalid",
    });
    expect(Buffer.concat(harness.onData.mock.calls.map(([chunk]) => chunk)).toString())
      .toBe("Blocked by Sandlot: HTTP request https://example.invalid");
  });

  it("streams a targetless material denial", async () => {
    const harness = createRunnerHarness(undefined, [{ line: "bash(42) deny(1) process-fork" }]);
    const pending = harness.runner.run(harness.request({ maxOutputBytes: 1_024 }));
    await harness.spawned();
    harness.child.emitClose(0);

    await expect(pending).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "Blocked by Sandlot: fork process",
    });
  });

  it("separates a notice after streamed stdout without a trailing newline", async () => {
    const harness = createRunnerHarness(undefined, [{ line: "deny http-request https://example.invalid" }]);
    const pending = harness.runner.run(harness.request());
    await harness.spawned();
    harness.child.stdout.write(Buffer.from("out"));
    harness.child.emitClose(0);

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(Buffer.concat(harness.onData.mock.calls.map(([chunk]) => chunk)).toString())
      .toBe("out\nBlocked by Sandlot: HTTP request https://example.invalid");
  });

  it("does not double-separate a notice after stdout ending in a newline", async () => {
    const harness = createRunnerHarness(undefined, [{ line: "deny http-request https://example.invalid" }]);
    const pending = harness.runner.run(harness.request());
    await harness.spawned();
    harness.child.stdout.write(Buffer.from("out\n"));
    harness.child.emitClose(0);

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(Buffer.concat(harness.onData.mock.calls.map(([chunk]) => chunk)).toString())
      .toBe("out\nBlocked by Sandlot: HTTP request https://example.invalid");
  });

  it("separates a notice after streamed stderr even when output capture is unlimited", async () => {
    const harness = createRunnerHarness(undefined, [{ line: "deny http-request https://example.invalid" }]);
    const pending = harness.runner.run(harness.request());
    await harness.spawned();
    harness.child.stderr.write(Buffer.from("err"));
    harness.child.emitClose(0);

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(Buffer.concat(harness.onData.mock.calls.map(([chunk]) => chunk)).toString())
      .toBe("err\nBlocked by Sandlot: HTTP request https://example.invalid");
  });

  it("streams a material violation once before failing closed at the bounded capture limit", async () => {
    const harness = createRunnerHarness(undefined, [{ line: "deny mach-lookup com.apple.securityd" }]);
    const pending = harness.runner.run(harness.request({ maxOutputBytes: 8 }));
    await harness.spawned();
    harness.child.emitClose(0);

    await expect(pending).rejects.toThrow("output-limit:8");
    expect(Buffer.concat(harness.onData.mock.calls.map(([chunk]) => chunk)).toString())
      .toBe("Blocked by Sandlot: Mach service lookup com.apple.securityd");
    expect(harness.violationStore.getViolationsForCommand).toHaveBeenCalledOnce();
  });

  it("keeps violation annotations out of a structured child transport when requested", async () => {
    // Catches appending monitor prose to a JSON worker's stderr, which turns a
    // successful protocol response into a host-side protocol failure.
    const harness = createRunnerHarness(undefined, [
      { line: "deny sysctl-read harmless-platform-probe" },
    ]);
    const pending = harness.runner.run(harness.request({
      maxOutputBytes: 1_024,
      annotateViolations: false,
    }));
    await harness.spawned();

    harness.child.stdout.write(Buffer.from('{"ok":true}'));
    harness.child.emitClose(0);

    await expect(pending).resolves.toEqual({
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: "",
    });
    expect(harness.violationStore.getViolationsForCommand).not.toHaveBeenCalled();
  });

  it("cleans up once after wrapping even when host spawn throws", async () => {
    const harness = createRunnerHarness();
    harness.spawn.mockImplementationOnce(() => {
      throw new Error("spawn exploded");
    });

    await expect(harness.runner.run(harness.request())).rejects.toThrow("spawn exploded");

    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual([]);
  });

  it("does not clean up when wrapping fails", async () => {
    const harness = createRunnerHarness();
    harness.manager.wrapWithSandboxArgv.mockRejectedValueOnce(new Error("wrap exploded"));

    await expect(harness.runner.run(harness.request())).rejects.toThrow("wrap exploded");

    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.manager.cleanupAfterCommand).not.toHaveBeenCalled();
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual([]);
  });

  it("rejects an already-aborted request before wrapping or spawning", async () => {
    const harness = createRunnerHarness();
    const caller = new AbortController();
    caller.abort();

    const pending = harness.runner.run(harness.request({ signal: caller.signal }));
    const rejection = expect(pending).rejects.toThrow("aborted");
    await flushAsync();
    if (harness.spawn.mock.calls.length > 0) harness.child.emitClose(null, "SIGKILL");

    await rejection;
    expect(harness.manager.wrapWithSandboxArgv).not.toHaveBeenCalled();
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.manager.cleanupAfterCommand).not.toHaveBeenCalled();
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual([]);
  });

  it("does not spawn when the caller cancels during wrapping", async () => {
    const harness = createRunnerHarness();
    const wrap = deferWrap(harness);
    const caller = new AbortController();
    const pending = harness.runner.run(harness.request({ signal: caller.signal }));
    const rejection = expect(pending).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(harness.manager.wrapWithSandboxArgv).toHaveBeenCalledOnce());

    caller.abort();
    wrap.resolve();
    await flushAsync();
    if (harness.spawn.mock.calls.length > 0) harness.child.emitClose(null, "SIGKILL");

    await rejection;
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("does not spawn when abortAll runs during wrapping and waits for cleanup", async () => {
    const harness = createRunnerHarness();
    const wrap = deferWrap(harness);
    const pending = harness.runner.run(harness.request());
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(harness.manager.wrapWithSandboxArgv).toHaveBeenCalledOnce());

    let abortFinished = false;
    const aborting = harness.runner.abortAll().then(() => { abortFinished = true; });
    await Promise.resolve();
    expect(abortFinished).toBe(false);
    wrap.resolve();
    await flushAsync();
    if (harness.spawn.mock.calls.length > 0) harness.child.emitClose(null, "SIGKILL");

    await aborting;
    await expect(pending).rejects.toThrow("aborted");
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("kills the detached process group on caller cancellation and waits for close", async () => {
    const harness = createRunnerHarness();
    const caller = new AbortController();
    const pending = harness.runner.run(harness.request({ signal: caller.signal }));
    const rejection = expect(pending).rejects.toThrow("aborted");
    await harness.spawned();

    caller.abort();
    await vi.waitFor(() => expect(harness.killProcess).toHaveBeenCalledWith(-321, "SIGKILL"));
    expect(harness.child.kill).not.toHaveBeenCalled();

    let settled = false;
    void pending.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    harness.child.emitClose(null, "SIGKILL");

    await rejection;
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("falls back to killing the child when process-group termination fails", async () => {
    const harness = createRunnerHarness();
    harness.killProcess.mockImplementationOnce(() => {
      throw new Error("group already gone");
    });
    const caller = new AbortController();
    const pending = harness.runner.run(harness.request({ signal: caller.signal }));
    const rejection = expect(pending).rejects.toThrow("aborted");
    await harness.spawned();

    caller.abort();
    await vi.waitFor(() => expect(harness.child.kill).toHaveBeenCalledWith("SIGKILL"));
    harness.child.emitClose(null, "SIGKILL");

    await rejection;
  });

  it.each([
    ["throws", () => { throw new Error("child kill failed"); }],
    ["returns false", () => false],
  ])("keeps abort nonthrowing and owned until close when fallback child.kill %s", async (_case, fallback) => {
    const harness = createRunnerHarness();
    harness.killProcess.mockImplementationOnce(() => {
      throw new Error("group kill failed");
    });
    harness.child.kill.mockImplementationOnce(fallback);
    const caller = new AbortController();
    const pending = harness.runner.run(harness.request({ signal: caller.signal }));
    const rejection = expect(pending).rejects.toThrow("aborted");
    await harness.spawned();

    expect(() => caller.abort()).not.toThrow();
    await flushAsync();
    harness.child.emit("error", new Error("later child error"));
    const stateBeforeClose = {
      active: harness.runtime.snapshot().activeInvocationIds,
      cleanupCalls: harness.manager.cleanupAfterCommand.mock.calls.length,
    };
    harness.child.emitClose(null, "SIGKILL");

    await rejection;
    expect(stateBeforeClose).toEqual({ active: ["tool-1"], cleanupCalls: 0 });
    expect(harness.killProcess).toHaveBeenCalledTimes(1);
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual([]);
  });

  it("aborts on timeout, kills the process group, and reports seconds", async () => {
    vi.useFakeTimers();
    try {
      const harness = createRunnerHarness();
      const pending = harness.runner.run(harness.request({ timeoutMs: 1_000 }));
      const rejection = expect(pending).rejects.toThrow("timeout:1");
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.killProcess).toHaveBeenCalledWith(-321, "SIGKILL");
      harness.child.emitClose(null, "SIGKILL");

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("latches caller cancellation when its timeout fires later", async () => {
    vi.useFakeTimers();
    try {
      const harness = createRunnerHarness();
      const caller = new AbortController();
      const pending = harness.runner.run(harness.request({ signal: caller.signal, timeoutMs: 1_000 }));
      const rejection = expect(pending).rejects.toThrow("aborted");
      await Promise.resolve();
      await Promise.resolve();

      caller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      harness.child.emitClose(null, "SIGKILL");

      await rejection;
      expect(harness.killProcess).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("latches timeout when shutdown happens later", async () => {
    vi.useFakeTimers();
    try {
      const harness = createRunnerHarness();
      const pending = harness.runner.run(harness.request({ timeoutMs: 1_000 }));
      const rejection = expect(pending).rejects.toThrow("timeout:1");
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1_000);
      harness.runtime.beginShutdown();
      harness.child.emitClose(null, "SIGKILL");

      await rejection;
      expect(harness.killProcess).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abortAll aborts every active run and waits for each process to close", async () => {
    const first = createRunnerHarness();
    const secondChild = new FakeChild(654);
    first.spawn.mockReturnValueOnce(first.child).mockReturnValueOnce(secondChild);
    const firstRun = first.runner.run(first.request({ invocationId: "tool-1" }));
    const secondRun = first.runner.run(first.request({ invocationId: "tool-2" }));
    void firstRun.catch(() => undefined);
    void secondRun.catch(() => undefined);
    await vi.waitFor(() => expect(first.spawn).toHaveBeenCalledTimes(2));

    const aborting = first.runner.abortAll();
    let finished = false;
    void aborting.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(first.killProcess).toHaveBeenCalledWith(-321, "SIGKILL");
    expect(first.killProcess).toHaveBeenCalledWith(-654, "SIGKILL");

    first.child.emitClose(null, "SIGKILL");
    secondChild.emitClose(null, "SIGKILL");

    await aborting;
    await expect(firstRun).rejects.toThrow("aborted");
    await expect(secondRun).rejects.toThrow("aborted");
  });

  it("rejects a result from a stale runtime generation without another spawn", async () => {
    const harness = createRunnerHarness();
    const pending = harness.runner.run(harness.request());
    await harness.spawned();

    harness.child.emitClose(0);
    harness.runtime.beginShutdown();

    await expect(pending).rejects.toThrow(/stale generation/);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects a generation change during wrapping before spawning", async () => {
    const harness = createRunnerHarness();
    let resolveWrap!: (descriptor: { argv: string[]; env: NodeJS.ProcessEnv }) => void;
    harness.manager.wrapWithSandboxArgv.mockImplementationOnce(() => new Promise((resolve) => {
      resolveWrap = resolve;
    }));
    const pending = harness.runner.run(harness.request());
    await vi.waitFor(() => expect(harness.manager.wrapWithSandboxArgv).toHaveBeenCalledOnce());

    harness.runtime.beginShutdown();
    resolveWrap({ argv: ["/sandbox", "wrapped"], env: {} });
    await Promise.resolve();
    if (harness.spawn.mock.calls.length > 0) harness.child.emitClose(null, "SIGKILL");

    await expect(pending).rejects.toThrow(/stale generation/);
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("handles asynchronous stdin EPIPE, kills the group, and waits for close", async () => {
    const harness = createRunnerHarness(undefined, [{ line: "deny after EPIPE" }]);
    const pending = harness.runner.run(harness.request());
    let settled = false;
    let failure: unknown;
    const observed = pending.then(
      () => { settled = true; },
      (error: unknown) => { settled = true; failure = error; },
    );
    await harness.spawned();
    const stdin = harness.child.stdin;
    expect(stdin).not.toBeNull();
    expect(stdin!.listenerCount("error")).toBe(1);
    const safetyListener = vi.fn();
    stdin!.on("error", safetyListener);

    queueMicrotask(() => stdin!.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeClose = settled;
    const cleanupBeforeClose = harness.manager.cleanupAfterCommand.mock.calls.length;
    harness.child.emitClose(null, "SIGKILL");

    await observed;
    expect(settledBeforeClose).toBe(false);
    expect(cleanupBeforeClose).toBe(0);
    expect(failure).toMatchObject({ message: "write EPIPE", code: "EPIPE" });
    expect(harness.killProcess).toHaveBeenCalledWith(-321, "SIGKILL");
    expect(harness.violationStore.getViolationsForCommand).toHaveBeenCalledWith("tool-1");
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(stdin!.listenerCount("error")).toBe(1);
    stdin!.off("error", safetyListener);
  });

  it("keeps child errors owned until delayed close and abortAll completion", async () => {
    const harness = createRunnerHarness(undefined, [{ line: "deny after child error" }]);
    const pending = harness.runner.run(harness.request());
    let settled = false;
    let failure: unknown;
    const observed = pending.then(
      () => { settled = true; },
      (error: unknown) => { settled = true; failure = error; },
    );
    await harness.spawned();

    harness.child.emit("error", new Error("child failed"));
    const aborting = harness.runner.abortAll();
    let abortFinished = false;
    void aborting.then(() => { abortFinished = true; });
    await Promise.resolve();
    const stateBeforeClose = { settled, abortFinished };
    harness.child.emitClose(null, "SIGKILL");

    await observed;
    await aborting;
    expect(stateBeforeClose).toEqual({ settled: false, abortFinished: false });
    expect(failure).toMatchObject({ message: "child failed" });
    expect(harness.killProcess).toHaveBeenCalledTimes(1);
    expect(harness.violationStore.getViolationsForCommand).toHaveBeenCalledWith("tool-1");
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("kills and owns a spawned child with missing stdio until close", async () => {
    const harness = createRunnerHarness();
    const missingStdio = new FakeChild(777, false);
    harness.spawn.mockReturnValueOnce(missingStdio);
    const pending = harness.runner.run(harness.request());
    let settled = false;
    let failure: unknown;
    const observed = pending.then(
      () => { settled = true; },
      (error: unknown) => { settled = true; failure = error; },
    );
    await harness.spawned();
    await Promise.resolve();
    const settledBeforeClose = settled;

    missingStdio.emitClose(null, "SIGKILL");
    await observed;

    expect(settledBeforeClose).toBe(false);
    expect(failure).toMatchObject({ message: "Sandbox child stdio was not piped" });
    expect(harness.killProcess).toHaveBeenCalledWith(-777, "SIGKILL");
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual([]);
  });

  it("streams without retaining output when no capture limit is requested", async () => {
    const harness = createRunnerHarness();
    const pending = harness.runner.run(harness.request());
    await harness.spawned();

    harness.child.stdout!.write(Buffer.from("streamed stdout"));
    harness.child.stderr!.write(Buffer.from("streamed stderr"));
    harness.child.emitClose(0);

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(Buffer.concat(harness.onData.mock.calls.map(([chunk]) => chunk)).toString()).toBe("streamed stdoutstreamed stderr");
  });

  it("retains structured output exactly at the combined byte boundary", async () => {
    const harness = createRunnerHarness();
    const pending = harness.runner.run(harness.request({ maxOutputBytes: 5 }));
    await harness.spawned();

    harness.child.stdout!.write(Buffer.from("123"));
    harness.child.stderr!.write(Buffer.from("45"));
    harness.child.emitClose(0);

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "123", stderr: "45" });
  });

  it("fails closed on capture overflow while preserving streaming", async () => {
    const harness = createRunnerHarness();
    const pending = harness.runner.run(harness.request({ maxOutputBytes: 4 }));
    const rejection = expect(pending).rejects.toThrow("output-limit:4");
    await harness.spawned();

    harness.child.stdout!.write(Buffer.from("12345"));
    await Promise.resolve();
    const killBeforeClose = harness.killProcess.mock.calls.length;
    harness.child.emitClose(null, "SIGKILL");

    await rejection;
    expect(killBeforeClose).toBe(1);
    expect(harness.killProcess).toHaveBeenCalledWith(-321, "SIGKILL");
    expect(Buffer.concat(harness.onData.mock.calls.map(([chunk]) => chunk)).toString()).toBe("12345");
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("releases the runtime lease when cleanup throws", async () => {
    const harness = createRunnerHarness();
    harness.manager.cleanupAfterCommand.mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });
    const pending = harness.runner.run(harness.request());
    await harness.spawned();
    harness.child.emitClose(0);

    await expect(pending).rejects.toThrow("cleanup failed");
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual([]);
  });

  it("awaits asynchronous runtime cleanup before resolving and releasing the lease", async () => {
    const harness = createRunnerHarness();
    let finishCleanup!: () => void;
    harness.manager.cleanupAfterCommand.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishCleanup = resolve; }),
    );
    const pending = harness.runner.run(harness.request());
    await harness.spawned();
    harness.child.emitClose(0);

    let settled = false;
    void pending.finally(() => { settled = true; });
    await flushAsync();
    expect(settled).toBe(false);
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual(["tool-1"]);

    finishCleanup();
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual([]);
  });

  it("fails closed when a child exits from an unexpected signal", async () => {
    const harness = createRunnerHarness();
    const pending = harness.runner.run(harness.request());
    await harness.spawned();

    harness.child.emitClose(null, "SIGTERM");

    await expect(pending).rejects.toThrow(/unexpected signal.*SIGTERM/i);
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("awaits supervised detached descendants before resolving and releasing ownership", async () => {
    const harness = createRunnerHarness();
    let descendantsDead!: () => void;
    harness.descendantSupervisor.terminateAndWait.mockImplementationOnce(
      () => new Promise<void>((resolve) => { descendantsDead = resolve; }),
    );
    const pending = harness.runner.run(harness.request());
    await harness.spawned();
    harness.child.emitClose(0);

    let settled = false;
    void pending.finally(() => { settled = true; });
    await flushAsync();
    expect(settled).toBe(false);
    expect(harness.createDescendantSupervisor).toHaveBeenCalledWith(321);
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual(["tool-1"]);

    descendantsDead();
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(harness.runtime.snapshot().activeInvocationIds).toEqual([]);
  });

  it("latches failed descendant supervision so later termination checks remain indeterminate", async () => {
    const harness = createRunnerHarness();
    harness.descendantSupervisor.terminateAndWait.mockRejectedValueOnce(
      new Error("literal descendant supervision failure"),
    );
    const pending = harness.runner.run(harness.request());
    await harness.spawned();

    harness.child.emitClose(0);

    await expect(pending).rejects.toThrow("literal descendant supervision failure");
    await expect(harness.runner.abortAll()).rejects.toThrow(
      "SandboxRunner could not confirm descendant termination: literal descendant supervision failure",
    );
    await expect(harness.runner.abortAll()).rejects.toThrow(
      "SandboxRunner could not confirm descendant termination: literal descendant supervision failure",
    );
  });

  it("settles deterministically when error wins a close race", async () => {
    const harness = createRunnerHarness();
    const pending = harness.runner.run(harness.request());
    const rejection = expect(pending).rejects.toThrow("failed to spawn");
    await harness.spawned();

    harness.child.emit("error", new Error("failed to spawn"));
    harness.child.emitClose(0);

    await rejection;
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("settles deterministically when close wins an error race", async () => {
    const harness = createRunnerHarness();
    const pending = harness.runner.run(harness.request());
    await harness.spawned();

    harness.child.emitClose(0);
    harness.child.emit("error", new Error("late spawn error"));

    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(harness.manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });
});

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdin: PassThrough | null;
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  readonly kill = vi.fn(() => true);
  stdinText = "";

  constructor(readonly pid = 321, withStdio = true) {
    super();
    this.stdin = withStdio ? new PassThrough() : null;
    this.stdout = withStdio ? new PassThrough() : null;
    this.stderr = withStdio ? new PassThrough() : null;
    this.stdin?.on("data", (chunk: Buffer) => { this.stdinText += chunk.toString(); });
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
}

function createRunnerHarness(
  descriptor: { argv: string[]; env: NodeJS.ProcessEnv } = { argv: ["/sandbox", "wrapped"], env: {} },
  violations: Array<{ line: string }> = [],
  dependencies: { violationSettleMs?: number; wait?: (milliseconds: number) => Promise<void> } = {},
) {
  const runtime = readyRuntime();
  const child = new FakeChild();
  const violationStore = {
    getViolationsForCommand: vi.fn(() => violations),
  };
  const manager = {
    wrapWithSandboxArgv: vi.fn(async () => descriptor),
    cleanupAfterCommand: vi.fn(),
    getSandboxViolationStore: vi.fn(() => violationStore),
  } satisfies SandboxManagerLike;
  const spawn = vi.fn<SpawnLike>(() => child);
  const killProcess = vi.fn<(pid: number, signal: NodeJS.Signals) => true>(() => true);
  const descendantSupervisor = { terminateAndWait: vi.fn(async () => undefined) };
  const createDescendantSupervisor = vi.fn(() => descendantSupervisor);
  const onData = vi.fn<(data: Buffer) => void>();
  const runner = new SandboxRunner(manager, runtime, {
    spawn,
    killProcess,
    platform: "darwin",
    createDescendantSupervisor,
    ...dependencies,
  } as never);

  return {
    runner,
    runtime,
    manager,
    child,
    violationStore,
    spawn,
    killProcess,
    descendantSupervisor,
    createDescendantSupervisor,
    onData,
    request(overrides: Partial<RunRequest> = {}): RunRequest {
      return {
        invocationId: "tool-1",
        command: "echo ok",
        commandText: "echo ok",
        cwd: "/work",
        env: { PATH: "/bin" },
        timeoutMs: 1_000,
        onData,
        ...overrides,
      };
    },
    async spawned(): Promise<void> {
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    },
  };
}

function readyRuntime(): RuntimeController {
  const runtime = new RuntimeController();
  runtime.beginInitialization();
  runtime.markReady({} as never);
  return runtime;
}

function deferWrap(harness: ReturnType<typeof createRunnerHarness>) {
  let resolve!: (descriptor: { argv: string[]; env: NodeJS.ProcessEnv }) => void;
  harness.manager.wrapWithSandboxArgv.mockImplementationOnce(() => new Promise((resolver) => {
    resolve = resolver;
  }));
  return {
    resolve: () => resolve({ argv: ["/sandbox", "wrapped"], env: {} }),
  };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
