import { type SearchWorkerRequest } from "./protocol.js";
import type { RunRequest, RunResult, SandboxRunner } from "../runner.js";
import type { FileWorkerCallContext } from "./file-worker.js";
export interface SearchMatch {
    readonly path: string;
    readonly line: number;
    readonly text: string;
    readonly kind: "match" | "context";
}
export interface SearchWorkerPathOptions {
    readonly nodePath?: string;
    readonly workerPath?: string;
    readonly rgPath?: string;
}
export interface ResolvedSearchWorkerPaths {
    readonly nodePath: string;
    readonly workerPath: string;
    readonly rgPath: string;
    readonly trustedReadPaths: readonly [string, string, string];
    readonly trustedExecutePaths: readonly [string, string];
}
export interface SearchWorkerClientOptions extends SearchWorkerPathOptions {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly createInvocationId?: () => string;
}
interface WorkerRunner {
    run(request: RunRequest): Promise<RunResult>;
}
export declare function resolveSearchWorkerPaths(options?: SearchWorkerPathOptions): Promise<ResolvedSearchWorkerPaths>;
export declare class SearchWorkerError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class SearchWorkerClient {
    #private;
    private readonly runner;
    constructor(runner: WorkerRunner | Pick<SandboxRunner, "run">, options?: SearchWorkerClientOptions);
    get trustedReadPaths(): readonly string[];
    get trustedExecutePaths(): readonly string[];
    /** Rebind the trusted executable only between runtime generations. */
    configureRgPath(rgPath: string): void;
    find(pattern: string, cwd: string, options: {
        readonly ignore: string[];
        readonly limit: number;
    }, context: FileWorkerCallContext): Promise<{
        paths: string[];
        limitReached: boolean;
    }>;
    exists(path: string, context: FileWorkerCallContext): Promise<boolean>;
    grep(request: Omit<Extract<SearchWorkerRequest, {
        operation: "grep";
    }>, "version" | "operation">, context: FileWorkerCallContext): Promise<{
        matches: SearchMatch[];
        matchLimitReached: boolean;
    }>;
    private request;
    private command;
}
export {};
