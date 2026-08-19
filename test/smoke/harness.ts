import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
export const PI_CLI = join(
  PROJECT_ROOT,
  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
export const PROCESS_TIMEOUT_MS = 30_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 2_000;
const PTY_STEP_TIMEOUT_MS = 8_000;
const RUNTIME_DEPENDENCIES = [
  "@anthropic-ai/sandbox-runtime",
  "@pondwader/socks5-server",
  "commander",
  "node-forge",
  "zod",
] as const;

export interface CommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SmokeInstallation {
  readonly root: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly installedPackage: string;
  readonly runtimeDependencyPaths: readonly string[];
  readonly tarball: string;
  readonly env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export interface GitSmokeInstallation extends SmokeInstallation {
  readonly source: string;
}

export async function packArtifact(root = PROJECT_ROOT): Promise<{
  readonly directory: string;
  readonly tarball: string;
  readonly integrity: string;
  cleanup(): Promise<void>;
}> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandlot-pack-")));
  const cleanup = idempotentCleanup(directory);
  const cacheDir = join(directory, "npm-cache");
  const homeDir = join(directory, "home");
  const npmUserConfig = join(directory, "npmrc");
  try {
    await Promise.all([
      mkdir(cacheDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      writeFile(npmUserConfig, "update-notifier=false\naudit=false\nfund=false\n"),
    ]);
    const result = await run("npm", [
      "pack",
      "--json",
      "--pack-destination",
      directory,
    ], {
      cwd: root,
      env: createSmokeEnvironment(directory, process.env),
      timeoutMs: 60_000,
    });
    if (result.code !== 0) {
      throw new Error(`npm pack failed (${result.code}):\n${result.stderr}\n${result.stdout}`);
    }
    const report = parseNpmPackReport(result.stdout, "Sandlot npm pack");
    return {
      directory,
      tarball: join(directory, report.filename),
      integrity: report.integrity,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function installPackedArtifact(): Promise<SmokeInstallation> {
  const packed = await packArtifact();
  let root: string;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "sandlot-pi-smoke-")));
  } catch (error) {
    await packed.cleanup();
    throw error;
  }
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const cacheDir = join(root, "npm-cache");
  const homeDir = join(root, "home");
  const npmRoot = join(agentDir, "npm");
  const npmUserConfig = join(root, "npmrc");
  const dependencyTarballDir = join(root, "locked-tarballs");
  const env = createSmokeEnvironment(root, process.env);

  try {
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
      mkdir(cacheDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      mkdir(npmRoot, { recursive: true }),
      mkdir(dependencyTarballDir, { recursive: true }),
      writeFile(npmUserConfig, "update-notifier=false\naudit=false\nfund=false\n"),
    ]);
    const lockedTarballs = await packLockedRuntimeDependencies(dependencyTarballDir, env);
    await writeOfflineInstallProject(npmRoot, packed, lockedTarballs);
    const install = await run("npm", [
      "ci",
      "--prefix",
      npmRoot,
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--offline",
    ], { cwd: workspace, env, timeoutMs: 120_000 });
    if (install.code !== 0) {
      throw new Error(`tarball install failed (${install.code}):\n${install.stderr}\n${install.stdout}`);
    }

    const installedPackage = join(npmRoot, "node_modules", "sandlot");
    const runtimeDependencyPaths = await Promise.all(RUNTIME_DEPENDENCIES.map(async (name) => {
      const path = await realpath(join(npmRoot, "node_modules", name));
      assertContainedPath(root, path, `${name} install`);
      if (path === PROJECT_ROOT || path.startsWith(`${PROJECT_ROOT}${sep}`)) {
        throw new Error(`${name} resolved into the source checkout: ${path}`);
      }
      return path;
    }));
    const piInstall = await run(process.execPath, [PI_CLI, "install", installedPackage], {
      cwd: workspace,
      env,
      timeoutMs: PROCESS_TIMEOUT_MS,
    });
    if (piInstall.code !== 0) {
      throw new Error(`pi install failed (${piInstall.code}):\n${piInstall.stderr}\n${piInstall.stdout}`);
    }
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      packages?: string[];
    };
    if (!settings.packages?.some((source) => resolve(agentDir, source) === installedPackage)) {
      throw new Error(`Pi did not register the installed package: ${JSON.stringify(settings)}`);
    }

    return {
      root,
      workspace,
      agentDir,
      installedPackage,
      runtimeDependencyPaths,
      tarball: packed.tarball,
      env,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true });
        await packed.cleanup();
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    await packed.cleanup();
    throw error;
  }
}

