import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { registerAwsPairs } from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-aws-pairs.js";
import { buildMaskedEnvVars } from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-mask-env.js";
import { stripDomainPatternPort } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import type { NetworkMode } from "../config.js";

interface ServiceManager {
  updateConfig(config: SandboxRuntimeConfig): void;
  checkDependenciesAsync(ripgrepConfig?: { command: string; args?: string[] }): Promise<unknown>;
  initialize(
    config: SandboxRuntimeConfig,
    askCallback?: SandboxAskCallback,
    enableLogMonitor?: boolean,
  ): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    signal?: AbortSignal,
    cwd?: string,
    options?: { commandId?: string; commandText?: string },
  ): Promise<unknown>;
  cleanupAfterCommand(): void;
  getLinuxGlobPatternWarnings(): string[];
  getSandboxViolationStore(): {
    clear(): void;
    getViolationsForCommand(commandId: string): Array<{ line: string }>;
  };
  getSentinelRegistry(): ReturnType<typeof SandboxManager.getSentinelRegistry>;
  getAwsPairRegistry(): ReturnType<typeof SandboxManager.getAwsPairRegistry>;
  reset(): Promise<void>;
}

interface ServiceSessionState {
  lifecycleGeneration: number;
  managerLifecycleTail: Promise<void>;
  managerLifecycleBarrierError: Error | undefined;
  credentialEnvironment: NodeJS.ProcessEnv;
  config: SandboxRuntimeConfig | undefined;
  stagedNetworkMode: NetworkMode | undefined;
  initializingNetworkMode: NetworkMode | undefined;
  initializedNetworkMode: NetworkMode | undefined;
  activeOperations: number;
}

const serviceStates = new WeakMap<ServiceManager, ServiceSessionState>();

function serviceState(manager: ServiceManager): ServiceSessionState {
  let state = serviceStates.get(manager);
  if (state === undefined) {
    state = {
      lifecycleGeneration: 0,
      managerLifecycleTail: Promise.resolve(),
      managerLifecycleBarrierError: undefined,
      credentialEnvironment: Object.create(null) as NodeJS.ProcessEnv,
      config: undefined,
      stagedNetworkMode: undefined,
      initializingNetworkMode: undefined,
      initializedNetworkMode: undefined,
      activeOperations: 0,
    };
    serviceStates.set(manager, state);
  }
  return state;
}

function queueManagerLifecycle<T>(
  state: ServiceSessionState,
  operation: () => Promise<T> | T,
): Promise<T> {
  const queuedOperation = state.managerLifecycleTail.then(operation);
  state.managerLifecycleTail = queuedOperation.then(
    () => undefined,
    () => undefined,
  );
  return queuedOperation;
}

type ServiceOperation =
  | "updateConfig"
  | "checkDependencies"
  | "initialize"
  | "wrap"
  | "violationsForCommand"
  | "cleanupAfterCommand"
  | "linuxGlobPatternWarnings"
  | "clearViolations"
  | "reset";

const SERVICE_OPERATION_TIMEOUTS: Readonly<Record<ServiceOperation, number>> = Object.freeze({
  updateConfig: 4_500,
  checkDependencies: 29_000,
  initialize: 29_000,
  wrap: 29_000,
  violationsForCommand: 4_500,
  cleanupAfterCommand: 4_500,
  linuxGlobPatternWarnings: 4_500,
  clearViolations: 4_500,
  reset: 4_500,
});
const MAX_ACTIVE_OPERATIONS = 64;
const MAX_IPC_MESSAGE_BYTES = 1024 * 1024;
const MAX_IPC_DATA_DEPTH = 20;
const MAX_IPC_DATA_NODES = 16_384;
const MAX_CREDENTIAL_ENVIRONMENT_NAMES = 128;
const MAX_CREDENTIAL_VALUE_BYTES = 256 * 1024;
const allowAllNetwork: SandboxAskCallback = async () => true;

