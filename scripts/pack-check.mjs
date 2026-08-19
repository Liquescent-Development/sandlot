import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform === "win32") {
  throw new Error("Sandlot release verification supports macOS and Linux only");
}

const root = await mkdtemp(join(tmpdir(), "sandlot-pack-check-"));
const cache = join(root, "npm-cache");
const home = join(root, "home");
const userConfig = join(root, "npmrc");
try {
  await Promise.all([
    mkdir(cache, { recursive: true }),
    mkdir(home, { recursive: true }),
    writeFile(userConfig, "update-notifier=false\naudit=false\nfund=false\n"),
  ]);
} catch (error) {
  await rm(root, { recursive: true, force: true });
  throw error;
}

const env = {};
for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
Object.assign(env, {
  HOME: home,
  XDG_CACHE_HOME: join(root, "xdg-cache"),
  npm_config_cache: cache,
  npm_config_userconfig: userConfig,
  npm_config_update_notifier: "false",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_offline: "true",
});

try {
  const child = spawn("npm", ["pack", "--dry-run"], {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      reject(new Error("npm pack --dry-run timed out after 60000ms"));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  if (code !== 0) throw new Error(`npm pack --dry-run exited with ${code}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
