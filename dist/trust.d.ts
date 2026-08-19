export interface ExtensionTrustPathInput {
    readonly entryPath: string;
    readonly nodePath: string;
    readonly fileWorkerPath: string;
    readonly searchWorkerPath: string;
    readonly rgPath: string;
    readonly sandboxRuntimeEntryPath: string;
    readonly piImageProcessorPath: string;
    readonly photonEntryPath: string;
    readonly photonWasmPath: string;
    readonly allowWritePaths: readonly string[];
    readonly entryAliases?: readonly string[];
    readonly additionalExecutablePaths?: readonly string[];
    readonly filesystemDisabled?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly arch?: NodeJS.Architecture;
    readonly configuredSeccompApplyPath?: string;
    readonly configuredBwrapPath?: string;
    readonly configuredSocatPath?: string;
}
export interface ResolvedExtensionTrustPaths {
    readonly trustedReadPaths: readonly string[];
    readonly immutablePaths: readonly string[];
    readonly rgPath: string;
    readonly imageProcessorPath: string;
    readonly seccompApplyPath?: string;
    readonly bwrapPath?: string;
    readonly socatPath?: string;
}
/** Resolve the exact ESM worker graph and host-loaded Sandlot module trust roots. */
export declare function resolveExtensionTrustPaths(input: ExtensionTrustPathInput): Promise<ResolvedExtensionTrustPaths>;
