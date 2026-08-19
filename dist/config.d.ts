import { z } from "zod";
export type NetworkMode = "filtered" | "unrestricted";
declare const FilteredUserNetworkSchema: z.ZodObject<{
    mode: z.ZodOptional<z.ZodLiteral<"filtered">>;
    allowedDomains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    deniedDomains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    deniedDomainReasons: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    allowUnixSockets: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    allowAllUnixSockets: z.ZodOptional<z.ZodBoolean>;
    allowLocalBinding: z.ZodOptional<z.ZodBoolean>;
    allowMachLookup: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    tlsTerminate: z.ZodOptional<z.ZodObject<{
        caCertPath: z.ZodOptional<z.ZodString>;
        caKeyPath: z.ZodOptional<z.ZodString>;
        excludeDomains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        extraCaCertPaths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strict", z.ZodTypeAny, {
        caCertPath?: string | undefined;
        caKeyPath?: string | undefined;
        excludeDomains?: string[] | undefined;
        extraCaCertPaths?: string[] | undefined;
    }, {
        caCertPath?: string | undefined;
        caKeyPath?: string | undefined;
        excludeDomains?: string[] | undefined;
        extraCaCertPaths?: string[] | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    mode?: "filtered" | undefined;
    allowedDomains?: string[] | undefined;
    deniedDomains?: string[] | undefined;
    deniedDomainReasons?: Record<string, string> | undefined;
    allowUnixSockets?: string[] | undefined;
    allowAllUnixSockets?: boolean | undefined;
    allowLocalBinding?: boolean | undefined;
    allowMachLookup?: string[] | undefined;
    tlsTerminate?: {
        caCertPath?: string | undefined;
        caKeyPath?: string | undefined;
        excludeDomains?: string[] | undefined;
        extraCaCertPaths?: string[] | undefined;
    } | undefined;
}, {
    mode?: "filtered" | undefined;
    allowedDomains?: string[] | undefined;
    deniedDomains?: string[] | undefined;
    deniedDomainReasons?: Record<string, string> | undefined;
    allowUnixSockets?: string[] | undefined;
    allowAllUnixSockets?: boolean | undefined;
    allowLocalBinding?: boolean | undefined;
    allowMachLookup?: string[] | undefined;
    tlsTerminate?: {
        caCertPath?: string | undefined;
        caKeyPath?: string | undefined;
        excludeDomains?: string[] | undefined;
        extraCaCertPaths?: string[] | undefined;
    } | undefined;
}>;
declare const UnrestrictedUserNetworkSchema: z.ZodObject<{
    mode: z.ZodLiteral<"unrestricted">;
}, "strict", z.ZodTypeAny, {
    mode: "unrestricted";
}, {
    mode: "unrestricted";
}>;
declare const EnvironmentPolicySchema: z.ZodObject<{
    passThrough: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    deny: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    exposePiSessionMetadata: z.ZodOptional<z.ZodBoolean>;
}, "strict", z.ZodTypeAny, {
    deny?: string[] | undefined;
    passThrough?: string[] | undefined;
    exposePiSessionMetadata?: boolean | undefined;
}, {
    deny?: string[] | undefined;
    passThrough?: string[] | undefined;
    exposePiSessionMetadata?: boolean | undefined;
}>;
declare const UserPolicySchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    network: z.ZodOptional<z.ZodUnion<[z.ZodObject<{
        mode: z.ZodOptional<z.ZodLiteral<"filtered">>;
        allowedDomains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        deniedDomains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        deniedDomainReasons: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        allowUnixSockets: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowAllUnixSockets: z.ZodOptional<z.ZodBoolean>;
        allowLocalBinding: z.ZodOptional<z.ZodBoolean>;
        allowMachLookup: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        tlsTerminate: z.ZodOptional<z.ZodObject<{
            caCertPath: z.ZodOptional<z.ZodString>;
            caKeyPath: z.ZodOptional<z.ZodString>;
            excludeDomains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            extraCaCertPaths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strict", z.ZodTypeAny, {
            caCertPath?: string | undefined;
            caKeyPath?: string | undefined;
            excludeDomains?: string[] | undefined;
            extraCaCertPaths?: string[] | undefined;
        }, {
            caCertPath?: string | undefined;
            caKeyPath?: string | undefined;
            excludeDomains?: string[] | undefined;
            extraCaCertPaths?: string[] | undefined;
        }>>;
    }, "strict", z.ZodTypeAny, {
        mode?: "filtered" | undefined;
        allowedDomains?: string[] | undefined;
        deniedDomains?: string[] | undefined;
        deniedDomainReasons?: Record<string, string> | undefined;
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: boolean | undefined;
        allowLocalBinding?: boolean | undefined;
        allowMachLookup?: string[] | undefined;
        tlsTerminate?: {
            caCertPath?: string | undefined;
            caKeyPath?: string | undefined;
            excludeDomains?: string[] | undefined;
            extraCaCertPaths?: string[] | undefined;
        } | undefined;
    }, {
        mode?: "filtered" | undefined;
        allowedDomains?: string[] | undefined;
        deniedDomains?: string[] | undefined;
        deniedDomainReasons?: Record<string, string> | undefined;
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: boolean | undefined;
        allowLocalBinding?: boolean | undefined;
        allowMachLookup?: string[] | undefined;
        tlsTerminate?: {
            caCertPath?: string | undefined;
            caKeyPath?: string | undefined;
            excludeDomains?: string[] | undefined;
            extraCaCertPaths?: string[] | undefined;
        } | undefined;
    }>, z.ZodObject<{
        mode: z.ZodLiteral<"unrestricted">;
    }, "strict", z.ZodTypeAny, {
        mode: "unrestricted";
    }, {
        mode: "unrestricted";
    }>]>>;
    filesystem: z.ZodOptional<z.ZodObject<{
        disabled: z.ZodOptional<z.ZodBoolean>;
        denyRead: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowRead: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowWrite: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        denyWrite: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowGitConfig: z.ZodOptional<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        disabled?: boolean | undefined;
        denyRead?: string[] | undefined;
        allowRead?: string[] | undefined;
        allowWrite?: string[] | undefined;
        denyWrite?: string[] | undefined;
        allowGitConfig?: boolean | undefined;
    }, {
        disabled?: boolean | undefined;
        denyRead?: string[] | undefined;
        allowRead?: string[] | undefined;
        allowWrite?: string[] | undefined;
        denyWrite?: string[] | undefined;
        allowGitConfig?: boolean | undefined;
    }>>;
    credentials: z.ZodOptional<z.ZodObject<{
        files: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            mode: z.ZodEnum<["deny", "mask"]>;
            extract: z.ZodOptional<z.ZodString>;
            onExtractNoMatch: z.ZodOptional<z.ZodEnum<["warn", "deny", "error"]>>;
            decode: z.ZodOptional<z.ZodEnum<["jwt"]>>;
            maskClaims: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            maskDuplicates: z.ZodOptional<z.ZodBoolean>;
            injectHosts: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strict", z.ZodTypeAny, {
            path: string;
            mode: "deny" | "mask";
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            maskDuplicates?: boolean | undefined;
            injectHosts?: string[] | undefined;
        }, {
            path: string;
            mode: "deny" | "mask";
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            maskDuplicates?: boolean | undefined;
            injectHosts?: string[] | undefined;
        }>, "many">>;
        envVars: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            mode: z.ZodEnum<["deny", "mask"]>;
            extract: z.ZodOptional<z.ZodString>;
            onExtractNoMatch: z.ZodOptional<z.ZodEnum<["warn", "deny", "error"]>>;
            decode: z.ZodOptional<z.ZodEnum<["jwt"]>>;
            maskClaims: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            injectHosts: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strict", z.ZodTypeAny, {
            mode: "deny" | "mask";
            name: string;
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            injectHosts?: string[] | undefined;
        }, {
            mode: "deny" | "mask";
            name: string;
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            injectHosts?: string[] | undefined;
        }>, "many">>;
        allowPlaintextInject: z.ZodOptional<z.ZodBoolean>;
        awsPairs: z.ZodOptional<z.ZodArray<z.ZodObject<{
            accessKeyIdVar: z.ZodString;
            secretAccessKeyVar: z.ZodString;
            sessionTokenVar: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            accessKeyIdVar: string;
            secretAccessKeyVar: string;
            sessionTokenVar?: string | undefined;
        }, {
            accessKeyIdVar: string;
            secretAccessKeyVar: string;
            sessionTokenVar?: string | undefined;
        }>, "many">>;
        sigv4: z.ZodOptional<z.ZodObject<{
            streaming: z.ZodOptional<z.ZodEnum<["deny", "passthrough"]>>;
            presigned: z.ZodOptional<z.ZodEnum<["deny", "passthrough"]>>;
            sigv4a: z.ZodOptional<z.ZodEnum<["deny", "passthrough"]>>;
        }, "strict", z.ZodTypeAny, {
            streaming?: "passthrough" | "deny" | undefined;
            presigned?: "passthrough" | "deny" | undefined;
            sigv4a?: "passthrough" | "deny" | undefined;
        }, {
            streaming?: "passthrough" | "deny" | undefined;
            presigned?: "passthrough" | "deny" | undefined;
            sigv4a?: "passthrough" | "deny" | undefined;
        }>>;
    }, "strict", z.ZodTypeAny, {
        files?: {
            path: string;
            mode: "deny" | "mask";
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            maskDuplicates?: boolean | undefined;
            injectHosts?: string[] | undefined;
        }[] | undefined;
        envVars?: {
            mode: "deny" | "mask";
            name: string;
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            injectHosts?: string[] | undefined;
        }[] | undefined;
        allowPlaintextInject?: boolean | undefined;
        awsPairs?: {
            accessKeyIdVar: string;
            secretAccessKeyVar: string;
            sessionTokenVar?: string | undefined;
        }[] | undefined;
        sigv4?: {
            streaming?: "passthrough" | "deny" | undefined;
            presigned?: "passthrough" | "deny" | undefined;
            sigv4a?: "passthrough" | "deny" | undefined;
        } | undefined;
    }, {
        files?: {
            path: string;
            mode: "deny" | "mask";
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            maskDuplicates?: boolean | undefined;
            injectHosts?: string[] | undefined;
        }[] | undefined;
        envVars?: {
            mode: "deny" | "mask";
            name: string;
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            injectHosts?: string[] | undefined;
        }[] | undefined;
        allowPlaintextInject?: boolean | undefined;
        awsPairs?: {
            accessKeyIdVar: string;
            secretAccessKeyVar: string;
            sessionTokenVar?: string | undefined;
        }[] | undefined;
        sigv4?: {
            streaming?: "passthrough" | "deny" | undefined;
            presigned?: "passthrough" | "deny" | undefined;
            sigv4a?: "passthrough" | "deny" | undefined;
        } | undefined;
    }>>;
    environment: z.ZodOptional<z.ZodObject<{
        passThrough: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        exposePiSessionMetadata: z.ZodOptional<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        deny?: string[] | undefined;
        passThrough?: string[] | undefined;
        exposePiSessionMetadata?: boolean | undefined;
    }, {
        deny?: string[] | undefined;
        passThrough?: string[] | undefined;
        exposePiSessionMetadata?: boolean | undefined;
    }>>;
    trustedCustomTools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    enableWeakerNestedSandbox: z.ZodOptional<z.ZodBoolean>;
    enableWeakerNetworkIsolation: z.ZodOptional<z.ZodBoolean>;
    allowAppleEvents: z.ZodOptional<z.ZodBoolean>;
    ripgrep: z.ZodOptional<z.ZodObject<{
        command: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        command: string;
    }, {
        command: string;
    }>>;
    seccomp: z.ZodOptional<z.ZodObject<{
        applyPath: z.ZodOptional<z.ZodString>;
        argv0: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        applyPath?: string | undefined;
        argv0?: string | undefined;
    }, {
        applyPath?: string | undefined;
        argv0?: string | undefined;
    }>>;
    bwrapPath: z.ZodOptional<z.ZodString>;
    socatPath: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    enabled?: boolean | undefined;
    network?: {
        mode?: "filtered" | undefined;
        allowedDomains?: string[] | undefined;
        deniedDomains?: string[] | undefined;
        deniedDomainReasons?: Record<string, string> | undefined;
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: boolean | undefined;
        allowLocalBinding?: boolean | undefined;
        allowMachLookup?: string[] | undefined;
        tlsTerminate?: {
            caCertPath?: string | undefined;
            caKeyPath?: string | undefined;
            excludeDomains?: string[] | undefined;
            extraCaCertPaths?: string[] | undefined;
        } | undefined;
    } | {
        mode: "unrestricted";
    } | undefined;
    filesystem?: {
        disabled?: boolean | undefined;
        denyRead?: string[] | undefined;
        allowRead?: string[] | undefined;
        allowWrite?: string[] | undefined;
        denyWrite?: string[] | undefined;
        allowGitConfig?: boolean | undefined;
    } | undefined;
    credentials?: {
        files?: {
            path: string;
            mode: "deny" | "mask";
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            maskDuplicates?: boolean | undefined;
            injectHosts?: string[] | undefined;
        }[] | undefined;
        envVars?: {
            mode: "deny" | "mask";
            name: string;
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            injectHosts?: string[] | undefined;
        }[] | undefined;
        allowPlaintextInject?: boolean | undefined;
        awsPairs?: {
            accessKeyIdVar: string;
            secretAccessKeyVar: string;
            sessionTokenVar?: string | undefined;
        }[] | undefined;
        sigv4?: {
            streaming?: "passthrough" | "deny" | undefined;
            presigned?: "passthrough" | "deny" | undefined;
            sigv4a?: "passthrough" | "deny" | undefined;
        } | undefined;
    } | undefined;
    environment?: {
        deny?: string[] | undefined;
        passThrough?: string[] | undefined;
        exposePiSessionMetadata?: boolean | undefined;
    } | undefined;
    trustedCustomTools?: string[] | undefined;
    enableWeakerNestedSandbox?: boolean | undefined;
    enableWeakerNetworkIsolation?: boolean | undefined;
    allowAppleEvents?: boolean | undefined;
    ripgrep?: {
        command: string;
    } | undefined;
    seccomp?: {
        applyPath?: string | undefined;
        argv0?: string | undefined;
    } | undefined;
    bwrapPath?: string | undefined;
    socatPath?: string | undefined;
}, {
    enabled?: boolean | undefined;
    network?: {
        mode?: "filtered" | undefined;
        allowedDomains?: string[] | undefined;
        deniedDomains?: string[] | undefined;
        deniedDomainReasons?: Record<string, string> | undefined;
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: boolean | undefined;
        allowLocalBinding?: boolean | undefined;
        allowMachLookup?: string[] | undefined;
        tlsTerminate?: {
            caCertPath?: string | undefined;
            caKeyPath?: string | undefined;
            excludeDomains?: string[] | undefined;
            extraCaCertPaths?: string[] | undefined;
        } | undefined;
    } | {
        mode: "unrestricted";
    } | undefined;
    filesystem?: {
        disabled?: boolean | undefined;
        denyRead?: string[] | undefined;
        allowRead?: string[] | undefined;
        allowWrite?: string[] | undefined;
        denyWrite?: string[] | undefined;
        allowGitConfig?: boolean | undefined;
    } | undefined;
    credentials?: {
        files?: {
            path: string;
            mode: "deny" | "mask";
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            maskDuplicates?: boolean | undefined;
            injectHosts?: string[] | undefined;
        }[] | undefined;
        envVars?: {
            mode: "deny" | "mask";
            name: string;
            extract?: string | undefined;
            onExtractNoMatch?: "deny" | "warn" | "error" | undefined;
            decode?: "jwt" | undefined;
            maskClaims?: string[] | undefined;
            injectHosts?: string[] | undefined;
        }[] | undefined;
        allowPlaintextInject?: boolean | undefined;
        awsPairs?: {
            accessKeyIdVar: string;
            secretAccessKeyVar: string;
            sessionTokenVar?: string | undefined;
        }[] | undefined;
        sigv4?: {
            streaming?: "passthrough" | "deny" | undefined;
            presigned?: "passthrough" | "deny" | undefined;
            sigv4a?: "passthrough" | "deny" | undefined;
        } | undefined;
    } | undefined;
    environment?: {
        deny?: string[] | undefined;
        passThrough?: string[] | undefined;
        exposePiSessionMetadata?: boolean | undefined;
    } | undefined;
    trustedCustomTools?: string[] | undefined;
    enableWeakerNestedSandbox?: boolean | undefined;
    enableWeakerNetworkIsolation?: boolean | undefined;
    allowAppleEvents?: boolean | undefined;
    ripgrep?: {
        command: string;
    } | undefined;
    seccomp?: {
        applyPath?: string | undefined;
        argv0?: string | undefined;
    } | undefined;
    bwrapPath?: string | undefined;
    socatPath?: string | undefined;
}>;
declare const ProjectPolicySchema: z.ZodObject<{
    network: z.ZodOptional<z.ZodObject<{
        allowedDomains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        deniedDomains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowUnixSockets: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowMachLookup: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowAllUnixSockets: z.ZodOptional<z.ZodLiteral<false>>;
        allowLocalBinding: z.ZodOptional<z.ZodLiteral<false>>;
    }, "strict", z.ZodTypeAny, {
        allowedDomains?: string[] | undefined;
        deniedDomains?: string[] | undefined;
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: false | undefined;
        allowLocalBinding?: false | undefined;
        allowMachLookup?: string[] | undefined;
    }, {
        allowedDomains?: string[] | undefined;
        deniedDomains?: string[] | undefined;
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: false | undefined;
        allowLocalBinding?: false | undefined;
        allowMachLookup?: string[] | undefined;
    }>>;
    filesystem: z.ZodOptional<z.ZodObject<{
        disabled: z.ZodOptional<z.ZodLiteral<false>>;
        denyRead: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowRead: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowWrite: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        denyWrite: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        allowGitConfig: z.ZodOptional<z.ZodLiteral<false>>;
    }, "strict", z.ZodTypeAny, {
        disabled?: false | undefined;
        denyRead?: string[] | undefined;
        allowRead?: string[] | undefined;
        allowWrite?: string[] | undefined;
        denyWrite?: string[] | undefined;
        allowGitConfig?: false | undefined;
    }, {
        disabled?: false | undefined;
        denyRead?: string[] | undefined;
        allowRead?: string[] | undefined;
        allowWrite?: string[] | undefined;
        denyWrite?: string[] | undefined;
        allowGitConfig?: false | undefined;
    }>>;
    trustedCustomTools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    enableWeakerNestedSandbox: z.ZodOptional<z.ZodLiteral<false>>;
    enableWeakerNetworkIsolation: z.ZodOptional<z.ZodLiteral<false>>;
    allowAppleEvents: z.ZodOptional<z.ZodLiteral<false>>;
}, "strict", z.ZodTypeAny, {
    network?: {
        allowedDomains?: string[] | undefined;
        deniedDomains?: string[] | undefined;
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: false | undefined;
        allowLocalBinding?: false | undefined;
        allowMachLookup?: string[] | undefined;
    } | undefined;
    filesystem?: {
        disabled?: false | undefined;
        denyRead?: string[] | undefined;
        allowRead?: string[] | undefined;
        allowWrite?: string[] | undefined;
        denyWrite?: string[] | undefined;
        allowGitConfig?: false | undefined;
    } | undefined;
    trustedCustomTools?: string[] | undefined;
    enableWeakerNestedSandbox?: false | undefined;
    enableWeakerNetworkIsolation?: false | undefined;
    allowAppleEvents?: false | undefined;
}, {
    network?: {
        allowedDomains?: string[] | undefined;
        deniedDomains?: string[] | undefined;
        allowUnixSockets?: string[] | undefined;
        allowAllUnixSockets?: false | undefined;
        allowLocalBinding?: false | undefined;
        allowMachLookup?: string[] | undefined;
    } | undefined;
    filesystem?: {
        disabled?: false | undefined;
        denyRead?: string[] | undefined;
        allowRead?: string[] | undefined;
        allowWrite?: string[] | undefined;
        denyWrite?: string[] | undefined;
        allowGitConfig?: false | undefined;
    } | undefined;
    trustedCustomTools?: string[] | undefined;
    enableWeakerNestedSandbox?: false | undefined;
    enableWeakerNetworkIsolation?: false | undefined;
    allowAppleEvents?: false | undefined;
}>;
export type EnvironmentPolicy = z.infer<typeof EnvironmentPolicySchema>;
type ParsedUserPolicy = z.infer<typeof UserPolicySchema>;
type FilteredUserNetwork = z.infer<typeof FilteredUserNetworkSchema> & {
    strictAllowlist?: true;
};
type UnrestrictedUserNetwork = z.infer<typeof UnrestrictedUserNetworkSchema>;
export type UserPolicy = Omit<ParsedUserPolicy, "network"> & {
    network?: FilteredUserNetwork | UnrestrictedUserNetwork;
};
type SecureNetworkDefaults = {
    mode: "filtered";
    allowedDomains: string[];
    deniedDomains: string[];
    strictAllowlist: true;
    allowUnixSockets: string[];
    allowAllUnixSockets: false;
    allowLocalBinding: false;
    allowMachLookup: string[];
};
type SecureUserDefaults = Omit<UserPolicy, "network"> & {
    network: SecureNetworkDefaults;
};
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;
export declare class SandlotConfigError extends Error {
    readonly source: string;
    constructor(source: string, message: string, options?: {
        cause?: unknown;
    });
}
export declare function parseUserPolicy(value: unknown, source?: string): UserPolicy;
export declare function parseProjectPolicy(value: unknown, source?: string): ProjectPolicy;
export declare function secureUserDefaults(cwd: string, agentDir: string): SecureUserDefaults;
export interface LoadPolicyFilesOptions {
    cwd: string;
    agentDir?: string;
    projectTrusted: boolean;
}
export interface LoadedPolicyFiles {
    user: UserPolicy | undefined;
    project: ProjectPolicy | undefined;
}
export declare function loadPolicyFiles(options: LoadPolicyFilesOptions): Promise<LoadedPolicyFiles>;
export {};
