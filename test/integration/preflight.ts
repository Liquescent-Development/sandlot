import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe } from "vitest";
import { runProbe } from "./probe.js";

const REQUIRED_SRT_VERSION = "0.0.73";

export interface IntegrationPreflight {
  readonly available: boolean;
  readonly reason: string | undefined;
  readonly executables: Readonly<Record<string, string>>;
}

export async function checkIntegrationPrerequisites(): Promise<IntegrationPreflight> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return unavailable(`unsupported platform ${process.platform}; Sandlot integration supports macOS and Linux only`);
  }
  if (!nodeAtLeast(22, 19)) return unavailable(`Node 22.19 or newer is required (found ${process.version})`);

  const required = process.platform === "linux"
    ? ["rg", "bwrap", "socat", "curl", "bash"]
    : ["rg", "sandbox-exec", "curl", "bash"];
  const entries = await Promise.all(required.map(async (name) => [name, await findExecutable(name)] as const));
  const missing = entries.filter((entry): entry is readonly [string, undefined] => entry[1] === undefined).map(([name]) => name);
  if (missing.length > 0) return unavailable(`missing prerequisite${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);

  const executables = Object.fromEntries(entries) as Record<string, string>;
  const installedVersion = await sandboxRuntimeVersion();
  if (installedVersion !== REQUIRED_SRT_VERSION) {
    return unavailable(`@anthropic-ai/sandbox-runtime ${REQUIRED_SRT_VERSION} is required (found ${installedVersion ?? "unreadable"})`);
  }

  const platformProbe = process.platform === "linux"
    ? await runProbe(executables.bwrap!, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user", "--unshare-pid", "/bin/true"])
    : await runProbe(executables["sandbox-exec"]!, ["-p", "(version 1) (allow default)", "/usr/bin/true"]);
  if (platformProbe !== undefined) return unavailable(`sandbox platform probe failed: ${platformProbe}`);

  return { available: true, reason: undefined, executables: Object.freeze(executables) };
}

function unavailable(reason: string): IntegrationPreflight {
  return { available: false, reason, executables: Object.freeze({}) };
}

function nodeAtLeast(major: number, minor: number): boolean {
  const [actualMajor = 0, actualMinor = 0] = process.versions.node.split(".").map(Number);
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

async function findExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

async function sandboxRuntimeVersion(): Promise<string | undefined> {
  const path = new URL("../../node_modules/@anthropic-ai/sandbox-runtime/package.json", import.meta.url);
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
  }
}

export const integrationPreflight = await checkIntegrationPrerequisites();
if (!integrationPreflight.available) {
  const message = `[sandlot integration] ${integrationPreflight.reason}`;
  if (process.env.SANDLOT_REQUIRE_INTEGRATION === "1") throw new Error(message);
  console.warn(`${message}; skipping (set SANDLOT_REQUIRE_INTEGRATION=1 to require execution)`);
}

export const describeIntegration = integrationPreflight.available ? describe : describe.skip;
