import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SandboxRuntimeConfigSchema, type FilesystemConfig, type NetworkConfig, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { URL } from "node:url";
import { SandlotConfigError, secureUserDefaults, type EnvironmentPolicy, type NetworkMode, type ProjectPolicy, type UserPolicy } from "./config.js";
import { canonicalizePolicyPath, isPathContained } from "./paths.js";

type EffectiveNetworkConfig = Omit<NetworkConfig, "strictAllowlist"> & { strictAllowlist: boolean };
type MergedNetworkConfig = {
  mode: NetworkMode;
  allowedDomains: string[];
  deniedDomains: string[];
  deniedDomainReasons?: Record<string, string>;
  strictAllowlist: boolean;
  allowUnixSockets: string[];
  allowAllUnixSockets: boolean;
  allowLocalBinding: boolean;
  allowMachLookup: string[];
  tlsTerminate?: NetworkConfig["tlsTerminate"];
};
type MergedUserPolicy = Omit<UserPolicy, "enabled" | "network" | "filesystem" | "credentials" | "environment"> & {
  enabled: boolean;
  network: MergedNetworkConfig;
  filesystem: NonNullable<UserPolicy["filesystem"]>;
  credentials: NonNullable<UserPolicy["credentials"]> | undefined;
  environment: EnvironmentPolicy;
};

