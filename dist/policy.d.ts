import { type FilesystemConfig, type NetworkConfig, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { type EnvironmentPolicy, type ProjectPolicy, type UserPolicy } from "./config.js";
type EffectiveNetworkConfig = Omit<NetworkConfig, "strictAllowlist"> & {
    strictAllowlist: true;
};
export interface EffectivePolicy {
    enabled: boolean;
    network: EffectiveNetworkConfig;
    filesystem: FilesystemConfig;
    credentials: NonNullable<UserPolicy["credentials"]> | undefined;
    environment: EnvironmentPolicy;
    trustedCustomTools: string[];
    enableWeakerNestedSandbox: boolean;
    enableWeakerNetworkIsolation: boolean;
    allowAppleEvents: boolean;
    ripgrep: UserPolicy["ripgrep"];
    seccomp: UserPolicy["seccomp"];
    bwrapPath: string | undefined;
    socatPath: string | undefined;
}
export interface PolicyCompositionContext {
    cwd: string;
    agentDir?: string;
}
export declare function domainPatternCovers(ceiling: string, requested: string): boolean;
export declare function composePolicy(user: UserPolicy, project: ProjectPolicy | undefined, context: PolicyCompositionContext): Promise<EffectivePolicy>;
export declare function toSandboxRuntimeConfig(effective: EffectivePolicy): SandboxRuntimeConfig;
export declare function validatePolicyForPlatform(effective: EffectivePolicy, platform: NodeJS.Platform, arch: NodeJS.Architecture): Promise<void>;
export {};
