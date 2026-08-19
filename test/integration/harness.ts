import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { buildChildEnvironment } from "../../dist/environment.js";
import { evaluateToolCall } from "../../dist/guard.js";
import {
  FileWorkerClient,
  resolveFileWorkerPaths,
  type FileWorkerCallContext,
} from "../../dist/helpers/file-worker.js";
import {
  SearchWorkerClient,
  resolveSearchWorkerPaths,
} from "../../dist/helpers/search-worker.js";
import { resolveExtensionTrustPaths, type ResolvedExtensionTrustPaths } from "../../dist/trust.js";
import { composePolicy, toSandboxRuntimeConfig, type EffectivePolicy } from "../../dist/policy.js";
import { SandboxRunner, type RunResult } from "../../dist/runner.js";
import { RuntimeController } from "../../dist/runtime.js";
import { SandboxRuntimeBoundary } from "../../dist/sandbox-runtime-boundary.js";
import { createSandlotBashTool } from "../../dist/tools/bash.js";
import {
  createSandlotEditTool,
  createSandlotLsTool,
  createSandlotReadTool,
  createSandlotWriteTool,
  resolvePinnedPiImagePaths,
} from "../../dist/tools/files.js";
import { createSandlotFindTool, createSandlotGrepTool } from "../../dist/tools/search.js";
import type { UserPolicy } from "../../dist/config.js";

const ENTRY_PATH = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const SANDBOX_RUNTIME_SERVICE_PATH = fileURLToPath(
  new URL("../../dist/helpers/sandbox-runtime-service.js", import.meta.url),
);
const SANDBOX_RUNTIME_ENTRY_PATH = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime");
const SENTINEL_NAME = "SANDLOT_INTEGRATION_SECRET";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export const PROTECTED_TOOL_NAMES = ["bash", "read", "write", "edit", "ls", "find", "grep"] as const;
export type ProtectedToolName = typeof PROTECTED_TOOL_NAMES[number];

export interface SecurityFixturePaths {
  readonly root: string;
  readonly home: string;
  readonly homeCredential: string;
  readonly homePiCredential: string;
  readonly workspaceFile: string;
  readonly outsideFile: string;
  readonly projectPiFile: string;
  readonly gitHook: string;
  readonly gitConfig: string;
  readonly environmentFile: string;
  readonly immutableHelper: string;
  readonly immutableExecutable: string;
  readonly immutablePackageRoot: string;
}

export interface AbortableRun {
  readonly result: Promise<RunResult>;
  abort(): void;
}

export interface SecurityHarness {
  readonly workspace: string;
  readonly outside: string;
  readonly allowedUrl: string;
  readonly credentialEchoUrl: string;
  readonly sentinelName: string;
  readonly localFallbackCalls: string[];
  readonly paths: SecurityFixturePaths;
  readonly resourcePorts: readonly number[];
  run(command: string, policy?: UserPolicy): Promise<RunResult>;
  runWithId(command: string, invocationId: string, policy?: UserPolicy): Promise<RunResult>;
  start(command: string, policy?: UserPolicy): AbortableRun;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  violationsFor(invocationId: string): readonly string[];
  failInitialization(): Promise<void>;
  runtimeState(): string;
  invokeProtectedTool(name: ProtectedToolName, input?: unknown): Promise<unknown>;
  guardToolCall(name: ProtectedToolName): { block: true; reason: string } | undefined;
  replaceProtectedTool(name: ProtectedToolName): Promise<void>;
  probeUnsafeTrustTopology(): Promise<{ state: string; error: string | undefined; managerInitialized: boolean }>;
  dispose(): Promise<void>;
}

export interface HarnessInitialization {
  readonly root: string;
  readonly workspace: string;
  readonly outside: string;
  readonly server: Server;
  readonly port: number;
  readonly paths: SecurityFixturePaths;
  readonly useProductionBoundary?: boolean;
}

export type SecurityHarnessSetupStage = "root-created" | "fixtures-populated" | "server-listening";

export interface SecurityHarnessSetupState {
  readonly root: string;
  readonly server: Server;
  readonly port?: number;
}