export interface EffectivePolicy {
  enabled: boolean;
  networkMode: NetworkMode;
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

interface ParsedDomainPattern {
  host: string;
  port: number | undefined;
  wildcard: boolean;
}

export function domainPatternCovers(ceiling: string, requested: string): boolean {
  const parent = parseDomainPattern(ceiling);
  const child = parseDomainPattern(requested);
  if (parent.port !== undefined && parent.port !== child.port) return false;

  if (!parent.wildcard) return !child.wildcard && parent.host === child.host;
  const parentBase = parent.host.slice(2);
  if (child.wildcard) {
    const childBase = child.host.slice(2);
    return childBase === parentBase || childBase.endsWith(`.${parentBase}`);
  }
  return child.host.endsWith(`.${parentBase}`);
}

export async function composePolicy(
  user: UserPolicy,
  project: ProjectPolicy | undefined,
  context: PolicyCompositionContext,
): Promise<EffectivePolicy> {
  const canonicalCustomCredentialFiles = await canonicalizeCustomCredentialFiles(
    user.credentials,
    context.cwd,
  );
  const merged = await protectGitWorktreeMetadata(mergeUserPolicy(user, context), context.cwd);
  const trusted = await canonicalizeTrustedSecurityPaths(merged, context.cwd);
  if (trusted.network.mode === "unrestricted" && project?.network !== undefined) {
    throw new SandlotConfigError(
      "project policy",
      "network cannot be configured when the trusted user selects network.mode: unrestricted",
    );
  }
  const userFilesystem = await canonicalizeFilesystem(trusted.filesystem, context.cwd, "user filesystem");
  const projectFilesystem = project?.filesystem === undefined
    ? undefined
    : await canonicalizeFilesystem(project.filesystem, context.cwd, "project filesystem");
  const userSockets = await canonicalizePaths(trusted.network.allowUnixSockets, context.cwd, "network.allowUnixSockets");
  const projectSockets = await canonicalizePaths(project?.network?.allowUnixSockets, context.cwd, "network.allowUnixSockets");

  const projectNetwork = project?.network;
  const allowedDomains = chooseCoveredAllowlist(
    trusted.network.allowedDomains,
    projectNetwork?.allowedDomains,
    "network.allowedDomains",
    domainPatternCovers,
  );
  const allowRead = chooseContainedPaths(userFilesystem.allowRead, projectFilesystem?.allowRead, "filesystem.allowRead");
  const allowWrite = chooseContainedPaths(userFilesystem.allowWrite, projectFilesystem?.allowWrite, "filesystem.allowWrite");
  const allowUnixSockets = chooseCoveredAllowlist(userSockets, projectSockets, "network.allowUnixSockets", (parent, child) => parent === child);
  const allowMachLookup = chooseCoveredAllowlist(
    trusted.network.allowMachLookup,
    projectNetwork?.allowMachLookup,
    "network.allowMachLookup",
    (parent, child) => parent === child,
  );
  const trustedCustomTools = chooseCoveredAllowlist(
    trusted.trustedCustomTools,
    project?.trustedCustomTools,
    "trustedCustomTools",
    (parent, child) => parent === child,
  );

  const effective: EffectivePolicy = {
    enabled: trusted.enabled,
    networkMode: trusted.network.mode,
    network: {
      allowedDomains,
      deniedDomains: stableUnion(trusted.network.deniedDomains, projectNetwork?.deniedDomains),
      deniedDomainReasons: trusted.network.deniedDomainReasons,
      strictAllowlist: trusted.network.mode !== "unrestricted",
      allowUnixSockets,
      allowAllUnixSockets: disableOnly(trusted.network.allowAllUnixSockets, projectNetwork?.allowAllUnixSockets, "network.allowAllUnixSockets"),
      allowLocalBinding: disableOnly(trusted.network.allowLocalBinding, projectNetwork?.allowLocalBinding, "network.allowLocalBinding"),
      allowMachLookup,
      tlsTerminate: trusted.network.tlsTerminate,
    },
    filesystem: {
      disabled: disableOnly(userFilesystem.disabled, projectFilesystem?.disabled, "filesystem.disabled"),
      denyRead: stableUnion(userFilesystem.denyRead, projectFilesystem?.denyRead),
      allowRead,
      allowWrite: allowWrite ?? [],
      denyWrite: stableUnion(userFilesystem.denyWrite, projectFilesystem?.denyWrite),
      allowGitConfig: disableOnly(userFilesystem.allowGitConfig, projectFilesystem?.allowGitConfig, "filesystem.allowGitConfig"),
    },
    credentials: await canonicalizeCredentialFiles(
      trusted.credentials,
      context.cwd,
      canonicalCustomCredentialFiles,
    ),
    environment: trusted.environment,
    trustedCustomTools,
    enableWeakerNestedSandbox: disableOnly(trusted.enableWeakerNestedSandbox, project?.enableWeakerNestedSandbox, "enableWeakerNestedSandbox"),
    enableWeakerNetworkIsolation: disableOnly(trusted.enableWeakerNetworkIsolation, project?.enableWeakerNetworkIsolation, "enableWeakerNetworkIsolation"),
    allowAppleEvents: disableOnly(trusted.allowAppleEvents, project?.allowAppleEvents, "allowAppleEvents"),
    ripgrep: trusted.ripgrep,
    seccomp: trusted.seccomp,
    bwrapPath: trusted.bwrapPath,
    socatPath: trusted.socatPath,
  };

  validateCredentialInjectionCoverage(effective);
  return effective;
}

type CredentialFileEntry = NonNullable<NonNullable<UserPolicy["credentials"]>["files"]>[number];

async function canonicalizeCustomCredentialFiles(
  credentials: UserPolicy["credentials"],
  cwd: string,
): Promise<CredentialFileEntry[] | undefined> {
  if (credentials?.files === undefined) return undefined;
  const canonicalFiles: CredentialFileEntry[] = [];
  for (const [index, file] of credentials.files.entries()) {
    const field = `credentials.files[${index}].path`;
    const lexical = normalize(isAbsolute(file.path) ? file.path : resolve(cwd, file.path));
    let canonical: string;
    try {
      canonical = await canonicalizePolicyPath(file.path, cwd);
    } catch (error: unknown) {
      throw new SandlotConfigError(
        "policy",
        `${field}: ${error instanceof Error ? error.message : "could not canonicalize path"}`,
        { cause: error },
      );
    }
    if (lexical !== canonical) {
      throw new SandlotConfigError(
        "policy",
        `${field}: custom credential paths must use their canonical spelling; symlinks in any component are not allowed: ${lexical}`,
      );
    }
    canonicalFiles.push({ ...file, path: canonical });
  }
  return canonicalFiles;
}

async function protectGitWorktreeMetadata(
  trusted: ReturnType<typeof mergeUserPolicy>,
  cwd: string,
): Promise<ReturnType<typeof mergeUserPolicy>> {
  const dotGit = resolve(cwd, ".git");
  let metadata;
  try {
    metadata = await lstat(dotGit);
  } catch (error: unknown) {
    if (isMissing(error)) return trusted;
    throw new SandlotConfigError("Git worktree", `could not inspect ${dotGit}`, { cause: error });
  }
  if (!metadata.isFile()) return trusted;

  const pointer = (await readFile(dotGit, "utf8")).trim();
  const match = /^gitdir:\s*(.+)$/i.exec(pointer);
  if (match?.[1] === undefined || match[1].trim() === "") {
    throw new SandlotConfigError("Git worktree", `${dotGit} does not contain a valid gitdir pointer`);
  }
  const gitDir = await requiredGitRealpath(resolve(dirname(dotGit), match[1].trim()), "worktree gitdir");
  let commonDir = gitDir;
  try {
    const commonPointer = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
    if (commonPointer === "") throw new SandlotConfigError("Git worktree", "commondir pointer is empty");
    commonDir = await requiredGitRealpath(resolve(gitDir, commonPointer), "worktree commondir");
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }

  const impossible = new Set([normalize(join(dotGit, "config")), normalize(join(dotGit, "hooks"))]);
  const denyWrite = (trusted.filesystem.denyWrite ?? []).filter((path) => !impossible.has(normalize(resolve(cwd, path))));
  denyWrite.push(dotGit, join(commonDir, "config"), join(commonDir, "hooks"), join(gitDir, "config.worktree"));
  return {
    ...trusted,
    filesystem: { ...trusted.filesystem, denyWrite: stableUnion(denyWrite) },
  };
}

async function requiredGitRealpath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    throw new SandlotConfigError("Git worktree", `${label} is unavailable: ${path}`, { cause: error });
  }
}