export async function installGitReleaseArtifact(): Promise<GitSmokeInstallation> {
  const packed = await packArtifact();
  let root: string;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "sandlot-pi-git-smoke-")));
  } catch (error) {
    await packed.cleanup();
    throw error;
  }
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const cacheDir = join(root, "npm-cache");
  const homeDir = join(root, "home");
  const dependencyTarballDir = join(root, "locked-tarballs");
  const releaseRepository = join(root, "release-origin");
  const npmUserConfig = join(root, "npmrc");
  const gitConfig = join(root, "gitconfig");
  const source = "git:fixture.invalid/Liquescent-Development/sandlot@v0.1.0";
  const installedPackage = join(
    agentDir,
    "git",
    "fixture.invalid",
    "Liquescent-Development",
    "sandlot",
  );
  const env = createSmokeEnvironment(root, process.env, {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  });

  try {
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
      mkdir(cacheDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      mkdir(dependencyTarballDir, { recursive: true }),
      mkdir(releaseRepository, { recursive: true }),
      writeFile(npmUserConfig, "update-notifier=false\naudit=false\nfund=false\n"),
      writeFile(gitConfig, [
        `[url "file://${releaseRepository}"]`,
        "\tinsteadOf = https://fixture.invalid/Liquescent-Development/sandlot",
        "[protocol \"file\"]",
        "\tallow = always",
        "",
      ].join("\n")),
    ]);
    await runRequired("tar", [
      "-xzf",
      packed.tarball,
      "--strip-components=1",
      "-C",
      releaseRepository,
    ], { cwd: workspace, env }, "release tar extraction");
    const lockedTarballs = await packLockedRuntimeDependencies(dependencyTarballDir, env);
    await writeGitOfflineLock(releaseRepository, lockedTarballs);
    for (const dependency of lockedTarballs) {
      await runRequired("npm", ["cache", "add", dependency.tarball], {
        cwd: workspace,
        env,
        timeoutMs: 30_000,
      }, `cache seed for ${dependency.name}`);
    }

    await runRequired("git", ["init"], { cwd: releaseRepository, env }, "release git init");
    await runRequired("git", ["add", "."], { cwd: releaseRepository, env }, "release git add");
    await runRequired("git", [
      "-c",
      "user.name=Sandlot Smoke",
      "-c",
      "user.email=sandlot-smoke.invalid",
      "commit",
      "-m",
      "release fixture",
    ], { cwd: releaseRepository, env }, "release git commit");
    await runRequired("git", ["tag", "v0.1.0"], {
      cwd: releaseRepository,
      env,
    }, "release git tag");

    await runRequired(process.execPath, [PI_CLI, "install", source], {
      cwd: workspace,
      env,
      timeoutMs: 90_000,
    }, "Pi Git install");

    const runtimeDependencyPaths = await Promise.all(RUNTIME_DEPENDENCIES.map(async (name) => {
      const path = await realpath(join(installedPackage, "node_modules", name));
      assertContainedPath(root, path, `${name} Git install`);
      if (path === PROJECT_ROOT || path.startsWith(`${PROJECT_ROOT}${sep}`)) {
        throw new Error(`${name} Git install resolved into the source checkout: ${path}`);
      }
      return path;
    }));
    return {
      root,
      workspace,
      agentDir,
      installedPackage,
      runtimeDependencyPaths,
      tarball: packed.tarball,
      source,
      env,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true });
        await packed.cleanup();
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    await packed.cleanup();
    throw error;
  }
}

export async function writeUserPolicy(
  installation: SmokeInstallation,
  contents: string,
): Promise<void> {
  await writeFile(join(installation.agentDir, "sandlot.json"), contents);
}

export function piArgs(...modeArgs: string[]): string[] {
  return [
    PI_CLI,
    "--no-session",
    "--no-approve",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    ...modeArgs,
  ];
}

export function createSmokeEnvironment(
  root: string,
  inherited: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const) {
    if (inherited[name] !== undefined) env[name] = inherited[name];
  }
  return {
    ...env,
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "npmrc"),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_install_links: "true",
    ...overrides,
  };
}

