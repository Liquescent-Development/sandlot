import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { FilesystemConfigSchema, NetworkConfigSchema, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const stringList = z.array(z.string());
const domainList = z.array(z.string().min(1));
const environmentVariableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name");
const environmentVariableList = z.array(environmentVariableName);
const disableOnly = z.literal(false);

const TlsTerminateSchema = z.object({
  caCertPath: z.string().optional(),
  caKeyPath: z.string().optional(),
  excludeDomains: domainList.optional(),
  extraCaCertPaths: stringList.optional(),
}).strict();

export type NetworkMode = "filtered" | "unrestricted";

const FilteredUserNetworkSchema = z.object({
  mode: z.literal("filtered").optional(),
  allowedDomains: domainList.optional(),
  deniedDomains: domainList.optional(),
  deniedDomainReasons: z.record(z.string()).optional(),
  allowUnixSockets: stringList.optional(),
  allowAllUnixSockets: z.boolean().optional(),
  allowLocalBinding: z.boolean().optional(),
  allowMachLookup: stringList.optional(),
  tlsTerminate: TlsTerminateSchema.optional(),
}).strict();

const UnrestrictedUserNetworkSchema = z.object({
  mode: z.literal("unrestricted"),
}).strict();

const UserNetworkSchema = z.union([FilteredUserNetworkSchema, UnrestrictedUserNetworkSchema]);

const UserFilesystemSchema = z.object({
  disabled: z.boolean().optional(),
  denyRead: stringList.optional(),
  allowRead: stringList.optional(),
  allowWrite: stringList.optional(),
  denyWrite: stringList.optional(),
  allowGitConfig: z.boolean().optional(),
}).strict();

const CredentialFileSchema = z.object({
  path: z.string(),
  mode: z.enum(["deny", "mask"]),
  extract: z.string().optional(),
  onExtractNoMatch: z.enum(["warn", "deny", "error"]).optional(),
  decode: z.enum(["jwt"]).optional(),
  maskClaims: stringList.optional(),
  maskDuplicates: z.boolean().optional(),
  injectHosts: domainList.optional(),
}).strict();

const CredentialEnvironmentSchema = z.object({
  name: environmentVariableName,
  mode: z.enum(["deny", "mask"]),
  extract: z.string().optional(),
  onExtractNoMatch: z.enum(["warn", "deny", "error"]).optional(),
  decode: z.enum(["jwt"]).optional(),
  maskClaims: stringList.optional(),
  injectHosts: domainList.optional(),
}).strict();

const CredentialsSchema = z.object({
  files: z.array(CredentialFileSchema).optional(),
  envVars: z.array(CredentialEnvironmentSchema).optional(),
  allowPlaintextInject: z.boolean().optional(),
  awsPairs: z.array(z.object({
    accessKeyIdVar: environmentVariableName,
    secretAccessKeyVar: environmentVariableName,
    sessionTokenVar: environmentVariableName.optional(),
  }).strict()).optional(),
  sigv4: z.object({
    streaming: z.enum(["deny", "passthrough"]).optional(),
    presigned: z.enum(["deny", "passthrough"]).optional(),
    sigv4a: z.enum(["deny", "passthrough"]).optional(),
  }).strict().optional(),
}).strict();

const EnvironmentPolicySchema = z.object({
  passThrough: environmentVariableList.optional(),
  deny: environmentVariableList.optional(),
  exposePiSessionMetadata: z.boolean().optional(),
}).strict();

const RipgrepSchema = z.object({
  command: z.string(),
}).strict();

const SeccompSchema = z.object({
  applyPath: z.string().optional(),
  argv0: z.string().optional(),
}).strict();

const UserPolicySchema = z.object({
  enabled: z.boolean().optional(),
  network: UserNetworkSchema.optional(),
  filesystem: UserFilesystemSchema.optional(),
  credentials: CredentialsSchema.optional(),
  environment: EnvironmentPolicySchema.optional(),
  trustedCustomTools: stringList.optional(),
  enableWeakerNestedSandbox: z.boolean().optional(),
  enableWeakerNetworkIsolation: z.boolean().optional(),
  allowAppleEvents: z.boolean().optional(),
  ripgrep: RipgrepSchema.optional(),
  seccomp: SeccompSchema.optional(),
  bwrapPath: z.string().optional(),
  socatPath: z.string().optional(),
}).strict();

const ProjectNetworkSchema = z.object({
  allowedDomains: domainList.optional(),
  deniedDomains: domainList.optional(),
  allowUnixSockets: stringList.optional(),
  allowMachLookup: stringList.optional(),
  allowAllUnixSockets: disableOnly.optional(),
  allowLocalBinding: disableOnly.optional(),
}).strict();

const ProjectFilesystemSchema = z.object({
  disabled: disableOnly.optional(),
  denyRead: stringList.optional(),
  allowRead: stringList.optional(),
  allowWrite: stringList.optional(),
  denyWrite: stringList.optional(),
  allowGitConfig: disableOnly.optional(),
}).strict();

const ProjectPolicySchema = z.object({
  network: ProjectNetworkSchema.optional(),
  filesystem: ProjectFilesystemSchema.optional(),
  trustedCustomTools: stringList.optional(),
  enableWeakerNestedSandbox: disableOnly.optional(),
  enableWeakerNetworkIsolation: disableOnly.optional(),
  allowAppleEvents: disableOnly.optional(),
}).strict();

export type EnvironmentPolicy = z.infer<typeof EnvironmentPolicySchema>;
type ParsedUserPolicy = z.infer<typeof UserPolicySchema>;
type FilteredUserNetwork = z.infer<typeof FilteredUserNetworkSchema> & { strictAllowlist?: true };
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
type SecureUserDefaults = Omit<UserPolicy, "network"> & { network: SecureNetworkDefaults };
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;

export class SandlotConfigError extends Error {
  constructor(readonly source: string, message: string, options?: { cause?: unknown }) {
    super(`Sandlot configuration error in ${source}: ${message}`, options);
    this.name = "SandlotConfigError";
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

export function parseUserPolicy(value: unknown, source = "user policy"): UserPolicy {
  const result = UserPolicySchema.safeParse(value);
  if (!result.success) throw new SandlotConfigError(source, formatIssues(result.error));
  validateSandboxRuntimePolicy(result.data, source);
  return result.data;
}

export function parseProjectPolicy(value: unknown, source = "project policy"): ProjectPolicy {
  const result = ProjectPolicySchema.safeParse(value);
  if (!result.success) throw new SandlotConfigError(source, formatIssues(result.error));
  validateProjectRuntimePolicy(result.data, source);
  return result.data;
}

export function secureUserDefaults(cwd: string, agentDir: string): SecureUserDefaults {
  const piDir = dirname(agentDir);
  const conventionalPiDir = basename(agentDir) === "agent" && basename(piDir) === CONFIG_DIR_NAME
    ? piDir
    : undefined;
  const homeDir = homedir();
  const denyRead = [
    join(homeDir, ".ssh"),
    join(homeDir, ".aws"),
    join(homeDir, ".azure"),
    join(homeDir, ".config", "gcloud"),
    join(homeDir, ".kube"),
    join(homeDir, ".npmrc"),
    join(homeDir, ".pypirc"),
    join(homeDir, ".netrc"),
    join(homeDir, ".git-credentials"),
    join(homeDir, ".config", "gh"),
    join(homeDir, ".docker"),
    join(homeDir, ".config", "containers"),
    join(homeDir, ".cargo", "credentials"),
    join(homeDir, ".cargo", "credentials.toml"),
    join(homeDir, ".gnupg"),
    join(homeDir, ".m2", "settings.xml"),
    join(homeDir, ".gradle", "gradle.properties"),
    ...(conventionalPiDir === undefined ? [] : [conventionalPiDir]),
    agentDir,
    ...(conventionalPiDir === undefined ? [] : [
      join(conventionalPiDir, "auth.json"),
      join(conventionalPiDir, "sessions"),
    ]),
    join(agentDir, "auth.json"),
    join(agentDir, "sessions"),
    join(cwd, ".npmrc"),
    join(cwd, ".pypirc"),
    join(cwd, ".netrc"),
    join(cwd, ".git-credentials"),
  ];
  const environmentFiles = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.test",
    ".env.test.local",
    ".env.production",
    ".env.production.local",
    ...existingEnvironmentFiles(cwd),
  ];
  const denyWrite = [
    join(cwd, CONFIG_DIR_NAME),
    join(cwd, ".git", "config"),
    join(cwd, ".git", "hooks"),
    ...[
      ".gitconfig",
      ".gitmodules",
      ".bashrc",
      ".bash_profile",
      ".zshrc",
      ".zprofile",
      ".profile",
      ".ripgreprc",
      ".mcp.json",
      ".vscode",
      ".idea",
      ".claude/commands",
      ".claude/agents",
    ].map((path) => join(cwd, path)),
    ...new Set(environmentFiles.map((file) => join(cwd, file))),
    join(cwd, ".npmrc"),
    join(cwd, ".pypirc"),
    join(cwd, ".netrc"),
    join(cwd, ".git-credentials"),
  ];

  return {
    enabled: true,
    network: {
      mode: "filtered",
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    },
    filesystem: {
      denyRead,
      allowWrite: [cwd],
      denyWrite,
      disabled: false,
      allowGitConfig: false,
    },
    credentials: {
      files: denyRead.map((path) => ({ path, mode: "deny" as const })),
      envVars: [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "NPM_TOKEN",
        "CARGO_REGISTRY_TOKEN",
        "DOCKER_AUTH_CONFIG",
      ].map((name) => ({ name, mode: "deny" as const })),
    },
    environment: { passThrough: [], deny: [], exposePiSessionMetadata: false },
    trustedCustomTools: [],
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  };
}

function existingEnvironmentFiles(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => name === ".env" || name.startsWith(".env."));
  } catch (error: unknown) {
    if (isMissingFile(error)) return [];
    throw new SandlotConfigError(cwd, "could not inspect workspace environment files", { cause: error });
  }
}