export function toSandboxRuntimeConfig(effective: EffectivePolicy): SandboxRuntimeConfig {
  return SandboxRuntimeConfigSchema.parse({
    network: {
      allowedDomains: effective.network.allowedDomains,
      deniedDomains: effective.network.deniedDomains,
      deniedDomainReasons: effective.network.deniedDomainReasons,
      strictAllowlist: effective.networkMode !== "unrestricted",
      allowUnixSockets: effective.network.allowUnixSockets,
      allowAllUnixSockets: effective.network.allowAllUnixSockets,
      allowLocalBinding: effective.network.allowLocalBinding,
      allowMachLookup: effective.network.allowMachLookup,
      tlsTerminate: effective.network.tlsTerminate,
    },
    filesystem: effective.filesystem,
    credentials: effective.credentials,
    enableWeakerNestedSandbox: effective.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation: effective.enableWeakerNetworkIsolation,
    allowAppleEvents: effective.allowAppleEvents,
    ripgrep: effective.ripgrep,
    seccomp: effective.seccomp,
    bwrapPath: effective.bwrapPath,
    socatPath: effective.socatPath,
  });
}

export async function validatePolicyForPlatform(
  effective: EffectivePolicy,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): Promise<void> {
  if (platform === "linux") {
    if (arch !== "x64" && arch !== "arm64") {
      throw new SandlotConfigError(
        "platform",
        `Linux is supported only on x64 and arm64 because those are the pinned seccomp-filter architectures (detected ${arch})`,
      );
    }
    for (const [field, paths] of [
      ["filesystem.allowWrite", effective.filesystem.allowWrite],
      ["filesystem.denyWrite", effective.filesystem.denyWrite],
    ] as const) {
      const glob = paths.find(containsGlobCharacters);
      if (glob !== undefined) {
        throw new SandlotConfigError("policy", `Linux does not support glob ${field} entries: ${glob}`);
      }
    }
  }

  for (const path of effective.filesystem.allowWrite) {
    try {
      if (!(await lstat(path)).isDirectory()) {
        throw new SandlotConfigError("policy", `filesystem.allowWrite must name an existing directory: ${path}`);
      }
    } catch (error: unknown) {
      if (error instanceof SandlotConfigError) throw error;
      throw new SandlotConfigError("policy", `filesystem.allowWrite must name an existing directory: ${path}`, { cause: error });
    }
  }
}

