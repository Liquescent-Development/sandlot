import { SandboxManager, type SandboxAskCallback, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
interface ServiceManager {
    updateConfig(config: SandboxRuntimeConfig): void;
    checkDependenciesAsync(ripgrepConfig?: {
        command: string;
        args?: string[];
    }): Promise<unknown>;
    initialize(config: SandboxRuntimeConfig, askCallback?: SandboxAskCallback, enableLogMonitor?: boolean): Promise<void>;
    wrapWithSandboxArgv(command: string, binShell?: string, customConfig?: Partial<SandboxRuntimeConfig>, signal?: AbortSignal, cwd?: string, options?: {
        commandId?: string;
        commandText?: string;
    }): Promise<unknown>;
    cleanupAfterCommand(): void;
    getLinuxGlobPatternWarnings(): string[];
    getSandboxViolationStore(): {
        clear(): void;
        getViolationsForCommand(commandId: string): Array<{
            line: string;
        }>;
    };
    getSentinelRegistry(): ReturnType<typeof SandboxManager.getSentinelRegistry>;
    getAwsPairRegistry(): ReturnType<typeof SandboxManager.getAwsPairRegistry>;
    reset(): Promise<void>;
}
type ServiceOperation = "updateConfig" | "checkDependencies" | "initialize" | "wrap" | "violationsForCommand" | "cleanupAfterCommand" | "linuxGlobPatternWarnings" | "clearViolations" | "reset";
interface ServiceRequestDependencies {
    readonly scanMandatoryDenyPaths: (ripgrepCommand: string, cwd: string, signal?: AbortSignal) => Promise<void>;
    readonly operationTimeouts?: Partial<Record<ServiceOperation, number>>;
}
export declare function handleSandboxRuntimeRequest(manager: ServiceManager, operation: string, payload: unknown, signal?: AbortSignal, dependencies?: ServiceRequestDependencies): Promise<unknown>;
export declare function runMandatoryDenyScan(ripgrepCommand: string, cwd: string, signal?: AbortSignal): Promise<void>;
interface ServiceRequestMessage {
    readonly type: "request";
    readonly id: number;
    readonly operation: string;
    readonly payload?: unknown;
}
interface ServiceNotifyMessage {
    readonly type: "notify";
    readonly operation: string;
    readonly payload?: unknown;
}
export declare function validateSandboxRuntimeServiceMessage(value: unknown): ServiceRequestMessage | ServiceNotifyMessage;
export {};