function validateSandboxRuntimePolicy(policy: UserPolicy, source: string): void {
  const userNetwork = policy.network;
  let network: Record<string, unknown> = {};
  if (userNetwork !== undefined && userNetwork.mode !== "unrestricted") {
    const { mode: _mode, strictAllowlist: _strictAllowlist, ...filteredNetwork } = userNetwork;
    network = filteredNetwork;
  }
  const result = SandboxRuntimeConfigSchema.safeParse({
    network: {
      allowedDomains: [],
      deniedDomains: [],
      ...network,
      strictAllowlist: policy.network?.mode !== "unrestricted",
    },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [], ...policy.filesystem },
    credentials: credentialsForRuntime(policy.credentials, policy.network?.mode, source),
    enableWeakerNestedSandbox: policy.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation: policy.enableWeakerNetworkIsolation,
    allowAppleEvents: policy.allowAppleEvents,
    ripgrep: policy.ripgrep,
    seccomp: policy.seccomp,
    bwrapPath: policy.bwrapPath,
    socatPath: policy.socatPath,
  });
  if (!result.success) throw new SandlotConfigError(source, formatIssues(result.error));
}

function credentialsForRuntime(
  credentials: UserPolicy["credentials"],
  networkMode: NetworkMode | undefined,
  source: string,
): UserPolicy["credentials"] {
  if (networkMode !== "unrestricted" || credentials === undefined) return credentials;
  for (const [kind, entries] of [["files", credentials.files], ["envVars", credentials.envVars]] as const) {
    for (const [index, entry] of (entries ?? []).entries()) {
      if (entry.injectHosts !== undefined) {
        throw new SandlotConfigError(
          source,
          `credentials.${kind}[${index}].injectHosts cannot be used when network.mode is unrestricted; injected credentials require a filtered network allowlist`,
        );
      }
    }
  }
  return {
    ...credentials,
    files: credentials.files?.map((entry) => entry.mode === "mask" ? { ...entry, mode: "deny" as const } : entry),
    envVars: credentials.envVars?.map((entry) => entry.mode === "mask" ? { ...entry, mode: "deny" as const } : entry),
  };
}

