import { createEditToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, type EditOperations, type LsOperations, type ReadOperations, type WriteOperations } from "@earendil-works/pi-coding-agent";
import type { AtomicImageRead, FileWorkerCallContext, FileWorkerClient } from "../helpers/file-worker.js";
import type { RuntimeController } from "../runtime.js";
export interface FileToolDependencies {
    readonly client: FileWorkerClient;
    readonly runtime: Pick<RuntimeController, "snapshot">;
    /** Optional test boundary, invoked only after explicit user disable. */
    readonly createLocalReadOperations?: () => ReadOperations;
    /** Optional test boundary, invoked only after explicit user disable. */
    readonly createLocalWriteOperations?: () => WriteOperations;
    /** Optional test boundary, invoked only after explicit user disable. */
    readonly createLocalEditOperations?: () => EditOperations;
    /** Optional test boundary, invoked only after explicit user disable. */
    readonly createLocalLsOperations?: () => LsOperations;
    /** Trusted test seam; production uses the pinned Pi image processor. */
    readonly processImage?: SandlotImageProcessor;
}
export interface FileOperations {
    readonly read: ReadOperations & {
        readImage(path: string): Promise<AtomicImageRead>;
    };
    readonly write: WriteOperations;
    readonly edit: EditOperations;
    readonly ls: LsOperations;
}
/**
 * Pi's operations are deliberately small transport seams. Keeping all file IO
 * here means Pi retains its native path resolution, limits, edit queue, and
 * rendered result shapes while the worker retains the sandbox boundary.
 */
export declare function createFileOperations(client: FileWorkerClient, context?: FileWorkerCallContext): FileOperations;
/** Preserves Pi's registered read definition, binding its execution cwd late. */
export declare function createSandlotReadTool(dependencies: FileToolDependencies): ReturnType<typeof createReadToolDefinition>;
/** Preserves Pi's registered write definition, binding its execution cwd late. */
export declare function createSandlotWriteTool(dependencies: FileToolDependencies): ReturnType<typeof createWriteToolDefinition>;
/** Preserves Pi's edit factory, including its process-wide mutation queue. */
export declare function createSandlotEditTool(dependencies: FileToolDependencies): ReturnType<typeof createEditToolDefinition>;
/** Preserves Pi's registered ls definition, binding its execution cwd late. */
export declare function createSandlotLsTool(dependencies: FileToolDependencies): ReturnType<typeof createLsToolDefinition>;
export interface PiImageProcessResult {
    readonly ok: boolean;
    readonly message?: string;
    readonly data?: string;
    readonly mimeType?: string;
    readonly hints?: readonly string[];
}
export type SandlotImageProcessor = (bytes: Buffer, mimeType: string, options?: {
    readonly signal?: AbortSignal;
}) => Promise<PiImageProcessResult>;
export interface PinnedPiImagePaths {
    readonly piPackageRoot: string;
    readonly piVersion: "0.84.2";
    readonly hostAnchored: true;
    readonly imageModuleCount: 7;
    readonly imageProcessorPath: string;
    readonly photonEntryPath: string;
    readonly photonWasmPath: string;
}
export interface ImageProcessorWorkerOptions {
    readonly moduleUrl: string;
    readonly bytes: Buffer;
    readonly mimeType: string;
}
export interface ImageProcessorWorkerLike {
    on(event: "message", listener: (message: unknown) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "exit", listener: (code: number) => void): this;
    off(event: "message", listener: (message: unknown) => void): this;
    off(event: "error", listener: (error: Error) => void): this;
    off(event: "exit", listener: (code: number) => void): this;
    terminate(): Promise<number>;
}
type ImageProcessorWorkerFactory = (options: ImageProcessorWorkerOptions) => ImageProcessorWorkerLike;
/** Session-bound importer: initialization supplies the already validated canonical module. */
export declare class PinnedPiImageProcessor {
    #private;
    private readonly createWorker;
    constructor(createWorker?: ImageProcessorWorkerFactory);
    bind(imageProcessorPath: string): void;
    clear(): void;
    readonly process: SandlotImageProcessor;
    abortAll(): Promise<void>;
    private startExecution;
}
export declare const pinnedPiImageProcessor: PinnedPiImageProcessor;
/** Resolve every package entry that Pi's image pipeline loads after a read. */
export declare function resolvePinnedPiImagePaths(piPackageDirectory?: string): PinnedPiImagePaths;
export {};
