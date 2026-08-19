import type { SandboxViolationLike } from "./runner.js";
export interface ClassifiedSandboxViolation {
    /** Semantic operation used for presentation and equivalence deduplication. */
    readonly operation: string;
    readonly target: string;
}
/**
 * Normalize every recognizably structured Runtime denial. A new Runtime
 * operation remains visible through the generic fallback rather than being
 * silently dropped; only the exact benign macOS probe is suppressed.
 */
export declare function classifySandboxViolations(violations: readonly SandboxViolationLike[]): readonly ClassifiedSandboxViolation[];
export declare function formatSandboxViolations(violations: readonly SandboxViolationLike[]): string;
export declare function formatClassifiedSandboxViolations(violations: readonly ClassifiedSandboxViolation[]): string;
