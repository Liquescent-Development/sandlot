import { createSandlotBashTool } from "./bash.js";
import { createSandlotEditTool, createSandlotLsTool, createSandlotReadTool, createSandlotWriteTool, } from "./files.js";
import { createSandlotFindTool, createSandlotGrepTool } from "./search.js";
/** Register the reviewed adapter definitions without starting session resources. */
export function registerProtectedTools(pi, dependencies) {
    const shared = { runtime: dependencies.runtime };
    pi.registerTool(createSandlotBashTool({ ...shared, runner: dependencies.runner, environment: dependencies.environment }));
    pi.registerTool(createSandlotReadTool({ ...shared, client: dependencies.fileClient, processImage: dependencies.processImage }));
    pi.registerTool(createSandlotWriteTool({ ...shared, client: dependencies.fileClient }));
    pi.registerTool(createSandlotEditTool({ ...shared, client: dependencies.fileClient }));
    pi.registerTool(createSandlotLsTool({ ...shared, client: dependencies.fileClient }));
    pi.registerTool(createSandlotFindTool({ ...shared, client: dependencies.searchClient }));
    pi.registerTool(createSandlotGrepTool({ ...shared, client: dependencies.searchClient }));
}