export function parseJsonLines(stdout: string, label: string): unknown[] {
  const records: unknown[] = [];
  for (const [index, line] of stdout.split("\n").entries()) {
    if (line === "") continue;
    try {
      records.push(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is not valid JSON`, { cause: error });
    }
  }
  return records;
}

export async function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
    readonly timeoutMs?: number;
  },
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  const result = await waitForExit(child, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
  return { ...result, stdout, stderr };
}

/** Package a third-party dependency without executing its untrusted lifecycle hooks. */
export async function packDependencyForOfflineInstall(
  source: string,
  destination: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const staged = await stageDependencyForPacking(source, destination);
  try {
    const result = await run("npm", [
      "pack",
      "--json",
      "--pack-destination",
      destination,
      staged.packageRoot,
    ], {
      cwd: destination,
      env,
      timeoutMs: 60_000,
    });
    if (result.code !== 0) return result;
    const report = parseNpmPackReport(result.stdout, `${staged.manifest.name} npm pack`);
    await validateStagedTarball(
      join(destination, report.filename),
      staged.manifest,
      env,
    );
    return result;
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly main?: string;
  readonly bin?: string | Record<string, string>;
  readonly hasScripts: boolean;
}

interface StagedDependency {
  readonly root: string;
  readonly packageRoot: string;
  readonly manifest: PackageManifest;
}

export async function stageDependencyForPacking(source: string, destination: string): Promise<StagedDependency> {
  const sourceRoot = await realpath(source);
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`dependency source must be a real directory: ${source}`);
  }
  const manifestPath = join(sourceRoot, "package.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`dependency package.json must be a regular file: ${source}`);
  }
  const manifest = parsePackageManifest(await readFile(manifestPath, "utf8"), source);
  const root = await mkdtemp(join(destination, ".sandlot-pack-stage-"));
  const packageRoot = join(root, "package");
  try {
    await cp(sourceRoot, packageRoot, {
      dereference: false,
      errorOnExist: true,
      filter: async (path) => assertSafeDependencyEntry(sourceRoot, path),
      force: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    const stagedManifestPath = join(packageRoot, "package.json");
    const stagedManifestStat = await lstat(stagedManifestPath);
    if (!stagedManifestStat.isFile() || stagedManifestStat.isSymbolicLink()) {
      throw new Error(`staged package.json must be a regular file: ${source}`);
    }
    const stagedManifest = JSON.parse(await readFile(stagedManifestPath, "utf8")) as Record<string, unknown>;
    delete stagedManifest.scripts;
    await writeFile(stagedManifestPath, JSON.stringify(stagedManifest, null, 2));
    return { root, packageRoot, manifest };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function assertSafeDependencyEntry(root: string, path: string): Promise<boolean> {
  const stat = await lstat(path);
  if (stat.isDirectory() || stat.isFile()) return true;
  if (!stat.isSymbolicLink()) {
    throw new Error(`dependency contains unsupported filesystem entry: ${path}`);
  }
  const target = await readlink(path);
  if (isAbsolute(target)) throw new Error(`dependency symlink is absolute: ${path}`);
  assertContainedPath(root, resolve(dirname(path), target), `dependency symlink ${path}`);
  return true;
}

function parsePackageManifest(value: string, source: string): PackageManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`dependency package.json is not valid JSON: ${source}`, { cause: error });
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`dependency package.json is not an object: ${source}`);
  }
  const record = manifest as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.version !== "string") {
    throw new Error(`dependency package.json has no name/version: ${source}`);
  }
  if (
    record.main !== undefined &&
    typeof record.main !== "string"
  ) throw new Error(`dependency package.json main is invalid: ${source}`);
  if (
    record.bin !== undefined &&
    typeof record.bin !== "string" &&
    (record.bin === null ||
      typeof record.bin !== "object" ||
      Array.isArray(record.bin) ||
      Object.values(record.bin).some((value) => typeof value !== "string"))
  ) throw new Error(`dependency package.json bin is invalid: ${source}`);
  return {
    name: record.name,
    version: record.version,
    hasScripts: Object.hasOwn(record, "scripts"),
    ...(typeof record.main === "string" ? { main: record.main } : {}),
    ...(typeof record.bin === "string" || (record.bin !== null && typeof record.bin === "object")
      ? { bin: record.bin as string | Record<string, string> }
      : {}),
  };
}

async function validateStagedTarball(
  tarball: string,
  expected: PackageManifest,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const manifestResult = await run("tar", ["-xOf", tarball, "package/package.json"], {
    cwd: dirname(tarball),
    env,
  });
  if (manifestResult.code !== 0) {
    throw new Error(`packed ${expected.name} tarball has no readable package.json`);
  }
  const packed = parsePackageManifest(manifestResult.stdout, tarball);
  if (packed.name !== expected.name || packed.version !== expected.version) {
    throw new Error(`packed tarball identity differs from ${expected.name}@${expected.version}`);
  }
  if (packed.hasScripts) {
    throw new Error(`packed ${expected.name} tarball retained lifecycle scripts`);
  }
  const contents = await run("tar", ["-tzf", tarball], { cwd: dirname(tarball), env });
  if (contents.code !== 0) throw new Error(`packed ${expected.name} tarball is unreadable`);
  const entries = new Set(contents.stdout.split("\n").filter(Boolean));
  if (!entries.has("package/package.json")) {
    throw new Error(`packed ${expected.name} tarball has no package.json entry`);
  }
  for (const runtimePath of runtimeManifestPaths(expected)) {
    if (!entries.has(`package/${runtimePath}`)) {
      throw new Error(`packed ${expected.name} tarball omitted runtime path ${runtimePath}`);
    }
  }
}

function runtimeManifestPaths(manifest: PackageManifest): string[] {
  const paths = [manifest.main, ...(typeof manifest.bin === "string"
    ? [manifest.bin]
    : Object.values(manifest.bin ?? {}))].filter((value): value is string => value !== undefined);
  return [...new Set(paths.map((path) => path.replace(/^\.\//, "")))];
}

async function runRequired(
  command: string,
  args: readonly string[],
  options: Parameters<typeof run>[2],
  label: string,
): Promise<CommandResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${label} failed (${result.code}):\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}

export async function runRpc(
  installation: SmokeInstallation,
  message = "/sandlot",
): Promise<CommandResult> {
  return runRpcCommand(installation, { id: "sandlot-smoke", type: "prompt", message });
}

export async function runRpcCommand(
  installation: SmokeInstallation,
  command: Readonly<Record<string, unknown>>,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CommandResult> {
  const id = command.id;
  if (typeof id !== "string" || id === "") throw new Error("RPC smoke command requires a nonempty string id");
  const child = spawn(process.execPath, piArgs("--mode", "rpc"), {
    cwd: options.cwd ?? installation.workspace,
    env: options.env ?? installation.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let pending = "";
  let sent = false;
  const send = (): void => {
    if (sent) return;
    sent = true;
    child.stdin.write(`${JSON.stringify(command)}\n`);
  };
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (
          record.id === id &&
          record.type === "response" &&
          record.success === true
        ) child.stdin.end();
      } catch {
        child.stdin.end();
      }
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  send();
  const result = await waitForExit(child, PROCESS_TIMEOUT_MS);
  return { ...result, stdout, stderr };
}

export async function runInteractivePty(installation: SmokeInstallation): Promise<CommandResult> {
  if (process.platform === "win32") throw new Error("Sandlot smoke tests do not support Windows");
  const plan = createPtyPlan(process.platform, [process.execPath, ...piArgs()]);
  if (!plan.stageExternally) return run(plan.command, plan.args, {
    cwd: installation.workspace,
    env: { ...installation.env, TERM: "xterm-256color" },
    timeoutMs: PROCESS_TIMEOUT_MS,
  });
  return runStagedPty(plan, installation);
}

export interface PtyPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly initialInput: undefined;
  readonly stageExternally: boolean;
  readonly stages: readonly [
    { readonly waitFor: "Sandlot disabled"; readonly send: "/sandlot\r" },
    { readonly waitFor: "Sandlot diagnostics"; readonly send: "\u0004" },
  ];
  readonly stageTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
}

export function createPtyPlan(platform: "darwin" | "linux", argv: readonly string[]): PtyPlan {
  const stages = [
    { waitFor: "Sandlot disabled" as const, send: "/sandlot\r" as const },
    { waitFor: "Sandlot diagnostics" as const, send: "\u0004" as const },
  ] as const;
  return {
    command: platform === "darwin" ? "/usr/bin/expect" : "script",
    args: platform === "darwin"
      ? ["-c", expectProgram(argv, stages)]
      : ["-q", "-e", "-c", shellCommand(argv), "/dev/null"],
    initialInput: undefined,
    stageExternally: platform === "linux",
    stages,
    stageTimeoutMs: PTY_STEP_TIMEOUT_MS * 3,
    cleanupTimeoutMs: PROCESS_CLEANUP_TIMEOUT_MS,
  };
}

export function combinedOutput(result: CommandResult): string {
  return stripAnsi(`${result.stdout}\n${result.stderr}`);
}

export function assertCleanModeExit(result: CommandResult, mode: string): void {
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`${mode} exited code=${String(result.code)} signal=${String(result.signal)}\n${combinedOutput(result)}`);
  }
  const output = combinedOutput(result);
  if (/Extension (?:error|load failure)|TypeError:.*(?:ui|setStatus|notify)/i.test(output)) {
    throw new Error(`${mode} had an extension/UI crash:\n${output}`);
  }
}

async function runStagedPty(plan: PtyPlan, installation: SmokeInstallation): Promise<CommandResult> {
  const child = spawn(plan.command, plan.args, {
    cwd: installation.workspace,
    env: { ...installation.env, TERM: "xterm-256color" },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let stage = 0;
  let stageError: Error | undefined;
  let stageTimer: ReturnType<typeof setTimeout>;
  const armStageTimeout = () => {
    clearTimeout(stageTimer);
    stageTimer = setTimeout(() => {
      const milestone = plan.stages[stage]?.waitFor ?? "PTY close";
      stageError = new Error(`Timed out waiting for ${milestone}`);
      terminateProcessTree(child);
    }, PTY_STEP_TIMEOUT_MS);
  };
  const advance = () => {
    const visible = stripAnsi(`${stdout}\n${stderr}`);
    const expected = plan.stages[stage];
    if (expected === undefined || !visible.includes(expected.waitFor)) return;
    child.stdin.write(expected.send);
    stage += 1;
    armStageTimeout();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; advance(); });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; advance(); });
  armStageTimeout();
  try {
    const result = await waitForExit(child, PROCESS_TIMEOUT_MS);
    if (stageError !== undefined) throw stageError;
    if (stage !== plan.stages.length) {
      throw new Error(`PTY closed before stage ${stage + 1}: ${stripAnsi(`${stdout}\n${stderr}`)}`);
    }
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(stageTimer!);
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<Pick<CommandResult, "code" | "signal">> {
  return new Promise((resolveClose, reject) => {
    let timedOut = false;
    let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
      cleanupTimeout = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms; process tree did not close within ${PROCESS_CLEANUP_TIMEOUT_MS}ms`));
      }, PROCESS_CLEANUP_TIMEOUT_MS);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (cleanupTimeout !== undefined) clearTimeout(cleanupTimeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (cleanupTimeout !== undefined) clearTimeout(cleanupTimeout);
      if (timedOut) {
        reject(new Error(`Timed out after ${timeoutMs}ms running pid ${String(child.pid)}`));
        return;
      }
      resolveClose({ code, signal });
    });
  });
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  for (const pid of descendantPids(child.pid).reverse()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
  }
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function descendantPids(rootPid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
    const children = new Map<number, number[]>();
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (match === null) continue;
      const pid = Number(match[1]);
      const parent = Number(match[2]);
      const siblings = children.get(parent) ?? [];
      siblings.push(pid);
      children.set(parent, siblings);
    }
    const result: number[] = [];
    const pending = [...(children.get(rootPid) ?? [])];
    while (pending.length > 0) {
      const pid = pending.shift()!;
      result.push(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    return result;
  } catch {
    return [];
  }
}

