import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  it("pins the security boundary and publishes the compiled Pi entry", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
    expect(pkg.version).toBe("0.2.0");
    expect(lock.version).toBe("0.2.0");
    expect(lock.packages[""].version).toBe("0.2.0");
    expect(pkg.engines.node).toBe(">=22.19.0");
    expect(pkg.dependencies["@anthropic-ai/sandbox-runtime"]).toBe("0.0.73");
    expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
    expect(pkg.devDependencies["@earendil-works/pi-coding-agent"]).toBe("0.84.2");
    expect(pkg.pi.extensions).toEqual(["./dist/index.js"]);
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "bin/mktemp"]));
    expect(pkg.files).not.toContain("SPEC.md");
  });

  it("keeps the retired SPEC local-only and out of version control", async () => {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "SPEC.md"], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
    });

    expect(tracked.status).toBe(1);
    expect(tracked.stdout).not.toContain("SPEC.md");
  });

  it("declares Windows unsupported for v1 in public documentation", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toMatch(/Windows is unsupported/i);
  });

  it("keeps the complete locked dependency tree valid for npm consumers", async () => {
    // Catches a root pin that npm dedupes into an incompatible transitive peer,
    // which makes a clean install appear successful while `npm ls --all` fails.
    const isolated = await mkdtemp(join(tmpdir(), "sandlot-npm-ls-"));
    try {
      const npmCli = process.env.npm_execpath;
      const command = npmCli === undefined
        ? (process.platform === "win32" ? "npm.cmd" : "npm")
        : process.execPath;
      const args = npmCli === undefined ? ["ls", "--all"] : [npmCli, "ls", "--all"];
      const result = spawnSync(command, args, {
        cwd: new URL("../..", import.meta.url),
        env: {
          PATH: process.env.PATH,
          HOME: join(isolated, "home"),
          XDG_CACHE_HOME: join(isolated, "xdg-cache"),
          npm_config_cache: join(isolated, "npm-cache"),
          npm_config_userconfig: join(isolated, "npmrc"),
          npm_config_update_notifier: "false",
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
        stdio: "ignore",
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});
