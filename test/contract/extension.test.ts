import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { FileWorkerClient } from "../../src/helpers/file-worker.js";
import { SearchWorkerClient } from "../../src/helpers/search-worker.js";
import {
  createSandlotExtension,
  resolveExtensionTrustPaths,
  type ExtensionDependencies,
} from "../../src/index.js";
import type { EffectivePolicy } from "../../src/policy.js";
import { RuntimeController } from "../../src/runtime.js";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ENTRY_PATH = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const PROTECTED_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];
const PI_IMAGE_MODULES = [
  "image-process.js",
  "image-convert.js",
  "image-resize.js",
  "image-resize-core.js",
  "image-resize-worker.js",
  "exif-orientation.js",
  "photon.js",
];

describe("Sandlot extension contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers the complete surface without starting session resources", () => {
    const harness = createHarness();

    harness.extension(harness.pi.api);

    expect([...harness.pi.tools.keys()].sort()).toEqual(PROTECTED_NAMES);
    expect([...harness.pi.commands.keys()].sort()).toEqual(["sandlot", "sandlot-reload"]);
    expect([...harness.pi.handlers.keys()].sort()).toEqual([
      "session_shutdown",
      "session_start",
      "tool_call",
      "user_bash",
    ]);
    expect(harness.manager.checkDependenciesAsync).not.toHaveBeenCalled();
    expect(harness.manager.initialize).not.toHaveBeenCalled();
    expect(harness.manager.reset).not.toHaveBeenCalled();
    expect(harness.runner.run).not.toHaveBeenCalled();
  });

  it("initializes a trusted session fail-closed, monitors violations, and verifies the live registry", async () => {
    const harness = createHarness();
    const ctx = createContext({ trusted: true });
    harness.loadPolicyFiles.mockImplementation(async (options: unknown) => {
      expect(harness.runtime.snapshot().state).toBe("initializing");
      expect(options).toEqual({ cwd: "/workspace", projectTrusted: true });
      return { user: { enabled: true }, project: { trustedCustomTools: ["safe-tool"] } };
    });
    harness.manager.checkDependenciesAsync.mockImplementation(async () => {
      expect(harness.runtime.snapshot().state).toBe("initializing");
      return { warnings: ["optional diagnostic warning"], errors: [] };
    });
    harness.manager.initialize.mockImplementation(async (_config: unknown, ask: unknown, monitor: boolean) => {
      expect(harness.runtime.snapshot().state).toBe("initializing");
      expect(harness.imageProcessor.bind).toHaveBeenCalledWith("/trusted/image-process");
      expect(ask).toBeUndefined();
      expect(monitor).toBe(true);
    });
    harness.pi.onGetAllTools = () => harness.pi.toolInfo();
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);

    expect(harness.composePolicy).toHaveBeenCalledWith(
      { enabled: true },
      { trustedCustomTools: ["safe-tool"] },
      { cwd: "/workspace" },
    );
    expect(harness.resolveWorkerPaths).toHaveBeenCalledWith(harness.effective, [ENTRY_PATH]);
    expect(harness.manager.checkDependenciesAsync).toHaveBeenCalledWith({ command: "/trusted/rg" });
    expect(harness.manager.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        filesystem: expect.objectContaining({
          allowRead: [
            "/workspace",
            "/trusted/node",
            "/trusted/file-worker",
            "/trusted/protocol",
            "/trusted/package.json",
            "/trusted/search-worker",
            "/trusted/rg",
            "/trusted/mktemp",
          ],
          denyWrite: [
            "/trusted/entry",
            "/trusted/node",
            "/trusted/file-worker",
            "/trusted/protocol",
            "/trusted/package.json",
            "/trusted/search-worker",
            "/trusted/rg",
            "/trusted/mktemp",
          ],
        }),
      }),
      undefined,
      true,
      "filtered",
    );
    expect(harness.runtime.snapshot()).toMatchObject({ state: "ready", generation: 1, error: undefined });
    expect(harness.imageProcessor.bind).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("sandlot", "🔒 Sandlot");
  });

  it("stages the complete composed config before dependency preflight", async () => {
    const harness = createHarness();
    const policy = { ...harness.effective, bwrapPath: "/trusted/bwrap", socatPath: "/trusted/socat" };
    let staged: unknown;
    harness.composePolicy.mockResolvedValue(policy);
    harness.manager.updateConfig.mockImplementation((config: unknown) => { staged = config; });
    harness.manager.checkDependenciesAsync.mockImplementation(async () => {
      expect(staged).toMatchObject({
        bwrapPath: "/trusted/bwrap",
        socatPath: "/trusted/socat",
        filesystem: { denyWrite: expect.arrayContaining(["/trusted/bwrap", "/trusted/socat"]) },
      });
      return { warnings: [], errors: [] };
    });
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.runtime.snapshot().state).toBe("ready");
    expect(harness.manager.updateConfig.mock.invocationCallOrder[0])
      .toBeLessThan(harness.manager.checkDependenciesAsync.mock.invocationCallOrder[0] as number);
  });

  it("opens the isolated runtime boundary in the invocation root before any Sandbox Runtime work", async () => {
    const harness = createHarness();
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.manager.open).toHaveBeenCalledWith("/workspace");
    expect(harness.manager.open.mock.invocationCallOrder[0])
      .toBeLessThan(harness.manager.updateConfig.mock.invocationCallOrder[0] as number);
  });

  it("sends the trusted effective mode rather than inferring unrestricted access from SRT config", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.toSandboxRuntimeConfig).mockReturnValue({
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: false },
      filesystem: harness.effective.filesystem,
    });
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.manager.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ network: expect.objectContaining({ strictAllowlist: false }) }),
      undefined,
      true,
      "filtered",
    );
  });

  it("threads a trusted unrestricted effective mode into staging and initialization", async () => {
    const harness = createHarness();
    const unrestricted = {
      ...harness.effective,
      networkMode: "unrestricted" as const,
      network: { ...harness.effective.network, allowedDomains: [], deniedDomains: [], strictAllowlist: false },
    };
    harness.composePolicy.mockResolvedValue(unrestricted);
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.manager.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ network: expect.objectContaining({ strictAllowlist: false }) }),
      "unrestricted",
    );
    expect(harness.manager.initialize).toHaveBeenCalledWith(expect.anything(), undefined, true, "unrestricted");
  });

  it("closes an opened runtime boundary when preflight fails", async () => {
    const harness = createHarness();
    harness.manager.updateConfig.mockRejectedValueOnce(new Error("staging failed"));
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.manager.open).toHaveBeenCalledOnce();
    expect(harness.manager.reset).toHaveBeenCalledOnce();
    expect(harness.processState.managerActive).toBe(false);
    expect(harness.runtime.snapshot().state).toBe("failed");
  });

  it("retries retained open-failure cleanup during startup and shutdown", async () => {
    const harness = createHarness();
    let retainedCleanupAuthority = false;
    harness.manager.open.mockImplementationOnce(async () => {
      retainedCleanupAuthority = true;
      throw new Error("literal open failure with retained cleanup authority");
    });
    harness.manager.reset
      .mockImplementationOnce(async () => {
        expect(retainedCleanupAuthority).toBe(true);
        throw new Error("literal startup cleanup retry failure");
      })
      .mockImplementationOnce(async () => {
        expect(retainedCleanupAuthority).toBe(true);
        retainedCleanupAuthority = false;
      });
    harness.extension(harness.pi.api);
    const ctx = createContext();

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);

    expect(harness.manager.reset).toHaveBeenCalledOnce();
    expect(retainedCleanupAuthority).toBe(true);
    expect(harness.processState.managerActive).toBe(true);
    expect(harness.processState.poisonedError).toMatch(/literal startup cleanup retry failure/);

    await harness.pi.emit("session_shutdown", { type: "session_shutdown", reason: "shutdown" }, ctx.value);

    expect(harness.manager.reset).toHaveBeenCalledTimes(2);
    expect(retainedCleanupAuthority).toBe(false);
    expect(harness.processState.managerActive).toBe(false);
  });

  it("fails closed when platform policy validation rejects before dependency discovery", async () => {
    const harness = createHarness({ platform: "linux" });
    harness.validatePolicyForPlatform.mockRejectedValue(new Error("Linux filesystem.allowWrite glob is unsupported"));
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.validatePolicyForPlatform).toHaveBeenCalledWith(harness.effective, "linux", process.arch);
    expect(harness.runtime.snapshot()).toMatchObject({ state: "failed" });
    expect(harness.resolveWorkerPaths).not.toHaveBeenCalled();
    expect(harness.manager.initialize).not.toHaveBeenCalled();
  });

  it("treats a missing Linux seccomp helper as fatal when Unix sockets are denied", async () => {
    const harness = createHarness({ platform: "linux" });
    harness.manager.checkDependenciesAsync.mockResolvedValue({
      warnings: ["seccomp not available - unix socket access not restricted"],
      errors: [],
    });
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.runtime.snapshot()).toMatchObject({ state: "failed" });
    expect(harness.manager.initialize).not.toHaveBeenCalled();
  });

  it("fails closed on Sandbox Runtime Linux glob warnings", async () => {
    const harness = createHarness({ platform: "linux" });
    harness.manager.getLinuxGlobPatternWarnings.mockResolvedValue([
      "Skipping glob pattern on Linux/WSL: /workspace/**",
    ]);
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.runtime.snapshot().state).toBe("failed");
    expect(harness.manager.initialize).not.toHaveBeenCalled();
  });

  it("passes Pi's live lexical entry spelling into trust resolution before ready", async () => {
    const harness = createHarness();
    const replaceableAlias = "/workspace/extensions/sandlot/dist/index.js";
    harness.extension(harness.pi.api);
    for (const name of PROTECTED_NAMES) harness.pi.overrideToolSource(name, replaceableAlias);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.resolveWorkerPaths).toHaveBeenCalledWith(harness.effective, [replaceableAlias]);
  });

  it("routes the composed canonical ripgrep command into the live search client", async () => {
    const harness = createHarness({ rgPath: process.execPath });
    harness.extension(harness.pi.api);
    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);
    harness.runner.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ version: 1, ok: true, value: { matches: [], matchLimitReached: false } }),
      stderr: "",
    });

    await harness.searchClient.grep({
      cwd: "/workspace",
      pattern: "x",
      ignoreCase: false,
      literal: false,
      context: 0,
      limit: 1,
    }, {
      expectedGeneration: 1,
      signal: undefined,
      nextInvocationId: () => "configured-rg",
    });

    const request = harness.runner.run.mock.calls.at(-1)?.[0] as { env: NodeJS.ProcessEnv };
    expect(request.env.SANDLOT_SEARCH_RG_PATH).toBe(await realpath(process.execPath));
  });

  it("stages the production-discovered absolute ripgrep command for SRT scans", async () => {
    const harness = createHarness({ rgPath: "/trusted/discovered-rg" });
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.manager.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      ripgrep: expect.objectContaining({ command: "/trusted/discovered-rg" }),
    }), "filtered");
    expect(harness.manager.checkDependenciesAsync).toHaveBeenCalledWith(expect.objectContaining({
      command: "/trusted/discovered-rg",
    }));
  });

  it("stages the installed seccomp helper and read-grants it before Linux initialization", async () => {
    const harness = createHarness({ platform: "linux", seccompApplyPath: "/trusted/apply-seccomp" });
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.manager.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      seccomp: expect.objectContaining({ applyPath: "/trusted/apply-seccomp" }),
      filesystem: expect.objectContaining({
        allowRead: expect.arrayContaining(["/trusted/apply-seccomp"]),
        denyWrite: expect.arrayContaining(["/trusted/apply-seccomp"]),
      }),
    }), "filtered");
  });

  it("does not load project policy when Pi has not trusted the project", async () => {
    const harness = createHarness();
    harness.extension(harness.pi.api);

    await harness.pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      createContext({ trusted: false }).value,
    );

    expect(harness.loadPolicyFiles).toHaveBeenCalledWith({ cwd: "/workspace", projectTrusted: false });
    expect(harness.composePolicy).toHaveBeenCalledWith({ enabled: true }, undefined, { cwd: "/workspace" });
  });

  it("retains redacted diagnostics and blocks tools and user bash after initialization failure", async () => {
    const harness = createHarness();
    const ctx = createContext();
    const sensitive = "ripgrep (/opt/local/bin/rg) not found; AWS_SECRET_ACCESS_KEY=value; https://user:pass@example.com/token\u0000tail";
    harness.manager.initialize.mockRejectedValue(new Error(sensitive));
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);

    expect(harness.runtime.snapshot()).toMatchObject({ state: "failed", generation: 1 });
    const blocked = await harness.pi.emit(
      "tool_call",
      { type: "tool_call", toolName: "read", toolCallId: "call-1", input: { path: "x" } },
      ctx.value,
    );
    expect(blocked).toEqual({ block: true, reason: "Sandlot is failed" });
    const userBash = await harness.pi.emit(
      "user_bash",
      { type: "user_bash", command: "pwd", excludeFromContext: false, cwd: "/workspace" },
      ctx.value,
    );
    expect(userBash).toEqual({
      result: {
        output: "Sandlot blocked local shell execution because the runtime is failed. Run /sandlot for diagnostics.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "ripgrep (<path>) not found; AWS_SECRET_ACCESS_KEY=<redacted>; https://<redacted>@example.com/token tail",
      "error",
    );
    await harness.pi.command("sandlot", ctx.commandValue);
    const diagnostic = ctx.ui.notify.mock.calls.at(-1)?.[0] as string;
    expect(diagnostic).toContain("state: failed");
    expect(diagnostic).toContain(
      "error: Error: ripgrep (<path>) not found; AWS_SECRET_ACCESS_KEY=<redacted>; https://<redacted>@example.com/token tail",
    );
    expect(diagnostic).not.toContain("/opt/local/bin/rg");
    expect(diagnostic).not.toContain("AWS_SECRET_ACCESS_KEY=value");
    expect(diagnostic).not.toContain("user:pass");
    expect(diagnostic).not.toContain("\u0000");
  });

  it("resets Sandbox Runtime when live ownership fails after initialize", async () => {
    const harness = createHarness();
    harness.extension(harness.pi.api);
    harness.pi.overrideToolSource("read", "/tmp/replaced-read.ts");

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    expect(harness.manager.initialize).toHaveBeenCalledTimes(1);
    expect(harness.manager.reset).toHaveBeenCalledTimes(1);
    expect(harness.runtime.snapshot()).toMatchObject({ state: "failed" });
    expect(harness.processState.managerActive).toBe(false);
  });

  it("clears process-global violations across replacement sessions even when command IDs repeat", async () => {
    const harness = createHarness();
    const ctx = createContext();
    const encoded = Buffer.from("repeat-id").toString("base64");
    harness.violationStore.addViolation({
      line: "old session violation",
      encodedCommand: encoded,
      command: "repeat-id",
      timestamp: new Date(),
    } as never);
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);
    expect(harness.violationStore.getViolationsForCommand("repeat-id")).toEqual([]);
    harness.violationStore.addViolation({
      line: "current session violation",
      encodedCommand: encoded,
      command: "repeat-id",
      timestamp: new Date(),
    } as never);
    await harness.pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx.value);
    expect(harness.violationStore.getViolationsForCommand("repeat-id")).toEqual([]);
    await harness.pi.emit("session_start", { type: "session_start", reason: "reload" }, ctx.value);
    expect(harness.violationStore.getViolations()).toEqual([]);
  });

  it("clears process-global violations even when shutdown arrives while idle", async () => {
    const harness = createHarness();
    harness.violationStore.addViolation({
      line: "orphaned violation",
      encodedCommand: Buffer.from("orphan").toString("base64"),
      command: "orphan",
      timestamp: new Date(),
    } as never);
    harness.extension(harness.pi.api);

    await harness.pi.emit(
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      createContext().value,
    );

    expect(harness.violationStore.getViolations()).toEqual([]);
  });

  it("clears violations emitted while active commands and monitors are being torn down", async () => {
    const harness = createHarness();
    const ctx = createContext();
    harness.manager.reset.mockImplementation(async () => {
      harness.violationStore.addViolation({
        line: "late teardown violation",
        encodedCommand: Buffer.from("repeat-id").toString("base64"),
        command: "repeat-id",
        timestamp: new Date(),
      } as never);
    });
    harness.extension(harness.pi.api);
    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);

    await harness.pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx.value);

    expect(harness.violationStore.getViolationsForCommand("repeat-id")).toEqual([]);
  });

  it("terminates and awaits active host image workers before resetting the sandbox boundary", async () => {
    const harness = createHarness();
    harness.extension(harness.pi.api);
    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext().value);

    await harness.pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, createContext().value);

    expect(harness.imageProcessor.abortAll).toHaveBeenCalledOnce();
    expect(harness.imageProcessor.abortAll.mock.invocationCallOrder[0])
      .toBeLessThan(harness.manager.reset.mock.invocationCallOrder[0] as number);
  });

  it("awaits runner-owned execution termination before resetting on reload", async () => {
    const harness = createHarness();
    let confirmRunnerTermination!: () => void;
    harness.runner.abortAll.mockImplementationOnce(
      () => new Promise<void>((resolve) => { confirmRunnerTermination = resolve; }),
    );
    harness.extension(harness.pi.api);
    const ctx = createContext();
    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);

    const shuttingDown = harness.pi.emit(
      "session_shutdown",
      { type: "session_shutdown", reason: "reload" },
      ctx.value,
    );
    await vi.waitFor(() => expect(harness.runner.abortAll).toHaveBeenCalledOnce());

    expect(harness.manager.reset).not.toHaveBeenCalled();
    confirmRunnerTermination();
    await shuttingDown;

    expect(harness.manager.reset).toHaveBeenCalledOnce();
    expect(harness.runtime.snapshot().state).toBe("idle");
  });

  it("poisons the process after cleanup failure and blocks a swallowed replacement start", async () => {
    const harness = createHarness();
    const ctx = createContext();
    harness.extension(harness.pi.api);
    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);
    const loadCount = harness.loadPolicyFiles.mock.calls.length;
    const initializeCount = harness.manager.initialize.mock.calls.length;
    harness.manager.reset.mockRejectedValueOnce(new Error("proxy close failed"));

    await expect(harness.pi.emit(
      "session_shutdown",
      { type: "session_shutdown", reason: "reload" },
      ctx.value,
    )).rejects.toThrow("proxy close failed");
    expect(harness.runtime.snapshot()).toMatchObject({ state: "failed", error: expect.stringMatching(/proxy close failed/) });
    expect(harness.processState.poisonedError).toMatch(/proxy close failed/);

    // Pi logs/swallow lifecycle exceptions; a subsequent start must still fail closed.
    await harness.pi.emit("session_start", { type: "session_start", reason: "reload" }, ctx.value);
    expect(harness.runtime.snapshot().state).toBe("failed");
    expect(harness.loadPolicyFiles).toHaveBeenCalledTimes(loadCount);
    expect(harness.manager.initialize).toHaveBeenCalledTimes(initializeCount);
    const bash = await harness.pi.emit(
      "user_bash",
      { type: "user_bash", command: "pwd", excludeFromContext: false, cwd: "/workspace" },
      ctx.value,
    );
    expect(bash).toMatchObject({ result: { exitCode: 1 } });
  });

  it("rejects unsupported platforms before dependency checks and remains fail-closed", async () => {
    const harness = createHarness({ platform: "win32" });
    const ctx = createContext();
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);

    expect(harness.runtime.snapshot()).toMatchObject({ state: "failed" });
    expect(harness.manager.checkDependenciesAsync).not.toHaveBeenCalled();
    expect(harness.manager.initialize).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Sandlot supports macOS and Linux only (detected win32).", "error");
  });

  it("makes explicit user disable conspicuous and selects the local backend only in that state", async () => {
    const harness = createHarness({ enabled: false });
    const ctx = createContext();
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);

    expect(harness.runtime.snapshot().state).toBe("disabled-by-user");
    expect(harness.manager.checkDependenciesAsync).not.toHaveBeenCalled();
    expect(harness.manager.initialize).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("sandlot", "🔓 Sandlot disabled");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Sandlot is disabled by trusted user policy; protected operations will run locally.",
      "warning",
    );

    const routed = await harness.pi.emit(
      "user_bash",
      { type: "user_bash", command: "pwd", excludeFromContext: false, cwd: "/workspace" },
      ctx.value,
    ) as { operations: { exec: (...args: unknown[]) => Promise<{ exitCode: number }> } };
    expect(routed.operations).toBeDefined();
    await routed.operations.exec("pwd", "/workspace", {});
    expect(harness.localExec).toHaveBeenCalledTimes(1);
    expect(harness.runner.run).not.toHaveBeenCalled();
  });

  it("never leaves user bash to Pi local fallback in enabled non-ready states", async () => {
    const harness = createHarness();
    const ctx = createContext();
    harness.extension(harness.pi.api);

    for (const state of ["idle", "initializing", "failed"] as const) {
      if (state === "initializing") harness.runtime.beginInitialization();
      if (state === "failed") harness.runtime.markFailed(new Error("failed"));
      const routed = await harness.pi.emit(
        "user_bash",
        { type: "user_bash", command: "pwd", excludeFromContext: false, cwd: "/workspace" },
        ctx.value,
      );
      expect(routed).toMatchObject({ result: { exitCode: 1, cancelled: false, truncated: false } });
    }
    expect(harness.localExec).not.toHaveBeenCalled();
  });

  it("consults the live registry so a post-start protected-tool replacement is blocked", async () => {
    const harness = createHarness();
    const ctx = createContext();
    harness.extension(harness.pi.api);
    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);
    harness.pi.overrideToolSource("read", "/tmp/host-read.ts");

    const result = await harness.pi.emit(
      "tool_call",
      { type: "tool_call", toolName: "read", toolCallId: "call-2", input: { path: "x" } },
      ctx.value,
    );

    expect(result).toEqual({ block: true, reason: "Sandlot ownership check failed for read" });
  });

  it("invalidates the generation before abort/reset and gives replacement events fresh generations", async () => {
    const harness = createHarness();
    const ctx = createContext();
    const observations: Array<{ phase: string; state: string; generation: number }> = [];
    harness.runner.abortAll.mockImplementation(async () => {
      const snapshot = harness.runtime.snapshot();
      observations.push({ phase: "abort", state: snapshot.state, generation: snapshot.generation });
    });
    harness.manager.reset.mockImplementation(async () => {
      const snapshot = harness.runtime.snapshot();
      observations.push({ phase: "reset", state: snapshot.state, generation: snapshot.generation });
    });
    harness.extension(harness.pi.api);

    const generations: number[] = [];
    for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
      await harness.pi.emit("session_start", { type: "session_start", reason }, ctx.value);
      generations.push(harness.runtime.snapshot().generation);
      await harness.pi.emit("session_shutdown", { type: "session_shutdown", reason: reason === "startup" ? "reload" : reason }, ctx.value);
      expect(harness.runtime.snapshot().state).toBe("idle");
    }

    expect(generations).toEqual([1, 3, 5, 7, 9]);
    expect(observations).toEqual([
      { phase: "abort", state: "shutting-down", generation: 2 },
      { phase: "reset", state: "shutting-down", generation: 2 },
      { phase: "abort", state: "shutting-down", generation: 4 },
      { phase: "reset", state: "shutting-down", generation: 4 },
      { phase: "abort", state: "shutting-down", generation: 6 },
      { phase: "reset", state: "shutting-down", generation: 6 },
      { phase: "abort", state: "shutting-down", generation: 8 },
      { phase: "reset", state: "shutting-down", generation: 8 },
      { phase: "abort", state: "shutting-down", generation: 10 },
      { phase: "reset", state: "shutting-down", generation: 10 },
    ]);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("sandlot", undefined);
  });

  it("reports diagnostics on stderr without calling UI APIs when UI is unavailable", async () => {
    const harness = createHarness();
    const ctx = createContext({ hasUI: false });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    harness.extension(harness.pi.api);

    await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);
    await harness.pi.command("sandlot", ctx.commandValue);
    await harness.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.value);

    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Sandlot diagnostics"));
  });

  it("reports graph-resolution failures through redacted diagnostics", async () => {
    const harness = createHarness();
    const ctx = createContext();
    harness.resolveImageGraph.mockImplementation(() => {
      throw new Error("graph failed at file:///Users/alice/private/image.js with API_TOKEN=secret-value");
    });
    harness.extension(harness.pi.api);

    await expect(harness.pi.command("sandlot", ctx.commandValue, "graph")).resolves.toBeUndefined();

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Sandlot image graph validation failed: graph failed at file://<path> with API_TOKEN=<redacted>",
      "error",
    );
  });

  it("awaits Pi reload through the registered command", async () => {
    const harness = createHarness();
    const ctx = createContext();
    let finished = false;
    ctx.reload.mockImplementation(async () => {
      await Promise.resolve();
      finished = true;
    });
    harness.extension(harness.pi.api);

    await harness.pi.command("sandlot-reload", ctx.commandValue);

    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(finished).toBe(true);
  });

  it("resolves the minimal worker load graph and immutable local-install module roots", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "sandlot-trust-")));
    try {
      const packageRoot = join(temporary, "local-install");
      const dist = join(packageRoot, "dist");
      const piRoot = join(temporary, "pi");
      const photonRoot = join(piRoot, "node_modules", "@silvia-odwyer", "photon-node");
      const runtimeModulesRoot = join(temporary, "runtime", "node_modules");
      const sandboxRuntimeRoot = join(runtimeModulesRoot, "@anthropic-ai", "sandbox-runtime");
      const zodRoot = join(runtimeModulesRoot, "zod");
      const modulePaths = [
        "index.js", "config.js", "diagnostics.js", "environment.js", "guard.js", "paths.js", "policy.js",
        "runner.js", "runtime.js", "sandbox-runtime-boundary.js", "helpers/file-worker.js", "helpers/image-worker.js", "helpers/protocol.js",
        "helpers/sandbox-runtime-service.js", "helpers/search-worker.js",
        "tools/bash.js", "tools/files.js", "tools/index.js", "tools/search.js", "trust.js", "violations.js",
      ];
      await Promise.all([
        mkdir(join(dist, "helpers"), { recursive: true }),
        mkdir(join(dist, "tools"), { recursive: true }),
        mkdir(join(temporary, "bin"), { recursive: true }),
        mkdir(join(piRoot, "dist", "utils"), { recursive: true }),
        mkdir(photonRoot, { recursive: true }),
        mkdir(join(sandboxRuntimeRoot, "dist"), { recursive: true }),
        mkdir(zodRoot, { recursive: true }),
        mkdir(join(temporary, "workspace"), { recursive: true }),
      ]);
      await Promise.all([
        ...modulePaths.map(async (path) => writeFile(join(dist, path), "export {};")),
        writeFile(join(packageRoot, "package.json"), '{"type":"module"}'),
        writeFile(join(temporary, "bin", "node"), "node"),
        writeFile(join(temporary, "bin", "rg"), "rg"),
        writeFile(join(temporary, "bin", "mktemp"), "mktemp"),
        writeFile(join(piRoot, "package.json"), '{"name":"@earendil-works/pi-coding-agent","version":"0.84.2","type":"module"}'),
        ...PI_IMAGE_MODULES.map((name) => writeFile(join(piRoot, "dist", "utils", name), "export {};")),
        writeFile(join(photonRoot, "package.json"), '{"name":"@silvia-odwyer/photon-node","version":"0.3.4","main":"photon_rs.js"}'),
        writeFile(join(photonRoot, "photon_rs.js"), "module.exports = {};"),
        writeFile(join(photonRoot, "photon_rs_bg.wasm"), "wasm"),
        writeFile(join(sandboxRuntimeRoot, "package.json"), '{"name":"@anthropic-ai/sandbox-runtime","version":"0.0.73","type":"module","main":"dist/index.js","dependencies":{"zod":"3.25.76"}}'),
        writeFile(join(sandboxRuntimeRoot, "dist", "index.js"), "export {};"),
        writeFile(join(zodRoot, "package.json"), '{"name":"zod","version":"3.25.76","type":"module","main":"index.js"}'),
        writeFile(join(zodRoot, "index.js"), "export {};"),
      ]);

      const resolved = await resolveExtensionTrustPaths({
        entryPath: join(dist, "index.js"),
        nodePath: join(temporary, "bin", "node"),
        fileWorkerPath: join(dist, "helpers", "file-worker.js"),
        searchWorkerPath: join(dist, "helpers", "search-worker.js"),
        rgPath: join(temporary, "bin", "rg"),
        sandboxRuntimeEntryPath: join(sandboxRuntimeRoot, "dist", "index.js"),
        piImageProcessorPath: join(piRoot, "dist", "utils", "image-process.js"),
        photonEntryPath: join(photonRoot, "photon_rs.js"),
        photonWasmPath: join(photonRoot, "photon_rs_bg.wasm"),
        allowWritePaths: [join(temporary, "workspace")],
        additionalExecutablePaths: [join(temporary, "bin", "mktemp")],
      });

      expect(resolved.trustedReadPaths).toEqual([
        join(temporary, "bin", "node"),
        join(dist, "helpers", "file-worker.js"),
        join(dist, "helpers", "protocol.js"),
        join(packageRoot, "package.json"),
        join(dist, "helpers", "search-worker.js"),
        join(temporary, "bin", "rg"),
        join(temporary, "bin", "mktemp"),
      ]);
      expect(resolved.immutablePaths).toEqual([
        ...modulePaths.map((path) => join(dist, path)),
        packageRoot,
        join(packageRoot, "package.json"),
        join(temporary, "bin", "node"),
        join(temporary, "bin", "rg"),
        join(temporary, "bin", "mktemp"),
        sandboxRuntimeRoot,
        zodRoot,
        join(sandboxRuntimeRoot, "package.json"),
        join(zodRoot, "package.json"),
        piRoot,
        ...PI_IMAGE_MODULES.map((name) => join(piRoot, "dist", "utils", name)),
        join(piRoot, "package.json"),
        photonRoot,
        join(photonRoot, "photon_rs.js"),
        join(photonRoot, "photon_rs_bg.wasm"),
        join(photonRoot, "package.json"),
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("fails before ready when the pinned Pi image processor is absent", async () => {
    const fixture = await createTrustFixture();
    try {
      await rm(fixture.piImageProcessorPath);

      await expect(resolveExtensionTrustPaths(fixture.input())).rejects.toThrow(
        /pinned Pi image processor.*unavailable|reinstall.*pi-coding-agent/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a host Pi image graph from any version other than the pinned 0.84.2", async () => {
    const fixture = await createTrustFixture();
    try {
      await writeFile(
        join(fixture.piRoot, "package.json"),
        '{"name":"@earendil-works/pi-coding-agent","version":"0.84.1","type":"module"}',
      );

      await expect(resolveExtensionTrustPaths(fixture.input())).rejects.toThrow(
        /Pi package.*version.*0\.84\.2|pinned Pi.*0\.84\.2/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a writable hoisted Sandbox Runtime transitive dependency", async () => {
    const fixture = await createTrustFixture();
    try {
      await expect(resolveExtensionTrustPaths(fixture.input({
        allowWritePaths: [fixture.zodRoot],
      }))).rejects.toThrow(/Sandbox Runtime|trusted host code.*immutable|zod.*allowWrite/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("resolves and protects the installed architecture-specific seccomp helper on Linux", async () => {
    const fixture = await createTrustFixture();
    const helper = join(fixture.sandboxRuntimeRoot, "vendor", "seccomp", "x64", "apply-seccomp");
    try {
      await mkdir(join(fixture.sandboxRuntimeRoot, "vendor", "seccomp", "x64"), { recursive: true });
      await writeFile(helper, "seccomp");
      await chmod(helper, 0o755);

      const resolved = await resolveExtensionTrustPaths(fixture.input({ platform: "linux", arch: "x64" }));

      expect(resolved.seccompApplyPath).toBe(helper);
      expect(resolved.trustedReadPaths).toContain(helper);
      expect(resolved.immutablePaths).toContain(helper);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed when the installed Linux seccomp helper is absent", async () => {
    const fixture = await createTrustFixture();
    try {
      await expect(resolveExtensionTrustPaths(fixture.input({ platform: "linux", arch: "x64" })))
        .rejects.toThrow(/seccomp helper.*unavailable|apply-seccomp/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("pins Linux bubblewrap and socat to canonical executable paths without PATH lookup", async () => {
    const fixture = await createTrustFixture();
    const helper = join(fixture.sandboxRuntimeRoot, "vendor", "seccomp", "x64", "apply-seccomp");
    try {
      await mkdir(join(fixture.sandboxRuntimeRoot, "vendor", "seccomp", "x64"), { recursive: true });
      await writeFile(helper, "seccomp");
      await chmod(helper, 0o755);

      const resolved = await resolveExtensionTrustPaths(fixture.input({ platform: "linux", arch: "x64" }));

      expect(resolved.bwrapPath).toBe(fixture.bwrapPath);
      expect(resolved.socatPath).toBe(fixture.socatPath);
      expect(resolved.immutablePaths).toEqual(expect.arrayContaining([fixture.bwrapPath, fixture.socatPath]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails before ready when a delayed Pi image worker module is absent", async () => {
    const fixture = await createTrustFixture();
    try {
      await rm(join(fixture.piRoot, "dist", "utils", "image-resize-worker.js"));

      await expect(resolveExtensionTrustPaths(fixture.input())).rejects.toThrow(
        /pinned Pi image pipeline module.*unavailable/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a Pi image graph member whose canonical target is writable", async () => {
    const fixture = await createTrustFixture();
    try {
      const graphMember = join(fixture.piRoot, "dist", "utils", "image-resize-worker.js");
      const writableTarget = join(fixture.workspace, "worker.js");
      await rm(graphMember);
      await writeFile(writableTarget, "export {};");
      await symlink(writableTarget, graphMember);

      await expect(resolveExtensionTrustPaths(fixture.input())).rejects.toThrow(
        /Pi image.*(outside|escape).*package|trusted.*writable|immutable.*allowWrite/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a relocated Pi resize importer whose actual worker edge reaches writable data", async () => {
    const fixture = await createTrustFixture();
    try {
      const utilsRoot = join(fixture.piRoot, "dist", "utils");
      const relocatedRoot = join(utilsRoot, "alt");
      const resizeAlias = join(utilsRoot, "image-resize.js");
      const relocatedResize = join(relocatedRoot, "image-resize.js");
      const relocatedWorker = join(relocatedRoot, "image-resize-worker.js");
      const writableWorker = join(fixture.workspace, "image-resize-worker.js");
      await mkdir(relocatedRoot);
      await rm(resizeAlias);
      await Promise.all([
        writeFile(relocatedResize, "export {};"),
        writeFile(writableWorker, "export {};"),
      ]);
      await Promise.all([
        symlink(relocatedResize, resizeAlias),
        symlink(writableWorker, relocatedWorker),
      ]);

      const canonicalResize = await realpath(resizeAlias);
      const actualWorkerEdge = fileURLToPath(new URL("./image-resize-worker.js", pathToFileURL(canonicalResize)));
      expect(await realpath(actualWorkerEdge)).toBe(writableWorker);

      await expect(resolveExtensionTrustPaths(fixture.input())).rejects.toThrow(
        /Pi image.*(canonical|relocat|symlink)|graph.*edge/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects relocated Pi photon code whose bare package edge resolves from a writable package", async () => {
    const fixture = await createTrustFixture();
    try {
      const utilsRoot = join(fixture.piRoot, "dist", "utils");
      const relocatedRoot = join(utilsRoot, "alt");
      const photonAlias = join(utilsRoot, "photon.js");
      const relocatedPhoton = join(relocatedRoot, "photon.js");
      const writablePhotonRoot = join(fixture.workspace, "photon-node");
      const writablePhotonEntry = join(writablePhotonRoot, "photon_rs.js");
      const nestedPhotonAlias = join(relocatedRoot, "node_modules", "@silvia-odwyer", "photon-node");
      await Promise.all([
        mkdir(join(relocatedRoot, "node_modules", "@silvia-odwyer"), { recursive: true }),
        mkdir(writablePhotonRoot),
      ]);
      await rm(photonAlias);
      await Promise.all([
        writeFile(relocatedPhoton, "export {};"),
        writeFile(writablePhotonEntry, "module.exports = {};"),
        writeFile(join(writablePhotonRoot, "photon_rs_bg.wasm"), "attacker wasm"),
        writeFile(join(writablePhotonRoot, "package.json"), '{"name":"@silvia-odwyer/photon-node","version":"0.3.4","main":"photon_rs.js"}'),
      ]);
      await Promise.all([
        symlink(relocatedPhoton, photonAlias),
        symlink(writablePhotonRoot, nestedPhotonAlias, "dir"),
      ]);

      const canonicalPhotonImporter = await realpath(photonAlias);
      const actualPhotonEntry = createRequire(pathToFileURL(canonicalPhotonImporter)).resolve("@silvia-odwyer/photon-node");
      expect(await realpath(actualPhotonEntry)).toBe(writablePhotonEntry);

      await expect(resolveExtensionTrustPaths(fixture.input())).rejects.toThrow(
        /Pi image.*(canonical|relocat|symlink)|Photon.*resolution.*drift|graph.*edge/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a Pi processor member alias that substitutes a nested package root", async () => {
    const fixture = await createTrustFixture();
    try {
      const nestedPiRoot = join(fixture.piRoot, "nested-pi");
      const nestedUtilsRoot = join(nestedPiRoot, "dist", "utils");
      await mkdir(nestedUtilsRoot, { recursive: true });
      await Promise.all([
        writeFile(join(nestedPiRoot, "package.json"), '{"name":"@earendil-works/pi-coding-agent","version":"0.84.2","type":"module"}'),
        ...PI_IMAGE_MODULES.map((name) => writeFile(join(nestedUtilsRoot, name), "export {};")),
      ]);
      await rm(fixture.piImageProcessorPath);
      await symlink(join(nestedUtilsRoot, "image-process.js"), fixture.piImageProcessorPath);

      await expect(resolveExtensionTrustPaths(fixture.input())).rejects.toThrow(
        /Pi package.*(root|alias).*drift|Pi image processor.*canonical.*graph/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("accepts a disjoint whole-package alias with regular canonical Pi and Photon members", async () => {
    const fixture = await createTrustFixture();
    try {
      const piAlias = join(fixture.root, "pi-local-install");
      const photonAliasRoot = join(piAlias, "node_modules", "@silvia-odwyer", "photon-node");
      await symlink(fixture.piRoot, piAlias, "dir");

      const resolved = await resolveExtensionTrustPaths(fixture.input({
        piImageProcessorPath: join(piAlias, "dist", "utils", "image-process.js"),
        photonEntryPath: join(photonAliasRoot, "photon_rs.js"),
        photonWasmPath: join(photonAliasRoot, "photon_rs_bg.wasm"),
      }));

      expect(resolved.imageProcessorPath).toBe(fixture.piImageProcessorPath);
      expect(resolved.immutablePaths).toEqual(expect.arrayContaining([fixture.piRoot, fixture.photonRoot]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a Photon WASM symlink whose canonical target is writable", async () => {
    const fixture = await createTrustFixture();
    try {
      const writableTarget = join(fixture.workspace, "photon.wasm");
      const wasmAlias = join(fixture.photonRoot, "photon_rs_bg.wasm");
      await rm(wasmAlias);
      await writeFile(writableTarget, "attacker wasm");
      await symlink(writableTarget, wasmAlias);

      await expect(resolveExtensionTrustPaths(fixture.input())).rejects.toThrow(
        /Photon WASM.*(outside|escape).*package|trusted.*writable|immutable.*allowWrite/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains every regular canonical image target for immutable binding", async () => {
    const fixture = await createTrustFixture();
    try {
      const resolved = await resolveExtensionTrustPaths(fixture.input());
      const canonicalImageModules = PI_IMAGE_MODULES.map((name) => join(fixture.piRoot, "dist", "utils", name));

      expect(resolved.imageProcessorPath).toBe(fixture.piImageProcessorPath);
      expect(resolved.immutablePaths).toEqual(expect.arrayContaining([
        ...canonicalImageModules,
        join(fixture.photonRoot, "photon_rs.js"),
        join(fixture.photonRoot, "photon_rs_bg.wasm"),
      ]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports an actionable redacted failure before initialization for an escaped image target", async () => {
    const fixture = await createTrustFixture();
    try {
      const graphMember = join(fixture.piRoot, "dist", "utils", "image-resize-worker.js");
      const writableTarget = join(fixture.workspace, "worker.js");
      await rm(graphMember);
      await writeFile(writableTarget, "export {};");
      await symlink(writableTarget, graphMember);
      const harness = createHarness();
      harness.resolveWorkerPaths.mockImplementation(() => resolveExtensionTrustPaths(fixture.input()));
      const ctx = createContext({ cwd: fixture.workspace });
      harness.extension(harness.pi.api);

      await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);

      expect(harness.runtime.snapshot().state).toBe("failed");
      expect(harness.manager.updateConfig).not.toHaveBeenCalled();
      expect(harness.manager.initialize).not.toHaveBeenCalled();
      const notification = ctx.ui.notify.mock.calls.at(-1)?.[0] as string;
      expect(notification).toMatch(/image.*package|trusted.*immutable/i);
      expect(notification).toMatch(/reinstall|move|narrow/i);
      expect(notification).toContain("<path>");
      expect(notification).not.toContain(fixture.root);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a local Sandlot package beneath an effective writable root", async () => {
    const fixture = await createTrustFixture({ packageInsideWorkspace: true });
    try {
      await expect(resolveExtensionTrustPaths(fixture.input())).rejects.toThrow(
        /trusted host code.*immutable.*filesystem\.allowWrite|writable.*trusted/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a replaceable writable symlink alias even when its target is external", async () => {
    const fixture = await createTrustFixture();
    try {
      const alias = join(fixture.workspace, "sandlot-link");
      await symlink(fixture.sandlotRoot, alias, "dir");

      await expect(resolveExtensionTrustPaths(fixture.input({
        entryPath: join(alias, "dist", "index.js"),
        fileWorkerPath: join(alias, "dist", "helpers", "file-worker.js"),
        searchWorkerPath: join(alias, "dist", "helpers", "search-worker.js"),
      }))).rejects.toThrow(/alias.*writable|trusted host code.*immutable/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps an external local-path install usable when writable data roots are disjoint", async () => {
    const fixture = await createTrustFixture();
    try {
      const resolved = await resolveExtensionTrustPaths(fixture.input());

      expect(resolved.immutablePaths).toEqual(expect.arrayContaining([
        fixture.sandlotRoot,
        fixture.piRoot,
        fixture.photonRoot,
      ]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails initialization closed with actionable redacted trust-topology diagnostics", async () => {
    const fixture = await createTrustFixture({ packageInsideWorkspace: true });
    try {
      const harness = createHarness();
      const policy = {
        ...harness.effective,
        filesystem: { ...harness.effective.filesystem, allowWrite: [fixture.workspace] },
      };
      harness.composePolicy.mockResolvedValue(policy);
      harness.resolveWorkerPaths.mockImplementation(() => resolveExtensionTrustPaths(fixture.input()));
      const ctx = createContext({ cwd: fixture.workspace });
      harness.extension(harness.pi.api);

      await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx.value);

      expect(harness.runtime.snapshot()).toMatchObject({ state: "failed" });
      expect(harness.manager.updateConfig).not.toHaveBeenCalled();
      expect(harness.manager.initialize).not.toHaveBeenCalled();
      const notification = ctx.ui.notify.mock.calls.at(-1)?.[0] as string;
      expect(notification).toMatch(/trusted host code.*immutable|writable.*trusted/i);
      expect(notification).toMatch(/move|install|narrow.*allowWrite/i);
      expect(notification).not.toContain(fixture.root);
      expect(notification).toContain("<path>");
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createTrustFixture(options: { packageInsideWorkspace?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sandlot-trust-topology-")));
  const workspace = join(root, "workspace");
  const sandlotRoot = options.packageInsideWorkspace ? join(workspace, "sandlot") : join(root, "sandlot");
  const dist = join(sandlotRoot, "dist");
  const piRoot = join(root, "pi");
  const photonRoot = join(piRoot, "node_modules", "@silvia-odwyer", "photon-node");
  const runtimeModulesRoot = join(root, "runtime", "node_modules");
  const sandboxRuntimeRoot = join(runtimeModulesRoot, "@anthropic-ai", "sandbox-runtime");
  const zodRoot = join(runtimeModulesRoot, "zod");
  const binRoot = join(root, "bin");
  const modulePaths = [
    "index.js", "config.js", "diagnostics.js", "environment.js", "guard.js", "paths.js", "policy.js",
    "runner.js", "runtime.js", "sandbox-runtime-boundary.js", "helpers/file-worker.js", "helpers/image-worker.js", "helpers/protocol.js",
    "helpers/sandbox-runtime-service.js", "helpers/search-worker.js",
    "tools/bash.js", "tools/files.js", "tools/index.js", "tools/search.js", "trust.js", "violations.js",
  ];
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(join(dist, "helpers"), { recursive: true }),
    mkdir(join(dist, "tools"), { recursive: true }),
    mkdir(join(piRoot, "dist", "utils"), { recursive: true }),
    mkdir(photonRoot, { recursive: true }),
    mkdir(join(sandboxRuntimeRoot, "dist"), { recursive: true }),
    mkdir(zodRoot, { recursive: true }),
    mkdir(binRoot, { recursive: true }),
  ]);
  await Promise.all([
    ...modulePaths.map(async (path) => writeFile(join(dist, path), "export {};")),
    writeFile(join(sandlotRoot, "package.json"), '{"type":"module"}'),
    writeFile(join(piRoot, "package.json"), '{"name":"@earendil-works/pi-coding-agent","version":"0.84.2","type":"module"}'),
    ...PI_IMAGE_MODULES.map((name) => writeFile(join(piRoot, "dist", "utils", name), "export {};")),
    writeFile(join(photonRoot, "package.json"), '{"name":"@silvia-odwyer/photon-node","version":"0.3.4","main":"photon_rs.js"}'),
    writeFile(join(photonRoot, "photon_rs.js"), "module.exports = {};"),
    writeFile(join(photonRoot, "photon_rs_bg.wasm"), "wasm"),
    writeFile(join(sandboxRuntimeRoot, "package.json"), '{"name":"@anthropic-ai/sandbox-runtime","version":"0.0.73","type":"module","main":"dist/index.js","dependencies":{"zod":"3.25.76"}}'),
    writeFile(join(sandboxRuntimeRoot, "dist", "index.js"), "export {};"),
    writeFile(join(zodRoot, "package.json"), '{"name":"zod","version":"3.25.76","type":"module","main":"index.js"}'),
    writeFile(join(zodRoot, "index.js"), "export {};"),
    writeFile(join(binRoot, "node"), "node"),
    writeFile(join(binRoot, "rg"), "rg"),
    writeFile(join(binRoot, "bwrap"), "bwrap"),
    writeFile(join(binRoot, "socat"), "socat"),
  ]);
  await Promise.all([
    chmod(join(binRoot, "bwrap"), 0o755),
    chmod(join(binRoot, "socat"), 0o755),
  ]);
  const piImageProcessorPath = join(piRoot, "dist", "utils", "image-process.js");
  const photonEntryPath = join(photonRoot, "photon_rs.js");
  return {
    root,
    workspace,
    sandlotRoot,
    piRoot,
    photonRoot,
    sandboxRuntimeRoot,
    zodRoot,
    bwrapPath: join(binRoot, "bwrap"),
    socatPath: join(binRoot, "socat"),
    piImageProcessorPath,
    input(overrides: Record<string, unknown> = {}) {
      return {
        entryPath: join(dist, "index.js"),
        nodePath: join(binRoot, "node"),
        fileWorkerPath: join(dist, "helpers", "file-worker.js"),
        searchWorkerPath: join(dist, "helpers", "search-worker.js"),
        rgPath: join(binRoot, "rg"),
        sandboxRuntimeEntryPath: join(sandboxRuntimeRoot, "dist", "index.js"),
        configuredBwrapPath: join(binRoot, "bwrap"),
        configuredSocatPath: join(binRoot, "socat"),
        piImageProcessorPath,
        photonEntryPath,
        photonWasmPath: join(photonRoot, "photon_rs_bg.wasm"),
        allowWritePaths: [workspace],
        ...overrides,
      };
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function createHarness(options: {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  rgPath?: string;
  seccompApplyPath?: string;
} = {}) {
  const runtime = new RuntimeController();
  const effective = effectivePolicy(options.enabled ?? true);
  const runner = {
    run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    abortAll: vi.fn(async () => undefined),
  };
  const violationStore = new SandboxViolationStore();
  const manager = {
    open: vi.fn(async () => undefined),
    updateConfig: vi.fn(),
    checkDependenciesAsync: vi.fn(async () => ({ warnings: [], errors: [] })),
    getLinuxGlobPatternWarnings: vi.fn(async () => [] as string[]),
    initialize: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    wrapWithSandboxArgv: vi.fn(),
    cleanupAfterCommand: vi.fn(),
    getSandboxViolationStore: vi.fn(() => violationStore),
  };
  const loadPolicyFiles = vi.fn(async () => ({ user: { enabled: true }, project: undefined }));
  const composePolicy = vi.fn(async () => effective);
  const validatePolicyForPlatform = vi.fn(async () => undefined);
  const resolveWorkerPaths = vi.fn(async () => ({
    trustedReadPaths: [
      "/trusted/node", "/trusted/file-worker", "/trusted/protocol", "/trusted/package.json",
      "/trusted/search-worker", options.rgPath ?? "/trusted/rg", "/trusted/mktemp",
    ],
    immutablePaths: [
      "/trusted/entry", "/trusted/node", "/trusted/file-worker", "/trusted/protocol", "/trusted/package.json",
      "/trusted/search-worker", options.rgPath ?? "/trusted/rg", "/trusted/mktemp",
    ],
    rgPath: options.rgPath ?? "/trusted/rg",
    imageProcessorPath: "/trusted/image-process",
    seccompApplyPath: options.seccompApplyPath,
  }));
  const resolveImageGraph = vi.fn(() => ({
    piVersion: "0.84.2",
    hostAnchored: true,
    imageModuleCount: 7,
    imageProcessorPath: "/trusted/image-process",
    photonEntryPath: "/trusted/photon",
    photonWasmPath: "/trusted/photon.wasm",
  }));
  const imageProcessor = {
    bind: vi.fn(),
    clear: vi.fn(),
    abortAll: vi.fn(async () => undefined),
    process: vi.fn(async () => ({ ok: false })),
  };
  const localExec = vi.fn(async () => ({ exitCode: 0 }));
  const fileClient = new FileWorkerClient(runner);
  const searchClient = new SearchWorkerClient(runner);
  const pi = createFakeExtensionApi();
  const processState = { managerActive: false, poisonedError: undefined };
  const dependencies = {
    runtime,
    runner,
    manager,
    fileClient,
    searchClient,
    imageProcessor,
    loadPolicyFiles,
    composePolicy,
    validatePolicyForPlatform,
    toSandboxRuntimeConfig: vi.fn((policy: EffectivePolicy) => ({
      network: policy.network,
      filesystem: policy.filesystem,
      ripgrep: policy.ripgrep,
      seccomp: policy.seccomp,
      bwrapPath: policy.bwrapPath,
      socatPath: policy.socatPath,
    })),
    resolveWorkerPaths,
    resolveImageGraph,
    processState,
    platform: options.platform ?? "linux",
    arch: process.arch,
    hostEnvironment: { PATH: "/usr/bin", SECRET: "hidden" },
    sandlotSourcePath: ENTRY_PATH,
    createLocalBashOperations: () => ({ exec: localExec }),
  } as unknown as ExtensionDependencies;
  return {
    runtime,
    effective,
    runner,
    manager,
    violationStore,
    processState,
    fileClient,
    searchClient,
    imageProcessor,
    loadPolicyFiles,
    composePolicy,
    validatePolicyForPlatform,
    resolveWorkerPaths,
    resolveImageGraph,
    localExec,
    pi,
    dependencies,
    extension: createSandlotExtension(dependencies),
  };
}

function effectivePolicy(enabled: boolean): EffectivePolicy {
  return {
    enabled,
    networkMode: "filtered",
    network: {
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    },
    filesystem: {
      disabled: false,
      denyRead: [],
      allowRead: ["/workspace"],
      allowWrite: ["/workspace"],
      denyWrite: [],
      allowGitConfig: false,
    },
    credentials: undefined,
    environment: { passThrough: [], deny: [], exposePiSessionMetadata: false },
    trustedCustomTools: [],
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    ripgrep: undefined,
    seccomp: undefined,
    bwrapPath: undefined,
    socatPath: undefined,
  };
}

function createFakeExtensionApi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }>();
  const sourceOverrides = new Map<string, string>();
  let onGetAllTools = () => toolInfo();
  const toolInfo = (): ToolInfo[] => [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    promptGuidelines: tool.promptGuidelines,
    sourceInfo: {
      path: sourceOverrides.get(tool.name) ?? ENTRY_PATH,
      source: "extension",
      scope: "project",
      origin: "top-level",
    },
  }));
  const api = {
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }) {
      commands.set(name, options);
    },
    getAllTools: () => onGetAllTools(),
  } as unknown as ExtensionAPI;
  return {
    api,
    handlers,
    tools,
    commands,
    toolInfo,
    set onGetAllTools(value: () => ToolInfo[]) { onGetAllTools = value; },
    get onGetAllTools() { return onGetAllTools; },
    overrideToolSource(name: string, source: string) { sourceOverrides.set(name, source); },
    async emit(event: string, payload: unknown, ctx: ExtensionContext) {
      const handler = handlers.get(event);
      if (handler === undefined) throw new Error(`Missing fake handler: ${event}`);
      return handler(payload, ctx);
    },
    async command(name: string, ctx: ExtensionCommandContext, args = "") {
      const command = commands.get(name);
      if (command === undefined) throw new Error(`Missing fake command: ${name}`);
      return command.handler(args, ctx);
    },
  };
}

function createContext(options: { trusted?: boolean; hasUI?: boolean; cwd?: string } = {}) {
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
  };
  const reload = vi.fn(async () => undefined);
  const value = {
    cwd: options.cwd ?? "/workspace",
    hasUI: options.hasUI ?? true,
    mode: "tui",
    ui,
    isProjectTrusted: () => options.trusted ?? true,
    sessionManager: { getSessionId: () => "session-1" },
    model: { provider: "test-provider", id: "test-model" },
  } as unknown as ExtensionContext;
  const commandValue = { ...value, reload } as unknown as ExtensionCommandContext;
  return { value, commandValue, ui, reload };
}