interface ServiceRequestDependencies {
  readonly scanMandatoryDenyPaths: (
    ripgrepCommand: string,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly operationTimeouts?: Partial<Record<ServiceOperation, number>>;
}

// SRT 0.0.73 roots its built-in mandatory control-path denies at
// process.cwd(), rather than at the cwd argument passed to wrapWithSandboxArgv.
// Serialize only the short wrapping phase while temporarily selecting the
// invocation root. Commands run after the descriptor is returned, so command
// execution remains concurrent and the service cwd is never shared between
// overlapping upstream scans/profile generation.
let wrapWorkingDirectoryTail: Promise<void> = Promise.resolve();

export async function handleSandboxRuntimeRequest(
  manager: ServiceManager,
  operation: string,
  payload: unknown,
  signal?: AbortSignal,
  dependencies: ServiceRequestDependencies = { scanMandatoryDenyPaths: runMandatoryDenyScan },
): Promise<unknown> {
  const serviceOperation = requiredServiceOperation(operation);
  assertIpcData(payload, `Sandbox Runtime service ${serviceOperation} payload`);
  const state = serviceState(manager);
  const requestCredentialEnvironment = credentialEnvironmentForRequest(
    serviceOperation,
    payload,
  ) ?? state.credentialEnvironment;
  if (signal?.aborted) throw new Error("aborted");
  if (state.activeOperations >= MAX_ACTIVE_OPERATIONS) {
    throw new Error(`Sandbox Runtime service active operation limit (${MAX_ACTIVE_OPERATIONS}) exceeded`);
  }
  state.activeOperations++;
  const operationController = new AbortController();
  const forwardAbort = (): void => operationController.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const operationPromise = dispatchSandboxRuntimeRequest(
    manager,
    state,
    serviceOperation,
    payload,
    operationController.signal,
    dependencies,
  ).finally(() => { state.activeOperations--; });
  const timeoutMs = requiredTimeout(
    dependencies.operationTimeouts?.[serviceOperation] ?? SERVICE_OPERATION_TIMEOUTS[serviceOperation],
    `${serviceOperation} operation timeout`,
  );
  try {
    const result = await withOperationDeadline(
      operationPromise,
      serviceOperation,
      timeoutMs,
      () => operationController.abort(),
    );
    assertNoCredentialValues(result, requestCredentialEnvironment, "Sandbox Runtime service response");
    return result;
  } catch (error: unknown) {
    throw redactCredentialError(error, requestCredentialEnvironment);
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function dispatchSandboxRuntimeRequest(
  manager: ServiceManager,
  state: ServiceSessionState,
  operation: ServiceOperation,
  payload: unknown,
  signal: AbortSignal | undefined,
  dependencies: ServiceRequestDependencies,
): Promise<unknown> {
  switch (operation) {
    case "updateConfig": {
      const record = requiredPayloadRecord(
        payload,
        ["config", "networkMode", "credentialEnvironment"],
        ["config", "networkMode"],
      );
      const config = requiredConfig(record.config);
      const networkMode = requiredNetworkMode(record.networkMode);
      assertNetworkModeConfigPair(networkMode, config);
      if (state.initializingNetworkMode !== undefined || state.initializedNetworkMode !== undefined) {
        throw new Error("Sandbox Runtime service config cannot change after initialization begins");
      }
      const credentialEnvironment = requiredCredentialEnvironment(record.credentialEnvironment, config);
      manager.updateConfig(config);
      state.credentialEnvironment = credentialEnvironment;
      state.config = config;
      state.stagedNetworkMode = networkMode;
      return undefined;
    }
    case "checkDependencies": {
      const record = requiredPayloadRecord(payload, ["ripgrepConfig"]);
      return manager.checkDependenciesAsync(optionalRipgrepConfig(record.ripgrepConfig));
    }
    case "initialize": {
      const record = requiredPayloadRecord(
        payload,
        ["config", "networkMode", "enableLogMonitor", "credentialEnvironment"],
        ["config", "networkMode"],
      );
      const config = requiredConfig(record.config);
      const networkMode = requiredNetworkMode(record.networkMode);
      assertNetworkModeConfigPair(networkMode, config);
      if (state.initializingNetworkMode !== undefined || state.initializedNetworkMode !== undefined) {
        throw new Error("Sandbox Runtime service is already initialized");
      }
      if (state.stagedNetworkMode !== undefined && state.stagedNetworkMode !== networkMode) {
        throw new Error("Sandbox Runtime service initialization network mode does not match staged config");
      }
      const credentialEnvironment = requiredCredentialEnvironment(record.credentialEnvironment, config);
      if (record.enableLogMonitor !== undefined && typeof record.enableLogMonitor !== "boolean") {
        throw new Error("Sandbox Runtime service enableLogMonitor must be boolean");
      }
      const initializationGeneration = state.lifecycleGeneration;
      state.initializingNetworkMode = networkMode;
      try {
        await queueManagerLifecycle(state, async () => {
          if (state.managerLifecycleBarrierError !== undefined) {
            throw state.managerLifecycleBarrierError;
          }
          await manager.initialize(
            config,
            networkMode === "unrestricted" ? allowAllNetwork : undefined,
            record.enableLogMonitor === true,
          );
        });
        if (state.lifecycleGeneration !== initializationGeneration) {
          throw new Error("Sandbox Runtime service initialization was cancelled by reset");
        }
        state.credentialEnvironment = credentialEnvironment;
        state.config = config;
        state.stagedNetworkMode = networkMode;
        state.initializedNetworkMode = networkMode;
      } finally {
        if (state.lifecycleGeneration === initializationGeneration) {
          state.initializingNetworkMode = undefined;
        }
      }
      return undefined;
    }
    case "wrap": {
      const record = requiredPayloadRecord(
        payload,
        ["command", "binShell", "cwd", "options", "mandatoryScan"],
        ["command", "cwd"],
      );
      if (state.initializedNetworkMode === undefined) {
        throw new Error("Sandbox Runtime service cannot wrap before it has initialized");
      }
      const wrapCwd = requiredAbsolutePath(record.cwd, "wrap cwd");
      if (record.mandatoryScan !== undefined) {
        const mandatoryScan = requiredPayloadRecord(
          record.mandatoryScan,
          ["ripgrepCommand"],
          ["ripgrepCommand"],
        );
        await dependencies.scanMandatoryDenyPaths(
          requiredAbsolutePath(mandatoryScan.ripgrepCommand, "mandatory scan ripgrep command"),
          wrapCwd,
          signal,
        );
      }
      const command = requiredString(record.command, "wrap command");
      const binShell = optionalString(record.binShell, "wrap shell") ?? "/bin/bash";
      const credentialMasking = prepareExplicitCredentialMasking(manager, state);
      const confinedCommand = buildCredentialOverlayCommand(
        command,
        binShell,
        credentialMasking.setEnvVars,
        credentialMasking.degradeToUnsetNames,
      );
      const descriptor = await withInvocationWorkingDirectory(wrapCwd, () =>
        manager.wrapWithSandboxArgv(
          confinedCommand,
          binShell,
          credentialMasking.runtimeConfig,
          signal,
          wrapCwd,
          optionalWrapOptions(record.options),
        ));
      return sanitizedWrapDescriptor(descriptor, state.credentialEnvironment);
    }
    case "violationsForCommand": {
      const record = requiredPayloadRecord(payload, ["commandId"], ["commandId"]);
      return sanitizedViolationLines(
        manager.getSandboxViolationStore().getViolationsForCommand(
          requiredString(record.commandId, "violation command ID"),
        ),
        state.credentialEnvironment,
      );
    }
    case "cleanupAfterCommand":
      requireNoPayload(payload, operation);
      manager.cleanupAfterCommand();
      return undefined;
    case "linuxGlobPatternWarnings":
      requireNoPayload(payload, operation);
      return manager.getLinuxGlobPatternWarnings();
    case "clearViolations":
      requireNoPayload(payload, operation);
      manager.getSandboxViolationStore().clear();
      return undefined;
    case "reset":
      requireNoPayload(payload, operation);
      const resetCredentialEnvironment = state.credentialEnvironment;
      const resetOvertakesInitialization = state.initializingNetworkMode !== undefined;
      state.lifecycleGeneration++;
      state.credentialEnvironment = Object.create(null) as NodeJS.ProcessEnv;
      state.config = undefined;
      state.stagedNetworkMode = undefined;
      state.initializingNetworkMode = undefined;
      state.initializedNetworkMode = undefined;
      try {
        const resetManager = queueManagerLifecycle(state, async () => {
          try {
            await manager.reset();
            state.managerLifecycleBarrierError = undefined;
          } catch (error: unknown) {
            const barrierError = redactCredentialError(error, resetCredentialEnvironment);
            state.managerLifecycleBarrierError = barrierError;
            throw barrierError;
          }
        });
        if (resetOvertakesInitialization) {
          void resetManager.catch(() => undefined);
          return undefined;
        }
        await resetManager;
      } catch (error: unknown) {
        throw redactCredentialError(error, resetCredentialEnvironment);
      }
      return undefined;
  }
}

async function withOperationDeadline<T>(
  promise: Promise<T>,
  operation: ServiceOperation,
  timeoutMs: number,
  onTimeout: () => void = () => undefined,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new ServicePoisonError(
            `Sandbox Runtime service ${operation} operation timed out after ${timeoutMs}ms`,
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class ServicePoisonError extends Error {
  override name = "SandboxRuntimeServicePoisonError";
}

function prepareExplicitCredentialMasking(
  manager: ServiceManager,
  state: ServiceSessionState,
): {
  setEnvVars: Record<string, string>;
  degradeToUnsetNames: string[];
  runtimeConfig: Partial<SandboxRuntimeConfig> | undefined;
} {
  const credentials = state.config?.credentials;
  if (credentials === undefined) {
    return { setEnvVars: {}, degradeToUnsetNames: [], runtimeConfig: undefined };
  }
  const defaultInjectHosts = [...new Set(
    (state.config?.network?.allowedDomains ?? []).map(stripDomainPatternPort),
  )];
  const result = buildMaskedEnvVars(
    credentials.envVars ?? [],
    defaultInjectHosts,
    manager.getSentinelRegistry(),
    state.credentialEnvironment,
  );
  registerAwsPairs(
    credentials.envVars ?? [],
    credentials.awsPairs,
    defaultInjectHosts,
    result.setEnvVars,
    manager.getAwsPairRegistry(),
    state.credentialEnvironment,
  );
  const setEnvVars = { ...result.setEnvVars };
  if (process.platform === "darwin" && state.config?.network?.allowLocalBinding
    && Object.hasOwn(setEnvVars, "JAVA_TOOL_OPTIONS")) {
    const javaIpv4Flag = "-Djava.net.preferIPv4Stack=true";
    const current = setEnvVars.JAVA_TOOL_OPTIONS!;
    if (!current.includes(javaIpv4Flag)) setEnvVars.JAVA_TOOL_OPTIONS = `${current} ${javaIpv4Flag}`;
  }
  const degraded = new Set(result.degradeToUnsetNames);
  for (const entry of credentials.envVars ?? []) {
    if (entry.mode === "mask" && Object.hasOwn(state.credentialEnvironment, entry.name)
      && !Object.hasOwn(setEnvVars, entry.name) && !degraded.has(entry.name)) {
      throw new ServicePoisonError(
        `Sandbox Runtime credential masking failed closed for declared source ${entry.name}`,
      );
    }
  }
  return {
    setEnvVars,
    degradeToUnsetNames: result.degradeToUnsetNames,
    // Sandlot has already registered every masked source explicitly. Passing
    // only structural denies to SRT prevents its ambient builder from reading
    // fixed service variables (PATH/TMPDIR/etc.) and overwriting the explicit
    // registry entry, while preserving credential file restrictions.
    runtimeConfig: {
      credentials: {
        ...credentials,
        envVars: (credentials.envVars ?? []).filter(({ mode }) => mode === "deny"),
      },
    },
  };
}

function buildCredentialOverlayCommand(
  command: string,
  binShell: string,
  setEnvVars: Readonly<Record<string, string>>,
  unsetNames: readonly string[],
): string {
  const entries = Object.entries(setEnvVars);
  if (entries.length === 0 && unsetNames.length === 0) return command;
  const args = ["/usr/bin/env"];
  for (const name of [...new Set(unsetNames)]) args.push("-u", name);
  for (const [name, value] of entries) args.push(`${name}=${value}`);
  args.push(binShell, "-c", command);
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function withInvocationWorkingDirectory<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  let releaseTurn!: () => void;
  const previousTurn = wrapWorkingDirectoryTail;
  wrapWorkingDirectoryTail = new Promise<void>((resolveTurn) => { releaseTurn = resolveTurn; });
  await previousTurn;

  const serviceCwd = process.cwd();
  try {
    process.chdir(cwd);
    return await operation();
  } finally {
    try {
      process.chdir(serviceCwd);
    } finally {
      releaseTurn();
    }
  }
}

const MANDATORY_SCAN_ARGS = [
  "--files",
  "--hidden",
  "--max-depth",
  "3",
  "--iglob", ".gitconfig",
  "--iglob", ".gitmodules",
  "--iglob", ".bashrc",
  "--iglob", ".bash_profile",
  "--iglob", ".zshrc",
  "--iglob", ".zprofile",
  "--iglob", ".profile",
  "--iglob", ".ripgreprc",
  "--iglob", ".mcp.json",
  "--iglob", "**/.vscode/**",
  "--iglob", "**/.idea/**",
  "--iglob", "**/.claude/commands/**",
  "--iglob", "**/.claude/agents/**",
  "--iglob", "**/.git/hooks/**",
  "--iglob", "**/.git/config",
  "-g", "!**/node_modules/**",
  ".",
] as const;

export async function runMandatoryDenyScan(
  ripgrepCommand: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  const child = spawn(requiredAbsolutePath(ripgrepCommand, "mandatory scan ripgrep command"), [...MANDATORY_SCAN_ARGS], {
    cwd: requiredAbsolutePath(cwd, "mandatory scan cwd"),
    env: process.env,
    signal,
    timeout: 10_000,
    windowsHide: true,
    stdio: "ignore",
  });
  const { code, exitSignal } = await new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code, exitSignal) => resolveExit({ code, exitSignal }));
    },
  );
  if (code === 0 || code === 1) return;
  if (exitSignal !== null) {
    throw new Error(`mandatory control-path ripgrep scan exited from signal ${exitSignal}`);
  }
  throw new Error(`mandatory control-path ripgrep scan failed with exit code ${String(code)}`);
}

interface ServiceRequestMessage {
  readonly type: "request";
  readonly id: number;
  readonly operation: string;
  readonly payload?: unknown;
}

interface ServiceNotifyMessage {
  readonly type: "notify";
  readonly operation: string;
  readonly payload?: unknown;
}

interface ServiceResponseMessage {
  readonly type: "response";
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
}

function startService(manager: ServiceManager): void {
  const active = new Map<number, AbortController>();
  let shuttingDown = false;
  const shutdown = (exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const controller of active.values()) controller.abort();
    active.clear();
    const state = serviceState(manager);
    state.lifecycleGeneration++;
    state.credentialEnvironment = Object.create(null) as NodeJS.ProcessEnv;
    state.config = undefined;
    state.stagedNetworkMode = undefined;
    state.initializingNetworkMode = undefined;
    state.initializedNetworkMode = undefined;
    void withOperationDeadline(Promise.resolve().then(() => manager.reset()), "reset", 1_000)
      .catch(() => undefined)
      .finally(() => process.exit(exitCode));
  };
  process.on("message", (message: unknown) => {
    if (shuttingDown) return;
    let parsed: ServiceRequestMessage | ServiceNotifyMessage;
    try {
      parsed = validateSandboxRuntimeServiceMessage(message);
    } catch {
      shutdown(1);
      return;
    }
    if (parsed.type === "request") {
      if (active.has(parsed.id) || active.size >= MAX_ACTIVE_OPERATIONS) {
        shutdown(1);
        return;
      }
      const controller = new AbortController();
      active.set(parsed.id, controller);
      const requestCredentialEnvironment = serviceState(manager).credentialEnvironment;
      void handleSandboxRuntimeRequest(manager, parsed.operation, parsed.payload, controller.signal).then(
        (value) => sendServiceResponse(
          { type: "response", id: parsed.id, ok: true, value },
          requestCredentialEnvironment,
          shutdown,
        ),
        (error: unknown) => {
          const redacted = redactCredentialError(error, requestCredentialEnvironment);
          sendServiceResponse({
            type: "response",
            id: parsed.id,
            ok: false,
            error: { name: redacted.name, message: redacted.message },
          }, requestCredentialEnvironment, shutdown);
          if (error instanceof ServicePoisonError || redacted.name === "SandboxRuntimeServicePoisonError") {
            shutdown(1);
          }
        },
      ).finally(() => active.delete(parsed.id));
      return;
    }
    if (parsed.operation === "abort") {
      active.get((parsed.payload as { readonly id: number }).id)?.abort();
    } else {
      manager.getSandboxViolationStore().clear();
    }
  });
  process.on("disconnect", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));
}

