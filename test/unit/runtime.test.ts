import { describe, expect, it } from "vitest";
import { RuntimeController } from "../../src/runtime.js";

describe("RuntimeController", () => {
  it("rejects an invocation captured in an earlier ready generation", () => {
    // Catches ignoring a file call's captured generation at acquisition time,
    // which would allow a later worker operation to enter a replacement runtime.
    const runtime = readyRuntime();
    const capturedGeneration = runtime.snapshot().generation;
    runtime.beginShutdown();
    runtime.finishShutdown();
    runtime.beginInitialization();
    runtime.markReady({} as never);

    expect(() => runtime.acquire("old-file-call", capturedGeneration)).toThrow(/stale generation/i);
    expect(runtime.snapshot().activeInvocationIds).toEqual([]);
  });
  it("rejects work until ready and invalidates old leases", () => {
    const runtime = new RuntimeController();

    expect(() => runtime.acquire("call-1")).toThrow(/not ready/);

    runtime.beginInitialization();
    runtime.markReady({} as never);
    const lease = runtime.acquire("call-1");

    runtime.beginShutdown();

    expect(() => runtime.assertCurrent(lease)).toThrow(/stale generation/);
    expect(() => runtime.acquire("call-2")).toThrow(/not ready/);
  });

  it("advances generations monotonically for initialization and shutdown", () => {
    const runtime = new RuntimeController();

    expect(runtime.snapshot().generation).toBe(0);
    runtime.beginInitialization();
    expect(runtime.snapshot().generation).toBe(1);
    runtime.markReady({} as never);
    expect(runtime.snapshot().generation).toBe(1);
    runtime.beginShutdown();
    expect(runtime.snapshot().generation).toBe(2);
    runtime.finishShutdown();
    runtime.beginInitialization();
    expect(runtime.snapshot().generation).toBe(3);
  });

  it("rejects invalid transitions", () => {
    const runtime = new RuntimeController();

    expect(() => runtime.markReady({} as never)).toThrow(/Cannot mark ready/);
    expect(() => runtime.markFailed(new Error("boom"))).toThrow(/Cannot mark failed/);
    expect(() => runtime.finishShutdown()).toThrow(/Cannot finish shutdown/);

    runtime.beginInitialization();
    expect(() => runtime.beginInitialization()).toThrow(/Cannot begin initialization/);
    runtime.markReady({} as never);
    expect(() => runtime.markDisabled()).toThrow(/Cannot disable/);
  });

  it("rejects duplicate invocation IDs before abort registration", () => {
    const runtime = readyRuntime();

    runtime.acquire("call-1");

    expect(() => runtime.acquire("call-1")).toThrow(/Duplicate Sandlot invocation/);
  });

  it("keeps failed diagnostics and disabled state distinct", () => {
    const failed = new RuntimeController();
    failed.beginInitialization();
    failed.markFailed(new Error("sandbox dependency unavailable"));

    expect(failed.snapshot()).toMatchObject({
      state: "failed",
      error: "Error: sandbox dependency unavailable",
      policy: undefined,
    });
    expect(() => failed.acquire("call-1")).toThrow(/failed/);

    const disabled = new RuntimeController();
    disabled.markDisabled();

    expect(disabled.snapshot()).toMatchObject({
      state: "disabled-by-user",
      error: undefined,
      policy: undefined,
    });
    expect(() => disabled.acquire("call-1")).toThrow(/disabled-by-user/);
  });

  it("records an unrecoverable poisoned state without returning through idle", () => {
    const shuttingDown = readyRuntime();
    shuttingDown.beginShutdown();

    (shuttingDown as RuntimeController & { markPoisoned(error: unknown): void }).markPoisoned(new Error("reset failed"));

    expect(shuttingDown.snapshot()).toMatchObject({
      state: "failed",
      generation: 2,
      error: "Error: reset failed",
      policy: undefined,
    });
    expect(() => shuttingDown.beginInitialization()).toThrow(/failed/);

    const replacement = new RuntimeController();
    (replacement as RuntimeController & { markPoisoned(error: unknown): void }).markPoisoned("prior manager cleanup failed");
    expect(replacement.snapshot()).toMatchObject({
      state: "failed",
      generation: 1,
      error: "prior manager cleanup failed",
    });
  });

  it("aborts active and newly registered calls synchronously on shutdown", () => {
    const runtime = readyRuntime();
    const activeController = new AbortController();
    const lateController = new AbortController();

    const activeLease = runtime.acquire("active");
    runtime.registerAbort(activeLease, activeController);
    expect(() => runtime.registerAbort(activeLease, activeController)).not.toThrow();
    const lateLease = runtime.acquire("late");

    runtime.beginShutdown();
    runtime.registerAbort(lateLease, lateController);

    expect(activeController.signal.aborted).toBe(true);
    expect(lateController.signal.aborted).toBe(true);
    expect(() => runtime.acquire("new-call")).toThrow(/shutting-down/);
  });

  it("releases invocation ownership idempotently", () => {
    const runtime = readyRuntime();
    const lease = runtime.acquire("call-1");

    runtime.release(lease);
    runtime.release(lease);

    expect(() => runtime.acquire("call-1")).not.toThrow();
  });

  it("does not let a stale lease affect a replacement with the same invocation ID", () => {
    const runtime = readyRuntime();
    const staleLease = runtime.acquire("call-1");
    const staleController = new AbortController();

    runtime.release(staleLease);
    const currentLease = runtime.acquire("call-1");
    const currentController = new AbortController();

    expect(() => runtime.assertCurrent(staleLease)).toThrow(/stale generation/);
    runtime.release(staleLease);
    expect(() => runtime.assertCurrent(currentLease)).not.toThrow();
    expect(() => runtime.registerAbort(staleLease, staleController)).toThrow(/stale generation/);

    runtime.registerAbort(currentLease, currentController);
    runtime.beginShutdown();

    expect(staleController.signal.aborted).toBe(false);
    expect(currentController.signal.aborted).toBe(true);
    runtime.release(currentLease);
    runtime.release(currentLease);
  });

  it.each([
    [new Error(), "Error: Unknown Sandlot runtime initialization failure"],
    [new Error(" \n\t"), "Error: Unknown Sandlot runtime initialization failure"],
    [undefined, "Unknown Sandlot runtime initialization failure"],
    [{ unexpected: true }, "Unknown Sandlot runtime initialization failure"],
  ])("records an exact actionable failed diagnostic for %p", (failure, expected) => {
    const runtime = new RuntimeController();

    runtime.beginInitialization();
    runtime.markFailed(failure);

    expect(runtime.snapshot().error).toBe(expected);
  });

  it("returns immutable snapshots without exposing stored policy", () => {
    const runtime = new RuntimeController();
    const policy = { enabled: true, network: { allowedDomains: ["example.com"] } };

    runtime.beginInitialization();
    runtime.markReady(policy as never);
    policy.network.allowedDomains.push("changed-after-ready.example.com");
    const snapshot = runtime.snapshot();

    expect(snapshot).not.toBe(runtime.snapshot());
    expect(snapshot.policy).not.toBe(policy);
    expect(() => (snapshot.activeInvocationIds as string[]).push("forged")).toThrow();
    expect(() => ((snapshot.policy as { network: { allowedDomains: string[] } }).network.allowedDomains.push("evil.example.com"))).toThrow();
    expect(runtime.snapshot().activeInvocationIds).toEqual([]);
    expect((runtime.snapshot().policy as { network: { allowedDomains: string[] } }).network.allowedDomains).toEqual(["example.com"]);
  });
});

function readyRuntime(): RuntimeController {
  const runtime = new RuntimeController();
  runtime.beginInitialization();
  runtime.markReady({} as never);
  return runtime;
}