function validateProjectRuntimePolicy(policy: ProjectPolicy, source: string): void {
  if (policy.network) {
    const result = NetworkConfigSchema.safeParse({ allowedDomains: [], deniedDomains: [], ...policy.network });
    if (!result.success) throw new SandlotConfigError(source, formatIssues(result.error));
  }
  if (policy.filesystem) {
    const result = FilesystemConfigSchema.safeParse({ denyRead: [], allowWrite: [], denyWrite: [], ...policy.filesystem });
    if (!result.success) throw new SandlotConfigError(source, formatIssues(result.error));
  }
}

async function readPolicyFile<T>(path: string, parse: (value: unknown, source: string) => T): Promise<T | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw new SandlotConfigError(path, "could not read policy file", { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error: unknown) {
    throw new SandlotConfigError(path, "invalid JSON", { cause: error });
  }
  return parse(value, path);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export interface LoadPolicyFilesOptions {
  cwd: string;
  agentDir?: string;
  projectTrusted: boolean;
}

export interface LoadedPolicyFiles {
  user: UserPolicy | undefined;
  project: ProjectPolicy | undefined;
}

export async function loadPolicyFiles(options: LoadPolicyFilesOptions): Promise<LoadedPolicyFiles> {
  const agentDir = options.agentDir ?? getAgentDir();
  const user = await readPolicyFile(join(agentDir, "sandlot.json"), parseUserPolicy);
  if (!options.projectTrusted) return { user, project: undefined };

  const project = await readPolicyFile(join(options.cwd, CONFIG_DIR_NAME, "sandlot.json"), parseProjectPolicy);
  return { user, project };
}