export function validateSandboxRuntimeServiceMessage(
  value: unknown,
): ServiceRequestMessage | ServiceNotifyMessage {
  assertIpcData(value, "Sandbox Runtime service message");
  const record = requiredPayloadRecord(value, ["type", "id", "operation", "payload"], ["type", "operation"]);
  const type = record.type;
  if (type !== "request" && type !== "notify") throw new Error("Sandbox Runtime service message type is invalid");
  if (typeof record.operation !== "string") throw new Error("Sandbox Runtime service message operation is invalid");
  if (type === "request") {
    if (!Object.hasOwn(record, "id") || !Number.isSafeInteger(record.id) || (record.id as number) <= 0) {
      throw new Error("Sandbox Runtime service request ID is invalid");
    }
    requiredServiceOperation(record.operation);
    return {
      type,
      id: record.id as number,
      operation: record.operation,
      payload: record.payload,
    };
  }
  if (Object.hasOwn(record, "id")) throw new Error("Sandbox Runtime service notification must not contain an ID");
  if (record.operation !== "abort" && record.operation !== "clearViolations") {
    throw new Error("Sandbox Runtime service notification operation is invalid");
  }
  if (record.operation === "clearViolations" && record.payload !== undefined) {
    throw new Error("Sandbox Runtime clearViolations notification must not contain a payload");
  }
  if (record.operation === "abort") {
    const abort = requiredPayloadRecord(record.payload, ["id"], ["id"]);
    const id = abort.id;
    if (!Number.isSafeInteger(id) || (id as number) <= 0) {
      throw new Error("Sandbox Runtime abort notification request ID is invalid");
    }
    return { type, operation: record.operation, payload: { id: id as number } };
  }
  return { type, operation: record.operation, payload: undefined };
}

