import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const MAX_PACK_REPORT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 60_000;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** @typedef {(request: { command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number }) => Promise<{ code: number, stdout: string, stderr: string }>} PackRunner */
/** @typedef {{ version: string, tag: string, commit: string, tarball: string, checksum: string, tarballBytes: number, sha256: string }} ReleaseHandoff */

export function parsePackReport(raw, expected) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_PACK_REPORT_BYTES || !isPlainObject(expected)) {
    throw new Error("npm pack report is invalid");
  }
  let reports;
  try {
    reports = JSON.parse(raw);
  } catch {
    throw new Error("npm pack report is invalid");
  }
  if (!Array.isArray(reports) || reports.length !== 1 || !isPlainObject(reports[0])) {
    throw new Error("npm pack report is invalid");
  }
  const report = reports[0];
  if (
    expected.name !== "sandlot"
    || report.name !== "sandlot"
    || report.name !== expected.name
    || report.version !== expected.version
    || !isSafeTarballName(report.filename)
    || !Number.isSafeInteger(report.size)
    || report.size < 1
    || report.size > MAX_ARTIFACT_BYTES
    || !isSha512Integrity(report.integrity)
  ) {
    throw new Error("npm pack report is invalid");
  }
  return { filename: report.filename, size: report.size, integrity: report.integrity };
}

export async function sha256File(path) {
  return (await hashRegularFile(path, ["sha256"])).sha256;
}

/** @param {{ root: string, version: string, outDir: string, runPack?: PackRunner }} options @returns {Promise<ReleaseHandoff>} */
export async function buildReleaseArtifact(options) {
  const root = validateRoot(options?.root);
  const version = validateVersion(options?.version);
  const outDir = validateOutDir(options?.outDir);
  await ensurePrivateEmptyDirectory(outDir);

  try {
    const commit = await gitCommit(root);
    const environment = await packEnvironment();
    try {
      const request = npmRequest(root, outDir, environment.env);
      const result = await (options.runPack ?? runPack)(request);
      if (!isPlainObject(result) || result.code !== 0) throw new Error("npm pack failed");
      const report = parsePackReport(result.stdout, { name: "sandlot", version });
      await assertOnlyOutput(outDir, report.filename);
      const tarballPath = resolve(outDir, report.filename);
      const hashes = await hashRegularFile(tarballPath, ["sha256", "sha512"], report.size);
      if (`sha512-${hashes.sha512}` !== report.integrity) throw new Error("npm pack integrity does not match tarball");

      const checksum = `${report.filename}.sha256`;
      const handoff = {
        version,
        tag: `v${version}`,
        commit,
        tarball: report.filename,
        checksum,
        tarballBytes: report.size,
        sha256: hashes.sha256,
      };
      await writeAtomically(outDir, checksum, `${hashes.sha256}  ${report.filename}\n`);
      await writeAtomically(outDir, "release-handoff.json", `${JSON.stringify(handoff, null, 2)}\n`);
      return handoff;
    } finally {
      await environment.cleanup();
    }
  } catch (error) {
    await cleanupPartialOutputs(outDir);
    throw error;
  }
}

async function runPack(request) {
  const npmCli = process.env.npm_execpath;
  return runCommand(npmCli === undefined ? {
    ...request,
    command: process.platform === "win32" ? "npm.cmd" : "npm",
  } : {
    ...request,
    command: process.execPath,
    args: [npmCli, ...request.args],
  });
}

async function gitCommit(root) {
  const result = await runCommand({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: root,
    env: commandEnvironment(),
    timeoutMs: PROCESS_TIMEOUT_MS,
  });
  const commit = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("release commit is invalid");
  return commit;
}

function npmRequest(root, outDir, env) {
  return {
    command: "npm",
    args: ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir],
    cwd: root,
    env,
    timeoutMs: PROCESS_TIMEOUT_MS,
  };
}

async function packEnvironment() {
  const work = await mkdirTemporary("sandlot-release-artifact-");
  const cache = resolve(work, "npm-cache");
  const home = resolve(work, "home");
  const userConfig = resolve(work, "npmrc");
  try {
    await Promise.all([
      mkdir(cache, { mode: 0o700 }),
      mkdir(home, { mode: 0o700 }),
      writeFile(userConfig, "update-notifier=false\naudit=false\nfund=false\nignore-scripts=true\n", { mode: 0o600 }),
    ]);
  } catch (error) {
    await cleanupPrivateDirectory(work);
    throw error;
  }
  return {
    env: {
      ...commandEnvironment(),
      HOME: home,
      XDG_CACHE_HOME: resolve(work, "xdg-cache"),
      npm_config_cache: cache,
      npm_config_userconfig: userConfig,
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_ignore_scripts: "true",
    },
    cleanup: () => cleanupPrivateDirectory(work),
  };
}

