import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FileWorkerClient } from "../helpers/file-worker.js";
import type { SearchWorkerClient } from "../helpers/search-worker.js";
import type { SandboxRunner } from "../runner.js";
import type { RuntimeController } from "../runtime.js";
import { type SandlotImageProcessor } from "./files.js";
export interface ProtectedToolDependencies {
    readonly runtime: RuntimeController;
    readonly runner: Pick<SandboxRunner, "run">;
    readonly fileClient: FileWorkerClient;
    readonly searchClient: SearchWorkerClient;
    readonly environment: () => NodeJS.ProcessEnv;
    readonly processImage: SandlotImageProcessor;
}
/** Register the reviewed adapter definitions without starting session resources. */
export declare function registerProtectedTools(pi: ExtensionAPI, dependencies: ProtectedToolDependencies): void;
