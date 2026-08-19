import { randomUUID } from "node:crypto";
import { createBashTool, createBashToolDefinition, createLocalBashOperations, } from "@earendil-works/pi-coding-agent";
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1_000;
/**
 * Sandboxed Pi operations. The runtime state is evaluated per execution so a
 * stale/failed generation cannot fall back to host command execution.
 */
export function createSandlotBashOperations(dependencies) {
    const invocationId = dependencies.invocationId ?? randomUUID;
    return {
        async exec(command, cwd, options) {
            const timeoutMs = resolveTimeoutMs(options.timeout);
            const snapshot = dependencies.runtime.snapshot();
            if (snapshot.state === "disabled-by-user") {
                return (dependencies.createLocalBashOperations ?? createLocalBashOperations)().exec(command, cwd, options);
            }
            if (snapshot.state !== "ready")
                throw new Error(`Sandlot runtime is not ready (${snapshot.state})`);
            const result = await dependencies.runner.run({
                invocationId: invocationId(),
                expectedGeneration: snapshot.generation,
                command,
                commandText: command,
                cwd,
                env: dependencies.environment(),
                timeoutMs,
                signal: options.signal,
                onData: options.onData,
            });
            return { exitCode: result.exitCode };
        },
    };
}
/** Operations used by Pi's `user_bash` event; the default invocation ID is a UUID. */
export function createSandlotUserBashOperations(dependencies) {
    return createSandlotBashOperations({ ...dependencies, invocationId: dependencies.invocationId ?? randomUUID });
}
/**
 * Retains Pi's public bash definition (schema, text, renderers) and delegates
 * each execution to a fresh Pi tool bound to the call's working directory.
 */
export function createSandlotBashTool(dependencies) {
    const piDefinition = createBashToolDefinition(process.cwd(), {
        operations: createSandlotBashOperations({ ...dependencies, invocationId: randomUUID }),
        exposeSessionEnvironment: false,
    });
    return {
        ...piDefinition,
        async execute(toolCallId, input, signal, onUpdate, context) {
            const tool = createBashTool(context.cwd, {
                operations: createSandlotBashOperations({ ...dependencies, invocationId: () => toolCallId }),
                exposeSessionEnvironment: false,
            });
            return tool.execute(toolCallId, input, signal, onUpdate);
        },
    };
}
function resolveTimeoutMs(timeout) {
    if (timeout === undefined)
        return undefined;
    if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error("Invalid timeout: must be a finite number of seconds");
    }
    const timeoutMs = timeout * 1_000;
    if (timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
    }
    return timeoutMs;
}