function commandEnvironment() {
  const env = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "SystemRoot", "COMSPEC"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

async function runCommand(request) {
  return new Promise((resolveResult, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputTooLarge = false;
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      stop();
      finish(reject, new Error("release command timed out"));
    }, request.timeoutMs);
    const append = (which, chunk) => {
      const next = which === "stdout" ? stdout : stderr;
      if (Buffer.byteLength(next, "utf8") + chunk.length > MAX_PACK_REPORT_BYTES) {
        outputTooLarge = true;
        stop();
        return;
      }
      if (which === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", () => finish(reject, new Error("release command failed to start")));
    child.once("close", (code) => {
      if (outputTooLarge) finish(reject, new Error("release command output exceeded limit"));
      else finish(resolveResult, { code: code ?? -1, stdout, stderr });
    });
  });
}

async function hashRegularFile(path, algorithms, expectedSize) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_ARTIFACT_BYTES || (expectedSize !== undefined && before.size !== expectedSize)) {
      throw new Error("release tarball is invalid");
    }
    const hashes = Object.fromEntries(algorithms.map((algorithm) => [algorithm, createHash(algorithm)]));
    let bytes = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > MAX_ARTIFACT_BYTES) {
        stream.destroy();
        throw new Error("release tarball exceeds size limit");
      }
      for (const hash of Object.values(hashes)) hash.update(chunk);
    }
    const after = await handle.stat();
    if (bytes !== before.size || after.size !== before.size || (expectedSize !== undefined && bytes !== expectedSize)) {
      throw new Error("release tarball changed while hashing");
    }
    return Object.fromEntries(Object.entries(hashes).map(([algorithm, hash]) => [
      algorithm,
      hash.digest(algorithm === "sha256" ? "hex" : "base64"),
    ]));
  } finally {
    await handle.close();
  }
}

async function assertOnlyOutput(outDir, filename) {
  const entries = await readdir(outDir);
  if (entries.length !== 1 || entries[0] !== filename) throw new Error("npm pack produced unexpected output");
  const info = await lstat(resolve(outDir, filename));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("release tarball is not a regular file");
}

async function ensurePrivateEmptyDirectory(outDir) {
  try {
    await mkdir(outDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const info = await lstat(outDir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("release output directory is not private");
  if ((await readdir(outDir)).length !== 0) throw new Error("release output directory is not empty");
  await chmod(outDir, 0o700);
}

async function writeAtomically(outDir, filename, contents) {
  const target = resolve(outDir, filename);
  if (basename(target) !== filename || !target.startsWith(`${outDir}/`)) throw new Error("release output filename is invalid");
  const temporary = resolve(outDir, `.${filename}.${randomBytes(16).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

async function cleanupPartialOutputs(outDir) {
  let entries;
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.filter((entry) => !entry.isDirectory()).map(async (entry) => {
    try { await unlink(resolve(outDir, entry.name)); } catch { /* best effort cleanup */ }
  }));
}

async function mkdirTemporary(prefix) {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(resolve(tmpdir(), prefix));
}

async function cleanupPrivateDirectory(path) {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    await unlink(path).catch(() => undefined);
    return;
  }
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await cleanupPrivateDirectory(child);
    else await unlink(child).catch(() => undefined);
  }
  await rmdir(path).catch(() => undefined);
}

function validateRoot(root) {
  if (typeof root !== "string" || root.length === 0) throw new Error("release root is invalid");
  return resolve(root);
}

function validateVersion(version) {
  if (typeof version !== "string" || !STABLE_VERSION.test(version)) throw new Error("release version is invalid");
  return version;
}

function validateOutDir(outDir) {
  if (typeof outDir !== "string" || outDir.length === 0 || !isAbsolute(resolve(outDir))) throw new Error("release output directory is invalid");
  return resolve(outDir);
}

function isSafeTarballName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && name === basename(name) && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".." && name.endsWith(".tgz") && !name.includes("\\0");
}

function isSha512Integrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try { return Buffer.from(value.slice(7), "base64").length === 64; } catch { return false; }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

async function main(args = process.argv.slice(2)) {
  try {
    if (args.length !== 4 || args[0] !== "--version" || args[2] !== "--out-dir") throw new Error("invalid arguments");
    await buildReleaseArtifact({ root: process.cwd(), version: args[1], outDir: args[3] });
  } catch {
    process.stderr.write("release artifact construction failed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
