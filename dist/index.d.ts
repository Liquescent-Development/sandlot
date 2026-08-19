import type { SandboxDependencyCheck, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { type BashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type LoadedPolicyFiles } from "./config.js";
import { buildChildEnvironment } from "./environment.js";
import { FileWorkerClient } from "./helpers/file-worker.js";
import { SearchWorkerClient } from "./helpers/search-worker.js";
import { validatePolicyForPlatform, type EffectivePolicy, type PolicyCompositionContext } from "./policy.js";
import { SandboxRunner, type SandboxManagerLike } from "./runner.js";
import { RuntimeController } from "./runtime.js";
import { resolvePinnedPiImagePaths, type PinnedPiImageProcessor } from "./tools/files.js";
import { type ResolvedExtensionTrustPaths } from "./trust.js";
export { resolveExtensionTrustPaths } from "./trust.js";
interface ExtensionSandboxManager extends SandboxManagerLike {
    open(cwd: string): Promise<void>;
    updateConfig(config: SandboxRuntimeConfig, networkMode?: EffectivePolicy["networkMode"]): Promise<void>;
    getLinuxGlobPatternWarnings(): Promise<string[]>;
    checkDependenciesAsync(ripgrepConfig?: {
        command: string;
        args?: string[];
    }): Promise<SandboxDependencyCheck>;
    initialize(config: SandboxRuntimeConfig, askCallback?: undefined, enableLogMonitor?: boolean, networkMode?: EffectivePolicy["networkMode"]): Promise<void>;
    reset(): Promise<void>;
    getSandboxViolationStore(): SandboxManagerLike["getSandboxViolationStore"] extends (...args: never[]) => infer T ? T & {
        clear(): void;
        getViolations(limit?: number): Array<{
            line: string;
        }>;
        getTotalCount(): number;
    } : never;
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
    readonly loadPolicyFiles: (options: {
        cwd: string;
        projectTrusted: boolean;
    }) => Promise<LoadedPolicyFiles>;
    readonly composePolicy: (user: NonNullable<LoadedPolicyFiles["user"]>, project: LoadedPolicyFiles["project"], context: PolicyCompositionContext) => Promise<EffectivePolicy>;
    readonly validatePolicyForPlatform: typeof validatePolicyForPlatform;
    readonly toSandboxRuntimeConfig: (policy: EffectivePolicy) => SandboxRuntimeConfig;
    readonly resolveWorkerPaths: (policy: EffectivePolicy, entryAliases: readonly string[]) => Promise<ResolvedExtensionTrustPaths>;
    readonly resolveImageGraph: typeof resolvePinnedPiImagePaths;
    readonly processState: ExtensionProcessState;
    readonly platform: NodeJS.Platform;
    readonly arch: NodeJS.Architecture;
    readonly hostEnvironment: NodeJS.ProcessEnv;
    readonly sandlotSourcePath: string;
    readonly createLocalBashOperations?: () => BashOperations;
    readonly buildChildEnvironment?: typeof buildChildEnvironment;
}
export declare function createSandlotExtension(dependencies: ExtensionDependencies): (pi: ExtensionAPI) => void;
declare const sandlot: (pi: ExtensionAPI) => void;
export default sandlot;
