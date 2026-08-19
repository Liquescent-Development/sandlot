import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { RuntimeState } from "./runtime.js";
export interface GuardInput {
    readonly toolName: string;
    readonly state: RuntimeState;
    readonly tools: readonly ToolInfo[];
    /** Canonical Sandlot entry-module source supplied by src/index.ts. */
    readonly sandlotSourcePath: string;
    readonly trustedCustomTools: readonly string[];
}
export type GuardDecision = {
    block: false;
} | {
    block: true;
    reason: string;
};
export declare function evaluateToolCall(input: GuardInput): GuardDecision;
export declare function assertProtectedOwnership(tools: readonly ToolInfo[], sourcePath: string): void;
/** Preserve Pi's lexical extension spelling so writable symlink aliases can be rejected. */
export declare function protectedToolSourcePaths(tools: readonly ToolInfo[]): string[];
