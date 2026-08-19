/**
 * Owns a single runtime lifecycle. Work is available only while a current
 * generation is ready; every replacement or shutdown invalidates prior work.
 */
export class RuntimeController {
    #state = "idle";
    #generation = 0;
    #policy;
    #error;
    #nextAcquisitionId = 0;
    #active = new Map();
    beginInitialization() {
        this.#requireState("begin initialization", ["idle"]);
        this.#generation++;
        this.#policy = undefined;
        this.#error = undefined;
        this.#state = "initializing";
    }
    markReady(policy) {
        this.#requireState("mark ready", ["initializing"]);
        this.#policy = immutableCopy(policy);
        this.#error = undefined;
        this.#state = "ready";
    }
    markFailed(error) {
        this.#requireState("mark failed", ["initializing"]);
        this.#policy = undefined;
        this.#error = formatError(error);
        this.#state = "failed";
    }
    /** Permanently fail closed when process-global sandbox cleanup cannot be proven complete. */
    markPoisoned(error) {
        this.#requireState("mark poisoned", ["idle", "initializing", "failed", "shutting-down"]);
        if (this.#state === "idle")
            this.#generation++;
        this.#policy = undefined;
        this.#error = formatError(error);
        this.#state = "failed";
        for (const active of this.#active.values())
            active.controller?.abort();
    }
    markDisabled() {
        this.#requireState("disable", ["idle", "initializing"]);
        this.#policy = undefined;
        this.#error = undefined;
        this.#state = "disabled-by-user";
    }
    acquire(invocationId, expectedGeneration) {
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
    registerAbort(lease, controller) {
        const active = this.#activeFor(lease);
        if (active.controller !== undefined && active.controller !== controller) {
            throw new Error(`Abort controller already registered for Sandlot invocation: ${lease.invocationId}`);
        }
        active.controller = controller;
        if (this.#state !== "ready")
            controller.abort();
    }
    assertCurrent(lease) {
        if (this.#state !== "ready"
            || lease.generation !== this.#generation
            || !this.#matchesActiveInvocation(lease)) {
            throw new Error(`Sandlot runtime stale generation for ${lease.invocationId}`);
        }
    }
    release(lease) {
        if (this.#matchesActiveInvocation(lease))
            this.#active.delete(lease.invocationId);
    }
    beginShutdown() {
        this.#requireState("begin shutdown", ["initializing", "ready", "failed", "disabled-by-user"]);
        this.#generation++;
        this.#policy = undefined;
        this.#state = "shutting-down";
        for (const active of this.#active.values())
            active.controller?.abort();
    }
    finishShutdown() {
        this.#requireState("finish shutdown", ["shutting-down"]);
        this.#active.clear();
        this.#policy = undefined;
        this.#error = undefined;
        this.#state = "idle";
    }
    snapshot() {
        return freezeRecursively({
            state: this.#state,
            generation: this.#generation,
            policy: this.#policy === undefined ? undefined : immutableCopy(this.#policy),
            error: this.#error,
            activeInvocationIds: [...this.#active.keys()],
        });
    }
    #requireState(action, states) {
        if (!states.includes(this.#state)) {
            throw new Error(`Cannot ${action} while Sandlot runtime is ${this.#state}`);
        }
    }
    #activeFor(lease) {
        const active = this.#active.get(lease.invocationId);
        if (active === undefined || active.generation !== lease.generation || active.acquisitionId !== lease.acquisitionId) {
            throw new Error(`Sandlot runtime stale generation for ${lease.invocationId}`);
        }
        return active;
    }
    #matchesActiveInvocation(lease) {
        const active = this.#active.get(lease.invocationId);
        return active !== undefined && active.generation === lease.generation && active.acquisitionId === lease.acquisitionId;
    }
}
function formatError(error) {
    const fallback = "Unknown Sandlot runtime initialization failure";
    if (error instanceof Error) {
        const name = error.name.trim() || "Error";
        return error.message.trim() === "" ? `${name}: ${fallback}` : `${name}: ${error.message}`;
    }
    return typeof error === "string" && error.trim() !== "" ? error : fallback;
}
function immutableCopy(value) {
    return freezeRecursively(structuredClone(value));
}
function freezeRecursively(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value))
        return value;
    for (const child of Object.values(value))
        freezeRecursively(child);
    return Object.freeze(value);
}
