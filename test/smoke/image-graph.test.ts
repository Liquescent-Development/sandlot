import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertCleanModeExit,
  installGitReleaseArtifact,
  installPackedArtifact,
  piArgs,
  run,
  type GitSmokeInstallation,
  type SmokeInstallation,
} from "./harness.js";

describe("enabled installed image graph resolution", () => {
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
  ] as const)("anchors the %s extension to Pi's exact host image graph", async (_label, installed) => {
    const installation = installed();
    await expect(access(join(
      installation.installedPackage,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    ))).rejects.toMatchObject({ code: "ENOENT" });
    const result = await run(process.execPath, piArgs("--print", "/sandlot graph"), {
      cwd: installation.workspace,
      env: installation.env,
    });
    assertCleanModeExit(result, `${_label} enabled image graph`);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Sandlot image graph[\s\S]*Pi: @earendil-works\/pi-coding-agent@0\.84\.2/);
    expect(result.stderr).toMatch(/host anchored: yes[\s\S]*image modules: 7/);
    expect(result.stderr).toMatch(/Photon module: present[\s\S]*Photon WASM: present/);
    expect(result.stderr).not.toMatch(/Pinned Pi image processor is unavailable/);
  }, 90_000);
});
