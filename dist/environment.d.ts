import type { EnvironmentPolicy } from "./config.js";
/** Directory containing the immutable package-owned macOS compatibility shims. */
export declare function sandlotMktempShimDirectory(): string;
export interface PiSessionEnvironment {
    PI_SESSION_ID?: string;
    PI_PROVIDER?: string;
    PI_MODEL?: string;
}
export declare function buildOuterEnvironment(platform: NodeJS.Platform, _host: NodeJS.ProcessEnv, temporaryDirectory?: string): NodeJS.ProcessEnv;
/** Build a command whose environment overlay is evaluated by the already-confined shell. */
export declare function buildSandboxedChildCommand(command: string, childEnvironment: NodeJS.ProcessEnv, shellPath?: string): string;
export declare function buildChildEnvironment(host: NodeJS.ProcessEnv, policy: EnvironmentPolicy, session?: PiSessionEnvironment): NodeJS.ProcessEnv;
