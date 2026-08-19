import type { Readable, Writable } from "node:stream";
import type { RuntimeController } from "./runtime.js";
export interface RunRequest {
    readonly invocationId: string;
    /** Generation captured by the trusted caller before its operation began. */
    readonly expectedGeneration?: number;
    readonly command: string;
    readonly commandText: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly stdin?: string | Uint8Array;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly onData?: (data: Buffer) => void;
    /** Combined stdout/stderr bytes to retain. Omit for streaming-only calls. */
    readonly maxOutputBytes?: number;
    /** Keep structured worker transports free of human-readable violation annotations. */
    readonly annotateViolations?: boolean;
}
export interface RunResult {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
}
export interface SandboxViolationLike {
    readonly line: string;
}
export interface SandboxViolationStoreLike {
    getViolationsForCommand(commandId: string): SandboxViolationLike[];
}
export interface SandboxManagerLike {
    wrapWithSandboxArgv(command: string, binShell?: string, customConfig?: undefined, abortSignal?: AbortSignal, cwd?: string, options?: {
        commandId?: string;
        commandText?: string;
        childEnvironment?: NodeJS.ProcessEnv;
    }): Promise<{
        argv: string[];
        env: NodeJS.ProcessEnv;
    }>;
    collectViolations?(commandId: string): Promise<readonly SandboxViolationLike[]>;
    cleanupAfterCommand(): void | Promise<void>;
    getSandboxViolationStore(): SandboxViolationStoreLike;
    bindExecutionTerminationGate?(gate: SandboxExecutionTerminationGate): void;
}
export interface SandboxExecutionTerminationGate {
    /** Resolves only after every owned child and supervised descendant has settled. */
    terminateAndWait(): Promise<void>;
}
export interface ChildProcessLike {
    readonly pid?: number;
    readonly stdin: Writable | null;
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    off(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    off(event: "error", listener: (error: Error) => void): this;
    kill(signal?: NodeJS.Signals): boolean;
}
export interface SpawnOptionsLike {
    readonly shell: false;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly detached: boolean;
    readonly stdio: ["pipe", "pipe", "pipe"];
}
export type SpawnLike = (command: string, args: string[], options: SpawnOptionsLike) => ChildProcessLike;
export interface SandboxRunnerDependencies {
    readonly spawn?: SpawnLike;
    readonly killProcess?: (pid: number, signal: NodeJS.Signals) => unknown;
    readonly platform?: NodeJS.Platform;
    readonly createDescendantSupervisor?: (rootPid: number) => DescendantSupervisor;
    /** Bounded macOS log-monitor settle window after a failed child closes. */
    readonly violationSettleMs?: number;
    /** Test seam for the bounded violation settle delay. */
    readonly wait?: (milliseconds: number) => Promise<void>;
}
export interface DescendantSupervisor {
    terminateAndWait(): Promise<void>;
}
export declare class SandboxRunner {
    #private;
    private readonly manager;
    private readonly runtime;
    constructor(manager: SandboxManagerLike, runtime: RuntimeController, dependencies?: SandboxRunnerDependencies);
    run(request: RunRequest): Promise<RunResult>;
    abortAll(): Promise<void>;
    private runWithLease;
    private spawnAndCollect;
    private formatViolations;
    private collectFormattedViolations;
}
