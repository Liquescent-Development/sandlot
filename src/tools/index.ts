import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FileWorkerClient } from "../helpers/file-worker.js";
import type { SearchWorkerClient } from "../helpers/search-worker.js";
import type { SandboxRunner } from "../runner.js";
import type { RuntimeController } from "../runtime.js";
import { createSandlotBashTool } from "./bash.js";
import {
  createSandlotEditTool,
  createSandlotLsTool,
  createSandlotReadTool,
  createSandlotWriteTool,
  type SandlotImageProcessor,
} from "./files.js";
import { createSandlotFindTool, createSandlotGrepTool } from "./search.js";

export interface ProtectedToolDependencies {
  readonly runtime: RuntimeController;
  readonly runner: Pick<SandboxRunner, "run">;
  readonly fileClient: FileWorkerClient;
  readonly searchClient: SearchWorkerClient;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly processImage: SandlotImageProcessor;
}

/** Register the reviewed adapter definitions without starting session resources. */
export function registerProtectedTools(pi: ExtensionAPI, dependencies: ProtectedToolDependencies): void {
  const shared = { runtime: dependencies.runtime };
  pi.registerTool(createSandlotBashTool({ ...shared, runner: dependencies.runner, environment: dependencies.environment }));
  pi.registerTool(createSandlotReadTool({ ...shared, client: dependencies.fileClient, processImage: dependencies.processImage }));
  pi.registerTool(createSandlotWriteTool({ ...shared, client: dependencies.fileClient }));
  pi.registerTool(createSandlotEditTool({ ...shared, client: dependencies.fileClient }));
  pi.registerTool(createSandlotLsTool({ ...shared, client: dependencies.fileClient }));
  pi.registerTool(createSandlotFindTool({ ...shared, client: dependencies.searchClient }));
  pi.registerTool(createSandlotGrepTool({ ...shared, client: dependencies.searchClient }));
}
