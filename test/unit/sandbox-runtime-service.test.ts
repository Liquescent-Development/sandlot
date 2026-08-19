import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleSandboxRuntimeRequest,
  validateSandboxRuntimeServiceMessage,
} from "../../src/helpers/sandbox-runtime-service.js";

describe("Sandbox Runtime service protocol", () => {
  it("routes wrap ownership, cwd, cleanup, and command-scoped violations through SRT", async () => {
    const cwd = process.cwd();
    const violations = [{ line: "deny file-write /protected" }];
    const manager = {
      updateConfig: vi.fn(),
      checkDependenciesAsync: vi.fn(async () => ({ warnings: [], errors: [] })),
      initialize: vi.fn(async () => undefined),
      wrapWithSandboxArgv: vi.fn(async () => ({ argv: ["/bin/bash", "-c", "wrapped"], env: {} })),
      cleanupAfterCommand: vi.fn(),
      getLinuxGlobPatternWarnings: vi.fn(() => []),
      getSandboxViolationStore: vi.fn(() => ({
        clear: vi.fn(),
        getViolationsForCommand: vi.fn(() => violations),
      })),
      reset: vi.fn(async () => undefined),
    };
    const abort = new AbortController();

    const descriptor = await handleSandboxRuntimeRequest(manager, "wrap", {
      command: "inner command",
      binShell: "/bin/bash",
      cwd,
      options: { commandId: "tool-1", commandText: "original command" },
    }, abort.signal);
    const collected = await handleSandboxRuntimeRequest(manager, "violationsForCommand", { commandId: "tool-1" });
    await handleSandboxRuntimeRequest(manager, "cleanupAfterCommand", undefined);

    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledWith(
      "inner command",
      "/bin/bash",
      undefined,
      expect.any(AbortSignal),
      cwd,
      { commandId: "tool-1", commandText: "original command" },
    );
    expect(descriptor).toEqual({ argv: ["/bin/bash", "-c", "wrapped"] });
    expect(collected).toEqual(violations);
    expect(manager.cleanupAfterCommand).toHaveBeenCalledOnce();
  });

  it("fails the wrap closed when the mandatory Linux control-path scan fails", async () => {
    const manager = {
      updateConfig: vi.fn(),
      checkDependenciesAsync: vi.fn(),
      initialize: vi.fn(),
      wrapWithSandboxArgv: vi.fn(),
      cleanupAfterCommand: vi.fn(),
      getLinuxGlobPatternWarnings: vi.fn(() => []),
      getSandboxViolationStore: vi.fn(() => ({ clear: vi.fn(), getViolationsForCommand: vi.fn(() => []) })),
      reset: vi.fn(),
    };
    const scanMandatoryDenyPaths = vi.fn(async () => {
      throw new Error("ripgrep scan failed with exit code 2");
    });

    await expect(handleSandboxRuntimeRequest(manager, "wrap", {
      command: "inner command",
      cwd: "/workspace",
      mandatoryScan: { ripgrepCommand: "/trusted/rg" },
    }, undefined, { scanMandatoryDenyPaths })).rejects.toThrow(/ripgrep scan failed/i);

    expect(scanMandatoryDenyPaths).toHaveBeenCalledWith("/trusted/rg", "/workspace", expect.any(AbortSignal));
    expect(manager.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it("roots upstream mandatory denies at each invocation cwd and restores the service cwd", async () => {
    const createdRoots = await Promise.all([
      mkdtemp(join(tmpdir(), "sandlot-service-cwd-a-")),
      mkdtemp(join(tmpdir(), "sandlot-service-cwd-b-")),
    ]);
    const invocationRoots = await Promise.all(createdRoots.map((root) => realpath(root)));
    const serviceRoot = process.cwd();
    const observed = new Map<string, string[]>();
    const manager = {
      updateConfig: vi.fn(),
      checkDependenciesAsync: vi.fn(),
      initialize: vi.fn(),
      wrapWithSandboxArgv: vi.fn(async (command: string) => {
        const samples = [process.cwd()];
        observed.set(command, samples);
        await new Promise((resolve) => setTimeout(resolve, 5));
        samples.push(process.cwd());
        return { argv: ["/bin/bash", "-c", "wrapped"], env: {} };
      }),
      cleanupAfterCommand: vi.fn(),
      getLinuxGlobPatternWarnings: vi.fn(() => []),
      getSandboxViolationStore: vi.fn(() => ({ clear: vi.fn(), getViolationsForCommand: vi.fn(() => []) })),
      reset: vi.fn(),
    };

    try {
      await Promise.all(invocationRoots.map((cwd, index) => handleSandboxRuntimeRequest(manager, "wrap", {
        command: `inner command ${index}`,
        cwd,
      })));

      expect(observed.get("inner command 0")).toEqual([invocationRoots[0], invocationRoots[0]]);
      expect(observed.get("inner command 1")).toEqual([invocationRoots[1], invocationRoots[1]]);
      expect(process.cwd()).toBe(serviceRoot);
    } finally {
      await Promise.all(invocationRoots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("rejects inherited and unexpected wrap payload properties before manager dispatch", async () => {
    const manager = serviceManager();
    const inherited = Object.create({ command: "true", cwd: "/workspace" });
    const scanMandatoryDenyPaths = vi.fn(async () => undefined);

    await expect(handleSandboxRuntimeRequest(manager, "wrap", inherited)).rejects.toThrow(/own|plain|payload/i);
    await expect(handleSandboxRuntimeRequest(manager, "wrap", {
      command: "true",
      cwd: "/workspace",
      unexpected: "authority",
    })).rejects.toThrow(/unexpected|property/i);
    await expect(handleSandboxRuntimeRequest(manager, "wrap", {
      command: "true",
      cwd: "/workspace",
      mandatoryScan: { ripgrepCommand: "/trusted/rg", unexpected: "authority" },
    }, undefined, { scanMandatoryDenyPaths })).rejects.toThrow(/unexpected|property/i);

    expect(manager.wrapWithSandboxArgv).not.toHaveBeenCalled();
    expect(scanMandatoryDenyPaths).not.toHaveBeenCalled();
  });

  it("registers credentials explicitly without ever installing ambient sources", async () => {
    const secret = "sandbox-runtime-service-private-secret";
    const name = "SANDLOT_SERVICE_MASKED_TOKEN";
    const previous = process.env[name];
    delete process.env[name];
    const manager = serviceManager({
      wrapWithSandboxArgv: vi.fn(async (command: string) => {
        expect(process.env[name]).toBeUndefined();
        expect(command).toContain("fake_value_unit_test");
        expect(command).not.toContain(secret);
        return { argv: ["/bin/bash", "-c", "wrapped"], env: { ...process.env } };
      }),
    });
    const config = {
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      credentials: {
        allowPlaintextInject: true,
        envVars: [{ name, mode: "mask" as const }],
      },
    };

    try {
      await handleSandboxRuntimeRequest(manager, "updateConfig", {
        config,
        credentialEnvironment: { [name]: secret },
      });
      const descriptor = await handleSandboxRuntimeRequest(manager, "wrap", {
        command: "true",
        cwd: process.cwd(),
      });

      expect(descriptor).toEqual({ argv: ["/bin/bash", "-c", "wrapped"] });
      expect(JSON.stringify(descriptor)).not.toContain(secret);
      expect(process.env[name]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it.each(["CLAUDE_TMPDIR", "CLAUDE_CODE_TMPDIR", "JAVA_TOOL_OPTIONS"])(
    "never exposes the raw %s source to ambient SRT plumbing",
    async (name) => {
      const secret = `raw-${name.toLowerCase()}-credential`;
      const previous = process.env[name];
      delete process.env[name];
      const manager = serviceManager({
        wrapWithSandboxArgv: vi.fn(async (command: string) => {
          expect(process.env[name]).toBeUndefined();
          expect(command).toContain("fake_value_unit_test");
          expect(command).not.toContain(secret);
          return { argv: ["/bin/bash", "-c", "wrapped"], env: { ...process.env } };
        }),
      });
      const config = credentialConfig(name);
      try {
        await handleSandboxRuntimeRequest(manager, "updateConfig", {
          config,
          credentialEnvironment: { [name]: secret },
        });
        await expect(handleSandboxRuntimeRequest(manager, "wrap", {
          command: "true",
          cwd: process.cwd(),
        })).resolves.toEqual({ argv: ["/bin/bash", "-c", "wrapped"] });
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    },
  );

  it("removes mask entries from SRT's ambient pass while retaining structural denies", async () => {
    const secret = "raw-host-tmpdir-credential";
    const manager = serviceManager({
      wrapWithSandboxArgv: vi.fn(async (
        command: string,
        _shell: string,
        customConfig: { credentials?: { envVars?: Array<{ name: string; mode: string }> } },
      ) => {
        expect(process.env.TMPDIR).not.toBe(secret);
        expect(command).toContain("fake_value_unit_test");
        expect(customConfig.credentials?.envVars).toEqual([{ name: "DENIED_TOKEN", mode: "deny" }]);
        return { argv: ["/bin/bash", "-c", "wrapped"], env: { ...process.env } };
      }),
    });
    const config = {
      ...credentialConfig("TMPDIR"),
      credentials: {
        allowPlaintextInject: true,
        envVars: [
          { name: "TMPDIR", mode: "mask" as const },
          { name: "DENIED_TOKEN", mode: "deny" as const },
        ],
      },
    };
    await handleSandboxRuntimeRequest(manager, "updateConfig", {
      config,
      credentialEnvironment: { TMPDIR: secret },
    });

    await expect(handleSandboxRuntimeRequest(manager, "wrap", {
      command: "true",
      cwd: process.cwd(),
    })).resolves.toEqual({ argv: ["/bin/bash", "-c", "wrapped"] });
  });

  it("fails closed before IPC when an upstream descriptor contains a raw credential", async () => {
    const name = "SANDLOT_DESCRIPTOR_LEAK_TOKEN";
    const secret = "raw-descriptor-leak-secret";
    const manager = serviceManager({
      wrapWithSandboxArgv: vi.fn(async () => ({
        argv: ["/bin/bash", "-c", `accidental ${secret}`],
        env: { LEAK: secret },
      })),
    });
    await handleSandboxRuntimeRequest(manager, "updateConfig", {
      config: credentialConfig(name),
      credentialEnvironment: { [name]: secret },
    });

    const error = await handleSandboxRuntimeRequest(manager, "wrap", {
      command: "true",
      cwd: process.cwd(),
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("SandboxRuntimeServicePoisonError");
    expect(String(error)).not.toContain(secret);
  });

  it("poisons any otherwise-successful service response containing a raw credential", async () => {
    const name = "SANDLOT_RESPONSE_LEAK_TOKEN";
    const secret = "raw-success-response-secret";
    const manager = serviceManager({
      checkDependenciesAsync: vi.fn(async () => ({ warnings: [secret], errors: [] })),
    });
    await handleSandboxRuntimeRequest(manager, "updateConfig", {
      config: credentialConfig(name),
      credentialEnvironment: { [name]: secret },
    });

    const error = await handleSandboxRuntimeRequest(manager, "checkDependencies", {})
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("SandboxRuntimeServicePoisonError");
    expect(String(error)).not.toContain(secret);
  });

  it("clears credential state after reset without exposing a credential in the reset error", async () => {
    const secret = "sandbox-runtime-service-reset-secret";
    const name = "SANDLOT_SERVICE_RESET_TOKEN";
    const manager = serviceManager({
      reset: vi.fn(async () => { throw new Error(`reset failed for ${secret}`); }),
    });
    const config = {
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      credentials: {
        allowPlaintextInject: true,
        envVars: [{ name, mode: "mask" as const }],
      },
    };
    await handleSandboxRuntimeRequest(manager, "updateConfig", {
      config,
      credentialEnvironment: { [name]: secret },
    });

    const error = await handleSandboxRuntimeRequest(manager, "reset", undefined)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("[REDACTED]");
    expect(String(error)).not.toContain(secret);
    expect(String((error as Error & { cause?: unknown }).cause)).not.toContain(secret);
  });

  it("copies only bounded redacted violation lines into the IPC response", async () => {
    const secret = "sandbox-runtime-service-violation-secret";
    const name = "SANDLOT_SERVICE_VIOLATION_TOKEN";
    const manager = serviceManager({
      getSandboxViolationStore: vi.fn(() => ({
        clear: vi.fn(),
        getViolationsForCommand: vi.fn(() => [{
          line: `denied access involving ${secret}`,
          command: "private command metadata",
          encodedCommand: "private encoded metadata",
          timestamp: new Date(),
        }]),
      })),
    });
    const config = {
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      credentials: {
        allowPlaintextInject: true,
        envVars: [{ name, mode: "mask" as const }],
      },
    };
    await handleSandboxRuntimeRequest(manager, "updateConfig", {
      config,
      credentialEnvironment: { [name]: secret },
    });

    const violations = await handleSandboxRuntimeRequest(
      manager,
      "violationsForCommand",
      { commandId: "tool-1" },
    );

    expect(violations).toEqual([{ line: "denied access involving [REDACTED]" }]);
    expect(JSON.stringify(violations)).not.toContain(secret);
  });

  it("rejects an oversized operation input before manager dispatch", async () => {
    const manager = serviceManager();

    await expect(handleSandboxRuntimeRequest(manager, "wrap", {
      command: "x".repeat(2 * 1024 * 1024),
      cwd: "/workspace",
    })).rejects.toThrow(/large|size|limit/i);

    expect(manager.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it("gives a hung reset a finite service-side deadline", async () => {
    const manager = serviceManager({ reset: vi.fn(() => new Promise<void>(() => undefined)) });
    const request = handleSandboxRuntimeRequest(manager, "reset", undefined, undefined, {
      scanMandatoryDenyPaths: async () => undefined,
      operationTimeouts: { reset: 40 },
    } as never).catch((error: unknown) => error);

    const result = await Promise.race([request, delay(150).then(() => "still-pending")]);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/reset.*timed out|timed out.*reset/i);
  });

  it("aborts and poisons a hung stateful wrap when its service deadline expires", async () => {
    let observedSignal: AbortSignal | undefined;
    const manager = serviceManager({
      wrapWithSandboxArgv: vi.fn((_command: string, _shell: string, _config: undefined, signal: AbortSignal) => {
        observedSignal = signal;
        return new Promise<never>(() => undefined);
      }),
    });
    const request = handleSandboxRuntimeRequest(manager, "wrap", {
      command: "true",
      cwd: process.cwd(),
    }, undefined, {
      scanMandatoryDenyPaths: async () => undefined,
      operationTimeouts: { wrap: 40 },
    } as never).catch((error: unknown) => error);

    const result = await Promise.race([request, delay(150).then(() => "still-pending")]);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).name).toBe("SandboxRuntimeServicePoisonError");
    expect(observedSignal?.aborted).toBe(true);
  });

  it.each([
    undefined,
    null,
    {},
    { id: 0 },
    { id: 1, extra: true },
  ])("rejects malformed abort payload %j inside strict message parsing", (payload) => {
    expect(() => validateSandboxRuntimeServiceMessage({
      type: "notify",
      operation: "abort",
      payload,
    })).toThrow(/abort|payload|property|object/i);
  });

  it("bounds concurrent service operations even when earlier work never settles", async () => {
    const manager = serviceManager({ initialize: vi.fn(() => new Promise<void>(() => undefined)) });
    const dependencies = {
      scanMandatoryDenyPaths: async () => undefined,
      operationTimeouts: { initialize: 200 },
    } as never;
    const config = {
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    };
    const requests = Array.from({ length: 65 }, () => handleSandboxRuntimeRequest(
      manager,
      "initialize",
      { config },
      undefined,
      dependencies,
    ).catch((error: unknown) => error));

    const overflow = await Promise.race([requests[64], delay(100).then(() => "still-pending")]);

    expect(overflow).toBeInstanceOf(Error);
    expect((overflow as Error).message).toMatch(/active.*limit|too many.*operation/i);
    await Promise.all(requests.slice(0, 64));
  });
});

function serviceManager(overrides: Record<string, unknown> = {}) {
  const sentinelRegistry = {
    register: vi.fn(() => "fake_value_unit_test"),
    registerWithSentinel: vi.fn((_key: string, sentinel: string) => sentinel),
  };
  return {
    updateConfig: vi.fn(),
    checkDependenciesAsync: vi.fn(async () => ({ warnings: [], errors: [] })),
    initialize: vi.fn(async () => undefined),
    wrapWithSandboxArgv: vi.fn(async () => ({ argv: ["/bin/bash", "-c", "wrapped"], env: {} })),
    cleanupAfterCommand: vi.fn(),
    getLinuxGlobPatternWarnings: vi.fn(() => []),
    getSandboxViolationStore: vi.fn(() => ({ clear: vi.fn(), getViolationsForCommand: vi.fn(() => []) })),
    getSentinelRegistry: vi.fn(() => sentinelRegistry),
    getAwsPairRegistry: vi.fn(() => ({ register: vi.fn() })),
    reset: vi.fn(async () => undefined),
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function credentialConfig(name: string) {
  return {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    credentials: {
      allowPlaintextInject: true,
      envVars: [{ name, mode: "mask" as const }],
    },
  };
}
