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
export class RuntimeController {
  #state: RuntimeState = "idle";
  #generation = 0;
  #policy: EffectivePolicy | undefined;
  #error: string | undefined;
  #nextAcquisitionId = 0;
  #active = new Map<string, ActiveInvocation>();

  beginInitialization(): void {
    this.#requireState("begin initialization", ["idle"]);
    this.#generation++;
    this.#policy = undefined;
    this.#error = undefined;
    this.#state = "initializing";
  }

  markReady(policy: EffectivePolicy): void {
    this.#requireState("mark ready", ["initializing"]);
    this.#policy = immutableCopy(policy);
    this.#error = undefined;
    this.#state = "ready";
  }

  markFailed(error: unknown): void {
    this.#requireState("mark failed", ["initializing"]);
    this.#policy = undefined;
    this.#error = formatError(error);
    this.#state = "failed";
  }

  /** Permanently fail closed when process-global sandbox cleanup cannot be proven complete. */
  markPoisoned(error: unknown): void {
    this.#requireState("mark poisoned", ["idle", "initializing", "failed", "shutting-down"]);
    if (this.#state === "idle") this.#generation++;
    this.#policy = undefined;
    this.#error = formatError(error);
    this.#state = "failed";
    for (const active of this.#active.values()) active.controller?.abort();
  }

  markDisabled(): void {
    this.#requireState("disable", ["idle", "initializing"]);
    this.#policy = undefined;
    this.#error = undefined;
    this.#state = "disabled-by-user";
  }

  acquire(invocationId: string, expectedGeneration?: number): RuntimeLease {
    if (this.#state !== "ready") {
      throw new Error(`Sandlot runtime is not ready (${this.#state})`);
    }
    if (expectedGeneration !== undefined && expectedGeneration !== this.#generation) {
      throw new Error(`Sandlot runtime stale generation for ${invocationId}`);
    }
    if (this.#active.has(invocationId)) {
      throw new Error(`Duplicate Sandlot invocation: ${invocationId}`);
    }

    const acquisitionId = ++this.#nextAcquisitionId;
    this.#active.set(invocationId, { acquisitionId, generation: this.#generation });
    return Object.freeze({ invocationId, generation: this.#generation, acquisitionId });
  }

  registerAbort(lease: RuntimeLease, controller: AbortController): void {
    const active = this.#activeFor(lease);
    if (active.controller !== undefined && active.controller !== controller) {
      throw new Error(`Abort controller already registered for Sandlot invocation: ${lease.invocationId}`);
    }
    active.controller = controller;

    if (this.#state !== "ready") controller.abort();
  }

  assertCurrent(lease: RuntimeLease): void {
    if (
      this.#state !== "ready"
      || lease.generation !== this.#generation
      || !this.#matchesActiveInvocation(lease)
    ) {
      throw new Error(`Sandlot runtime stale generation for ${lease.invocationId}`);
    }
  }

  release(lease: RuntimeLease): void {
    if (this.#matchesActiveInvocation(lease)) this.#active.delete(lease.invocationId);
  }

  beginShutdown(): void {
    this.#requireState("begin shutdown", ["initializing", "ready", "failed", "disabled-by-user"]);
    this.#generation++;
    this.#policy = undefined;
    this.#state = "shutting-down";

    for (const active of this.#active.values()) active.controller?.abort();
  }

  finishShutdown(): void {
    this.#requireState("finish shutdown", ["shutting-down"]);
    this.#active.clear();
    this.#policy = undefined;
    this.#error = undefined;
    this.#state = "idle";
  }

  snapshot(): RuntimeSnapshot {
    return freezeRecursively({
      state: this.#state,
      generation: this.#generation,
      policy: this.#policy === undefined ? undefined : immutableCopy(this.#policy),
      error: this.#error,
      activeInvocationIds: [...this.#active.keys()],
    });
  }

  #requireState(action: string, states: readonly RuntimeState[]): void {
    if (!states.includes(this.#state)) {
      throw new Error(`Cannot ${action} while Sandlot runtime is ${this.#state}`);
    }
  }

  #activeFor(lease: RuntimeLease): ActiveInvocation {
    const active = this.#active.get(lease.invocationId);
    if (active === undefined || active.generation !== lease.generation || active.acquisitionId !== lease.acquisitionId) {
      throw new Error(`Sandlot runtime stale generation for ${lease.invocationId}`);
    }
    return active;
  }

  #matchesActiveInvocation(lease: RuntimeLease): boolean {
    const active = this.#active.get(lease.invocationId);
    return active !== undefined && active.generation === lease.generation && active.acquisitionId === lease.acquisitionId;
  }
}

interface ActiveInvocation {
  acquisitionId: number;
  generation: number;
  controller?: AbortController;
}

function formatError(error: unknown): string {
  const fallback = "Unknown Sandlot runtime initialization failure";
  if (error instanceof Error) {
    const name = error.name.trim() || "Error";
    return error.message.trim() === "" ? `${name}: ${fallback}` : `${name}: ${error.message}`;
  }
  return typeof error === "string" && error.trim() !== "" ? error : fallback;
}

function immutableCopy<T>(value: T): T {
  return freezeRecursively(structuredClone(value));
}

function freezeRecursively<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeRecursively(child);
  return Object.freeze(value);
}
