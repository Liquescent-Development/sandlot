import { createBashToolDefinition, type BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSandlotBashOperations, createSandlotBashTool, createSandlotUserBashOperations } from "../../src/tools/bash.js";
import type { RunRequest, RunResult } from "../../src/runner.js";
import { RuntimeController } from "../../src/runtime.js";

describe("Sandlot bash adapters", () => {
  it("forwards a sandboxed bash command, Pi timeout, signal, stream callback, and sanitized environment to the runner", async () => {
    // Catches a production mutation that drops a BashOperations argument, uses the
    // host/Pi environment, or converts Pi's seconds timeout more than once.
    const harness = createHarness();
    const signal = new AbortController().signal;
    const onData = vi.fn();
    const operations = createSandlotBashOperations({ ...harness.dependencies, invocationId: () => "call-7" });

    await expect(operations.exec("printf ok", "/repo", {
      timeout: 2.5,
      signal,
      onData,
      env: { HOST_SECRET: "must-not-reach-runner" },
    })).resolves.toEqual({ exitCode: 7 });

    expect(harness.runner.run).toHaveBeenCalledWith({
      invocationId: "call-7",
      expectedGeneration: 1,
      command: "printf ok",
      commandText: "printf ok",
      cwd: "/repo",
      env: { PATH: "/sandbox/bin", LANG: "C" },
      timeoutMs: 2_500,
      signal,
      onData,
    });
  });

  it.each([
    [0, "Invalid timeout: must be a finite number of seconds"],
    [-1, "Invalid timeout: must be a finite number of seconds"],
    [Infinity, "Invalid timeout: must be a finite number of seconds"],
    [NaN, "Invalid timeout: must be a finite number of seconds"],
    [2_147_483.648, "Invalid timeout: maximum is 2147483.647 seconds"],
  ])("rejects invalid Pi timeout %s before calling the sandbox runner", async (timeout, message) => {
    // Catches accepting values that Pi rejects, which otherwise lets an
    // overlarge/invalid host timer reach the sandbox runner.
    const harness = createHarness();
    const operations = createSandlotBashOperations({ ...harness.dependencies, invocationId: () => "timeout-check" });

    await expect(operations.exec("printf timeout", "/repo", { timeout, onData: vi.fn() })).rejects.toThrow(message);

    expect(harness.runner.run).not.toHaveBeenCalled();
  });

  it("accepts Pi's exact maximum timeout and converts it once to milliseconds", async () => {
    // Catches off-by-one timer validation or a second seconds-to-milliseconds
    // conversion at the Sandlot runner boundary.
    const harness = createHarness();
    const operations = createSandlotBashOperations({ ...harness.dependencies, invocationId: () => "timeout-max" });

    await expect(operations.exec("printf timeout", "/repo", { timeout: 2_147_483.647, onData: vi.fn() }))
      .resolves.toEqual({ exitCode: 7 });

    expect(harness.runner.run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 2_147_483_647 }));
  });

  it("delegates registered bash calls through Pi's renderer and streams sandbox violations under the Pi tool-call ID", async () => {
    // Catches replacing Pi's tool factory or using a generated ID for registered
    // tool calls, which would lose Pi formatting or violation attribution.
    const harness = createHarness({
      run: async (request) => {
        request.onData?.(Buffer.from("stdout\n<sandbox_violations>\ndeny read /secret\n</sandbox_violations>"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const tool = createSandlotBashTool(harness.dependencies);
    const updates = vi.fn();

    await expect(tool.execute("call-7", { command: "printf ok", timeout: 3 }, undefined, updates, { cwd: "/repo" } as never))
      .resolves.toMatchObject({
        content: [{ type: "text", text: "stdout\n<sandbox_violations>\ndeny read /secret\n</sandbox_violations>" }],
      });

    expect(harness.runner.run).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: "call-7",
      command: "printf ok",
      cwd: "/repo",
      timeoutMs: 3_000,
    }));
    expect(updates).toHaveBeenCalledWith(expect.objectContaining({ content: [] }));
  });

  it("registers the same safe metadata and prompt guidance as Pi's no-session-environment bash definition", () => {
    // Catches registration through Pi's unsafe default options, which creates a
    // local backend and advertises PI_* session variables despite Sandlot's
    // environment boundary.
    const harness = createHarness();
    const safeOperations = createSandlotBashOperations({ ...harness.dependencies, invocationId: () => "registration" });
    const expected = createBashToolDefinition(process.cwd(), {
      operations: safeOperations,
      exposeSessionEnvironment: false,
    });
    const actual = createSandlotBashTool({ ...harness.dependencies, invocationId: () => "registration" });

    expect({
      name: actual.name,
      label: actual.label,
      description: actual.description,
      promptSnippet: actual.promptSnippet,
      promptGuidelines: actual.promptGuidelines,
      parameters: actual.parameters,
    }).toEqual({
      name: expected.name,
      label: expected.label,
      description: expected.description,
      promptSnippet: expected.promptSnippet,
      promptGuidelines: expected.promptGuidelines,
      parameters: expected.parameters,
    });
  });

  it("returns a nonzero runner exit code to Pi instead of treating it as a sandbox adapter failure", async () => {
    // Catches throwing on a nonzero runner result, which would bypass Pi's normal
    // status formatting and conflate command failures with sandbox failures.
    const harness = createHarness();
    const operations = createSandlotBashOperations({ ...harness.dependencies, invocationId: () => "call-9" });

    await expect(operations.exec("false", "/repo", { onData: vi.fn() })).resolves.toEqual({ exitCode: 7 });
  });

  it("preserves Pi-compatible timeout and abort errors from the sandbox runner", async () => {
    // Catches rewriting runner errors to adapter-specific text that Pi cannot map
    // to its established command timeout and abort messages.
    const timeoutHarness = createHarness({ run: async () => { throw new Error("timeout:2"); } });
    await expect(createSandlotBashTool(timeoutHarness.dependencies).execute(
      "timeout-call", { command: "sleep 9", timeout: 2 }, undefined, undefined, { cwd: "/repo" } as never,
    )).rejects.toThrow("Command timed out after 2 seconds");

    const abortHarness = createHarness({ run: async () => { throw new Error("aborted"); } });
    await expect(createSandlotBashTool(abortHarness.dependencies).execute(
      "abort-call", { command: "sleep 9" }, undefined, undefined, { cwd: "/repo" } as never,
    )).rejects.toThrow("Command aborted");
  });

  it("uses a UUID for enabled user_bash operations", async () => {
    // Catches reusing a tool-call ID (unavailable to user_bash) or a fixed ID,
    // which would allow active-invocation collisions in the runtime controller.
    const harness = createHarness();
    const operations = createSandlotUserBashOperations(harness.dependencies);

    await operations.exec("printf user-one", "/repo", { onData: vi.fn() });
    await operations.exec("printf user-two", "/repo", { onData: vi.fn() });

    const invocationIds = harness.runner.run.mock.calls.map(([request]) => request.invocationId);
    expect(invocationIds).toHaveLength(2);
    expect(invocationIds.every((id) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))).toBe(true);
    expect(invocationIds[0]).not.toBe(invocationIds[1]);
  });

  it("uses the deliberate local backend only when disabled by the user", async () => {
    // Catches widening the local fallback branch to an enabled runtime state.
    const local = localOperations(31);
    const harness = createHarness({ local });
    harness.runtime.beginShutdown();
    harness.runtime.finishShutdown();
    harness.runtime.markDisabled();

    await expect(createSandlotUserBashOperations(harness.dependencies).exec("printf local", "/repo", { onData: vi.fn() }))
      .resolves.toEqual({ exitCode: 31 });
    expect(local.exec).toHaveBeenCalledWith("printf local", "/repo", expect.objectContaining({ onData: expect.any(Function) }));
    expect(harness.runner.run).not.toHaveBeenCalled();
  });

  it("fails closed after initialization failure instead of invoking the local backend", async () => {
    // Catches treating a failed sandbox initialization like explicit opt-out.
    const local = localOperations(31);
    const harness = createHarness({ local });
    harness.runtime.beginShutdown();
    harness.runtime.finishShutdown();
    harness.runtime.beginInitialization();
    harness.runtime.markFailed(new Error("sandbox unavailable"));

    await expect(createSandlotUserBashOperations(harness.dependencies).exec("printf blocked", "/repo", { onData: vi.fn() }))
      .rejects.toThrow("Sandlot runtime is not ready (failed)");
    expect(local.exec).not.toHaveBeenCalled();
    expect(harness.runner.run).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  run?: (request: RunRequest) => Promise<RunResult>;
  local?: BashOperations;
} = {}) {
  const runtime = new RuntimeController();
  runtime.beginInitialization();
  runtime.markReady({} as never);
  const runner = { run: vi.fn(options.run ?? (async () => ({ exitCode: 7, stdout: "", stderr: "" }))) };
  const local = options.local ?? localOperations(0);
  return {
    runtime,
    runner,
    dependencies: {
      runner,
      runtime,
      environment: () => ({ PATH: "/sandbox/bin", LANG: "C" }),
      createLocalBashOperations: () => local,
    },
  };
}

function localOperations(exitCode: number): BashOperations {
  return { exec: vi.fn(async () => ({ exitCode })) };
}
