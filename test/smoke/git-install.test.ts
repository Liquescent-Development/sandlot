import { access, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertCleanModeExit,
  installGitReleaseArtifact,
  piArgs,
  run,
  writeUserPolicy,
} from "./harness.js";

describe("pinned Pi Git release installation", () => {
  let installation: Awaited<ReturnType<typeof installGitReleaseArtifact>>;

  beforeAll(async () => {
    installation = await installGitReleaseArtifact();
  }, 120_000);

  afterAll(async () => installation?.cleanup());

  it("clones a local release ref, installs offline, and automatically discovers built output", async () => {
    expect(installation.installedPackage.startsWith(`${installation.root}${sep}`)).toBe(true);
    expect(installation.installedPackage).not.toContain("sandlot-implementation");
    for (const path of [
      "dist/index.js",
      "dist/helpers/file-worker.js",
      "dist/helpers/search-worker.js",
    ]) {
      await expect(access(join(installation.installedPackage, path))).resolves.toBeUndefined();
    }
    const settings = JSON.parse(
      await readFile(join(installation.agentDir, "settings.json"), "utf8"),
    ) as { packages?: string[] };
    expect(settings.packages).toContain(installation.source);

    await writeUserPolicy(installation, '{"enabled":false}\n');
    const diagnostic = await run(process.execPath, piArgs("-p", "/sandlot"), {
      cwd: installation.workspace,
      env: installation.env,
    });
    assertCleanModeExit(diagnostic, "Git release print");
    expect(diagnostic.stdout).toBe("");
    expect(diagnostic.stderr).toContain("Sandlot diagnostics");
    expect(diagnostic.stderr).toContain("state: disabled-by-user");
  });
});