export interface SecurityHarnessOptions {
  readonly symlinkProjectControlPlane?: boolean;
  readonly useProductionBoundary?: boolean;
  readonly setupCheckpoint?: (
    stage: SecurityHarnessSetupStage,
    state: SecurityHarnessSetupState,
  ) => void | Promise<void>;
}

interface MaterializedPolicy {
  readonly effective: EffectivePolicy;
  readonly config: SandboxRuntimeConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly key: string;
}

interface RegisteredTool {
  readonly definition: { readonly execute: unknown };
  sourcePath: string;
}

export async function createSecurityHarness(options: SecurityHarnessOptions = {}): Promise<SecurityHarness> {
  const createdRoot = await mkdtemp(join(tmpdir(), "sandlot-security-"));
  let server: Server | undefined;
  try {
    const root = await realpath(createdRoot);
    server = createServer((request, response) => {
      if (request.url === "/credential-echo?all=1") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          authorization: request.headers.authorization ?? "missing-authorization",
          claudeTmpdir: request.headers["x-claude-tmpdir"] ?? "missing-claude-tmpdir",
          claudeCodeTmpdir: request.headers["x-claude-code-tmpdir"] ?? "missing-claude-code-tmpdir",
          javaToolOptions: request.headers["x-java-tool-options"] ?? "missing-java-tool-options",
        }));
        return;
      }
      if (request.url === "/credential-echo") {
        response.end(request.headers.authorization ?? "missing-authorization");
        return;
      }
      response.end("allowed");
    });
    await options.setupCheckpoint?.("root-created", { root, server });

    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const home = join(root, "home");
    const immutablePackageRoot = join(root, "trusted-package");
    const immutableHelper = join(immutablePackageRoot, "helper.js");
    const immutableExecutable = join(root, "trusted-bin", "fixture-tool");
    const paths: SecurityFixturePaths = {
      root,
      home,
      homeCredential: join(home, ".ssh", "id_ed25519"),
      homePiCredential: join(home, ".pi", "agent", "auth.json"),
      workspaceFile: join(workspace, "readable.txt"),
      outsideFile: join(outside, "secret.txt"),
      projectPiFile: join(workspace, ".pi", "sandlot.json"),
      gitHook: join(workspace, ".git", "hooks", "pre-commit"),
      gitConfig: join(workspace, ".git", "config"),
      environmentFile: join(workspace, ".env"),
      immutableHelper,
      immutableExecutable,
      immutablePackageRoot,
    };

    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(outside),
      mkdir(dirname(paths.homeCredential), { recursive: true }),
      mkdir(dirname(paths.homePiCredential), { recursive: true }),
      mkdir(dirname(paths.gitHook), { recursive: true }),
      mkdir(immutablePackageRoot),
      mkdir(dirname(immutableExecutable), { recursive: true }),
    ]);
    if (options.symlinkProjectControlPlane) {
      const target = join(root, "symlinked-project-control-plane");
      await mkdir(target);
      await symlink(target, dirname(paths.projectPiFile), "dir");
    } else {
      await mkdir(dirname(paths.projectPiFile), { recursive: true });
    }
    await Promise.all([
      writeFile(paths.workspaceFile, "workspace-readable"),
      writeFile(paths.outsideFile, "outside-secret"),
      writeFile(paths.homeCredential, "fake-home-private-key"),
      writeFile(paths.homePiCredential, "fake-pi-token"),
      writeFile(paths.projectPiFile, "pi-policy"),
      writeFile(paths.gitHook, "protected-hook"),
      writeFile(paths.gitConfig, "protected-config"),
      writeFile(paths.environmentFile, "protected-env"),
      writeFile(paths.immutableHelper, "export const trusted = true;\n"),
      writeFile(paths.immutableExecutable, "#!/bin/sh\nprintf trusted\n"),
      writeFile(join(immutablePackageRoot, "package.json"), '{"name":"fixture-trust-root","type":"module"}\n'),
    ]);
    await chmod(paths.immutableExecutable, 0o755);
    await options.setupCheckpoint?.("fixtures-populated", { root, server });

    const port = await listenOnLoopback(server);
    await options.setupCheckpoint?.("server-listening", { root, server, port });
    return await createInitializedHarness({
      root,
      workspace,
      outside,
      server,
      port,
      paths,
      useProductionBoundary: options.useProductionBoundary,
    });
  } catch (error) {
    await Promise.allSettled([
      server === undefined ? Promise.resolve() : closeServer(server),
      rm(createdRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

export function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("loopback HTTP fixture did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function createInitializedHarness(input: HarnessInitialization): Promise<SecurityHarness> {
  await SandboxManager.reset();
  SandboxManager.getSandboxViolationStore().clear();

  const runtime = new RuntimeController();
  const [filePaths, searchPaths] = await Promise.all([
    resolveFileWorkerPaths(),
    resolveSearchWorkerPaths(),
  ]);
  const manager = input.useProductionBoundary === true
    ? new SandboxRuntimeBoundary({
      nodePath: filePaths.nodePath,
      servicePath: SANDBOX_RUNTIME_SERVICE_PATH,
      platform: process.platform,
      hostEnvironment: process.env,
    })
    : SandboxManager;
  const runner = new SandboxRunner(manager, runtime);
  const imagePaths = resolvePinnedPiImagePaths();
  const trustPaths = await resolveExtensionTrustPaths({
    entryPath: ENTRY_PATH,
    nodePath: filePaths.nodePath,
    fileWorkerPath: filePaths.workerPath,
    searchWorkerPath: searchPaths.workerPath,
    rgPath: searchPaths.rgPath,
    sandboxRuntimeEntryPath: SANDBOX_RUNTIME_ENTRY_PATH,
    piImageProcessorPath: imagePaths.imageProcessorPath,
    photonEntryPath: imagePaths.photonEntryPath,
    photonWasmPath: imagePaths.photonWasmPath,
    allowWritePaths: [input.workspace],
    entryAliases: [ENTRY_PATH],
    additionalExecutablePaths: [input.paths.immutableExecutable],
  });
  const idPrefix = `sandlot-it-${randomUUID()}`;
  const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  const fileClient = new FileWorkerClient(runner, {
    cwd: input.workspace,
    env: environment,
    nodePath: filePaths.nodePath,
    workerPath: filePaths.workerPath,
    createInvocationId: () => `${idPrefix}:file:${randomUUID()}`,
  });
  const searchClient = new SearchWorkerClient(runner, {
    cwd: input.workspace,
    env: environment,
    nodePath: searchPaths.nodePath,
    workerPath: searchPaths.workerPath,
    rgPath: searchPaths.rgPath,
    createInvocationId: () => `${idPrefix}:search:${randomUUID()}`,
  });
  const localFallbackCalls: string[] = [];
  const registered = createProtectedTools({
    runtime,
    runner,
    fileClient,
    searchClient,
    environment,
    localFallbackCalls,
  });
  const aliases = new Map<string, string>();
  let managerActive = false;
  let activeKey: string | undefined;
  let disposePromise: Promise<void> | undefined;

  const materialize = (policy?: UserPolicy): Promise<MaterializedPolicy> => materializePolicy(
    input,
    trustPaths,
    searchPaths.rgPath,
    policy,
  );

  const shutdownRuntime = async (): Promise<void> => {
    const state = runtime.snapshot().state;
    if (state !== "idle" && state !== "shutting-down") runtime.beginShutdown();
    if (runtime.snapshot().state === "shutting-down") {
      await runner.abortAll();
      await manager.reset();
      managerActive = false;
      manager.getSandboxViolationStore().clear();
      runtime.finishShutdown();
    } else {
      await manager.reset();
      managerActive = false;
      manager.getSandboxViolationStore().clear();
    }
    activeKey = undefined;
  };

  const activate = async (policy?: UserPolicy): Promise<void> => {
    const next = await materialize(policy);
    const snapshot = runtime.snapshot();
    if (snapshot.state === "ready" && activeKey === next.key) return;
    if (snapshot.state !== "idle") await shutdownRuntime();

    runtime.beginInitialization();
    replaceEnvironment(environment, next.environment);
    try {
      if (manager instanceof SandboxRuntimeBoundary && !managerActive) {
        await manager.open(input.workspace);
        managerActive = true;
      }
      if (manager instanceof SandboxRuntimeBoundary) {
        await manager.updateConfig(next.config, next.effective.networkMode);
      } else {
        await manager.updateConfig(next.config);
      }
      if (process.platform === "linux") {
        const globWarnings = await manager.getLinuxGlobPatternWarnings();
        if (globWarnings.length > 0) {
          throw new Error(`Sandbox Runtime rejected Linux filesystem patterns: ${globWarnings.join("; ")}`);
        }
      }
      const dependencies = await manager.checkDependenciesAsync(next.config.ripgrep);
      if (dependencies.errors.length > 0) {
        throw new Error(`Sandbox Runtime dependencies unavailable: ${dependencies.errors.join("; ")}`);
      }
      if (
        process.platform === "linux"
        && !next.effective.network.allowAllUnixSockets
        && dependencies.warnings.some((warning) => /seccomp|unix socket/i.test(warning))
      ) {
        throw new Error(`Sandbox Runtime cannot enforce Unix-socket denial: ${dependencies.warnings.join("; ")}`);
      }
      managerActive = true;
      if (manager instanceof SandboxRuntimeBoundary) {
        await manager.initialize(next.config, undefined, true, next.effective.networkMode);
      } else {
        await manager.initialize(next.config, undefined, true);
      }
      runtime.markReady(next.effective);
      activeKey = next.key;
    } catch (error) {
      if (runtime.snapshot().state === "initializing") runtime.markFailed(error);
      if (managerActive) await manager.reset();
      managerActive = false;
      activeKey = undefined;
      throw error;
    }
  };

  const runWithSignal = async (
    command: string,
    invocationId: string,
    policy: UserPolicy | undefined,
    signal: AbortSignal | undefined,
    exactInvocationId = false,
  ): Promise<RunResult> => {
    await activate(policy);
    const snapshot = runtime.snapshot();
    const commandId = exactInvocationId ? invocationId : `${idPrefix}:${invocationId}`;
    aliases.set(invocationId, commandId);
    return runner.run({
      invocationId: commandId,
      expectedGeneration: snapshot.generation,
      command,
      commandText: command,
      cwd: input.workspace,
      env: { ...environment },
      signal,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  };

  await activate();

  return {
    workspace: input.workspace,
    outside: input.outside,
    allowedUrl: `http://127.0.0.1:${input.port}/allowed`,
    credentialEchoUrl: `http://127.0.0.1:${input.port}/credential-echo`,
    sentinelName: SENTINEL_NAME,
    localFallbackCalls,
    paths: input.paths,
    get resourcePorts() {
      return Object.freeze(uniqueNumbers([
        input.port,
        ...(manager instanceof SandboxRuntimeBoundary
          ? []
          : [manager.getProxyPort(), manager.getSocksProxyPort()]),
      ]));
    },
    run(command, policy) {
      return runWithSignal(command, `run:${randomUUID()}`, policy, undefined);
    },
    runWithId(command, invocationId, policy) {
      return runWithSignal(command, invocationId, policy, undefined, true);
    },
    start(command, policy) {
      const controller = new AbortController();
      return {
        result: runWithSignal(command, `abortable:${randomUUID()}`, policy, controller.signal),
        abort: () => controller.abort(),
      };
    },
    async read(path) {
      await activate();
      return fileClient.readText(path, workerContext(runtime, idPrefix));
    },
    async write(path, content) {
      await activate();
      await fileClient.write(path, content, true, workerContext(runtime, idPrefix));
    },
    violationsFor(invocationId) {
      const full = aliases.get(invocationId) ?? invocationId;
      return manager.getSandboxViolationStore().getViolationsForCommand(full).map(({ line }) => line);
    },
    async failInitialization() {
      await shutdownRuntime();
      const good = await materialize();
      const bad: SandboxRuntimeConfig = {
        ...good.config,
        network: {
          ...good.config.network,
          tlsTerminate: {},
          mitmProxy: {
            socketPath: join(input.root, "mutually-exclusive-mitm.sock"),
            domains: ["fixture.invalid"],
          },
        },
      };
      runtime.beginInitialization();
      let initializationError: unknown;
      try {
        if (manager instanceof SandboxRuntimeBoundary && !managerActive) {
          await manager.open(input.workspace);
          managerActive = true;
        }
        if (manager instanceof SandboxRuntimeBoundary) {
          await manager.updateConfig(bad, good.effective.networkMode);
        } else {
          await manager.updateConfig(bad);
        }
        const dependencies = await manager.checkDependenciesAsync(good.config.ripgrep);
        if (dependencies.errors.length > 0) {
          throw new Error(`Sandbox Runtime dependencies unavailable: ${dependencies.errors.join("; ")}`);
        }
        managerActive = true;
        if (manager instanceof SandboxRuntimeBoundary) {
          await manager.initialize(bad, undefined, true, good.effective.networkMode);
        } else {
          await manager.initialize(bad, undefined, true);
        }
      } catch (error) {
        initializationError = error;
      }
      if (managerActive) await manager.reset();
      managerActive = false;
      activeKey = undefined;
      if (initializationError === undefined) {
        const error = new Error("Sandbox Runtime unexpectedly accepted mutually exclusive network modes");
        runtime.markFailed(error);
        throw error;
      }
      runtime.markFailed(initializationError);
    },
    runtimeState() {
      return runtime.snapshot().state;
    },
    async invokeProtectedTool(name, requestedInput) {
      const tool = registered.get(name);
      if (tool === undefined) throw new Error(`missing protected tool ${name}`);
      const inputValue = requestedInput ?? protectedToolInput(name, input.paths);
      const execute = tool.definition.execute as (
        id: string,
        args: unknown,
        signal: AbortSignal | undefined,
        onUpdate: (value: unknown) => void,
        context: unknown,
      ) => Promise<unknown>;
      return execute(`${idPrefix}:tool:${name}`, inputValue, undefined, () => undefined, {
        cwd: input.workspace,
        model: { input: ["text"] },
      });
    },
    guardToolCall(name) {
      const snapshot = runtime.snapshot();
      const decision = evaluateToolCall({
        toolName: name,
        state: snapshot.state,
        tools: [...registered].map(([toolName, tool]) => ({
          name: toolName,
          description: `${toolName} integration fixture`,
          sourceInfo: { source: "extension", path: tool.sourcePath },
        })),
        sandlotSourcePath: ENTRY_PATH,
        trustedCustomTools: snapshot.policy?.trustedCustomTools ?? [],
      });
      return decision.block ? decision : undefined;
    },
    async replaceProtectedTool(name) {
      const attackerPath = join(input.root, `replacement-${name}.js`);
      await writeFile(attackerPath, "export default {};\n");
      const tool = registered.get(name);
      if (tool === undefined) throw new Error(`missing protected tool ${name}`);
      tool.sourcePath = attackerPath;
    },
    async probeUnsafeTrustTopology() {
      const probe = new RuntimeController();
      probe.beginInitialization();
      let managerInitialized = false;
      try {
        await resolveExtensionTrustPaths({
          entryPath: ENTRY_PATH,
          nodePath: filePaths.nodePath,
          fileWorkerPath: filePaths.workerPath,
          searchWorkerPath: searchPaths.workerPath,
          rgPath: searchPaths.rgPath,
          sandboxRuntimeEntryPath: SANDBOX_RUNTIME_ENTRY_PATH,
          piImageProcessorPath: imagePaths.imageProcessorPath,
          photonEntryPath: imagePaths.photonEntryPath,
          photonWasmPath: imagePaths.photonWasmPath,
          allowWritePaths: [dirname(ENTRY_PATH)],
          entryAliases: [ENTRY_PATH],
        });
        const currentPolicy = runtime.snapshot().policy;
        if (currentPolicy === undefined) throw new Error("integration runtime policy disappeared");
        probe.markReady(currentPolicy);
      } catch (error) {
        probe.markFailed(error);
      }
      const snapshot = probe.snapshot();
      return { state: snapshot.state, error: snapshot.error, managerInitialized };
    },
    dispose() {
      disposePromise ??= (async () => {
        const failures: unknown[] = [];
        try {
          await shutdownRuntime();
        } catch (error) {
          failures.push(error);
        }
        try {
          await closeServer(input.server);
        } catch (error) {
          failures.push(error);
        }
        try {
          await rm(input.root, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) throw new AggregateError(failures, "security harness cleanup failed");
      })();
      return disposePromise;
    },
  };
}

async function materializePolicy(
  input: HarnessInitialization,
  trustPaths: ResolvedExtensionTrustPaths,
  rgPath: string,
  requested: UserPolicy | undefined,
): Promise<MaterializedPolicy> {
  const requestedFilesystem = requested?.filesystem;
  if (requestedFilesystem?.disabled === true) throw new Error("integration policies cannot disable filesystem enforcement");
  if (requestedFilesystem?.allowWrite?.some((path) => path !== input.workspace)) {
    throw new Error("integration policies may grant writes only to the fixture workspace");
  }

  const user: UserPolicy = {
    ...requested,
    enabled: true,
    network: {
      allowedDomains: requested?.network?.allowedDomains ?? [],
      deniedDomains: requested?.network?.deniedDomains ?? [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
      ...requested?.network,
    },
    filesystem: {
      disabled: false,
      denyRead: uniqueStrings([
        dirname(input.paths.homeCredential),
        join(input.paths.home, ".pi"),
        ...(requestedFilesystem?.denyRead ?? []),
      ]),
      allowRead: uniqueStrings([
        input.workspace,
        input.paths.immutablePackageRoot,
        input.paths.immutableExecutable,
        ...(requestedFilesystem?.allowRead ?? []),
      ]),
      allowWrite: requestedFilesystem?.allowWrite ?? [input.workspace],
      denyWrite: uniqueStrings([
        input.paths.projectPiFile,
        dirname(input.paths.projectPiFile),
        input.paths.gitHook,
        dirname(input.paths.gitHook),
        input.paths.gitConfig,
        input.paths.environmentFile,
        input.paths.immutableHelper,
        input.paths.immutableExecutable,
        input.paths.immutablePackageRoot,
        ...(requestedFilesystem?.denyWrite ?? []),
      ]),
      allowGitConfig: false,
    },
    credentials: {
      ...requested?.credentials,
      files: [
        { path: input.paths.homeCredential, mode: "deny" },
        { path: input.paths.homePiCredential, mode: "deny" },
        ...(requested?.credentials?.files ?? []),
      ],
      envVars: [
        { name: SENTINEL_NAME, mode: "deny" },
        ...(requested?.credentials?.envVars ?? []),
      ],
    },
    environment: {
      ...requested?.environment,
      deny: uniqueStrings([SENTINEL_NAME, ...(requested?.environment?.deny ?? [])]),
    },
    ripgrep: { command: rgPath },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  };
  const effective = await composePolicy(user, undefined, {
    cwd: input.workspace,
    agentDir: join(input.paths.home, ".pi", "agent"),
  });
  const baseConfig = toSandboxRuntimeConfig(effective);
  const config: SandboxRuntimeConfig = {
    ...baseConfig,
    ripgrep: { ...baseConfig.ripgrep, command: trustPaths.rgPath },
    seccomp: trustPaths.seccompApplyPath === undefined
      ? baseConfig.seccomp
      : { ...baseConfig.seccomp, applyPath: trustPaths.seccompApplyPath },
    bwrapPath: trustPaths.bwrapPath ?? baseConfig.bwrapPath,
    socatPath: trustPaths.socatPath ?? baseConfig.socatPath,
    filesystem: {
      ...baseConfig.filesystem,
      allowRead: uniqueStrings([
        ...(baseConfig.filesystem.allowRead ?? []),
        ...trustPaths.trustedReadPaths,
        input.paths.immutablePackageRoot,
        input.paths.immutableExecutable,
      ]),
      allowWrite: [input.workspace],
      denyWrite: uniqueStrings([
        ...baseConfig.filesystem.denyWrite,
        ...trustPaths.immutablePaths,
        trustPaths.rgPath,
        ...(trustPaths.seccompApplyPath === undefined ? [] : [trustPaths.seccompApplyPath]),
        ...(trustPaths.bwrapPath === undefined ? [] : [trustPaths.bwrapPath]),
        ...(trustPaths.socatPath === undefined ? [] : [trustPaths.socatPath]),
        input.paths.immutablePackageRoot,
        input.paths.immutableHelper,
        input.paths.immutableExecutable,
      ]),
    },
  };
  if (config.filesystem.allowWrite.some((path) => path === input.root || path === dirname(input.root))) {
    throw new Error("integration policy widened writes to a fixture parent");
  }
  const hostEnvironment = { ...process.env, HOME: input.paths.home, [SENTINEL_NAME]: "must-not-cross-boundary" };
  const childEnvironment = buildChildEnvironment(hostEnvironment, effective.environment);
  childEnvironment.HOME = input.paths.home;
  return {
    effective,
    config,
    environment: childEnvironment,
    key: stablePolicyKey(config),
  };
}

function createProtectedTools(input: {
  runtime: RuntimeController;
  runner: SandboxRunner;
  fileClient: FileWorkerClient;
  searchClient: SearchWorkerClient;
  environment: NodeJS.ProcessEnv;
  localFallbackCalls: string[];
}): Map<ProtectedToolName, RegisteredTool> {
  const localFileFactory = (name: string) => () => {
    input.localFallbackCalls.push(name);
    return new Proxy({}, { get: () => async () => undefined });
  };
  const localSearchFactory = (name: string) => () => {
    input.localFallbackCalls.push(name);
    return { execute: async () => ({ content: [], details: undefined }) };
  };
  const tools = new Map<ProtectedToolName, RegisteredTool>();
  tools.set("bash", {
    definition: createSandlotBashTool({
      runtime: input.runtime,
      runner: input.runner,
      environment: () => ({ ...input.environment }),
      createLocalBashOperations: () => ({
        exec: async () => {
          input.localFallbackCalls.push("bash");
          return { exitCode: 0 };
        },
      }),
    }),
    sourcePath: ENTRY_PATH,
  });
  tools.set("read", {
    definition: createSandlotReadTool({
      runtime: input.runtime,
      client: input.fileClient,
      createLocalReadOperations: localFileFactory("read") as never,
    }),
    sourcePath: ENTRY_PATH,
  });
  tools.set("write", {
    definition: createSandlotWriteTool({
      runtime: input.runtime,
      client: input.fileClient,
      createLocalWriteOperations: localFileFactory("write") as never,
    }),
    sourcePath: ENTRY_PATH,
  });
  tools.set("edit", {
    definition: createSandlotEditTool({
      runtime: input.runtime,
      client: input.fileClient,
      createLocalEditOperations: localFileFactory("edit") as never,
    }),
    sourcePath: ENTRY_PATH,
  });
  tools.set("ls", {
    definition: createSandlotLsTool({
      runtime: input.runtime,
      client: input.fileClient,
      createLocalLsOperations: localFileFactory("ls") as never,
    }),
    sourcePath: ENTRY_PATH,
  });
  tools.set("find", {
    definition: createSandlotFindTool({
      runtime: input.runtime,
      client: input.searchClient,
      createLocalFindTool: localSearchFactory("find") as never,
    }),
    sourcePath: ENTRY_PATH,
  });
  tools.set("grep", {
    definition: createSandlotGrepTool({
      runtime: input.runtime,
      client: input.searchClient,
      createLocalGrepTool: localSearchFactory("grep") as never,
    }),
    sourcePath: ENTRY_PATH,
  });
  return tools;
}

function protectedToolInput(name: ProtectedToolName, paths: SecurityFixturePaths): unknown {
  switch (name) {
    case "bash": return { command: "printf protected-tool" };
    case "read": return { path: paths.workspaceFile };
    case "write": return { path: join(dirname(paths.workspaceFile), "tool-write.txt"), content: "tool-write" };
    case "edit": return { path: paths.workspaceFile, oldText: "workspace-readable", newText: "workspace-edited" };
    case "ls": return { path: dirname(paths.workspaceFile) };
    case "find": return { path: dirname(paths.workspaceFile), pattern: "**/*", limit: 10 };
    case "grep": return { path: dirname(paths.workspaceFile), pattern: "workspace", limit: 10 };
  }
}

function workerContext(runtime: RuntimeController, idPrefix: string): FileWorkerCallContext {
  const snapshot = runtime.snapshot();
  if (snapshot.state !== "ready") throw new Error(`Sandlot runtime is not ready (${snapshot.state})`);
  let index = 0;
  return {
    expectedGeneration: snapshot.generation,
    signal: undefined,
    nextInvocationId: () => `${idPrefix}:worker:${index++}:${randomUUID()}`,
  };
}

function replaceEnvironment(target: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function stablePolicyKey(config: SandboxRuntimeConfig): string {
  return JSON.stringify(config);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: readonly (number | undefined)[]): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined))];
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
