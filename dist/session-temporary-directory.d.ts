import type { Dirent } from "node:fs";
interface Identity {
    readonly dev: number;
    readonly ino: number;
    readonly uid: number;
}
export interface SandlotTemporaryDirectoryStatus extends Identity {
    readonly mode: number;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
}
export interface SandlotTemporaryDirectoryFileSystem {
    mkdir(path: string, mode: number): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    lstat(path: string): Promise<SandlotTemporaryDirectoryStatus>;
    readdir(path: string): Promise<Dirent[]>;
    rmdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
}
export interface SandlotTemporaryDirectoryCleanupAuthority {
    cleanup(): Promise<void>;
}
export interface SandlotSessionTemporaryDirectory extends SandlotTemporaryDirectoryCleanupAuthority {
    readonly path: string;
}
export interface SandlotSessionTemporaryDirectoryOptions {
    readonly root?: string;
    readonly uid?: number;
    readonly sessionId?: string;
    /** A narrow syscall seam for deterministic validation of filesystem failures. */
    readonly filesystem?: SandlotTemporaryDirectoryFileSystem;
}
export type SandlotSessionTemporaryDirectoryCreationResult = {
    readonly ok: true;
    readonly directory: SandlotSessionTemporaryDirectory;
} | {
    readonly ok: false;
    readonly error: Error;
    readonly cleanupAuthority?: SandlotTemporaryDirectoryCleanupAuthority;
};
export declare function createSandlotSessionTemporaryDirectory(options?: SandlotSessionTemporaryDirectoryOptions): Promise<SandlotSessionTemporaryDirectoryCreationResult>;
export {};
