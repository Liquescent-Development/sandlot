import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROCESS_TIMEOUT_MS,
  createPtyPlan,
  createSmokeEnvironment,
  packDependencyForOfflineInstall,
  parseJsonLines,
  run,
  stageDependencyForPacking,
} from "./harness.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("smoke harness isolation", () => {
  it("allowlists only operational host variables and drops ambient Pi, npm, proxy, loader, and credential state", () => {
    const env = createSmokeEnvironment("/isolated", {
      PATH: "/trusted/bin",
      LANG: "en_US.UTF-8",
      TMPDIR: "/host/tmp",
      NODE_OPTIONS: "--import=/host/poison.mjs",
      NODE_PATH: "/host/modules",
      PI_PACKAGE_DIR: "/host/pi-packages",
      PI_CODING_AGENT_DIR: "/host/pi-agent",
      PI_UNRELATED: "poison",
      npm_config_registry: "https://attacker.invalid",
      npm_config_prefix: "/host/npm",
      HTTPS_PROXY: "http://attacker.invalid",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      RANDOM_SECRET: "secret",
    });

    expect(env).toMatchObject({
      PATH: "/trusted/bin",
      LANG: "en_US.UTF-8",
      HOME: "/isolated/home",
      PI_CODING_AGENT_DIR: "/isolated/agent",
      PI_CODING_AGENT_SESSION_DIR: "/isolated/sessions",
      npm_config_cache: "/isolated/npm-cache",
      npm_config_userconfig: "/isolated/npmrc",
    });
    for (const name of [
      "TMPDIR",
      "NODE_OPTIONS",
      "NODE_PATH",
      "PI_PACKAGE_DIR",
      "PI_UNRELATED",
      "npm_config_registry",
      "npm_config_prefix",
      "HTTPS_PROXY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "RANDOM_SECRET",
    ]) {
      expect(env, `${name} leaked into the smoke environment`).not.toHaveProperty(name);
    }
  });

  it("parses every nonempty JSONL record and identifies the exact bad line", () => {
    expect(parseJsonLines('{"type":"one"}\n\n{"type":"two"}\n', "RPC stdout"))
      .toEqual([{ type: "one" }, { type: "two" }]);
    expect(() => parseJsonLines('{"ok":true}\nnot-json\n', "JSON stdout"))
      .toThrow(/JSON stdout line 2 is not valid JSON/);
  });

  it.each(["darwin", "linux"] as const)("stages %s PTY input only after ordered visible milestones", (platform) => {
    const plan = createPtyPlan(platform, ["node", "pi"]);
    expect(plan.stages).toEqual([
      { waitFor: "Sandlot disabled", send: "/sandlot\r" },
      { waitFor: "Sandlot diagnostics", send: "\u0004" },
    ]);
    expect(plan.initialInput).toBeUndefined();
    expect(PROCESS_TIMEOUT_MS).toBeGreaterThan(plan.stageTimeoutMs + plan.cleanupTimeoutMs);
    const serialized = plan.args.join(" ");
    if (platform === "darwin") {
      expect(serialized.indexOf("Sandlot disabled")).toBeLessThan(serialized.indexOf("/sandlot"));
      expect(serialized.indexOf("/sandlot")).toBeLessThan(serialized.indexOf("Sandlot diagnostics"));
    } else {
      expect(plan.args).toEqual(expect.arrayContaining(["-e"]));
    }
  });

  it.skipIf(process.platform !== "linux")("propagates a nonzero PTY child exit through util-linux script", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-smoke-script-exit-"));
    roots.push(root);
    const plan = createPtyPlan("linux", ["/bin/sh", "-c", "exit 23"]);
    const result = await run(plan.command, plan.args, {
      cwd: root,
      env: createSmokeEnvironment(root, process.env),
    });
    expect(result.code).toBe(23);
    expect(result.signal).toBeNull();
  });

  it("waits for stream EOF and kills descendants that inherit output pipes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-smoke-close-"));
    roots.push(root);
    const marker = join(root, "descendant-marker");
    const descendant = [
      "const {writeFileSync}=require('node:fs');",
      `setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'escaped'),750);`,
    ].join("");
    const parent = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});`,
    ].join("");

    const started = Date.now();
    await expect(run(process.execPath, ["-e", parent], {
      cwd: root,
      env: createSmokeEnvironment(root, process.env),
      timeoutMs: 100,
    })).rejects.toThrow(/Timed out after 100ms/);
    expect(Date.now() - started).toBeLessThan(2_500);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(marker)).toBe(false);
  }, 5_000);

  it("stages third-party tarballs without running lifecycle scripts or mutating their source", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-smoke-pack-lifecycle-"));
    roots.push(root);
    const fixture = join(root, "lifecycle-fixture");
    const destination = join(root, "tarballs");
    const marker = join(fixture, "prepare-ran");
    const environment = {
      ...createSmokeEnvironment(root, process.env),
      SANDLOT_SMOKE_LIFECYCLE_MARKER: marker,
    };
    const prepare = "node -e 'require(\"node:fs\").writeFileSync(process.env.SANDLOT_SMOKE_LIFECYCLE_MARKER, \"ran\"); process.exit(23)'";
    await Promise.all([
      mkdir(fixture, { recursive: true }),
      mkdir(destination, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(fixture, "package.json"), JSON.stringify({
        name: "lifecycle-fixture",
        version: "1.0.0",
        scripts: { prepare },
      })),
      writeFile(join(fixture, "index.js"), "module.exports = 'fixture';\n"),
      mkdir(join(fixture, "bin"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(fixture, "bin", "runtime"), "#!/usr/bin/env node\n"),
      symlink("index.js", join(fixture, "runtime-link")),
    ]);
    await chmod(join(fixture, "bin", "runtime"), 0o755);
    const sourceManifest = await readFile(join(fixture, "package.json"), "utf8");

    const staged = await stageDependencyForPacking(fixture, destination);
    try {
      expect((await lstat(join(staged.packageRoot, "bin", "runtime"))).mode & 0o777).toBe(0o755);
      expect((await lstat(join(staged.packageRoot, "runtime-link"))).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(join(staged.packageRoot, "package.json"), "utf8")))
        .not.toHaveProperty("scripts");
    } finally {
      await rm(staged.root, { recursive: true, force: true });
    }

    const unguarded = await run("npm", ["pack", "--json", "--pack-destination", destination, fixture], {
      cwd: destination,
      env: environment,
    });
    expect(unguarded.code).not.toBe(0);
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const guarded = await packDependencyForOfflineInstall(fixture, destination, environment);
    expect(guarded.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(join(fixture, "package.json"), "utf8")).toBe(sourceManifest);
    const tarball = join(destination, "lifecycle-fixture-1.0.0.tgz");
    expect(await readdir(destination)).toContain("lifecycle-fixture-1.0.0.tgz");
    const packedManifest = await run("tar", ["-xOf", tarball, "package/package.json"], {
      cwd: destination,
      env: environment,
    });
    expect(packedManifest.code).toBe(0);
    expect(JSON.parse(packedManifest.stdout)).not.toHaveProperty("scripts");
    const packedContents = await run("tar", ["-tzf", tarball], { cwd: destination, env: environment });
    expect(packedContents.code).toBe(0);
    expect(packedContents.stdout).toContain("package/bin/runtime");
    const packedRuntime = await run("tar", ["-xOf", tarball, "package/bin/runtime"], {
      cwd: destination,
      env: environment,
    });
    expect(packedRuntime.code).toBe(0);
    expect(packedRuntime.stdout).toBe("#!/usr/bin/env node\n");
    const packedMetadata = await run("tar", ["-tvzf", tarball], { cwd: destination, env: environment });
    expect(packedMetadata.code).toBe(0);
    expect(packedMetadata.stdout).toMatch(/-rwxr-xr-x .* package\/bin\/runtime/);
    expect((await lstat(join(fixture, "bin", "runtime"))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(fixture, "runtime-link"))).isSymbolicLink()).toBe(true);
  }, 30_000);

  it("refuses dependency symlinks that escape the private staging source", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-smoke-pack-symlink-"));
    roots.push(root);
    const fixture = join(root, "symlink-fixture");
    const destination = join(root, "tarballs");
    await Promise.all([
      mkdir(fixture, { recursive: true }),
      mkdir(destination, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(fixture, "package.json"), JSON.stringify({
        name: "symlink-fixture",
        version: "1.0.0",
      })),
      symlink("../outside", join(fixture, "escape")),
    ]);

    await expect(stageDependencyForPacking(fixture, destination))
      .rejects.toThrow(/symlink .* escaped/);
  });
});