function sendServiceResponse(
  response: ServiceResponseMessage,
  credentialEnvironment: NodeJS.ProcessEnv,
  shutdown: (exitCode: number) => void,
): void {
  let bounded = response;
  try {
    assertNoCredentialValues(bounded, credentialEnvironment, "Sandbox Runtime service response");
    assertIpcData(bounded, "Sandbox Runtime service response");
  } catch {
    bounded = {
      type: "response",
      id: response.id,
      ok: false,
      error: { name: "Error", message: "Sandbox Runtime service response exceeded protocol bounds" },
    };
    shutdown(1);
  }
  try {
    process.send?.(bounded, (error) => {
      if (error !== null) shutdown(1);
    });
  } catch {
    shutdown(1);
  }
}

function redactCredentialError(error: unknown, credentialEnvironment: NodeJS.ProcessEnv): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const values = credentialEnvironmentValues(credentialEnvironment);
  if (values.length === 0) return original;
  const redacted = new Error(redactCredentialText(original.message, values));
  redacted.name = redactCredentialText(original.name, values);
  return redacted;
}

function credentialEnvironmentValues(credentialEnvironment: NodeJS.ProcessEnv): string[] {
  return Object.values(credentialEnvironment)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function redactCredentialText(input: string, credentialValues: readonly string[]): string {
  return credentialValues.reduce(
    (result, value) => result.split(value).join("[REDACTED]"),
    input,
  );
}

function optionalRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Sandbox Runtime service payload must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Sandbox Runtime service payload must be a plain own-property object");
  }
  return value as Record<string, unknown>;
}

function requiredPayloadRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = [],
): Record<string, unknown> {
  const record = optionalRecord(value);
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) {
    throw new Error("Sandbox Runtime service payload contains an unexpected property");
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) throw new Error(`Sandbox Runtime service payload is missing ${key}`);
  }
  return record;
}

function requiredString(value: unknown, label: string, maxBytes = 256 * 1024): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL`);
  return value;
}

function requiredAbsolutePath(value: unknown, label: string): string {
  const path = requiredString(value, label, 16 * 1024);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return path;
}

function optionalString(value: unknown, label: string, maxBytes = 256 * 1024): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, maxBytes);
}

function requiredConfig(value: unknown): SandboxRuntimeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Sandbox Runtime service config must be an object");
  }
  return SandboxRuntimeConfigSchema.parse(value);
}

function requiredNetworkMode(value: unknown): NetworkMode {
  if (value === "filtered" || value === "unrestricted") return value;
  throw new Error("Sandbox Runtime service network mode must be filtered or unrestricted");
}

function assertNetworkModeConfigPair(networkMode: NetworkMode, config: SandboxRuntimeConfig): void {
  const network = config.network;
  if (networkMode === "filtered") {
    if (network.strictAllowlist !== true) {
      throw new Error("Sandbox Runtime service filtered network mode requires strict allowlisting");
    }
    return;
  }
  if (
    network.strictAllowlist !== false
    || network.allowedDomains.length !== 0
    || network.deniedDomains.length !== 0
  ) {
    throw new Error(
      "Sandbox Runtime service unrestricted network mode requires strictAllowlist false and empty domain lists",
    );
  }
}

function requiredCredentialEnvironment(
  value: unknown,
  config: SandboxRuntimeConfig,
): NodeJS.ProcessEnv {
  const record = optionalRecord(value);
  const allowed = new Set(
    (config.credentials?.envVars ?? [])
      .filter(({ mode }) => mode === "mask")
      .map(({ name }) => name),
  );
  const environment = Object.create(null) as NodeJS.ProcessEnv;
  const names = Object.keys(record);
  if (names.length > MAX_CREDENTIAL_ENVIRONMENT_NAMES) {
    throw new Error(
      `Sandbox Runtime service credential environment exceeds the ${MAX_CREDENTIAL_ENVIRONMENT_NAMES}-name limit`,
    );
  }
  for (const name of names) {
    if (!allowed.has(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Sandbox Runtime service received an undeclared credential environment name: ${name}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new Error(`Sandbox Runtime service credential environment value for ${name} must be a string`);
    }
    if (descriptor.value.includes("\0")) {
      throw new Error(`Sandbox Runtime service credential environment value for ${name} must not contain NUL`);
    }
    if (Buffer.byteLength(descriptor.value) > MAX_CREDENTIAL_VALUE_BYTES) {
      throw new Error(
        `Sandbox Runtime service credential environment value for ${name} exceeds the ${MAX_CREDENTIAL_VALUE_BYTES}-byte limit`,
      );
    }
    environment[name] = descriptor.value;
  }
  return environment;
}

function credentialEnvironmentForRequest(
  operation: ServiceOperation,
  payload: unknown,
): NodeJS.ProcessEnv | undefined {
  if (operation !== "updateConfig" && operation !== "initialize") return undefined;
  const record = requiredPayloadRecord(
    payload,
    operation === "updateConfig"
      ? ["config", "networkMode", "credentialEnvironment"]
      : ["config", "networkMode", "enableLogMonitor", "credentialEnvironment"],
    ["config", "networkMode"],
  );
  return requiredCredentialEnvironment(record.credentialEnvironment, requiredConfig(record.config));
}

function optionalWrapOptions(value: unknown): { commandId?: string; commandText?: string } | undefined {
  if (value === undefined) return undefined;
  const record = optionalRecord(value);
  requiredPayloadRecord(record, ["commandId", "commandText"]);
  return {
    commandId: optionalString(record.commandId, "command ID", 4 * 1024),
    commandText: optionalString(record.commandText, "command text"),
  };
}

function sanitizedWrapDescriptor(
  value: unknown,
  credentialEnvironment: NodeJS.ProcessEnv,
): { argv: string[] } {
  assertNoCredentialValues(value, credentialEnvironment, "Sandbox Runtime service wrap descriptor");
  const record = requiredPayloadRecord(value, ["argv", "env"], ["argv"]);
  const argvDescriptor = Object.getOwnPropertyDescriptor(record, "argv");
  if (argvDescriptor === undefined || !("value" in argvDescriptor) || !Array.isArray(argvDescriptor.value)) {
    throw new Error("Sandbox Runtime service wrap result argv must be an array");
  }
  const argv = argvDescriptor.value as unknown[];
  if (Object.getPrototypeOf(argv) !== Array.prototype || argv.length === 0 || argv.length > 4_096) {
    throw new Error("Sandbox Runtime service wrap result argv must be a non-empty plain array of at most 4096 strings");
  }
  const copy: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(argv, index);
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new Error("Sandbox Runtime service wrap result argv must contain only own string elements");
    }
    if (descriptor.value.includes("\0") || Buffer.byteLength(descriptor.value) > 256 * 1024) {
      throw new Error("Sandbox Runtime service wrap result argv contains an invalid argument");
    }
    copy.push(descriptor.value);
  }
  if (copy[0] === "") throw new Error("Sandbox Runtime service wrap result executable must not be empty");
  return { argv: copy };
}

function assertNoCredentialValues(
  value: unknown,
  credentialEnvironment: NodeJS.ProcessEnv,
  label: string,
): void {
  const values = credentialEnvironmentValues(credentialEnvironment);
  if (values.length === 0) return;
  const seen = new Set<object>();
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      if (values.some((credential) => current.includes(credential))) {
        throw new ServicePoisonError(`${label} contained a raw credential value`);
      }
      return;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) return;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key === "string") visit(key);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && "value" in descriptor) visit(descriptor.value);
    }
  };
  visit(value);
}

function sanitizedViolationLines(
  value: unknown,
  credentialEnvironment: NodeJS.ProcessEnv,
): Array<{ line: string }> {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 100) {
    throw new Error("Sandbox Runtime service violations must be a plain array of at most 100 entries");
  }
  const credentialValues = credentialEnvironmentValues(credentialEnvironment);
  const lines: Array<{ line: string }> = [];
  for (let index = 0; index < value.length; index++) {
    const eventDescriptor = Object.getOwnPropertyDescriptor(value, index);
    if (eventDescriptor === undefined || !("value" in eventDescriptor)
      || typeof eventDescriptor.value !== "object" || eventDescriptor.value === null) {
      throw new Error("Sandbox Runtime service violation entry must be an own object");
    }
    const lineDescriptor = Object.getOwnPropertyDescriptor(eventDescriptor.value, "line");
    if (lineDescriptor === undefined || !("value" in lineDescriptor) || typeof lineDescriptor.value !== "string") {
      throw new Error("Sandbox Runtime service violation line must be an own string");
    }
    if (Buffer.byteLength(lineDescriptor.value) > 64 * 1024 || lineDescriptor.value.includes("\0")) {
      throw new Error("Sandbox Runtime service violation line exceeds protocol bounds");
    }
    lines.push({ line: redactCredentialText(lineDescriptor.value, credentialValues) });
  }
  return lines;
}

function optionalRipgrepConfig(value: unknown): { command: string; args?: string[] } | undefined {
  if (value === undefined) return undefined;
  const record = requiredPayloadRecord(value, ["command", "args"], ["command"]);
  const args = record.args;
  if (args !== undefined && (!Array.isArray(args) || args.length > 256 || args.some((arg) => typeof arg !== "string"))) {
    throw new Error("Sandbox Runtime service ripgrep args must be an array of at most 256 strings");
  }
  return {
    command: requiredString(record.command, "ripgrep command", 16 * 1024),
    args: args as string[] | undefined,
  };
}

function requireNoPayload(value: unknown, operation: ServiceOperation): void {
  if (value !== undefined) throw new Error(`Sandbox Runtime service ${operation} does not accept a payload`);
}

function requiredServiceOperation(value: string): ServiceOperation {
  if (Object.hasOwn(SERVICE_OPERATION_TIMEOUTS, value)) return value as ServiceOperation;
  throw new Error(`Unknown Sandbox Runtime service operation: ${value}`);
}

function requiredTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 300_000) {
    throw new Error(`${label} must be a positive safe integer no greater than 300000ms`);
  }
  return value;
}

function assertIpcData(value: unknown, label: string): void {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    if (current === undefined || current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(`${label} contains a non-finite number`);
      return;
    }
    if (typeof current !== "object") throw new Error(`${label} contains unsupported data`);
    if (depth > MAX_IPC_DATA_DEPTH) throw new Error(`${label} exceeds the maximum data depth`);
    if (seen.has(current)) throw new Error(`${label} contains a cyclic object`);
    if (++nodes > MAX_IPC_DATA_NODES) throw new Error(`${label} contains too many values`);
    seen.add(current);
    const prototype = Object.getPrototypeOf(current);
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) throw new Error(`${label} contains an invalid array prototype`);
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain own-property objects`);
    }
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string") throw new Error(`${label} contains a symbol property`);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error(`${label} contains an accessor property`);
      }
      visit(descriptor.value, depth + 1);
    }
    seen.delete(current);
  };
  visit(value, 0);
  let size: number;
  try {
    size = serialize(value).byteLength;
  } catch (error: unknown) {
    throw new Error(`${label} is not serializable`, { cause: error });
  }
  if (size > MAX_IPC_MESSAGE_BYTES) {
    throw new Error(`${label} is too large (${size} bytes; limit ${MAX_IPC_MESSAGE_BYTES})`);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))) {
  startService(SandboxManager as ServiceManager);
}
