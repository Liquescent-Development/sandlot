import { execFile, spawn as nodeSpawn } from "node:child_process";
import { formatSandboxViolations } from "./violations.js";
// macOS unified-log delivery can trail the sandboxed child's close event. Keep
// this UX-only recovery window short (and only for unannotated nonzero exits),
// while successful commands and already-classified failures pay no delay.
const FAILED_VIOLATION_SETTLE_MS = 250;
const VIOLATION_SETTLE_INTERVAL_MS = 25;
export class SandboxRunner {
    manager;
    runtime;
    #spawn;
    #killProcess;
    #platform;
    #createDescendantSupervisor;
    #violationSettleMs;
    #wait;
    #active = new Map();
    #terminationFailure;
    constructor(manager, runtime, dependencies = {}) {
        this.manager = manager;
        this.runtime = runtime;
        this.#spawn = dependencies.spawn ?? defaultSpawn;
        this.#killProcess = dependencies.killProcess ?? process.kill.bind(process);
        this.#platform = dependencies.platform ?? process.platform;
        this.#createDescendantSupervisor = dependencies.createDescendantSupervisor
            ?? ((rootPid) => new PollingDescendantSupervisor(rootPid, this.#killProcess));
        this.#violationSettleMs = dependencies.violationSettleMs ?? FAILED_VIOLATION_SETTLE_MS;
        this.#wait = dependencies.wait ?? delay;
        this.manager.bindExecutionTerminationGate?.({ terminateAndWait: () => this.abortAll() });
    }
    run(request) {
        const lease = this.runtime.acquire(request.invocationId, request.expectedGeneration);
        const controller = new AbortController();
        const execution = this.runWithLease(request, lease, controller);
        this.#active.set(controller, execution);
        void execution.finally(() => this.#active.delete(controller)).catch(() => undefined);
        return execution;
    }
    async abortAll() {
        const active = [...this.#active.entries()];
        for (const [controller] of active)
            controller.abort();
        await Promise.allSettled(active.map(([, execution]) => execution));
        if (this.#terminationFailure !== undefined) {
            throw new Error(`SandboxRunner could not confirm descendant termination: ${this.#terminationFailure.message}`, { cause: this.#terminationFailure });
        }
    }
    async runWithLease(request, lease, controller) {
        const abortFromCaller = () => controller.abort();
        let wrapped = false;
        try {
            this.runtime.registerAbort(lease, controller);
            if (request.signal?.aborted)
                controller.abort();
            else
                request.signal?.addEventListener("abort", abortFromCaller, { once: true });
            if (controller.signal.aborted)
                throw new Error("aborted");
            const descriptor = await this.manager.wrapWithSandboxArgv(request.command, undefined, undefined, controller.signal, request.cwd, {
                commandId: request.invocationId,
                commandText: request.commandText,
                childEnvironment: request.env,
            });
            wrapped = true;
            this.runtime.assertCurrent(lease);
            if (controller.signal.aborted)
                throw new Error("aborted");
            const result = await this.spawnAndCollect(descriptor, request, controller.signal);
            this.runtime.assertCurrent(lease);
            if (controller.signal.aborted)
                throw new Error("aborted");
            return result;
        }
        finally {
            request.signal?.removeEventListener("abort", abortFromCaller);
            try {
                if (wrapped)
                    await this.manager.cleanupAfterCommand();
            }
            finally {
                this.runtime.release(lease);
            }
        }
    }
    async spawnAndCollect(descriptor, request, signal) {
        const { argv } = descriptor;
        const [command, ...args] = argv;
        if (command === undefined || command === "")
            throw new Error("Sandbox Runtime returned empty argv");
        if (request.maxOutputBytes !== undefined
            && (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 0)) {
            throw new Error("maxOutputBytes must be a non-negative safe integer");
        }
        const child = this.#spawn(command, args, {
            shell: false,
            cwd: request.cwd,
            env: descriptor.env,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const descendantSupervisor = this.#platform === "darwin" && child.pid !== undefined
            ? this.#createDescendantSupervisor(child.pid)
            : undefined;
        const stdin = child.stdin;
        const childStdout = child.stdout;
        const childStderr = child.stderr;
        const stdout = [];
        const stderr = [];
        const timeoutController = new AbortController();
        let capturedBytes = 0;
        let streamedOutput = false;
        let streamedOutputEndsWithNewline = false;
        let closed = false;
        let killRequested = false;
        let failure;
        let timeout;
        let listenerCleanup;
        const terminate = () => {
            if (closed || killRequested)
                return;
            killRequested = true;
            if (child.pid !== undefined) {
                try {
                    const groupKilled = this.#killProcess(-child.pid, "SIGKILL");
                    if (groupKilled !== false)
                        return;
                }
                catch {
                    // The group can disappear between close detection and kill.
                }
            }
            try {
                // Kill delivery is best-effort. A throw or false result must not
                // replace the invocation failure or release ownership before close.
                child.kill("SIGKILL");
            }
            catch {
                // The child can disappear after group termination fails.
            }
        };
        const recordFailure = (error) => {
            if (failure !== undefined)
                return;
            failure = asError(error);
            if (timeout !== undefined) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            if (!closed)
                terminate();
        };
        const streamAndCapture = (target, data) => {
            if (closed)
                return;
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (chunk.length > 0) {
                streamedOutput = true;
                streamedOutputEndsWithNewline = chunk[chunk.length - 1] === 0x0a;
            }
            try {
                request.onData?.(chunk);
            }
            catch (error) {
                recordFailure(error);
                return;
            }
            const limit = request.maxOutputBytes;
            if (limit === undefined)
                return;
            const remaining = limit - capturedBytes;
            if (chunk.length <= remaining) {
                target.push(chunk);
                capturedBytes += chunk.length;
                return;
            }
            if (remaining > 0) {
                target.push(chunk.subarray(0, remaining));
                capturedBytes += remaining;
            }
            recordFailure(new Error(`output-limit:${limit}`));
        };
        try {
            return await new Promise((resolve, reject) => {
                const onAbort = () => {
                    if (!closed)
                        recordFailure(new Error("aborted"));
                };
                const onTimeout = () => {
                    if (!closed)
                        recordFailure(new Error(`timeout:${formatSeconds(request.timeoutMs ?? 0)}`));
                };
                const onError = (error) => {
                    if (!closed)
                        recordFailure(error);
                };
                const onStdinError = (error) => {
                    if (!closed)
                        recordFailure(error);
                };
                const onClose = (exitCode, exitSignal) => {
                    if (closed)
                        return;
                    closed = true;
                    if (timeout !== undefined) {
                        clearTimeout(timeout);
                        timeout = undefined;
                    }
                    void (async () => {
                        if (failure === undefined && exitSignal !== null) {
                            failure = new Error(`Sandbox child exited from unexpected signal ${exitSignal}`);
                        }
                        let descendantsConfirmed = true;
                        try {
                            await descendantSupervisor?.terminateAndWait();
                        }
                        catch (error) {
                            descendantsConfirmed = false;
                            this.#terminationFailure ??= asError(error);
                            recordFailure(error);
                        }
                        try {
                            const violationChunk = request.annotateViolations === false
                                ? Buffer.alloc(0)
                                : descendantsConfirmed
                                    ? await this.formatViolations(request.invocationId, streamedOutput && !streamedOutputEndsWithNewline, failure === undefined && exitCode !== null && exitCode !== 0)
                                    : Buffer.alloc(0);
                            if (violationChunk.length > 0) {
                                try {
                                    request.onData?.(violationChunk);
                                }
                                catch (error) {
                                    recordFailure(error);
                                }
                                const limit = request.maxOutputBytes;
                                if (limit !== undefined) {
                                    const remaining = limit - capturedBytes;
                                    if (violationChunk.length <= remaining) {
                                        stderr.push(violationChunk);
                                        capturedBytes += violationChunk.length;
                                    }
                                    else {
                                        if (remaining > 0) {
                                            stderr.push(violationChunk.subarray(0, remaining));
                                            capturedBytes += remaining;
                                        }
                                        recordFailure(new Error(`output-limit:${limit}`));
                                    }
                                }
                            }
                        }
                        catch (error) {
                            recordFailure(error);
                        }
                        if (failure !== undefined)
                            reject(failure);
                        else
                            resolve({
                                exitCode,
                                stdout: Buffer.concat(stdout).toString(),
                                stderr: Buffer.concat(stderr).toString(),
                            });
                    })();
                };
                const onStdout = (data) => streamAndCapture(stdout, data);
                const onStderr = (data) => streamAndCapture(stderr, data);
                signal.addEventListener("abort", onAbort, { once: true });
                timeoutController.signal.addEventListener("abort", onTimeout, { once: true });
                child.on("error", onError);
                child.on("close", onClose);
                stdin?.on("error", onStdinError);
                childStdout?.on("data", onStdout);
                childStderr?.on("data", onStderr);
                listenerCleanup = () => {
                    signal.removeEventListener("abort", onAbort);
                    timeoutController.signal.removeEventListener("abort", onTimeout);
                    child.off("error", onError);
                    child.off("close", onClose);
                    stdin?.off("error", onStdinError);
                    childStdout?.off("data", onStdout);
                    childStderr?.off("data", onStderr);
                };
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
                    timeout = setTimeout(() => timeoutController.abort(), request.timeoutMs);
                }
                if (stdin === null || childStdout === null || childStderr === null) {
                    recordFailure(new Error("Sandbox child stdio was not piped"));
                    return;
                }
                try {
                    stdin.end(request.stdin);
                }
                catch (error) {
                    recordFailure(error);
                }
            });
        }
        finally {
            if (timeout !== undefined)
                clearTimeout(timeout);
            listenerCleanup?.();
        }
    }
    async formatViolations(invocationId, needsSeparator, settleForMaterialViolation) {
        let formatted = await this.collectFormattedViolations(invocationId);
        let remaining = this.#violationSettleMs;
        while (settleForMaterialViolation && formatted === "" && remaining > 0) {
            const interval = Math.min(VIOLATION_SETTLE_INTERVAL_MS, remaining);
            await this.#wait(interval);
            remaining -= interval;
            formatted = await this.collectFormattedViolations(invocationId);
        }
        return formatted === "" ? Buffer.alloc(0) : Buffer.from(`${needsSeparator ? "\n" : ""}${formatted}`);
    }
    async collectFormattedViolations(invocationId) {
        const violations = this.manager.collectViolations === undefined
            ? this.manager.getSandboxViolationStore().getViolationsForCommand(invocationId)
            : await this.manager.collectViolations(invocationId);
        return formatSandboxViolations(violations);
    }
}
class PollingDescendantSupervisor {
    rootPid;
    killProcess;
    #known = new Map();
    #timer;
    #sampling = Promise.resolve();
    #samplingError;
    constructor(rootPid, killProcess) {
        this.rootPid = rootPid;
        this.killProcess = killProcess;
        this.queueSample();
        this.#timer = setInterval(() => this.queueSample(), 10);
        this.#timer.unref();
    }
    async terminateAndWait() {
        clearInterval(this.#timer);
        await this.queueSample();
        if (this.#samplingError !== undefined)
            throw this.#samplingError;
        const deadline = Date.now() + 2_000;
        while (true) {
            const records = await listProcesses();
            this.capture(records);
            const active = new Map(records.map((record) => [record.pid, record]));
            const descendants = [...this.#known.entries()].filter(([pid, started]) => active.get(pid)?.started === started);
            if (descendants.length === 0)
                return;
            for (const [pid] of descendants) {
                try {
                    this.killProcess(pid, "SIGKILL");
                }
                catch (error) {
                    if (!isNoSuchProcess(error))
                        throw error;
                }
            }
            if (Date.now() >= deadline) {
                throw new Error(`Detached sandbox descendants did not terminate: ${descendants.map(([pid]) => pid).join(", ")}`);
            }
            await delay(20);
        }
    }
    queueSample() {
        this.#sampling = this.#sampling.then(async () => {
            if (this.#samplingError !== undefined)
                return;
            try {
                this.capture(await listProcesses());
            }
            catch (error) {
                this.#samplingError = asError(error);
            }
        });
        return this.#sampling;
    }
    capture(records) {
        const active = new Map(records.map((record) => [record.pid, record]));
        const ancestors = new Set([this.rootPid]);
        for (const [pid, started] of this.#known) {
            if (active.get(pid)?.started === started)
                ancestors.add(pid);
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const record of records) {
                if (record.pid === this.rootPid || !ancestors.has(record.parentPid) || ancestors.has(record.pid))
                    continue;
                this.#known.set(record.pid, record.started);
                ancestors.add(record.pid);
                changed = true;
            }
        }
    }
}
async function listProcesses() {
    const stdout = await new Promise((resolveOutput, reject) => {
        execFile("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
            encoding: "utf8",
            env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", TMPDIR: "/private/tmp" },
            maxBuffer: 4 * 1024 * 1024,
            timeout: 2_000,
            windowsHide: true,
        }, (error, output) => error === null ? resolveOutput(output) : reject(error));
    });
    return stdout.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
            return [];
        return [{ pid: Number(match[1]), parentPid: Number(match[2]), started: match[3] }];
    });
}
function isNoSuchProcess(error) {
    return typeof error === "object" && error !== null && "code" in error
        && error.code === "ESRCH";
}
function delay(milliseconds) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
const defaultSpawn = (command, args, options) => nodeSpawn(command, args, options);
function formatSeconds(timeoutMs) {
    return String(timeoutMs / 1_000);
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