function containsGlobCharacters(path: string): boolean {
  return /[*?\[]/.test(path);
}

function mergeUserPolicy(user: UserPolicy, context: PolicyCompositionContext): MergedUserPolicy {
  const defaults = secureUserDefaults(context.cwd, context.agentDir ?? getAgentDir());
  const network: MergedNetworkConfig = user.network?.mode === "unrestricted"
    ? {
      ...defaults.network,
      mode: "unrestricted",
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: false,
    }
    : { ...defaults.network, ...user.network, mode: "filtered", strictAllowlist: true };
  const filesystem = { ...defaults.filesystem, ...user.filesystem };
  const credentials = user.credentials === undefined
    ? defaults.credentials
    : { ...defaults.credentials, ...user.credentials };
  return {
    ...defaults,
    ...user,
    enabled: user.enabled ?? defaults.enabled ?? true,
    network,
    filesystem,
    credentials,
    environment: { ...defaults.environment, ...user.environment },
    trustedCustomTools: user.trustedCustomTools ?? defaults.trustedCustomTools ?? [],
    enableWeakerNestedSandbox: user.enableWeakerNestedSandbox ?? defaults.enableWeakerNestedSandbox ?? false,
    enableWeakerNetworkIsolation: user.enableWeakerNetworkIsolation ?? defaults.enableWeakerNetworkIsolation ?? false,
    allowAppleEvents: user.allowAppleEvents ?? defaults.allowAppleEvents ?? false,
  };
}

async function canonicalizeTrustedSecurityPaths(
  trusted: ReturnType<typeof mergeUserPolicy>,
  cwd: string,
) {
  return {
    ...trusted,
    network: {
      ...trusted.network,
      tlsTerminate: await canonicalizeTlsTerminate(trusted.network.tlsTerminate, cwd),
    },
    ripgrep: trusted.ripgrep === undefined ? undefined : {
      ...trusted.ripgrep,
      command: await canonicalizeRequiredPath(trusted.ripgrep.command, cwd, "ripgrep.command"),
    },
    bwrapPath: await canonicalizeOptionalPath(trusted.bwrapPath, cwd, "bwrapPath"),
    socatPath: await canonicalizeOptionalPath(trusted.socatPath, cwd, "socatPath"),
    seccomp: trusted.seccomp === undefined ? undefined : {
      ...trusted.seccomp,
      applyPath: await canonicalizeOptionalPath(trusted.seccomp.applyPath, cwd, "seccomp.applyPath"),
      argv0: await canonicalizeOptionalPath(trusted.seccomp.argv0, cwd, "seccomp.argv0"),
    },
  };
}

async function canonicalizeTlsTerminate(
  tlsTerminate: NetworkConfig["tlsTerminate"] | undefined,
  cwd: string,
) {
  if (tlsTerminate === undefined) return undefined;
  return {
    ...tlsTerminate,
    caCertPath: await canonicalizeOptionalPath(tlsTerminate.caCertPath, cwd, "network.tlsTerminate.caCertPath"),
    caKeyPath: await canonicalizeOptionalPath(tlsTerminate.caKeyPath, cwd, "network.tlsTerminate.caKeyPath"),
    extraCaCertPaths: tlsTerminate.extraCaCertPaths === undefined
      ? undefined
      : await canonicalizePaths(tlsTerminate.extraCaCertPaths, cwd, "network.tlsTerminate.extraCaCertPaths"),
  };
}

async function canonicalizeOptionalPath(path: string | undefined, cwd: string, field: string): Promise<string | undefined> {
  if (path === undefined) return undefined;
  return (await canonicalizePaths([path], cwd, field))[0];
}

async function canonicalizeRequiredPath(path: string, cwd: string, field: string): Promise<string> {
  return (await canonicalizePaths([path], cwd, field))[0]!;
}

async function canonicalizeFilesystem(
  filesystem: NonNullable<UserPolicy["filesystem"]>,
  cwd: string,
  source: string,
): Promise<FilesystemConfig> {
  return {
    disabled: filesystem.disabled,
    denyRead: await canonicalizeDenyPaths(filesystem.denyRead, cwd, `${source}.denyRead`),
    allowRead: filesystem.allowRead === undefined ? undefined : await canonicalizePaths(filesystem.allowRead, cwd, `${source}.allowRead`),
    allowWrite: await canonicalizePaths(filesystem.allowWrite, cwd, `${source}.allowWrite`),
    denyWrite: await canonicalizeDenyPaths(filesystem.denyWrite, cwd, `${source}.denyWrite`),
    allowGitConfig: filesystem.allowGitConfig,
  };
}

async function canonicalizeDenyPaths(paths: readonly string[] | undefined, cwd: string, field: string): Promise<string[]> {
  if (paths === undefined) return [];
  return stableUnion(...await Promise.all(paths.map(async (path) => {
    const lexical = normalize(isAbsolute(path) ? path : resolve(cwd, path));
    try {
      return [lexical, await canonicalizePolicyPath(path, cwd)];
    } catch (error: unknown) {
      throw new SandlotConfigError("policy", `${field}: ${error instanceof Error ? error.message : "could not canonicalize path"}`, { cause: error });
    }
  })));
}

async function canonicalizePaths(paths: readonly string[] | undefined, cwd: string, field: string): Promise<string[]> {
  if (paths === undefined) return [];
  return stableUnion(await Promise.all(paths.map(async (path) => {
    try {
      return await canonicalizePolicyPath(path, cwd);
    } catch (error: unknown) {
      throw new SandlotConfigError("policy", `${field}: ${error instanceof Error ? error.message : "could not canonicalize path"}`, { cause: error });
    }
  })));
}

async function canonicalizeCredentialFiles(
  credentials: NonNullable<UserPolicy["credentials"]> | undefined,
  cwd: string,
  canonicalCustomFiles?: readonly CredentialFileEntry[],
): Promise<NonNullable<UserPolicy["credentials"]> | undefined> {
  if (credentials === undefined) return undefined;
  return {
    ...credentials,
    files: canonicalCustomFiles === undefined
      ? credentials.files === undefined ? undefined : await Promise.all(credentials.files.map(async (file, index) => ({
      ...file,
      path: (await canonicalizePaths([file.path], cwd, `credentials.files[${index}].path`))[0],
      })))
      : canonicalCustomFiles.map((file) => ({ ...file })),
  };
}

function chooseCoveredAllowlist(
  ceiling: readonly string[] | undefined,
  requested: readonly string[] | undefined,
  field: string,
  covers: (parent: string, child: string) => boolean,
): string[] {
  const normalizedCeiling = ceiling ?? [];
  if (requested === undefined) return [...normalizedCeiling];
  for (const entry of requested) {
    if (!normalizedCeiling.some((candidate) => covers(candidate, entry))) {
      throw new SandlotConfigError("project policy", `${field} entry ${entry} is not covered by the user policy`);
    }
  }
  return stableUnion(requested);
}

function chooseContainedPaths(
  ceiling: readonly string[] | undefined,
  requested: readonly string[] | undefined,
  field: string,
): string[] | undefined {
  if (requested === undefined) return ceiling === undefined ? undefined : [...ceiling];
  const roots = ceiling ?? [];
  for (const path of requested) {
    if (!roots.some((root) => isPathContained(root, path))) {
      throw new SandlotConfigError("project policy", `${field} entry ${path} is not covered by the user policy`);
    }
  }
  return stableUnion(requested);
}

function disableOnly(userValue: boolean | undefined, projectValue: boolean | undefined, field: string): boolean {
  if (projectValue === true) {
    throw new SandlotConfigError("project policy", `${field} may only be disabled by a project policy`);
  }
  return projectValue === false ? false : userValue ?? false;
}

function stableUnion(...lists: Array<readonly string[] | undefined>): string[] {
  const values = new Set<string>();
  for (const list of lists) for (const value of list ?? []) values.add(value);
  return [...values];
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function validateCredentialInjectionCoverage(effective: EffectivePolicy): void {
  const sources = [
    ...(effective.credentials?.files ?? []).map((entry, index) => ({ injectHosts: entry.injectHosts, field: `credentials.files[${index}].injectHosts` })),
    ...(effective.credentials?.envVars ?? []).map((entry, index) => ({ injectHosts: entry.injectHosts, field: `credentials.envVars[${index}].injectHosts` })),
  ];
  for (const source of sources) {
    if (effective.networkMode === "unrestricted" && (source.injectHosts?.length ?? 0) > 0) {
      throw new SandlotConfigError(
        "user policy",
        `${source.field} cannot be used when network.mode is unrestricted; injected credentials require a filtered network allowlist`,
      );
    }
    for (const host of source.injectHosts ?? []) {
      const hostPattern = parseDomainPattern(host).host;
      if (!effective.network.allowedDomains.some((allowed) => domainPatternCovers(parseDomainPattern(allowed).host, hostPattern))) {
        throw new SandlotConfigError("user policy", `${source.field} entry ${host} is not covered by network.allowedDomains`);
      }
    }
  }
}

function parseDomainPattern(pattern: string): ParsedDomainPattern {
  let host = pattern;
  let port: number | undefined;
  if (pattern.startsWith("[")) {
    const close = pattern.indexOf("]");
    if (close !== -1) {
      host = pattern.slice(1, close);
      const suffix = pattern.slice(close + 1);
      if (/^:[1-9][0-9]*$/.test(suffix)) port = Number(suffix.slice(1));
    }
  } else {
    const colon = pattern.lastIndexOf(":");
    if (colon !== -1 && pattern.indexOf(":") === colon && /^[1-9][0-9]*$/.test(pattern.slice(colon + 1))) {
      host = pattern.slice(0, colon);
      port = Number(pattern.slice(colon + 1));
    }
  }
  host = canonicalizeDomainHost(host);
  return { host, port, wildcard: host.startsWith("*.") };
}

function canonicalizeDomainHost(host: string): string {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("*.")) return `*.${canonicalizeDomainHost(normalized.slice(2))}`;
  try {
    const value = isIP(normalized) === 6 ? `[${normalized}]` : normalized;
    return new URL(`http://${value}/`).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return normalized;
  }
}
