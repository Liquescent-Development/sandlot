import type { RunRequest, RunResult, SandboxRunner } from "../runner.js";
export interface SerializedStat {
    readonly kind: "file" | "directory" | "other";
}
export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp";
export interface AtomicImageRead {
    readonly bytes: Buffer;
    readonly mimeType: SupportedImageMimeType | undefined;
}
export declare const MAX_FILE_READ_BYTES: number;
interface WorkerRunner {
    run(request: RunRequest): Promise<RunResult>;
}
export interface FileWorkerPathOptions {
    readonly nodePath?: string;
    readonly workerPath?: string;
}
export interface ResolvedFileWorkerPaths {
    readonly nodePath: string;
    readonly workerPath: string;
    readonly trustedReadPaths: readonly [string, string];
}
export interface FileWorkerClientOptions extends FileWorkerPathOptions {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly createInvocationId?: () => string;
}
/** Trusted per-Pi-call ownership that must cross every worker operation. */
export interface FileWorkerCallContext {
    readonly expectedGeneration: number;
    readonly signal: AbortSignal | undefined;
    readonly nextInvocationId: () => string;
}
export declare function resolveFileWorkerPaths(options?: FileWorkerPathOptions): Promise<ResolvedFileWorkerPaths>;
export declare class FileWorkerError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class FileWorkerClient {
    #private;
    private readonly runner;
    constructor(runner: WorkerRunner | Pick<SandboxRunner, "run">, options?: FileWorkerClientOptions);
    get trustedReadPaths(): readonly string[];
    read(path: string, context?: FileWorkerCallContext): Promise<Buffer>;
    readText(path: string, context?: FileWorkerCallContext): Promise<string>;
    readImage(path: string, context?: FileWorkerCallContext): Promise<AtomicImageRead>;
    access(path: string, mode: "read" | "write", context?: FileWorkerCallContext): Promise<void>;
    exists(path: string, context?: FileWorkerCallContext): Promise<boolean>;
    write(path: string, content: string, createParents: boolean, context?: FileWorkerCallContext): Promise<void>;
    mkdir(path: string, recursive: boolean, context?: FileWorkerCallContext): Promise<void>;
    stat(path: string, context?: FileWorkerCallContext): Promise<SerializedStat>;
    readdir(path: string, context?: FileWorkerCallContext): Promise<string[]>;
    mime(path: string, context?: FileWorkerCallContext): Promise<SupportedImageMimeType | undefined>;
    private request;
    private command;
}
export declare function detectSupportedImageMimeType(buffer: Buffer): SupportedImageMimeType | null;
export {};
