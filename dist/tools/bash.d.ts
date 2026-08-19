import { createBashToolDefinition, type BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxRunner } from "../runner.js";
import type { RuntimeController } from "../runtime.js";
export interface BashDependencies {
    readonly runner: Pick<SandboxRunner, "run">;
    readonly runtime: Pick<RuntimeController, "snapshot">;
    /** Returns the already-sanitized environment for a sandbox child. */
    readonly environment: () => NodeJS.ProcessEnv;
    /** Testable local backend boundary; selected only after explicit user disable. */
    readonly createLocalBashOperations?: () => BashOperations;
    /** A call-specific identity; registered calls supply their Pi tool-call ID. */
    readonly invocationId?: () => string;
}
/**
 * Sandboxed Pi operations. The runtime state is evaluated per execution so a
 * stale/failed generation cannot fall back to host command execution.
 */
export declare function createSandlotBashOperations(dependencies: BashDependencies): BashOperations;
/** Operations used by Pi's `user_bash` event; the default invocation ID is a UUID. */
export declare function createSandlotUserBashOperations(dependencies: BashDependencies): BashOperations;
/**
 * Retains Pi's public bash definition (schema, text, renderers) and delegates
 * each execution to a fresh Pi tool bound to the call's working directory.
 */
export declare function createSandlotBashTool(dependencies: BashDependencies): ReturnType<typeof createBashToolDefinition>;
