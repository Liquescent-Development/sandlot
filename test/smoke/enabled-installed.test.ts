import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertCleanModeExit,
  installGitReleaseArtifact,
  installPackedArtifact,
  parseJsonLines,
  run,
  runRpcCommand,
  type GitSmokeInstallation,
  type SmokeInstallation,
} from "./harness.js";

const supported = process.platform === "darwin" || process.platform === "linux";

describe.skipIf(!supported)("enabled installed production defaults", () => {
  let npmInstallation: SmokeInstallation;
  let gitInstallation: GitSmokeInstallation;

  beforeAll(async () => {
    [npmInstallation, gitInstallation] = await Promise.all([
      installPackedArtifact(),
      installGitReleaseArtifact(),
    ]);
  }, 150_000);

  afterAll(async () => {
    await Promise.all([npmInstallation?.cleanup(), gitInstallation?.cleanup()]);
  });

  it.each([
    ["npm tarball", () => npmInstallation],
    ["pinned Git ref", () => gitInstallation],
  ] as const)("starts the %s install ready in a real Git worktree and denies host read/write fallback", async (_label, installed) => {
    const installation = installed();
    const cwd = await createGitWorktree(installation);
    const secret = join(installation.root, "home", ".ssh", "id_ed25519");
    const fallbackMarker = join(installation.root, "host-fallback-marker");
    const hostInjectionMarker = join(installation.root, "host-executable-injection-marker");
    const hostileBin = join(installation.root, "writable-host-bin");
    const bashEnv = join(installation.root, "host-bash-env");
    await mkdir(join(installation.root, "home", ".ssh"), { recursive: true });
    await writeFile(secret, "installed-smoke-secret");
    await mkdir(hostileBin);
    await writeFile(bashEnv, `printf bash-env-host-executed >> ${shellQuote(hostInjectionMarker)}\n`);
    for (const executable of ["rg", "bwrap", "socat", "which", "env", "log", "npm"]) {
      const path = join(hostileBin, executable);
      await writeFile(path, `#!/bin/sh\nprintf ${shellQuote(`${executable}-host-executed`)} >> ${shellQuote(hostInjectionMarker)}\nexit 97\n`);
      await chmod(path, 0o755);
    }
    const hostileEnvironment = {
      ...installation.env,
      PATH: `${hostileBin}:${installation.env.PATH ?? "/usr/bin:/bin"}`,
      BASH_ENV: bashEnv,
      ENV: bashEnv,
      LD_PRELOAD: process.platform === "linux" ? linuxInertLoaderLibrary() : undefined,
      DYLD_INSERT_LIBRARIES: process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : undefined,
    };

    const diagnostic = await runRpcCommand(installation, {
      id: "enabled-diagnostic",
      type: "prompt",
      message: "/sandlot",
    }, { cwd, env: hostileEnvironment });
    assertCleanModeExit(diagnostic, `${_label} enabled diagnostic`);
    expect(parseJsonLines(diagnostic.stdout, `${_label} diagnostic RPC`)).toContainEqual(expect.objectContaining({
      type: "extension_ui_request",
      method: "notify",
      notifyType: "info",
      message: expect.stringMatching(/Sandlot diagnostics[\s\S]*state: ready/),
    }));

    const scrubbedEnvironment = await runRpcCommand(installation, {
      id: "enabled-loader-environment",
      type: "bash",
      command: "/usr/bin/env",
    }, { cwd, env: hostileEnvironment });
    assertCleanModeExit(scrubbedEnvironment, `${_label} enabled loader environment`);
    const environmentOutput = rpcBashResult(scrubbedEnvironment, "enabled-loader-environment").output;
    expect(environmentOutput).not.toContain("DYLD_INSERT_LIBRARIES=");
    expect(environmentOutput).not.toContain("LD_PRELOAD=");

    const deniedWrite = await runRpcCommand(installation, {
      id: "enabled-write-denial",
      type: "bash",
      command: `printf host-fallback > ${shellQuote(fallbackMarker)}`,
    }, { cwd, env: hostileEnvironment });
    assertCleanModeExit(deniedWrite, `${_label} enabled write denial`);
    expect(rpcBashResult(deniedWrite, "enabled-write-denial").exitCode).not.toBe(0);
    await expect(access(fallbackMarker)).rejects.toMatchObject({ code: "ENOENT" });

    const deniedRead = await runRpcCommand(installation, {
      id: "enabled-read-denial",
      type: "bash",
      command: `/bin/cat ${shellQuote(secret)}`,
    }, { cwd, env: hostileEnvironment });
    assertCleanModeExit(deniedRead, `${_label} enabled read denial`);
    const readResult = rpcBashResult(deniedRead, "enabled-read-denial");
    expect(readResult.exitCode).not.toBe(0);
    expect(readResult.output).not.toContain("installed-smoke-secret");
    await expect(access(hostInjectionMarker)).rejects.toMatchObject({ code: "ENOENT" });

    if (process.platform === "darwin") {
      const mktemp = await runRpcCommand(installation, {
        id: "enabled-mktemp-shim",
        type: "bash",
        command: "command -v mktemp; mktemp; mktemp -d; mktemp -t sandlot-smoke; mktemp \"$TMPDIR/explicit.XXXXXXXX\"",
      }, { cwd, env: hostileEnvironment });
      assertCleanModeExit(mktemp, `${_label} mktemp shim`);
      const result = rpcBashResult(mktemp, "enabled-mktemp-shim");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(join(installation.installedPackage, "bin", "mktemp"));
      expect(result.output).not.toContain("<sandbox_violations>");
    }
  }, 120_000);
});

async function createGitWorktree(installation: SmokeInstallation): Promise<string> {
  const repository = join(installation.root, "enabled-repository");
  const worktree = join(installation.root, "enabled-worktree");
  await mkdir(repository);
  await requiredGit(["init", "--initial-branch=main"], repository, installation);
  await writeFile(join(repository, "tracked.txt"), "tracked\n");
  await requiredGit(["add", "tracked.txt"], repository, installation);
  await requiredGit([
    "-c", "user.name=Sandlot Smoke", "-c", "user.email=sandlot-smoke.invalid",
    "commit", "-m", "worktree fixture",
  ], repository, installation);
  await requiredGit(["worktree", "add", "-b", "enabled-smoke", worktree], repository, installation);
  return worktree;
}

async function requiredGit(args: string[], cwd: string, installation: SmokeInstallation): Promise<void> {
  const result = await run("git", args, { cwd, env: installation.env });
  if (result.code !== 0) throw new Error(`Git smoke setup failed: ${result.stderr}\n${result.stdout}`);
}

function rpcBashResult(result: { stdout: string }, id: string): { exitCode: number | undefined; output: string } {
  const response = parseJsonLines(result.stdout, `${id} RPC stdout`).find((record) => {
    if (typeof record !== "object" || record === null) return false;
    const value = record as Record<string, unknown>;
    return value.id === id && value.type === "response" && value.command === "bash" && value.success === true;
  }) as { data?: { exitCode?: number; output?: string } } | undefined;
  if (response?.data === undefined || typeof response.data.output !== "string") {
    throw new Error(`RPC bash response ${id} was absent or malformed: ${result.stdout}`);
  }
  return { exitCode: response.data.exitCode, output: response.data.output };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function linuxInertLoaderLibrary(): string {
  return process.arch === "arm64"
    ? "/lib/aarch64-linux-gnu/libc.so.6"
    : "/lib/x86_64-linux-gnu/libc.so.6";
}
