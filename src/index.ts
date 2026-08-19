import type { SandboxDependencyCheck, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createRequire } from "node:module";
import {
  createLocalBashOperations,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionContext,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { loadPolicyFiles, type LoadedPolicyFiles } from "./config.js";
import { renderDiagnosticSnapshot, redactDiagnosticText } from "./diagnostics.js";
import { buildChildEnvironment, sandlotMktempShimDirectory, type PiSessionEnvironment } from "./environment.js";
import { assertProtectedOwnership, evaluateToolCall, protectedToolSourcePaths } from "./guard.js";
import {
  FileWorkerClient,
  resolveFileWorkerPaths,
} from "./helpers/file-worker.js";
import {
  SearchWorkerClient,
  resolveSearchWorkerPaths,
} from "./helpers/search-worker.js";
import {
  composePolicy,
  toSandboxRuntimeConfig,
  validatePolicyForPlatform,
  type EffectivePolicy,
  type PolicyCompositionContext,
} from "./policy.js";
import { SandboxRunner, type SandboxManagerLike } from "./runner.js";
import { RuntimeController } from "./runtime.js";
import { SandboxRuntimeBoundary } from "./sandbox-runtime-boundary.js";
import { createSandlotUserBashOperations } from "./tools/bash.js";
import {
  pinnedPiImageProcessor,
  resolvePinnedPiImagePaths,
  type PinnedPiImageProcessor,
} from "./tools/files.js";
import { registerProtectedTools } from "./tools/index.js";
import {
  resolveExtensionTrustPaths,
  type ResolvedExtensionTrustPaths,
} from "./trust.js";

export { resolveExtensionTrustPaths } from "./trust.js";

interface ExtensionSandboxManager extends SandboxManagerLike {
  open(cwd: string): Promise<void>;
  updateConfig(config: SandboxRuntimeConfig): Promise<void>;
  getLinuxGlobPatternWarnings(): Promise<string[]>;
  checkDependenciesAsync(ripgrepConfig?: { command: string; args?: string[] }): Promise<SandboxDependencyCheck>;
  initialize(config: SandboxRuntimeConfig, askCallback?: undefined, enableLogMonitor?: boolean): Promise<void>;
  reset(): Promise<void>;
  getSandboxViolationStore(): SandboxManagerLike["getSandboxViolationStore"] extends (...args: never[]) => infer T
    ? T & { clear(): void; getViolations(limit?: number): Array<{ line: string }>; getTotalCount(): number }
    : never;
}

export interface ExtensionProcessState {
  managerActive: boolean;
  poisonedError: string | undefined;
}

export interface ExtensionDependencies {
  readonly runtime: RuntimeController;
  readonly runner: Pick<SandboxRunner, "run" | "abortAll">;
  readonly manager: ExtensionSandboxManager;
  readonly fileClient: FileWorkerClient;
  readonly searchClient: SearchWorkerClient;
  readonly imageProcessor: Pick<PinnedPiImageProcessor, "bind" | "clear" | "process" | "abortAll">;
  readonly loadPolicyFiles: (options: { cwd: string; projectTrusted: boolean }) => Promise<LoadedPolicyFiles>;
  readonly composePolicy: (
    user: NonNullable<LoadedPolicyFiles["user"]>,
    project: LoadedPolicyFiles["project"],
    context: PolicyCompositionContext,
  ) => Promise<EffectivePolicy>;
  readonly validatePolicyForPlatform: typeof validatePolicyForPlatform;
  readonly toSandboxRuntimeConfig: (policy: EffectivePolicy) => SandboxRuntimeConfig;
  readonly resolveWorkerPaths: (
    policy: EffectivePolicy,
    entryAliases: readonly string[],
  ) => Promise<ResolvedExtensionTrustPaths>;
  readonly resolveImageGraph: typeof resolvePinnedPiImagePaths;
  readonly processState: ExtensionProcessState;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly sandlotSourcePath: string;
  readonly createLocalBashOperations?: () => BashOperations;
  readonly buildChildEnvironment?: typeof buildChildEnvironment;
}

interface ExtensionSessionState {
  dependencyWarnings: string[];
  environment: PiSessionEnvironment | undefined;
}

export function createSandlotExtension(dependencies: ExtensionDependencies) {
  return function sandlot(pi: ExtensionAPI): void {
    const session: ExtensionSessionState = {
      dependencyWarnings: [],
      environment: undefined,
    };
    const childEnvironment = (): NodeJS.ProcessEnv => {
      const snapshot = dependencies.runtime.snapshot();
      if (snapshot.state !== "ready" || snapshot.policy === undefined) {
        throw new Error(`Sandlot runtime is not ready (${snapshot.state})`);
      }
      return (dependencies.buildChildEnvironment ?? buildChildEnvironment)(
        dependencies.hostEnvironment,
        snapshot.policy.environment,
        session.environment,
      );
    };
    const userBashOperations = createSandlotUserBashOperations({
      runner: dependencies.runner,
      runtime: dependencies.runtime,
      environment: childEnvironment,
      createLocalBashOperations: dependencies.createLocalBashOperations,
    });

    registerProtectedTools(pi, {
      runtime: dependencies.runtime,
      runner: dependencies.runner,
      fileClient: dependencies.fileClient,
      searchClient: dependencies.searchClient,
      environment: childEnvironment,
      processImage: dependencies.imageProcessor.process,
    });

    pi.on("session_start", async (_event, ctx) => {
      dependencies.imageProcessor.clear();
      const violationStore = dependencies.manager.getSandboxViolationStore();
      violationStore.clear();
      if (dependencies.processState.poisonedError !== undefined) {
        if (dependencies.runtime.snapshot().state !== "failed") {
          dependencies.runtime.markPoisoned(dependencies.processState.poisonedError);
        }
        if (ctx.hasUI) ctx.ui.setStatus("sandlot", "⚠ Sandlot poisoned");
        reportDiagnostic(
          ctx,
          `${diagnosticError(dependencies.processState.poisonedError)} Restart Pi before using protected operations.`,
          "error",
        );
        return;
      }
      dependencies.runtime.beginInitialization();
      session.dependencyWarnings = [];
      session.environment = sessionEnvironment(ctx);
      setStatus(ctx, "Sandlot initializing…");

      try {
        const loaded = await dependencies.loadPolicyFiles({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
        const policy = await dependencies.composePolicy(loaded.user ?? {}, loaded.project, { cwd: ctx.cwd });
        if (!policy.enabled) {
          dependencies.runtime.markDisabled();
          if (ctx.hasUI) ctx.ui.setStatus("sandlot", "🔓 Sandlot disabled");
          reportDiagnostic(
            ctx,
            "Sandlot is disabled by trusted user policy; protected operations will run locally.",
            "warning",
          );
          return;
        }

        assertSupportedPlatform(dependencies.platform);
        await dependencies.validatePolicyForPlatform(policy, dependencies.platform, dependencies.arch);
        const workerPaths = await dependencies.resolveWorkerPaths(policy, protectedToolSourcePaths(pi.getAllTools()));
        dependencies.imageProcessor.bind(workerPaths.imageProcessorPath);
        dependencies.searchClient.configureRgPath(workerPaths.rgPath);
        const config = withTrustedWorkerPaths(
          dependencies.toSandboxRuntimeConfig(policy),
          workerPaths.trustedReadPaths,
          workerPaths.immutablePaths,
          workerPaths.rgPath,
          workerPaths.seccompApplyPath,
          workerPaths.bwrapPath,
          workerPaths.socatPath,
        );
        dependencies.processState.managerActive = true;
        await dependencies.manager.open(ctx.cwd);
        // Sandbox Runtime 0.0.73 reads non-rg dependency paths from its
        // process-global config even in the explicit preflight API.
        await dependencies.manager.updateConfig(config);
        if (dependencies.platform === "linux") {
          const globWarnings = await dependencies.manager.getLinuxGlobPatternWarnings();
          if (globWarnings.length > 0) {
            throw new Error(`Sandbox Runtime rejected Linux filesystem patterns: ${globWarnings.join("; ")}`);
          }
        }
        const dependencyCheck = await dependencies.manager.checkDependenciesAsync(config.ripgrep);
        session.dependencyWarnings = [...dependencyCheck.warnings];
        if (dependencyCheck.errors.length > 0) {
          throw new Error(`Sandbox Runtime dependencies unavailable: ${dependencyCheck.errors.join("; ")}`);
        }
        if (
          dependencies.platform === "linux"
          && !policy.network.allowAllUnixSockets
          && dependencyCheck.warnings.some((warning) => /seccomp|unix socket/i.test(warning))
        ) {
          throw new Error(
            `Sandbox Runtime cannot enforce Unix-socket denial: ${dependencyCheck.warnings.join("; ")}`,
          );
        }

        await dependencies.manager.initialize(config, undefined, true);
        assertProtectedOwnership(pi.getAllTools(), dependencies.sandlotSourcePath);
        dependencies.runtime.markReady(policy);
        setStatus(ctx, "🔒 Sandlot");
        if (ctx.hasUI) {
          for (const warning of session.dependencyWarnings) ctx.ui.notify(redactDiagnosticText(warning), "warning");
        }
      } catch (error) {
        dependencies.imageProcessor.clear();
        dependencies.runtime.markFailed(error);
        if (dependencies.processState.managerActive) {
          try {
            await dependencies.manager.reset();
            dependencies.processState.managerActive = false;
          } catch (cleanupError) {
            dependencies.runtime.markPoisoned(cleanupError);
            dependencies.processState.poisonedError = dependencies.runtime.snapshot().error;
          }
        }
        const message = diagnosticError(dependencies.runtime.snapshot().error);
        if (ctx.hasUI) ctx.ui.setStatus("sandlot", "⚠ Sandlot failed");
        reportDiagnostic(ctx, message, "error");
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      dependencies.imageProcessor.clear();
      dependencies.manager.getSandboxViolationStore().clear();
      const state = dependencies.runtime.snapshot().state;
      if (state === "idle") {
        clearStatus(ctx);
        return;
      }
      dependencies.runtime.beginShutdown();
      let failure: unknown;
      try {
        await dependencies.runner.abortAll();
      } catch (error) {
        failure = error;
      }
      try {
        await dependencies.imageProcessor.abortAll();
      } catch (error) {
        failure ??= error;
      }
      if (dependencies.processState.managerActive) {
        try {
          await dependencies.manager.reset();
          dependencies.processState.managerActive = false;
        } catch (error) {
          failure ??= error;
        }
      }
      dependencies.manager.getSandboxViolationStore().clear();
      session.dependencyWarnings = [];
      session.environment = undefined;
      clearStatus(ctx);
      if (failure !== undefined) {
        dependencies.runtime.markPoisoned(failure);
        dependencies.processState.poisonedError = dependencies.runtime.snapshot().error;
        throw failure;
      }
      dependencies.runtime.finishShutdown();
    });

    pi.on("tool_call", (event) => {
      const snapshot = dependencies.runtime.snapshot();
      const decision = evaluateToolCall({
        toolName: event.toolName,
        state: snapshot.state,
        tools: pi.getAllTools(),
        sandlotSourcePath: dependencies.sandlotSourcePath,
        trustedCustomTools: snapshot.policy?.trustedCustomTools ?? [],
      });
      return decision.block ? { block: true, reason: decision.reason } : undefined;
    });

    pi.on("user_bash", (): UserBashEventResult => {
      const state = dependencies.runtime.snapshot().state;
      if (state === "ready" || state === "disabled-by-user") return { operations: userBashOperations };
      return {
        result: {
          output: `Sandlot blocked local shell execution because the runtime is ${state}. Run /sandlot for diagnostics.`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    });

    pi.registerCommand("sandlot", {
      description: "Show redacted Sandlot runtime diagnostics",
      handler: async (args, ctx) => {
        if (args.trim() === "graph") {
          try {
            const graph = dependencies.resolveImageGraph();
            reportDiagnostic(ctx, [
              "Sandlot image graph",
              `Pi: @earendil-works/pi-coding-agent@${graph.piVersion}`,
              `host anchored: ${graph.hostAnchored ? "yes" : "no"}`,
              `image modules: ${graph.imageModuleCount}`,
              "Photon module: present",
              "Photon WASM: present",
            ].join("\n"), "info");
          } catch (error: unknown) {
            reportDiagnostic(ctx, `Sandlot image graph validation failed: ${diagnosticError(error)}`, "error");
          }
          return;
        }
        const violations = dependencies.manager.getSandboxViolationStore().getViolations();
        reportDiagnostic(ctx, renderDiagnosticSnapshot({
          platform: dependencies.platform,
          runtime: dependencies.runtime.snapshot(),
          dependencyWarnings: session.dependencyWarnings,
          tools: pi.getAllTools(),
          sandlotSourcePath: dependencies.sandlotSourcePath,
          violations,
        }), "info");
      },
    });
    pi.registerCommand("sandlot-reload", {
      description: "Reload Pi and safely restart Sandlot",
      handler: async (_args, ctx) => ctx.reload(),
    });
  };
}

function createProductionDependencies(): ExtensionDependencies {
  const runtime = new RuntimeController();
  const manager = new SandboxRuntimeBoundary({
    nodePath: process.execPath,
    servicePath: fileURLToPath(new URL("./helpers/sandbox-runtime-service.js", import.meta.url)),
    platform: process.platform,
    hostEnvironment: process.env,
  }) as ExtensionSandboxManager;
  const runner = new SandboxRunner(manager, runtime);
  const fileClient = new FileWorkerClient(runner);
  const searchClient = new SearchWorkerClient(runner);
  return {
    runtime,
    manager,
    runner,
    fileClient,
    searchClient,
    imageProcessor: pinnedPiImageProcessor,
    loadPolicyFiles,
    composePolicy,
    validatePolicyForPlatform,
    toSandboxRuntimeConfig,
    resolveWorkerPaths: async (policy, entryAliases) => {
      const [filePaths, searchPaths] = await Promise.all([
        resolveFileWorkerPaths(),
        resolveSearchWorkerPaths({ rgPath: policy.ripgrep?.command }),
      ]);
      const imagePaths = resolvePinnedPiImagePaths();
      return resolveExtensionTrustPaths({
        entryPath: fileURLToPath(import.meta.url),
        nodePath: filePaths.nodePath,
        fileWorkerPath: filePaths.workerPath,
        searchWorkerPath: searchPaths.workerPath,
        rgPath: searchPaths.rgPath,
        sandboxRuntimeEntryPath: createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime"),
        piImageProcessorPath: imagePaths.imageProcessorPath,
        photonEntryPath: imagePaths.photonEntryPath,
        photonWasmPath: imagePaths.photonWasmPath,
        allowWritePaths: policy.filesystem.allowWrite,
        entryAliases,
        additionalExecutablePaths: [
          ...policyExecutablePaths(policy),
          ...(process.platform === "darwin" ? [`${sandlotMktempShimDirectory()}mktemp`] : []),
        ],
        filesystemDisabled: policy.filesystem.disabled,
        platform: process.platform,
        arch: process.arch,
        configuredSeccompApplyPath: policy.seccomp?.applyPath,
        configuredBwrapPath: policy.bwrapPath,
        configuredSocatPath: policy.socatPath,
      });
    },
    resolveImageGraph: resolvePinnedPiImagePaths,
    processState: productionProcessState(),
    platform: process.platform,
    arch: process.arch,
    hostEnvironment: process.env,
    sandlotSourcePath: fileURLToPath(import.meta.url),
    createLocalBashOperations,
    buildChildEnvironment,
  };
}

function policyExecutablePaths(policy: EffectivePolicy): string[] {
  return unique([
    policy.seccomp?.applyPath,
    policy.seccomp?.argv0,
    policy.bwrapPath,
    policy.socatPath,
  ].filter((path): path is string => path !== undefined));
}

function withTrustedWorkerPaths(
  config: SandboxRuntimeConfig,
  trustedReadPaths: readonly string[],
  immutablePaths: readonly string[],
  rgPath: string,
  seccompApplyPath?: string,
  bwrapPath?: string,
  socatPath?: string,
): SandboxRuntimeConfig {
  const staged: SandboxRuntimeConfig = {
    ...config,
    ripgrep: { ...config.ripgrep, command: rgPath },
    seccomp: seccompApplyPath === undefined
      ? config.seccomp
      : { ...config.seccomp, applyPath: seccompApplyPath },
    bwrapPath: bwrapPath ?? config.bwrapPath,
    socatPath: socatPath ?? config.socatPath,
    filesystem: {
      ...config.filesystem,
      allowRead: unique([
        ...(config.filesystem?.allowRead ?? []),
        ...trustedReadPaths,
        ...(seccompApplyPath === undefined ? [] : [seccompApplyPath]),
      ]),
      denyWrite: unique([
        ...(config.filesystem?.denyWrite ?? []),
        ...immutablePaths,
      ]),
    },
  };
  return {
    ...staged,
    filesystem: {
      ...staged.filesystem,
      denyWrite: unique([
        ...(staged.filesystem?.denyWrite ?? []),
        ...securityExecutablePaths(staged),
      ]),
    },
  };
}

function securityExecutablePaths(config: SandboxRuntimeConfig): string[] {
  return [
    config.ripgrep?.command,
    config.seccomp?.applyPath,
    config.seccomp?.argv0,
    config.bwrapPath,
    config.socatPath,
  ].filter((path): path is string => path !== undefined);
}

const PROCESS_STATE = Symbol.for("sandlot.extension.process-state.v1");

function productionProcessState(): ExtensionProcessState {
  const globals = globalThis as typeof globalThis & { [key: symbol]: ExtensionProcessState | undefined };
  globals[PROCESS_STATE] ??= { managerActive: false, poisonedError: undefined };
  return globals[PROCESS_STATE];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Sandlot supports macOS and Linux only (detected ${platform}).`);
  }
}

function sessionEnvironment(ctx: ExtensionContext): PiSessionEnvironment {
  return {
    PI_SESSION_ID: ctx.sessionManager.getSessionId(),
    PI_PROVIDER: ctx.model?.provider,
    PI_MODEL: ctx.model?.id,
  };
}

function setStatus(ctx: ExtensionContext, value: string): void {
  if (ctx.hasUI) ctx.ui.setStatus("sandlot", value);
}

function clearStatus(ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setStatus("sandlot", undefined);
}

function diagnosticError(error: unknown): string {
  const fallback = "Unknown Sandlot runtime initialization failure";
  const raw = error instanceof Error
    ? `${error.name.trim() || "Error"}: ${error.message.trim() || fallback}`
    : typeof error === "string" && error.trim() !== ""
      ? error
      : fallback;
  const value = redactDiagnosticText(raw);
  return value.startsWith("Error: ") ? value.slice("Error: ".length) : value;
}

function reportDiagnostic(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.error(message);
}

const sandlot = createSandlotExtension(createProductionDependencies());
export default sandlot;
