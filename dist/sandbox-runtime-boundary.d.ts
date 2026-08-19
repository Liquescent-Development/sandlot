import type { SandboxDependencyCheck, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { NetworkMode } from "./config.js";
import type { SandboxExecutionTerminationGate, SandboxViolationLike, SandboxViolationStoreLike } from "./runner.js";
import { type SandlotSessionTemporaryDirectoryCreationResult } from "./session-temporary-directory.js";
export interface SandboxRuntimeTransport {
    request<T = unknown>(operation: string, payload?: unknown, signal?: AbortSignal): Promise<T>;
    notify(operation: string, payload?: unknown): void;
    close(): Promise<void>;
}
export interface SandboxRuntimeTransportLaunch {
    readonly nodePath: string;
    readonly servicePath: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
}
export interface SandboxRuntimeBoundaryOptions {
    readonly nodePath: string;
    readonly servicePath: string;
    readonly platform: NodeJS.Platform;
    readonly hostEnvironment: NodeJS.ProcessEnv;
    readonly createTransport?: (launch: SandboxRuntimeTransportLaunch) => Promise<SandboxRuntimeTransport>;
    readonly createTemporaryDirectory?: () => Promise<SandlotSessionTemporaryDirectoryCreationResult>;
    readonly transportTimeouts?: SandboxRuntimeTransportTimeouts;
}
export interface SandboxRuntimeTransportTimeouts {
    readonly operations?: Partial<Record<ServiceOperation, number>>;
    readonly termGraceMs?: number;
    readonly killWaitMs?: number;
}
type ServiceOperation = "updateConfig" | "checkDependencies" | "initialize" | "wrap" | "violationsForCommand" | "cleanupAfterCommand" | "linuxGlobPatternWarnings" | "reset";
interface BoundaryWrapOptions {
    readonly commandId?: string;
    readonly commandText?: string;
    readonly childEnvironment?: NodeJS.ProcessEnv;
}
interface WrapDescriptor {
    readonly argv: string[];
    readonly env: NodeJS.ProcessEnv;
}
export declare class SandboxRuntimeBoundary {
    #private;
    private readonly options;
    constructor(options: SandboxRuntimeBoundaryOptions);
    open(cwd: string): Promise<void>;
    private openOnce;
    updateConfig(config: SandboxRuntimeConfig, networkMode?: NetworkMode): Promise<void>;
    checkDependenciesAsync(ripgrepConfig?: {
        command: string;
        args?: string[];
    }): Promise<SandboxDependencyCheck>;
    initialize(config: SandboxRuntimeConfig, _askCallback?: undefined, enableLogMonitor?: boolean, networkMode?: NetworkMode): Promise<void>;
    wrapWithSandboxArgv(command: string, binShell?: string, _customConfig?: undefined, abortSignal?: AbortSignal, cwd?: string, options?: BoundaryWrapOptions): Promise<WrapDescriptor>;
    collectViolations(commandId: string): Promise<readonly SandboxViolationLike[]>;
    cleanupAfterCommand(): Promise<void>;
    bindExecutionTerminationGate(gate: SandboxExecutionTerminationGate): void;
    getSandboxViolationStore(): MirroredViolationStore;
    getLinuxGlobPatternWarnings(): Promise<string[]>;
    reset(): Promise<void>;
    private resetOnce;
    private activeService;
    private request;
    private bindCredentialPolicy;
    private requiredTemporaryDirectory;
    private withOperationalTemporaryGrant;
    private prepareExecutionLifecycle;
    private ensureExecutionsTerminated;
    private terminateService;
    private maybeReleaseTemporaryDirectory;
    private releaseTemporaryDirectory;
}
export declare class MirroredViolationStore implements SandboxViolationStoreLike {
    #private;
    bindClearRemote(clearRemote: () => void): void;
    replaceForCommand(commandId: string, violations: readonly SandboxViolationLike[]): void;
    getViolationsForCommand(commandId: string): SandboxViolationLike[];
    getViolations(limit?: number): SandboxViolationLike[];
    getTotalCount(): number;
    clear(): void;
    clearLocal(): void;
}
export {};
