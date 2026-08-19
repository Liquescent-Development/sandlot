import { fork } from "node:child_process";
import { isAbsolute } from "node:path";
import { serialize } from "node:v8";
import { buildOuterEnvironment, buildSandboxedChildCommand } from "./environment.js";
import { createSandlotSessionTemporaryDirectory, } from "./session-temporary-directory.js";
const DEFAULT_OPERATION_TIMEOUTS = Object.freeze({
    updateConfig: 5_000,
    checkDependencies: 30_000,
    initialize: 30_000,
    wrap: 30_000,
    violationsForCommand: 5_000,
    cleanupAfterCommand: 5_000,
    linuxGlobPatternWarnings: 5_000,
    reset: 5_000,
});
const MAX_PENDING_REQUESTS = 64;
const MAX_IPC_MESSAGE_BYTES = 1024 * 1024;
const MAX_IPC_DATA_DEPTH = 20;
const MAX_IPC_DATA_NODES = 16_384;
const MAX_RETIRED_RESPONSE_IDS = 256;
const DEFAULT_TERM_GRACE_MS = 1_000;
const DEFAULT_KILL_WAIT_MS = 4_000;
export class SandboxRuntimeBoundary {
    options;
    #outerEnvironment;
    #hostEnvironment;
    #createTransport;
    #createTemporaryDirectory;
    #violations = new MirroredViolationStore();
    #opening;
    #nextOpeningGeneration = 0;
    #service;
    // Generations never reset: only a successful close can advance confirmation.
    #nextServiceGeneration = 0;
    #serviceTerminationRequiredGeneration = 0;
    #serviceTerminationConfirmedGeneration = 0;
    #resetAttempt;
    #cwd;
    #ripgrepCommand;
    #credentialNames = new Set();
    #credentialValues = [];
    #poisonedError;
    #temporaryDirectory;
    #temporaryDirectoryOwnership;
    #executionTerminationGate;
    #executionTerminationAttempt;
    #executionTerminationConfirmed = false;
    #executionTerminationFailure;
    #temporaryDirectoryCleanupRequested = false;
    #temporaryDirectoryCleanupPromise;
    constructor(options) {
        this.options = options;
        this.#outerEnvironment = Object.freeze({ ...buildOuterEnvironment(options.platform, options.hostEnvironment) });
        this.#hostEnvironment = options.hostEnvironment;
        this.#createTransport = options.createTransport
            ?? ((launch) => createForkSandboxRuntimeTransport(launch, options.transportTimeouts));
        this.#createTemporaryDirectory = options.createTemporaryDirectory
            ?? (() => createSandlotSessionTemporaryDirectory());
    }
    async open(cwd) {
        if (this.#poisonedError !== undefined) {
            throw new Error(`Sandbox Runtime boundary is poisoned: ${this.#poisonedError.message}`, {
                cause: this.#poisonedError,
            });
        }
        if (this.#opening !== undefined
            || this.#resetAttempt !== undefined
            || this.#service !== undefined
            || this.#temporaryDirectoryOwnership !== undefined) {
            throw new Error("Sandbox Runtime boundary is already open");
        }
        if (!isAbsolute(this.options.nodePath) || !isAbsolute(this.options.servicePath) || !isAbsolute(cwd)) {
            throw new Error("Sandbox Runtime boundary paths must be absolute");
        }
        const opening = createOwnedOpeningAttempt(++this.#nextOpeningGeneration);
        this.#opening = opening;
        try {
            await this.openOnce(cwd, opening);
        }
        finally {
            if (this.#opening === opening)
                this.#opening = undefined;
            opening.settle();
        }
    }
    async openOnce(cwd, opening) {
        this.prepareExecutionLifecycle();
        const creation = await this.#createTemporaryDirectory();
        if (!creation.ok) {
            if (creation.cleanupAuthority !== undefined) {
                this.#temporaryDirectoryOwnership = creation.cleanupAuthority;
                this.#poisonedError = creation.error;
            }
            throw creation.error;
        }
        const temporaryDirectory = creation.directory;
        this.#temporaryDirectory = temporaryDirectory;
        this.#temporaryDirectoryOwnership = temporaryDirectory;
        this.#outerEnvironment = Object.freeze({
            ...buildOuterEnvironment(this.options.platform, this.#hostEnvironment, temporaryDirectory.path),
        });
        if (opening.cancelled)
            throw openingCancelledError(opening);
        try {
            const transport = await this.#createTransport({
                nodePath: this.options.nodePath,
                servicePath: this.options.servicePath,
                cwd,
                env: { ...this.#outerEnvironment },
            });
            const generation = ++this.#nextServiceGeneration;
            this.#serviceTerminationRequiredGeneration = generation;
            this.#service = { generation, transport, active: !opening.cancelled };
        }
        catch (error) {
            try {
                await this.releaseTemporaryDirectory();
            }
            catch (cleanupError) {
                const failure = new AggregateError([error, cleanupError], "Sandbox Runtime transport startup and temporary-directory cleanup both failed");
                this.#poisonedError = failure;
                throw failure;
            }
            throw error;
        }
        if (opening.cancelled)
            throw openingCancelledError(opening);
        this.#cwd = cwd;
        this.#violations.bindClearRemote(() => {
            if (this.#service?.active === true)
                this.#service.transport.notify("clearViolations");
        });
    }
    async updateConfig(config) {
        const ripgrepCommand = config.ripgrep?.command;
        if (this.options.platform === "linux" && (ripgrepCommand === undefined || !isAbsolute(ripgrepCommand))) {
            throw new Error("Linux Sandbox Runtime requires an absolute pinned ripgrep command");
        }
        const credentialEnvironment = buildCredentialEnvironment(config, this.#hostEnvironment);
        await this.request("updateConfig", { config: this.withOperationalTemporaryGrant(config), credentialEnvironment }, undefined, credentialValues(credentialEnvironment));
        this.#ripgrepCommand = ripgrepCommand;
        this.bindCredentialPolicy(config, credentialEnvironment);
    }
    async checkDependenciesAsync(ripgrepConfig) {
        return this.request("checkDependencies", { ripgrepConfig });
    }
    async initialize(config, _askCallback, enableLogMonitor = false) {
        const credentialEnvironment = buildCredentialEnvironment(config, this.#hostEnvironment);
        await this.request("initialize", { config: this.withOperationalTemporaryGrant(config), enableLogMonitor, credentialEnvironment }, undefined, credentialValues(credentialEnvironment));
        this.bindCredentialPolicy(config, credentialEnvironment);
    }
    async wrapWithSandboxArgv(command, binShell, _customConfig, abortSignal, cwd, options) {
        const shellPath = binShell ?? "/bin/bash";
        const childEnvironment = withOperationalTemporaryEnvironment(withoutCredentialEnvironment(options?.childEnvironment ?? {}, this.#credentialNames), this.requiredTemporaryDirectory().path);
        if (this.options.platform === "darwin")
            childEnvironment.PATH = this.#outerEnvironment.PATH;
        const confinedCommand = buildSandboxedChildCommand(command, childEnvironment, shellPath);
        const descriptor = await this.request("wrap", {
            command: confinedCommand,
            binShell: shellPath,
            cwd: cwd ?? this.#cwd,
            options: { commandId: options?.commandId, commandText: options?.commandText },
            mandatoryScan: this.options.platform === "linux"
                ? { ripgrepCommand: this.#ripgrepCommand }
                : undefined,
        }, abortSignal);
        if (!Array.isArray(descriptor.argv) || descriptor.argv.length === 0 || descriptor.argv.some((value) => typeof value !== "string")) {
            throw new Error("Sandbox Runtime boundary returned invalid argv");
        }
        if (!isAbsolute(descriptor.argv[0])) {
            throw new Error(`Sandbox Runtime boundary returned non-absolute outer executable: ${descriptor.argv[0]}`);
        }
        return { argv: [...descriptor.argv], env: { ...this.#outerEnvironment } };
    }
    async collectViolations(commandId) {
        const violations = await this.request("violationsForCommand", { commandId });
        this.#violations.replaceForCommand(commandId, violations);
        return violations;
    }
    async cleanupAfterCommand() {
        await this.request("cleanupAfterCommand");
    }
    bindExecutionTerminationGate(gate) {
        if (this.#executionTerminationGate !== undefined && this.#executionTerminationGate !== gate) {
            throw new Error("Sandbox Runtime boundary execution termination gate is already bound");
        }
        if (this.#opening !== undefined
            || this.#resetAttempt !== undefined
            || this.#service !== undefined
            || this.#temporaryDirectoryOwnership !== undefined) {
            throw new Error("Sandbox Runtime boundary execution termination gate must be bound before open");
        }
        this.#executionTerminationGate = gate;
    }
    getSandboxViolationStore() {
        return this.#violations;
    }
    async getLinuxGlobPatternWarnings() {
        return this.request("linuxGlobPatternWarnings");
    }
    reset() {
        if (this.#resetAttempt !== undefined)
            return this.#resetAttempt;
        const attempt = this.resetOnce();
        this.#resetAttempt = attempt;
        void attempt.then(() => {
            if (this.#resetAttempt === attempt)
                this.#resetAttempt = undefined;
        }, () => {
            if (this.#resetAttempt === attempt)
                this.#resetAttempt = undefined;
        });
        return attempt;
    }
    async resetOnce() {
        const opening = this.#opening;
        if (opening !== undefined) {
            opening.cancelled = true;
            await opening.settled;
        }
        const service = this.#service;
        const activeService = service?.active === true ? service : undefined;
        // Detach atomically while retaining the exact transport in #service.
        if (activeService !== undefined)
            activeService.active = false;
        this.#cwd = undefined;
        this.#ripgrepCommand = undefined;
        this.#violations.clearLocal();
        this.#credentialNames.clear();
        const failures = [];
        this.#temporaryDirectoryCleanupRequested = true;
        try {
            await this.ensureExecutionsTerminated();
        }
        catch (error) {
            failures.push(error);
        }
        if (activeService !== undefined) {
            try {
                await activeService.transport.request("reset");
            }
            catch (error) {
                failures.push(redactCredentialError(error, this.#credentialValues));
            }
        }
        if (service !== undefined) {
            try {
                await this.terminateService(service);
            }
            catch (error) {
                failures.push(redactCredentialError(error, this.#credentialValues));
            }
        }
        // The service transport and runner-owned executions are independent
        // lifecycles. Both must terminate positively before cleanup can proceed.
        // Reset request failures are still surfaced, but cannot veto safe cleanup.
        try {
            await this.maybeReleaseTemporaryDirectory();
        }
        catch (error) {
            failures.push(error);
        }
        this.#credentialValues = [];
        if (failures.length === 0)
            return;
        this.#poisonedError = asError(failures[failures.length - 1]);
        if (failures.length === 1)
            throw failures[0];
        throw new AggregateError(failures, "Sandbox Runtime reset, service close, or temporary-directory cleanup failed");
    }
    activeService() {
        if (this.#poisonedError !== undefined) {
            throw new Error(`Sandbox Runtime boundary is poisoned: ${this.#poisonedError.message}`, {
                cause: this.#poisonedError,
            });
        }
        if (this.#service?.active !== true)
            throw new Error("Sandbox Runtime boundary is not open");
        return this.#service;
    }
    async request(operation, payload, signal, redactionValues = this.#credentialValues) {
        const requestCredentialValues = [...redactionValues];
        const service = this.activeService();
        const transport = service.transport;
        try {
            const result = await transport.request(operation, payload, signal);
            assertNoCredentialResponse(result, requestCredentialValues);
            return result;
        }
        catch (error) {
            const redacted = redactCredentialError(error, requestCredentialValues);
            if (isPoisonError(error)) {
                this.#poisonedError = redacted;
                if (this.#service === service)
                    service.active = false;
                this.#cwd = undefined;
                this.#ripgrepCommand = undefined;
                this.#credentialNames.clear();
                this.#credentialValues = [];
                const failures = [redacted];
                this.#temporaryDirectoryCleanupRequested = true;
                // Starting runner termination here is safe, but awaiting it is not:
                // this poison can originate from an active runner's own final service
                // request, whose execution promise is the gate being awaited.
                void this.ensureExecutionsTerminated().catch(() => undefined);
                try {
                    await this.terminateService(service);
                }
                catch (closeError) {
                    const redactedClose = redactCredentialError(closeError, requestCredentialValues);
                    this.#poisonedError = redactedClose;
                    failures.push(redactedClose);
                }
                if (failures.length === 1) {
                    try {
                        await this.maybeReleaseTemporaryDirectory();
                    }
                    catch (cleanupError) {
                        this.#poisonedError = asError(cleanupError);
                        failures.push(cleanupError);
                    }
                }
                if (this.#executionTerminationFailure !== undefined && failures.length === 1) {
                    failures.push(this.#executionTerminationFailure);
                }
                if (failures.length > 1)
                    throw new AggregateError(failures, "Sandbox Runtime request failed and cleanup was indeterminate");
            }
            throw redacted;
        }
    }
    bindCredentialPolicy(config, credentialEnvironment) {
        this.#credentialNames = new Set((config.credentials?.envVars ?? []).map(({ name }) => name));
        this.#credentialValues = Object.values(credentialEnvironment)
            .filter((value) => typeof value === "string" && value.length > 0);
    }
    requiredTemporaryDirectory() {
        if (this.#temporaryDirectory === undefined)
            throw new Error("Sandbox Runtime boundary has no operational temporary directory");
        return this.#temporaryDirectory;
    }
    withOperationalTemporaryGrant(config) {
        const temporaryDirectory = this.requiredTemporaryDirectory().path;
        return {
            ...config,
            filesystem: {
                ...config.filesystem,
                allowWrite: uniquePaths([...(config.filesystem?.allowWrite ?? []), temporaryDirectory]),
            },
        };
    }
    prepareExecutionLifecycle() {
        this.#executionTerminationAttempt = undefined;
        this.#executionTerminationConfirmed = this.#executionTerminationGate === undefined;
        this.#executionTerminationFailure = undefined;
        this.#temporaryDirectoryCleanupRequested = false;
        this.#temporaryDirectoryCleanupPromise = undefined;
    }
    ensureExecutionsTerminated() {
        if (this.#executionTerminationFailure !== undefined) {
            return Promise.reject(this.#executionTerminationFailure);
        }
        if (this.#executionTerminationConfirmed)
            return Promise.resolve();
        if (this.#executionTerminationAttempt !== undefined)
            return this.#executionTerminationAttempt;
        const gate = this.#executionTerminationGate;
        if (gate === undefined) {
            this.#executionTerminationConfirmed = true;
            return Promise.resolve();
        }
        const attempt = Promise.resolve()
            .then(() => gate.terminateAndWait())
            .then(() => {
            this.#executionTerminationConfirmed = true;
            void this.maybeReleaseTemporaryDirectory().catch((error) => {
                this.#poisonedError = asError(error);
            });
        }, (error) => {
            const cause = asError(error);
            const failure = new Error(`Sandbox Runtime could not confirm runner execution termination: ${cause.message}`, { cause });
            this.#executionTerminationFailure = failure;
            this.#poisonedError = failure;
            throw failure;
        });
        this.#executionTerminationAttempt = attempt;
        return attempt;
    }
    terminateService(service) {
        if (this.#serviceTerminationConfirmedGeneration >= service.generation)
            return Promise.resolve();
        if (service.terminationAttempt !== undefined)
            return service.terminationAttempt;
        let closeAttempt;
        try {
            closeAttempt = service.transport.close();
        }
        catch (error) {
            return Promise.reject(error);
        }
        const attempt = closeAttempt.then(() => {
            this.#serviceTerminationConfirmedGeneration = Math.max(this.#serviceTerminationConfirmedGeneration, service.generation);
            if (this.#service === service)
                this.#service = undefined;
        });
        service.terminationAttempt = attempt;
        void attempt.catch(() => {
            if (service.terminationAttempt === attempt)
                service.terminationAttempt = undefined;
        });
        return attempt;
    }
    async maybeReleaseTemporaryDirectory() {
        if (!this.#temporaryDirectoryCleanupRequested
            || !this.#executionTerminationConfirmed
            || this.#executionTerminationFailure !== undefined
            || this.#serviceTerminationConfirmedGeneration < this.#serviceTerminationRequiredGeneration
            || this.#service !== undefined) {
            return;
        }
        if (this.#temporaryDirectoryCleanupPromise !== undefined) {
            await this.#temporaryDirectoryCleanupPromise;
            return;
        }
        const cleanup = (async () => {
            await this.releaseTemporaryDirectory();
            this.#temporaryDirectoryCleanupRequested = false;
        })();
        this.#temporaryDirectoryCleanupPromise = cleanup;
        try {
            await cleanup;
        }
        catch (error) {
            this.#poisonedError = asError(error);
            throw error;
        }
        finally {
            if (this.#temporaryDirectoryCleanupPromise === cleanup) {
                this.#temporaryDirectoryCleanupPromise = undefined;
            }
        }
    }
    async releaseTemporaryDirectory() {
        const ownership = this.#temporaryDirectoryOwnership;
        await ownership?.cleanup();
        this.#temporaryDirectoryOwnership = undefined;
        this.#temporaryDirectory = undefined;
        this.#outerEnvironment = Object.freeze({ ...buildOuterEnvironment(this.options.platform, this.#hostEnvironment) });
    }
}
function createOwnedOpeningAttempt(generation) {
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    return { generation, cancelled: false, settled, settle };
}
function openingCancelledError(opening) {
    return new Error(`Sandbox Runtime boundary opening generation ${opening.generation} was cancelled by reset`);
}
function credentialValues(environment) {
    return Object.values(environment)
        .filter((value) => typeof value === "string" && value.length > 0);
}
function buildCredentialEnvironment(config, hostEnvironment) {
    const credentialEnvironment = Object.create(null);
    for (const entry of config.credentials?.envVars ?? []) {
        if (entry.mode !== "mask" || !Object.hasOwn(hostEnvironment, entry.name))
            continue;
        const descriptor = Object.getOwnPropertyDescriptor(hostEnvironment, entry.name);
        if (descriptor === undefined || !("value" in descriptor)) {
            throw new Error(`Credential source ${entry.name} must be an own string data property`);
        }
        const value = descriptor.value;
        if (value === undefined)
            continue;
        if (typeof value !== "string") {
            throw new Error(`Credential source ${entry.name} must be an own string data property`);
        }
        if (value.includes("\0"))
            throw new Error(`Credential source ${entry.name} must not contain NUL`);
        if (Buffer.byteLength(value) > 256 * 1024) {
            throw new Error(`Credential source ${entry.name} exceeds the 262144-byte limit`);
        }
        credentialEnvironment[entry.name] = value;
    }
    return credentialEnvironment;
}
function withoutCredentialEnvironment(childEnvironment, credentialNames) {
    const filtered = Object.create(null);
    for (const [name, value] of Object.entries(childEnvironment)) {
        if (!credentialNames.has(name))
            filtered[name] = value;
    }
    return filtered;
}
function withOperationalTemporaryEnvironment(environment, temporaryDirectory) {
    return {
        ...environment,
        TMPDIR: temporaryDirectory,
        TMP: temporaryDirectory,
        TEMP: temporaryDirectory,
    };
}
function uniquePaths(paths) {
    return [...new Set(paths)];
}
function redactCredentialError(error, credentialValues) {
    const original = error instanceof Error ? error : new Error(String(error));
    const values = credentialValues.filter((value) => value.length > 0);
    if (values.length === 0)
        return original;
    const scrub = (input) => values.reduce((result, value) => result.split(value).join("[REDACTED]"), input);
    const redacted = new Error(scrub(original.message));
    redacted.name = scrub(original.name);
    return redacted;
}
function assertNoCredentialResponse(value, credentialValues) {
    const values = credentialValues.filter((credential) => credential.length > 0);
    if (values.length === 0)
        return;
    const seen = new Set();
    const visit = (current) => {
        if (typeof current === "string") {
            if (values.some((credential) => current.includes(credential))) {
                throw new SandboxRuntimeTransportPoisonError("Sandbox Runtime service response contained a raw credential value");
            }
            return;
        }
        if (typeof current !== "object" || current === null || seen.has(current))
            return;
        seen.add(current);
        for (const key of Reflect.ownKeys(current)) {
            if (typeof key === "string")
                visit(key);
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (descriptor !== undefined && "value" in descriptor)
                visit(descriptor.value);
        }
    };
    visit(value);
}
export class MirroredViolationStore {
    #byCommand = new Map();
    #all = [];
    #clearRemote;
    bindClearRemote(clearRemote) {
        this.#clearRemote = clearRemote;
    }
    replaceForCommand(commandId, violations) {
        const copy = violations.map((violation) => ({ line: violation.line }));
        this.#byCommand.set(commandId, copy);
        this.#all.push(...copy);
    }
    getViolationsForCommand(commandId) {
        return [...(this.#byCommand.get(commandId) ?? [])];
    }
    getViolations(limit = this.#all.length) {
        return this.#all.slice(-Math.max(0, limit));
    }
    getTotalCount() {
        return this.#all.length;
    }
    clear() {
        this.clearLocal();
        this.#clearRemote?.();
    }
    clearLocal() {
        this.#byCommand.clear();
        this.#all = [];
    }
}
class SandboxRuntimeTransportPoisonError extends Error {
    name = "SandboxRuntimeTransportPoisonError";
}
function isPoisonError(error) {
    return error instanceof SandboxRuntimeTransportPoisonError
        || (error instanceof Error && (error.name === "SandboxRuntimeServicePoisonError"
            || error.name === "SandboxRuntimeTransportPoisonError"));
}
class ForkSandboxRuntimeTransport {
    child;
    timeouts;
    #pending = new Map();
    #retired = new Set();
    #exitPromise;
    #onChildMessage = (message) => this.onMessage(message);
    #onChildError = (error) => this.failTerminal(error);
    #onChildExit = (code, signal) => {
        this.#exited = true;
        this.#resolveExit();
        if (!this.#closing) {
            this.failTerminal(new Error(`Sandbox Runtime service exited unexpectedly (code=${String(code)}, signal=${String(signal)})`));
        }
    };
    #nextId = 0;
    #closing = false;
    #exited = false;
    #terminalError;
    #closePromise;
    #resolveExit;
    constructor(child, timeouts) {
        this.child = child;
        this.timeouts = timeouts;
        this.#exitPromise = new Promise((resolveExit) => { this.#resolveExit = resolveExit; });
        child.on("message", this.#onChildMessage);
        child.on("error", this.#onChildError);
        child.on("exit", this.#onChildExit);
        if (child.exitCode !== null || child.signalCode !== null) {
            this.#exited = true;
            this.#resolveExit();
        }
    }
    request(operation, payload, signal) {
        let serviceOperation;
        try {
            serviceOperation = requiredServiceOperation(operation);
        }
        catch (error) {
            return Promise.reject(asError(error));
        }
        if (signal?.aborted)
            return Promise.reject(new Error("aborted"));
        if (this.#terminalError !== undefined)
            return Promise.reject(this.#terminalError);
        if (this.#closing || this.#exited || !this.child.connected) {
            return Promise.reject(new Error("Sandbox Runtime service is unavailable"));
        }
        if (this.#pending.size >= MAX_PENDING_REQUESTS) {
            return Promise.reject(new Error(`Sandbox Runtime service pending request limit (${MAX_PENDING_REQUESTS}) exceeded`));
        }
        if (this.#nextId >= Number.MAX_SAFE_INTEGER) {
            const error = new Error("Sandbox Runtime service request ID space exhausted");
            this.failTerminal(error);
            return Promise.reject(error);
        }
        const id = ++this.#nextId;
        const message = { type: "request", id, operation: serviceOperation, payload };
        try {
            assertIpcMessage(message, "Sandbox Runtime service request");
        }
        catch (error) {
            return Promise.reject(asError(error));
        }
        return new Promise((resolve, reject) => {
            const onAbort = signal === undefined
                ? undefined
                : () => {
                    try {
                        this.notify("abort", { id });
                    }
                    finally {
                        this.failTerminal(new SandboxRuntimeTransportPoisonError("aborted"));
                    }
                };
            if (onAbort !== undefined)
                signal?.addEventListener("abort", onAbort, { once: true });
            const timer = setTimeout(() => {
                this.failTerminal(new SandboxRuntimeTransportPoisonError(`Sandbox Runtime service ${serviceOperation} request timed out after ${this.timeouts.operations[serviceOperation]}ms`));
            }, this.timeouts.operations[serviceOperation]);
            this.#pending.set(id, {
                operation: serviceOperation,
                signal,
                onAbort,
                timer,
                resolve: (value) => resolve(value),
                reject,
            });
            try {
                this.child.send(message, (error) => {
                    if (error === null)
                        return;
                    this.failTerminal(error);
                });
            }
            catch (error) {
                this.failTerminal(asError(error));
            }
            if (signal?.aborted)
                onAbort?.();
        });
    }
    notify(operation, payload) {
        if (this.#closing || this.#exited || this.#terminalError !== undefined || !this.child.connected)
            return;
        if (operation !== "abort" && operation !== "clearViolations") {
            this.failTerminal(new Error(`Sandbox Runtime service protocol rejected unknown notification ${operation}`));
            return;
        }
        if (operation === "abort") {
            const record = ownRecord(payload, "Sandbox Runtime abort notification payload");
            assertExactOwnKeys(record, ["id"], "Sandbox Runtime abort notification payload");
            if (!Number.isSafeInteger(ownDataValue(record, "id"))) {
                this.failTerminal(new Error("Sandbox Runtime service protocol rejected an invalid abort request ID"));
                return;
            }
        }
        else if (payload !== undefined) {
            this.failTerminal(new Error("Sandbox Runtime clearViolations notification does not accept a payload"));
            return;
        }
        const message = { type: "notify", operation, payload };
        try {
            assertIpcMessage(message, "Sandbox Runtime service notification");
            this.child.send(message, (error) => {
                if (error !== null)
                    this.failTerminal(error);
            });
        }
        catch (error) {
            this.failTerminal(asError(error));
        }
    }
    async close() {
        const attempt = this.#closePromise ?? this.closeOnce();
        this.#closePromise = attempt;
        try {
            await attempt;
        }
        catch (error) {
            if (this.#closePromise === attempt)
                this.#closePromise = undefined;
            throw error;
        }
    }
    onMessage(message) {
        let response;
        try {
            response = requiredServiceResponse(message);
        }
        catch (error) {
            this.failProtocol(asError(error));
            return;
        }
        const pending = this.removePending(response.id, "completed");
        if (pending !== undefined) {
            if (response.ok)
                pending.resolve(response.value);
            else {
                const failure = new Error(response.error?.message ?? "Sandbox Runtime service request failed");
                failure.name = response.error?.name ?? "Error";
                pending.reject(failure);
            }
            return;
        }
        const retired = this.#retired.has(response.id);
        this.failProtocol(new Error(retired
            ? `Sandbox Runtime service protocol received duplicate response ID ${response.id}`
            : `Sandbox Runtime service protocol received unknown response ID ${response.id}`));
    }
    failAll(error) {
        for (const id of [...this.#pending.keys()]) {
            this.removePending(id)?.reject(error);
        }
    }
    removePending(id, retirement) {
        const pending = this.#pending.get(id);
        if (pending === undefined)
            return undefined;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.onAbort !== undefined)
            pending.signal?.removeEventListener("abort", pending.onAbort);
        if (retirement !== undefined)
            this.rememberRetired(id, retirement);
        return pending;
    }
    rememberRetired(id, _retirement) {
        this.#retired.delete(id);
        this.#retired.add(id);
        while (this.#retired.size > MAX_RETIRED_RESPONSE_IDS) {
            const oldest = this.#retired.values().next().value;
            if (oldest === undefined)
                break;
            this.#retired.delete(oldest);
        }
    }
    failProtocol(error) {
        this.failTerminal(error.message.includes("protocol")
            ? error
            : new Error(`Sandbox Runtime service protocol failure: ${error.message}`, { cause: error }));
    }
    failTerminal(error) {
        this.#terminalError ??= error instanceof SandboxRuntimeTransportPoisonError
            ? error
            : new SandboxRuntimeTransportPoisonError(error.message, { cause: error });
        this.failAll(this.#terminalError);
        void this.close().catch(() => undefined);
    }
    async closeOnce() {
        this.#closing = true;
        this.failAll(new Error("Sandbox Runtime service transport closed"));
        try {
            if (!this.#exited && this.child.exitCode === null && this.child.signalCode === null) {
                try {
                    this.child.kill("SIGTERM");
                }
                catch (error) {
                    if (!isNoSuchProcess(error))
                        throw error;
                }
                if (this.child.connected)
                    this.child.disconnect();
                if (!(await this.waitForExit(this.timeouts.termGraceMs))) {
                    try {
                        this.child.kill("SIGKILL");
                    }
                    catch (error) {
                        if (!isNoSuchProcess(error))
                            throw error;
                    }
                    if (!(await this.waitForExit(this.timeouts.killWaitMs))) {
                        throw new Error(`Sandbox Runtime service did not exit within ${this.timeouts.killWaitMs}ms after SIGKILL`);
                    }
                }
            }
        }
        finally {
            this.child.stderr?.destroy();
            if (this.#exited) {
                this.child.off("message", this.#onChildMessage);
                this.child.off("error", this.#onChildError);
                this.child.off("exit", this.#onChildExit);
            }
        }
    }
    async waitForExit(timeoutMs) {
        if (this.#exited || this.child.exitCode !== null || this.child.signalCode !== null)
            return true;
        let timer;
        try {
            return await Promise.race([
                this.#exitPromise.then(() => true),
                new Promise((resolveTimeout) => {
                    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
                }),
            ]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
}
async function createForkSandboxRuntimeTransport(launch, timeoutOverrides) {
    const child = fork(launch.servicePath, [], {
        cwd: launch.cwd,
        env: launch.env,
        execPath: launch.nodePath,
        detached: false,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr?.on("data", () => undefined);
    return new ForkSandboxRuntimeTransport(child, normalizeTransportTimeouts(timeoutOverrides));
}
function normalizeTransportTimeouts(overrides) {
    const operations = { ...DEFAULT_OPERATION_TIMEOUTS };
    for (const operation of Object.keys(overrides?.operations ?? {})) {
        requiredServiceOperation(operation);
        const value = overrides?.operations?.[operation];
        if (value !== undefined)
            operations[operation] = requiredTimeout(value, `${operation} operation timeout`);
    }
    return {
        operations: Object.freeze(operations),
        termGraceMs: requiredTimeout(overrides?.termGraceMs ?? DEFAULT_TERM_GRACE_MS, "SIGTERM grace timeout"),
        killWaitMs: requiredTimeout(overrides?.killWaitMs ?? DEFAULT_KILL_WAIT_MS, "SIGKILL exit timeout"),
    };
}
function requiredTimeout(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 300_000) {
        throw new Error(`${label} must be a positive safe integer no greater than 300000ms`);
    }
    return value;
}
function requiredServiceOperation(value) {
    if (Object.hasOwn(DEFAULT_OPERATION_TIMEOUTS, value))
        return value;
    throw new Error(`Sandbox Runtime service protocol rejected unknown operation ${value}`);
}
function requiredServiceResponse(value) {
    assertIpcMessage(value, "Sandbox Runtime service response");
    const record = ownRecord(value, "Sandbox Runtime service response");
    const ok = ownDataValue(record, "ok");
    assertExactOwnKeys(record, ok === true ? ["type", "id", "ok", "value"] : ["type", "id", "ok", "error"], "Sandbox Runtime service response", true);
    if (ownDataValue(record, "type") !== "response") {
        throw new Error("response type must be response");
    }
    const id = ownDataValue(record, "id");
    if (!Number.isSafeInteger(id) || id <= 0)
        throw new Error("response ID must be a positive safe integer");
    if (typeof ok !== "boolean")
        throw new Error("response ok flag must be boolean");
    if (ok)
        return { type: "response", id: id, ok: true, value: ownOptionalDataValue(record, "value") };
    const errorRecord = ownRecord(ownDataValue(record, "error"), "Sandbox Runtime service response error");
    assertExactOwnKeys(errorRecord, ["name", "message"], "Sandbox Runtime service response error", true);
    const name = ownOptionalDataValue(errorRecord, "name");
    const message = ownOptionalDataValue(errorRecord, "message");
    if (name !== undefined && typeof name !== "string")
        throw new Error("response error name must be a string");
    if (message !== undefined && typeof message !== "string")
        throw new Error("response error message must be a string");
    return {
        type: "response",
        id: id,
        ok: false,
        error: {
            name: typeof name === "string" && name !== "" ? name : "Error",
            message: typeof message === "string" && message.trim() !== ""
                ? message
                : "Sandbox Runtime service request failed",
        },
    };
}
function assertIpcMessage(value, label) {
    assertPlainIpcData(value, label);
    let size;
    try {
        size = serialize(value).byteLength;
    }
    catch (error) {
        throw new Error(`${label} is not serializable`, { cause: error });
    }
    if (size > MAX_IPC_MESSAGE_BYTES) {
        throw new Error(`${label} message is too large (${size} bytes; limit ${MAX_IPC_MESSAGE_BYTES})`);
    }
}
function assertPlainIpcData(value, label) {
    const seen = new Set();
    let nodes = 0;
    const visit = (current, depth) => {
        if (current === undefined || current === null || typeof current === "string" || typeof current === "boolean")
            return;
        if (typeof current === "number") {
            if (!Number.isFinite(current))
                throw new Error(`${label} contains a non-finite number`);
            return;
        }
        if (typeof current !== "object")
            throw new Error(`${label} contains unsupported data`);
        if (depth > MAX_IPC_DATA_DEPTH)
            throw new Error(`${label} exceeds the maximum data depth`);
        if (seen.has(current))
            throw new Error(`${label} contains a cyclic object`);
        if (++nodes > MAX_IPC_DATA_NODES)
            throw new Error(`${label} contains too many values`);
        seen.add(current);
        const prototype = Object.getPrototypeOf(current);
        if (Array.isArray(current)) {
            if (prototype !== Array.prototype)
                throw new Error(`${label} contains an invalid array prototype`);
        }
        else if (prototype !== Object.prototype && prototype !== null) {
            throw new Error(`${label} contains a non-plain object`);
        }
        for (const key of Reflect.ownKeys(current)) {
            if (typeof key !== "string")
                throw new Error(`${label} contains a symbol property`);
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (descriptor === undefined || !("value" in descriptor)) {
                throw new Error(`${label} contains an accessor property`);
            }
            visit(descriptor.value, depth + 1);
        }
        seen.delete(current);
    };
    visit(value, 0);
}
function ownRecord(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw new Error(`${label} must be a plain object`);
    return value;
}
function ownDataValue(record, key) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor))
        return undefined;
    return descriptor.value;
}
function ownOptionalDataValue(record, key) {
    return Object.hasOwn(record, key) ? ownDataValue(record, key) : undefined;
}
function assertExactOwnKeys(record, allowed, label, optionalLast = false) {
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
        throw new Error(`${label} contains an unexpected property`);
    }
    const required = optionalLast ? allowed.slice(0, -1) : allowed;
    if (required.some((key) => !Object.hasOwn(record, key)))
        throw new Error(`${label} is missing a required property`);
}
function isNoSuchProcess(error) {
    return typeof error === "object" && error !== null && "code" in error
        && error.code === "ESRCH";
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
