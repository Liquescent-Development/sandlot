import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { SandboxViolationLike } from "./runner.js";
import type { RuntimeSnapshot } from "./runtime.js";
export interface DiagnosticSnapshotInput {
    readonly platform: NodeJS.Platform;
    readonly runtime: RuntimeSnapshot;
    readonly dependencyWarnings: readonly string[];
    readonly tools: readonly ToolInfo[];
    readonly sandlotSourcePath: string;
    readonly violations: readonly SandboxViolationLike[];
}
/** Render only aggregate policy/security data; paths, commands, and secrets stay redacted. */
export declare function renderDiagnosticSnapshot(input: DiagnosticSnapshotInput): string;
export declare function redactDiagnosticText(value: string): string;
