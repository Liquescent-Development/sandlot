import type { EnvironmentPolicy } from "./config.js";
import { fileURLToPath } from "node:url";

const DEFAULT_ENV_NAMES = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP"] as const;

/** Directory containing the immutable package-owned macOS compatibility shims. */
export function sandlotMktempShimDirectory(): string {
  return fileURLToPath(new URL("../bin/", import.meta.url));
}

export interface PiSessionEnvironment {
  PI_SESSION_ID?: string;
  PI_PROVIDER?: string;
  PI_MODEL?: string;
}

export function buildOuterEnvironment(
  platform: NodeJS.Platform,
  _host: NodeJS.ProcessEnv,
  temporaryDirectory?: string,
): NodeJS.ProcessEnv {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cannot construct Sandlot outer environment for unsupported platform ${platform}`);
  }
  const environment: NodeJS.ProcessEnv = {
    PATH: platform === "darwin"
      ? `${sandlotMktempShimDirectory()}:/usr/bin:/bin:/usr/sbin:/sbin`
      : "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
  };
  if (temporaryDirectory === undefined) {
    environment.TMPDIR = platform === "darwin" ? "/private/tmp" : "/tmp";
  } else {
    environment.TMPDIR = temporaryDirectory;
    environment.TMP = temporaryDirectory;
    environment.TEMP = temporaryDirectory;
  }
  return environment;
}

/** Build a command whose environment overlay is evaluated by the already-confined shell. */
export function buildSandboxedChildCommand(
  command: string,
  childEnvironment: NodeJS.ProcessEnv,
  shellPath = "/bin/bash",
): string {
  if (!shellPath.startsWith("/")) throw new Error("Sandboxed child shell path must be absolute");
  const assignments = Object.entries(childEnvironment).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid sandbox child environment name: ${name}`);
    if (value === undefined) return undefined;
    if (value.includes("\0")) throw new Error(`Sandbox child environment value for ${name} contains NUL`);
    return quoteForPosixShell(`${name}=${value}`);
  }).filter((value): value is string => value !== undefined);
  return [
    "exec /usr/bin/env",
    ...assignments,
    quoteForPosixShell(shellPath),
    "-c",
    quoteForPosixShell(command),
  ].join(" ");
}

export function buildChildEnvironment(
  host: NodeJS.ProcessEnv,
  policy: EnvironmentPolicy,
  session?: PiSessionEnvironment,
): NodeJS.ProcessEnv {
  const child = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of new Set([...DEFAULT_ENV_NAMES, ...(policy.passThrough ?? [])])) {
    if (Object.hasOwn(host, name) && host[name] !== undefined) child[name] = host[name];
  }
  if (policy.exposePiSessionMetadata && session) {
    for (const name of ["PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL"] as const) {
      if (Object.hasOwn(session, name) && session[name] !== undefined) child[name] = session[name];
    }
  }
  for (const name of policy.deny ?? []) delete child[name];
  return child;
}

function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
