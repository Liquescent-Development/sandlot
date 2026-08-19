import { describe, expect, it, vi } from "vitest";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  SandboxRuntimeBoundary,
  type SandboxRuntimeBoundaryOptions,
  type SandboxRuntimeTransport,
} from "../../src/sandbox-runtime-boundary.js";
import {
  createSandlotSessionTemporaryDirectory,
  type SandlotSessionTemporaryDirectoryCreationResult,
  type SandlotTemporaryDirectoryFileSystem,
} from "../../src/session-temporary-directory.js";
import { sandlotMktempShimDirectory } from "../../src/environment.js";

describe("SandboxRuntimeBoundary", () => {
  it("replaces inherited temporary variables and grants only its private session directory to SRT", async () => {
    const requests: Array<{ operation: string; payload: unknown }> = [];
    let launchEnvironment: NodeJS.ProcessEnv | undefined;
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async (operation, payload) => {
        requests.push({ operation, payload });
        return undefined;
      }),
      notify: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: { TMPDIR: "/private/var/folders/host-owned", TMP: "/host/tmp", TEMP: "/host/temp" },
      createTransport: vi.fn(async (launch) => {
        launchEnvironment = launch.env;
        return transport;
      }),
    });
    const config: SandboxRuntimeConfig = {
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: { denyRead: [], allowWrite: ["/workspace"], denyWrite: [] },
    };

    await boundary.open("/workspace");
    const temporaryDirectory = launchEnvironment?.TMPDIR;
    expect(temporaryDirectory).toMatch(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/);
    expect(launchEnvironment).toMatchObject({ TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory });

    await boundary.updateConfig(config);
    await boundary.initialize(config);

    for (const request of requests.filter(({ operation }) => operation === "updateConfig" || operation === "initialize")) {
      expect((request.payload as { config: SandboxRuntimeConfig }).config.filesystem?.allowWrite)
        .toEqual(["/workspace", temporaryDirectory]);
    }
    expect(config.filesystem?.allowWrite).toEqual(["/workspace"]);

    await boundary.reset();
    await expect(access(temporaryDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates all SRT host work from hostile host and sandbox-child environments", async () => {
    const requests: Array<{ operation: string; payload: unknown }> = [];
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async (operation, payload) => {
        requests.push({ operation, payload });
        if (operation === "wrap") {
          return { argv: ["/bin/bash", "-c", "wrapped"], env: { PATH: "/attacker", LD_PRELOAD: "/attacker.so" } };
        }
        return undefined;
      }),
      notify: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const createTransport = vi.fn(async () => transport);
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {
        PATH: "/writable/bin",
        BASH_ENV: "/writable/bash-env",
        LD_PRELOAD: "/writable/preload.so",
        DYLD_INSERT_LIBRARIES: "/writable/preload.dylib",
      },
      createTransport,
    });

    await boundary.open("/workspace");
    const descriptor = await boundary.wrapWithSandboxArgv(
      "printf ok",
      undefined,
      undefined,
      undefined,
      "/workspace",
      {
        commandId: "tool-1",
        commandText: "printf ok",
        childEnvironment: { PATH: "/writable/bin", BASH_ENV: "/writable/bash-env", SAFE_CHILD: "quoted value" },
      },
    );

    const fixedOuter = expect.objectContaining({
      PATH: `${sandlotMktempShimDirectory()}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: expect.stringMatching(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/),
      TMP: expect.stringMatching(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/),
      TEMP: expect.stringMatching(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/),
    });
    expect(createTransport).toHaveBeenCalledWith({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      cwd: "/workspace",
      env: fixedOuter,
    });
    expect(descriptor).toEqual({ argv: ["/bin/bash", "-c", "wrapped"], env: fixedOuter });
    const wrap = requests.find((request) => request.operation === "wrap")?.payload as { command: string };
    expect(wrap.command).toContain(`'PATH=${sandlotMktempShimDirectory()}:/usr/bin:/bin:/usr/sbin:/sbin'`);
    expect(wrap.command).toContain("'BASH_ENV=/writable/bash-env'");
    expect(wrap.command).toContain("'SAFE_CHILD=quoted value'");
    await boundary.reset();
  });

  it("requires the pinned ripgrep scan before every Linux wrap", async () => {
    const request = vi.fn(async (operation: string) => operation === "wrap"
      ? { argv: ["/bin/bash", "-c", "wrapped"], env: {} }
      : undefined);
    const transport: SandboxRuntimeTransport = {
      request,
      notify: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "linux",
      hostEnvironment: {},
      createTransport: vi.fn(async () => transport),
    });
    await boundary.open("/workspace");
    await boundary.updateConfig({ ripgrep: { command: "/trusted/rg" } });

    await boundary.wrapWithSandboxArgv("true", undefined, undefined, undefined, "/workspace");

    expect(request).toHaveBeenLastCalledWith("wrap", expect.objectContaining({
      cwd: "/workspace",
      mandatoryScan: { ripgrepCommand: "/trusted/rg" },
    }), undefined);
    await boundary.reset();
  });

  it("keeps masked credential sources on private IPC and lets credential policy override pass-through", async () => {
    const secret = "sandlot-real-credential-value";
    const requests: Array<{ operation: string; payload: unknown }> = [];
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async (operation, payload) => {
        requests.push({ operation, payload });
        return operation === "wrap"
          ? { argv: ["/bin/bash", "-c", "wrapped"], env: {} }
          : undefined;
      }),
      notify: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const createTransport = vi.fn(async () => transport);
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {
        PATH: "/attacker/bin",
        MASKED_TOKEN: secret,
        DYLD_INSERT_LIBRARIES: "/attacker/preload.dylib",
      },
      createTransport,
    });
    const config = credentialConfig("MASKED_TOKEN", "mask");

    await boundary.open("/workspace");
    await boundary.updateConfig(config);
    await boundary.wrapWithSandboxArgv("printf '%s' \"$MASKED_TOKEN\"", undefined, undefined, undefined, "/workspace", {
      childEnvironment: { MASKED_TOKEN: secret, SAFE_FLAG: "yes" },
    });

    const fixedOuter = expect.objectContaining({
      PATH: `${sandlotMktempShimDirectory()}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: expect.stringMatching(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/),
      TMP: expect.stringMatching(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/),
      TEMP: expect.stringMatching(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/),
    });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ env: fixedOuter }));
    expect(JSON.stringify(createTransport.mock.calls)).not.toContain(secret);
    const update = requests.find(({ operation }) => operation === "updateConfig")?.payload;
    expect(update).toMatchObject({
      config: {
        ...config,
        filesystem: expect.objectContaining({
          allowWrite: expect.arrayContaining(["/workspace", expect.stringMatching(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/)]),
        }),
      },
      credentialEnvironment: { MASKED_TOKEN: secret },
    });
    const wrap = requests.find(({ operation }) => operation === "wrap")?.payload as { command: string };
    expect(wrap.command).toContain("'SAFE_FLAG=yes'");
    expect(wrap.command).not.toContain(secret);
    expect(wrap.command).not.toContain("MASKED_TOKEN=");
    await boundary.reset();
  });

  it("redacts credential source values from service errors", async () => {
    const secret = "service-error-secret-value";
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async (operation) => {
        if (operation === "wrap") throw new Error(`upstream failure accidentally included ${secret}`);
        return undefined;
      }),
      notify: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: { MASKED_TOKEN: secret },
      createTransport: vi.fn(async () => transport),
    });

    await boundary.open("/workspace");
    await boundary.updateConfig(credentialConfig("MASKED_TOKEN", "mask"));
    const error = await boundary.wrapWithSandboxArgv("true", undefined, undefined, undefined, "/workspace")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error).message).not.toContain(secret);
    expect(String((error as Error & { cause?: unknown }).cause)).not.toContain(secret);
    await boundary.reset();
  });

  it("poisons before returning a service descriptor that echoes a raw credential", async () => {
    const secret = "service-success-echo-secret";
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async (operation) => operation === "wrap"
        ? { argv: ["/bin/bash", "-c", secret], env: {} }
        : undefined),
      notify: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: { MASKED_TOKEN: secret },
      createTransport: vi.fn(async () => transport),
    });
    await boundary.open("/workspace");
    await boundary.updateConfig(credentialConfig("MASKED_TOKEN", "mask"));

    const error = await boundary.wrapWithSandboxArgv("true", undefined, undefined, undefined, "/workspace")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(transport.close).toHaveBeenCalledOnce();
    await expect(boundary.open("/workspace")).rejects.toThrow(/poisoned/i);
  });

  it("redacts a credential source if the initial configuration request fails", async () => {
    const secret = "initial-config-error-secret";
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async (operation) => {
        if (operation === "updateConfig") throw new Error(`configuration rejected ${secret}`);
        return undefined;
      }),
      notify: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: { MASKED_TOKEN: secret },
      createTransport: vi.fn(async () => transport),
    });
    await boundary.open("/workspace");

    const error = await boundary.updateConfig(credentialConfig("MASKED_TOKEN", "mask"))
      .catch((reason: unknown) => reason);

    expect(String(error)).toContain("[REDACTED]");
    expect(String(error)).not.toContain(secret);
    expect(String((error as Error & { cause?: unknown }).cause)).not.toContain(secret);
    await boundary.reset();
  });

  it("never invokes an accessor while reading a credential source", async () => {
    const getter = vi.fn(() => "accessor-secret");
    const hostEnvironment = Object.create(null) as NodeJS.ProcessEnv;
    Object.defineProperty(hostEnvironment, "MASKED_TOKEN", { enumerable: true, get: getter });
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async () => undefined),
      notify: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment,
      createTransport: vi.fn(async () => transport),
    });
    await boundary.open("/workspace");

    await expect(boundary.updateConfig(credentialConfig("MASKED_TOKEN", "mask")))
      .rejects.toThrow(/credential source.*own.*string/i);

    expect(getter).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
    await boundary.reset();
  });

  it("poisons after any reset uncertainty and after an indeterminate close", async () => {
    const safelyClosed: SandboxRuntimeTransport = {
      request: vi.fn(async (operation) => {
        if (operation === "reset") throw new Error("reset request timed out");
        return undefined;
      }),
      notify: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const replacement: SandboxRuntimeTransport = {
      request: vi.fn(async () => undefined),
      notify: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const safeCreate = vi.fn()
      .mockResolvedValueOnce(safelyClosed)
      .mockResolvedValueOnce(replacement);
    const safeBoundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {},
      createTransport: safeCreate,
    });
    await safeBoundary.open("/workspace");

    await expect(safeBoundary.reset()).rejects.toThrow(/reset request timed out/);
    await expect(safeBoundary.open("/workspace")).rejects.toThrow(/poisoned.*reset request timed out/i);
    expect(safeCreate).toHaveBeenCalledOnce();

    let indeterminateClose = true;
    const indeterminate: SandboxRuntimeTransport = {
      request: vi.fn(async () => undefined),
      notify: vi.fn(),
      close: vi.fn(async () => {
        if (indeterminateClose) {
          indeterminateClose = false;
          throw new Error("service did not exit after SIGKILL");
        }
      }),
    };
    const unsafeCreate = vi.fn(async () => indeterminate);
    const unsafeBoundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {},
      createTransport: unsafeCreate,
    });
    await unsafeBoundary.open("/workspace");

    await expect(unsafeBoundary.reset()).rejects.toThrow(/did not exit after SIGKILL/);
    await expect(unsafeBoundary.open("/workspace")).rejects.toThrow(/poisoned.*did not exit/i);
    expect(unsafeCreate).toHaveBeenCalledOnce();
    await unsafeBoundary.reset();
  });

  it("removes the real private directory after transport startup fails", async () => {
    let temporaryDirectory = "";
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {},
      createTransport: async (launch) => {
        temporaryDirectory = launch.env.TMPDIR!;
        await expect(access(temporaryDirectory)).resolves.toBeUndefined();
        throw new Error("literal transport startup failure");
      },
    });

    await expect(boundary.open("/workspace")).rejects.toThrow("literal transport startup failure");

    expect(temporaryDirectory).toMatch(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/);
    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels and consumes a deferred temporary-directory allocation before reset returns", async () => {
    const allocated = await createSandlotSessionTemporaryDirectory();
    if (!allocated.ok) throw allocated.error;
    const allocation = deferredValue<SandlotSessionTemporaryDirectoryCreationResult>();
    const transport: SandboxRuntimeTransport = {
      request: async () => undefined,
      notify: () => undefined,
      close: async () => undefined,
    };
    const createTransport = vi.fn(async () => transport);
    const createTemporaryDirectory = vi.fn(async () => allocation.promise);
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {},
      createTransport,
      createTemporaryDirectory,
    });

    let resetSettled = false;
    const opening = boundary.open("/workspace").then(
      () => ({ ok: true as const, error: undefined }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let resetting: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(createTemporaryDirectory).toHaveBeenCalledOnce());
      resetting = boundary.reset().finally(() => { resetSettled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(resetSettled).toBe(false);
      allocation.resolve(allocated);
      const [openResult] = await Promise.all([opening, resetting]);

      expect(openResult).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringMatching(/cancelled.*reset/i) }) });
      expect(createTransport).not.toHaveBeenCalled();
      await expect(access(allocated.directory.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      allocation.resolve(allocated);
      await Promise.allSettled([opening, resetting]);
      await boundary.reset().catch(() => undefined);
      await allocated.directory.cleanup().catch(() => undefined);
    }
  });

  it("retains a deferred transport startup until reset owns and terminates the delivered service", async () => {
    let temporaryDirectory = "";
    const transportDelivery = deferredValue<SandboxRuntimeTransport>();
    const transport: SandboxRuntimeTransport = {
      request: async () => undefined,
      notify: () => undefined,
      close: vi.fn(async () => undefined),
    };
    const createTransport = vi.fn(async (launch: { readonly env: NodeJS.ProcessEnv }) => {
      temporaryDirectory = launch.env.TMPDIR!;
      return transportDelivery.promise;
    });
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {},
      createTransport,
    });

    let resetSettled = false;
    const opening = boundary.open("/workspace").then(
      () => ({ ok: true as const, error: undefined }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let resetting: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(temporaryDirectory).toMatch(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/));
      resetting = boundary.reset().finally(() => { resetSettled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(resetSettled).toBe(false);
      await expect(access(temporaryDirectory)).resolves.toBeUndefined();

      transportDelivery.resolve(transport);
      const [openResult] = await Promise.all([opening, resetting]);
      expect(openResult).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringMatching(/cancelled.*reset/i) }) });
      expect(transport.close).toHaveBeenCalledOnce();
      await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      transportDelivery.resolve(transport);
      await Promise.allSettled([opening, resetting]);
      await boundary.reset().catch(() => undefined);
      if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a concurrent open before it can allocate or overwrite lifecycle ownership", async () => {
    const allocated = await createSandlotSessionTemporaryDirectory();
    if (!allocated.ok) throw allocated.error;
    const allocation = deferredValue<SandlotSessionTemporaryDirectoryCreationResult>();
    const transport: SandboxRuntimeTransport = {
      request: async () => undefined,
      notify: () => undefined,
      close: vi.fn(async () => undefined),
    };
    const createTemporaryDirectory = vi.fn(async () => allocation.promise);
    const createTransport = vi.fn(async () => transport);
    const boundary = new SandboxRuntimeBoundary({
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {},
      createTemporaryDirectory,
      createTransport,
    });

    const firstOpen = boundary.open("/workspace").then(
      () => ({ ok: true as const, error: undefined }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let secondOpen: Promise<{ readonly ok: boolean; readonly error: unknown }> | undefined;
    try {
      await vi.waitFor(() => expect(createTemporaryDirectory).toHaveBeenCalledOnce());
      secondOpen = boundary.open("/other-workspace").then(
        () => ({ ok: true as const, error: undefined }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      allocation.resolve(allocated);

      const [firstResult, secondResult] = await Promise.all([firstOpen, secondOpen]);
      expect(firstResult).toMatchObject({ ok: true });
      expect(secondResult).toMatchObject({
        ok: false,
        error: expect.objectContaining({ message: expect.stringMatching(/already open/i) }),
      });
      expect(createTemporaryDirectory).toHaveBeenCalledOnce();
      expect(createTransport).toHaveBeenCalledOnce();

      await boundary.reset();
      await expect(access(allocated.directory.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      allocation.resolve(allocated);
      await Promise.allSettled([firstOpen, secondOpen]);
      await boundary.reset().catch(() => undefined);
      await allocated.directory.cleanup().catch(() => undefined);
    }
  });

  it("retains the real private directory after initialization failure until confirmed reset termination", async () => {
    let temporaryDirectory = "";
    const transport: SandboxRuntimeTransport = {
      request: async (operation) => {
        if (operation === "initialize") throw new Error("literal initialization failure");
        return undefined;
      },
      notify: () => undefined,
      close: async () => undefined,
    };
    const boundary = lifecycleBoundary(transport, (path) => { temporaryDirectory = path; });

    await boundary.open("/workspace");
    await expect(boundary.initialize(credentialConfig("UNUSED", "deny")))
      .rejects.toThrow("literal initialization failure");
    await expect(access(temporaryDirectory)).resolves.toBeUndefined();

    await boundary.reset();
    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the private directory until service transport termination is confirmed", async () => {
    let temporaryDirectory = "";
    let confirmTermination: (() => void) | undefined;
    const transport: SandboxRuntimeTransport = {
      request: async () => undefined,
      notify: () => undefined,
      close: async () => new Promise<void>((resolve) => { confirmTermination = resolve; }),
    };
    const boundary = lifecycleBoundary(transport, (path) => { temporaryDirectory = path; });
    await boundary.open("/workspace");

    let resetSettled = false;
    const reset = boundary.reset().finally(() => { resetSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(resetSettled).toBe(false);
    await expect(access(temporaryDirectory)).resolves.toBeUndefined();
    confirmTermination!();
    await reset;
    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("orders reset behind runner-owned execution settlement and service termination", async () => {
    let temporaryDirectory = "";
    let confirmExecutions!: () => void;
    let confirmService!: () => void;
    const executionsSettled = new Promise<void>((resolve) => { confirmExecutions = resolve; });
    const serviceTerminated = new Promise<void>((resolve) => { confirmService = resolve; });
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async () => undefined),
      notify: () => undefined,
      close: vi.fn(async () => serviceTerminated),
    };
    const boundary = lifecycleBoundary(transport, (path) => { temporaryDirectory = path; });
    const terminateAndWait = vi.fn(async () => executionsSettled);
    boundary.bindExecutionTerminationGate({ terminateAndWait });
    await boundary.open("/workspace");

    const resetting = boundary.reset();
    await vi.waitFor(() => expect(terminateAndWait).toHaveBeenCalledOnce());

    expect(transport.request).not.toHaveBeenCalledWith("reset");
    expect(transport.close).not.toHaveBeenCalled();
    await expect(access(temporaryDirectory)).resolves.toBeUndefined();

    confirmExecutions();
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
    await expect(access(temporaryDirectory)).resolves.toBeUndefined();

    confirmService();
    await resetting;
    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the private directory through concurrent resets until the owned service transport closes", async () => {
    let temporaryDirectory = "";
    const executionsSettled = deferred();
    const resetRequestSettled = deferred();
    const serviceTerminated = deferred();
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async (operation) => {
        if (operation === "reset") await resetRequestSettled.promise;
        return undefined;
      }),
      notify: () => undefined,
      close: vi.fn(async () => serviceTerminated.promise),
    };
    const boundary = lifecycleBoundary(transport, (path) => { temporaryDirectory = path; });
    const terminateAndWait = vi.fn(async () => executionsSettled.promise);
    boundary.bindExecutionTerminationGate({ terminateAndWait });
    await boundary.open("/workspace");

    let firstSettled = false;
    let secondSettled = false;
    const firstReset = boundary.reset().finally(() => { firstSettled = true; });
    let secondReset: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(terminateAndWait).toHaveBeenCalledOnce());
      secondReset = boundary.reset().finally(() => { secondSettled = true; });

      executionsSettled.resolve();
      await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("reset"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      expect(transport.close).not.toHaveBeenCalled();
      await expect(access(temporaryDirectory)).resolves.toBeUndefined();

      resetRequestSettled.resolve();
      await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
      await expect(access(temporaryDirectory)).resolves.toBeUndefined();

      serviceTerminated.resolve();
      await Promise.all([firstReset, secondReset]);
      await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      executionsSettled.resolve();
      resetRequestSettled.resolve();
      serviceTerminated.resolve();
      await Promise.allSettled([firstReset, secondReset]);
      if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the private directory through concurrent poison and reset until the owned service transport closes", async () => {
    let temporaryDirectory = "";
    let cleanupStarted = false;
    const executionsSettled = deferred();
    const serviceTerminated = deferred();
    const poison = new Error("literal concurrent poison");
    poison.name = "SandboxRuntimeServicePoisonError";
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async (operation) => {
        if (operation === "violationsForCommand") throw poison;
        return undefined;
      }),
      notify: () => undefined,
      close: vi.fn(async () => serviceTerminated.promise),
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
      createTemporaryDirectory: async () => {
        const creation = await createSandlotSessionTemporaryDirectory();
        if (!creation.ok) return creation;
        const allocated = creation.directory;
        return {
          ok: true,
          directory: {
            path: allocated.path,
            cleanup: async () => {
              cleanupStarted = true;
              await allocated.cleanup();
            },
          },
        };
      },
    });
    const terminateAndWait = vi.fn(async () => executionsSettled.promise);
    boundary.bindExecutionTerminationGate({ terminateAndWait });
    await boundary.open("/workspace");

    let poisonSettled = false;
    let resetSettled = false;
    const poisonedRequest = boundary.collectViolations("literal-concurrent-command")
      .then(
        () => ({ ok: true as const, error: undefined }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => { poisonSettled = true; });
    let resetting: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(terminateAndWait).toHaveBeenCalledOnce());
      resetting = boundary.reset().finally(() => { resetSettled = true; });

      executionsSettled.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(poisonSettled).toBe(false);
      expect(resetSettled).toBe(false);
      expect(cleanupStarted).toBe(false);
      await expect(access(temporaryDirectory)).resolves.toBeUndefined();

      serviceTerminated.resolve();
      const [poisonResult] = await Promise.all([poisonedRequest, resetting]);
      expect(poisonResult).toMatchObject({ ok: false, error: expect.objectContaining({ message: "literal concurrent poison" }) });
      expect(transport.close).toHaveBeenCalledOnce();
      await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      executionsSettled.resolve();
      serviceTerminated.resolve();
      await Promise.allSettled([poisonedRequest, resetting]);
      if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("retains the private directory after poison when runner termination is indeterminate", async () => {
    let temporaryDirectory = "";
    const poison = new Error("literal service poison before runner failure");
    poison.name = "SandboxRuntimeServicePoisonError";
    const transport: SandboxRuntimeTransport = {
      request: vi.fn(async (operation) => {
        if (operation === "violationsForCommand") throw poison;
      }),
      notify: () => undefined,
      close: vi.fn(async () => undefined),
    };
    const boundary = lifecycleBoundary(transport, (path) => { temporaryDirectory = path; });
    const terminateAndWait = vi.fn(async () => {
      throw new Error("literal runner termination indeterminate");
    });
    boundary.bindExecutionTerminationGate({ terminateAndWait });

    try {
      await boundary.open("/workspace");

      await expect(boundary.collectViolations("literal-poison-command")).rejects.toThrow(
        "literal service poison before runner failure",
      );
      await vi.waitFor(() => expect(terminateAndWait).toHaveBeenCalledOnce());
      expect(transport.close).toHaveBeenCalledOnce();
      await expect(access(temporaryDirectory)).resolves.toBeUndefined();
      await expect(boundary.open("/workspace")).rejects.toThrow(/poisoned.*runner termination indeterminate/i);

      await expect(boundary.reset()).rejects.toThrow(
        "Sandbox Runtime could not confirm runner execution termination: literal runner termination indeterminate",
      );
      expect(terminateAndWait).toHaveBeenCalledOnce();
      await expect(access(temporaryDirectory)).resolves.toBeUndefined();
    } finally {
      if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("cleans after close confirms termination even when the reset request failed", async () => {
    let temporaryDirectory = "";
    const transport: SandboxRuntimeTransport = {
      request: async (operation) => {
        if (operation === "reset") throw new Error("literal reset request failure");
        return undefined;
      },
      notify: () => undefined,
      close: async () => undefined,
    };
    const boundary = lifecycleBoundary(transport, (path) => { temporaryDirectory = path; });
    await boundary.open("/workspace");

    await expect(boundary.reset()).rejects.toThrow("literal reset request failure");

    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the private directory after poison close uncertainty and retries termination before cleanup", async () => {
    let temporaryDirectory = "";
    let closeAttempt = 0;
    let confirmTermination: (() => void) | undefined;
    const poison = new Error("literal poisoned request");
    poison.name = "SandboxRuntimeServicePoisonError";
    const transport: SandboxRuntimeTransport = {
      request: async (operation) => {
        if (operation === "violationsForCommand") throw poison;
        return undefined;
      },
      notify: () => undefined,
      close: async () => {
        closeAttempt += 1;
        if (closeAttempt === 1) throw new Error("literal termination uncertainty");
        await new Promise<void>((resolve) => { confirmTermination = resolve; });
        await chmod(`${temporaryDirectory}/termination-gate`, 0o700);
      },
    };
    const boundary = lifecycleBoundary(transport, (path) => { temporaryDirectory = path; });
    await boundary.open("/workspace");
    await mkdir(`${temporaryDirectory}/termination-gate`, { mode: 0o700 });
    await chmod(`${temporaryDirectory}/termination-gate`, 0o755);

    await expect(boundary.collectViolations("literal-command"))
      .rejects.toThrow("Sandbox Runtime request failed and cleanup was indeterminate");
    await expect(access(temporaryDirectory)).resolves.toBeUndefined();

    let resetSettled = false;
    const retry = boundary.reset().finally(() => { resetSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeConfirmation = resetSettled;
    const existedBeforeConfirmation = await access(temporaryDirectory).then(() => true, () => false);
    confirmTermination?.();
    await retry;

    expect(settledBeforeConfirmation).toBe(false);
    expect(existedBeforeConfirmation).toBe(true);
    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the real private directory after poison and confirmed termination", async () => {
    let temporaryDirectory = "";
    const poison = new Error("literal poison with confirmed termination");
    poison.name = "SandboxRuntimeServicePoisonError";
    const transport: SandboxRuntimeTransport = {
      request: async (operation) => {
        if (operation === "violationsForCommand") throw poison;
        return undefined;
      },
      notify: () => undefined,
      close: async () => undefined,
    };
    const boundary = lifecycleBoundary(transport, (path) => { temporaryDirectory = path; });
    await boundary.open("/workspace");

    await expect(boundary.collectViolations("literal-command"))
      .rejects.toThrow("literal poison with confirmed termination");

    await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains cleanup authority after identity failure and safely retries the original directory", async () => {
    let temporaryDirectory = "";
    const transport: SandboxRuntimeTransport = {
      request: async () => undefined,
      notify: () => undefined,
      close: async () => undefined,
    };
    const boundary = lifecycleBoundary(transport, (path) => { temporaryDirectory = path; });
    const savedDirectory = { path: "" };
    try {
      await boundary.open("/workspace");
      savedDirectory.path = `${temporaryDirectory}-recorded`;
      await writeFile(`${temporaryDirectory}/recorded`, "literal-recorded-data", { mode: 0o600 });
      await rename(temporaryDirectory, savedDirectory.path);
      await mkdir(temporaryDirectory, { mode: 0o700 });
      await writeFile(`${temporaryDirectory}/replacement`, "literal-replacement-data", { mode: 0o600 });

      await expect(boundary.reset()).rejects.toThrow(
        "Sandlot temporary session directory identity changed; refusing cleanup",
      );
      await expect(access(`${temporaryDirectory}/replacement`)).resolves.toBeUndefined();
      await expect(access(`${savedDirectory.path}/recorded`)).resolves.toBeUndefined();

      await rm(temporaryDirectory, { recursive: true });
      await rename(savedDirectory.path, temporaryDirectory);
      await boundary.reset();
      await expect(access(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
      if (savedDirectory.path !== "") await rm(savedDirectory.path, { recursive: true, force: true });
    }
  });

  it("retains partial-creation cleanup ownership and retries it through boundary reset", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sandlot-boundary-partial-"));
    const root = join(parent, "sandlot");
    const uid = process.getuid!();
    const user = join(root, String(uid));
    const session = join(user, "session-boundary-partial");
    let corruptSessionMode = true;
    let failUserRemoval = true;
    const filesystem: SandlotTemporaryDirectoryFileSystem = {
      mkdir: async (path, mode) => { await mkdir(path, { mode }); },
      chmod,
      lstat: async (path) => {
        const status = await lstat(path);
        if (path !== session || !corruptSessionMode) return status;
        corruptSessionMode = false;
        return new Proxy(status, {
          get(target, property) {
            if (property === "mode") return 0o755;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      readdir: async (path) => readdir(path, { withFileTypes: true }),
      rmdir: async (path) => {
        if (path === user && failUserRemoval) {
          failUserRemoval = false;
          throw new Error("literal boundary rollback failure");
        }
        await rmdir(path);
      },
      unlink,
    };
    const options: SandboxRuntimeBoundaryOptions = {
      nodePath: "/trusted/node",
      servicePath: "/trusted/sandbox-runtime-service.js",
      platform: "darwin",
      hostEnvironment: {},
      createTransport: async () => {
        throw new Error("transport must not start after temporary-directory creation failure");
      },
      createTemporaryDirectory: () => createSandlotSessionTemporaryDirectory({
        root,
        uid,
        sessionId: "boundary-partial",
        filesystem,
      }),
    };
    const boundary = new SandboxRuntimeBoundary(options);

    try {
      const error = await boundary.open("/workspace").catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        "Error: Sandlot temporary session directory has unsafe permissions",
        "Error: literal boundary rollback failure",
      ]);
      await expect(access(session)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(user)).resolves.toBeUndefined();
      await expect(access(root)).resolves.toBeUndefined();

      await boundary.reset();
      await expect(access(user)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

function lifecycleBoundary(
  transport: SandboxRuntimeTransport,
  captureTemporaryDirectory: (path: string) => void,
): SandboxRuntimeBoundary {
  return new SandboxRuntimeBoundary({
    nodePath: "/trusted/node",
    servicePath: "/trusted/sandbox-runtime-service.js",
    platform: "darwin",
    hostEnvironment: {},
    createTransport: async (launch) => {
      captureTemporaryDirectory(launch.env.TMPDIR!);
      return transport;
    },
  });
}

function credentialConfig(name: string, mode: "deny" | "mask"): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: { denyRead: [], allowWrite: ["/workspace"], denyWrite: [] },
    credentials: { envVars: [{ name, mode }] },
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function deferredValue<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
