import type { EffectivePolicy } from "./policy.js";
export type RuntimeState = "idle" | "initializing" | "ready" | "failed" | "shutting-down" | "disabled-by-user";
export interface RuntimeLease {
    readonly invocationId: string;
    readonly generation: number;
    readonly acquisitionId: number;
}
export interface RuntimeSnapshot {
    readonly state: RuntimeState;
    readonly generation: number;
    readonly policy: EffectivePolicy | undefined;
    readonly error: string | undefined;
    readonly activeInvocationIds: readonly string[];
}
/**
 * Owns a single runtime lifecycle. Work is available only while a current
 * generation is ready; every replacement or shutdown invalidates prior work.
 */
export declare class RuntimeController {
    #private;
    beginInitialization(): void;
    markReady(policy: EffectivePolicy): void;
    markFailed(error: unknown): void;
    /** Permanently fail closed when process-global sandbox cleanup cannot be proven complete. */
    markPoisoned(error: unknown): void;
    markDisabled(): void;
    acquire(invocationId: string, expectedGeneration?: number): RuntimeLease;
    registerAbort(lease: RuntimeLease, controller: AbortController): void;
    assertCurrent(lease: RuntimeLease): void;
    release(lease: RuntimeLease): void;
    beginShutdown(): void;
    finishShutdown(): void;
    snapshot(): RuntimeSnapshot;
}
