import { createFindTool, createFindToolDefinition, createGrepTool, createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SearchWorkerClient } from "../helpers/search-worker.js";
import type { RuntimeController } from "../runtime.js";
export interface SearchToolDependencies {
    readonly client: SearchWorkerClient;
    readonly runtime: Pick<RuntimeController, "snapshot">;
    /** Test seam only; it is selected exclusively after explicit user disable. */
    readonly createLocalFindTool?: typeof createFindTool;
    /** Test seam only; it is selected exclusively after explicit user disable. */
    readonly createLocalGrepTool?: typeof createGrepTool;
    /** Deliberately unused production seam proving adapters never spawn on host. */
    readonly hostSpawn?: (...args: never[]) => unknown;
}
/**
 * Keeps Pi's find schema, metadata, and renderers while creating fresh
 * worker-backed operations per call.  Pi's custom find path resolver is
 * lexical only; every existence check and glob search crosses the worker.
 */
export declare function createSandlotFindTool(dependencies: SearchToolDependencies): ReturnType<typeof createFindToolDefinition>;
/**
 * Pi 0.84.2's public GrepOperations still starts `rg` on the host.  Retain
 * its public definition/renderers, but own its executor so the only rg spawn
 * occurs in the fixed search worker inside Sandbox Runtime.
 */
export declare function createSandlotGrepTool(dependencies: SearchToolDependencies): ReturnType<typeof createGrepToolDefinition>;
export declare const SEARCH_LIMITS: Readonly<{
    find: 1000;
    grep: 100;
    lineChars: 2000;
}>;