function shellCommand(argv: readonly string[]): string {
  return argv.map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(" ");
}

function expectProgram(argv: readonly string[], stages: PtyPlan["stages"]): string {
  const command = argv.map(tclWord).join(" ");
  return [
    "log_user 1",
    `set timeout ${Math.ceil(PTY_STEP_TIMEOUT_MS / 1000)}`,
    `spawn -noecho ${command}`,
    "expect {",
    `  -re {${stages[0].waitFor}} {}`,
    "  timeout { catch {exec /bin/kill -KILL -- -[exp_pid]}; exit 124 }",
    "}",
    `send -- ${tclWord(stages[0].send)}`,
    "expect {",
    `  -re {${stages[1].waitFor}} {}`,
    "  timeout { catch {exec /bin/kill -KILL -- -[exp_pid]}; exit 124 }",
    "}",
    'send -- "\\004"',
    "expect {",
    "  eof {}",
    "  timeout { catch {exec /bin/kill -KILL -- -[exp_pid]}; exit 124 }",
    "}",
    "set result [wait]",
    "exit [lindex $result 3]",
  ].join("\n");
}

function tclWord(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\u0004", "\\004")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("[", "\\[")}"`;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

export function tarballName(path: string): string {
  return basename(path);
}

interface LockedTarball {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
  readonly lockEntry: Record<string, unknown>;
}

async function packLockedRuntimeDependencies(
  destination: string,
  env: NodeJS.ProcessEnv,
): Promise<LockedTarball[]> {
  const lock = JSON.parse(await readFile(join(PROJECT_ROOT, "package-lock.json"), "utf8")) as {
    packages?: Record<string, Record<string, unknown>>;
  };
  const results: LockedTarball[] = [];
  for (const name of RUNTIME_DEPENDENCIES) {
    const lockEntry = lock.packages?.[`node_modules/${name}`];
    if (lockEntry === undefined || typeof lockEntry.version !== "string") {
      throw new Error(`package-lock.json has no exact entry for ${name}`);
    }
    const source = join(PROJECT_ROOT, "node_modules", name);
    const installedManifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    if (installedManifest.name !== name || installedManifest.version !== lockEntry.version) {
      throw new Error(`${name} does not match package-lock.json version ${lockEntry.version}`);
    }
    const packed = await packDependencyForOfflineInstall(source, destination, env);
    if (packed.code !== 0) {
      throw new Error(`could not seed locked ${name} tarball: ${packed.stderr}\n${packed.stdout}`);
    }
    const report = parseNpmPackReport(packed.stdout, `${name} npm pack`);
    results.push({
      name,
      version: lockEntry.version,
      tarball: join(destination, report.filename),
      integrity: report.integrity,
      lockEntry,
    });
  }
  return results;
}

async function writeOfflineInstallProject(
  npmRoot: string,
  packed: { readonly tarball: string; readonly integrity: string },
  lockedTarballs: readonly LockedTarball[],
): Promise<void> {
  const sandlotManifest = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    engines?: Record<string, string>;
  };
  const sandlotSpec = `file:${packed.tarball}`;
  const packages: Record<string, unknown> = {
    "": {
      name: "sandlot-smoke-install",
      version: "0.0.0",
      dependencies: { sandlot: sandlotSpec },
    },
    "node_modules/sandlot": {
      version: sandlotManifest.version,
      resolved: sandlotSpec,
      integrity: packed.integrity,
      dependencies: sandlotManifest.dependencies,
      peerDependencies: sandlotManifest.peerDependencies,
      engines: sandlotManifest.engines,
    },
  };
  for (const dependency of lockedTarballs) {
    packages[`node_modules/${dependency.name}`] = {
      ...dependency.lockEntry,
      resolved: `file:${dependency.tarball}`,
      integrity: dependency.integrity,
    };
  }
  await Promise.all([
    writeFile(join(npmRoot, "package.json"), JSON.stringify({
      name: "sandlot-smoke-install",
      version: "0.0.0",
      private: true,
      dependencies: { sandlot: sandlotSpec },
    }, null, 2)),
    writeFile(join(npmRoot, "package-lock.json"), JSON.stringify({
      name: "sandlot-smoke-install",
      version: "0.0.0",
      lockfileVersion: 3,
      requires: true,
      packages,
    }, null, 2)),
  ]);
}

async function writeGitOfflineLock(
  releaseRepository: string,
  lockedTarballs: readonly LockedTarball[],
): Promise<void> {
  const lock = JSON.parse(await readFile(join(PROJECT_ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, Record<string, unknown>>;
  };
  for (const dependency of lockedTarballs) {
    lock.packages[`node_modules/${dependency.name}`] = {
      ...lock.packages[`node_modules/${dependency.name}`],
      resolved: `file:${dependency.tarball}`,
      integrity: dependency.integrity,
    };
  }
  await writeFile(join(releaseRepository, "package-lock.json"), JSON.stringify(lock, null, 2));
}

function parseNpmPackReport(stdout: string, label: string): { filename: string; integrity: string } {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`${label} did not return JSON`, { cause: error });
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${label} returned ${Array.isArray(value) ? value.length : "non-array"} entries`);
  }
  const entry = value[0] as Record<string, unknown> | undefined;
  if (
    entry === undefined ||
    typeof entry.filename !== "string" ||
    basename(entry.filename) !== entry.filename ||
    !entry.filename.endsWith(".tgz") ||
    typeof entry.integrity !== "string" ||
    !entry.integrity.startsWith("sha512-")
  ) {
    throw new Error(`${label} returned an invalid filename or integrity`);
  }
  return { filename: entry.filename, integrity: entry.integrity };
}

function assertContainedPath(root: string, path: string, label: string): void {
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escaped ${root}: ${path}`);
  }
}

function idempotentCleanup(root: string): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return () => {
    cleanup ??= rm(root, { recursive: true, force: true });
    return cleanup;
  };
}
