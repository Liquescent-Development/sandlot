import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractReleaseNotes,
  parseStableVersion,
  validateReleaseMetadata,
} from "../../scripts/release-metadata.mjs";

const stableChangelog = [
  "# Changelog",
  "",
  "## [0.1.0] - 2026-08-18",
  "",
  "### Added",
  "",
  "- First stable Sandlot release.",
  "",
  "## [0.2.0] - 2026-09-01",
  "",
  "- Later release.",
  "",
].join("\n");

const releaseInput = (overrides: Partial<{
  version: unknown;
  manifest: unknown;
  lockfile: unknown;
  changelog: string;
}> = {}) => ({
  version: "0.1.0",
  manifest: { version: "0.1.0" },
  lockfile: { version: "0.1.0", packages: { "": { version: "0.1.0" } } },
  changelog: stableChangelog,
  ...overrides,
});

describe("release metadata", () => {
  it.each(["0.1.0", "1.0.0", "10.20.30"])("accepts stable version %s", (version) => {
    // Removing strict numeric-semver acceptance would let an invalid release tag be published.
    expect(parseStableVersion(version)).toBe(version);
  });

  it.each([
    "v0.1.0", " 0.1.0", "0.1.0 ", "", "01.0.0", "0.01.0", "0.1.00",
    "0.1.0-rc.1", "0.1.0+build", "0.1.0\n", "0.1.*", "0.1.$(x)",
    null, 1, {}, "1".repeat(1024),
  ])("rejects unsafe or non-stable version %#", (version) => {
    // Weakening version parsing would admit a tag that is not an exact stable release version.
    expect(() => parseStableVersion(version)).toThrow();
  });

  it("extracts only the requested release body and normalizes its final newline", () => {
    // Failing to stop at the next level-two heading would publish a later release's notes.
    expect(extractReleaseNotes(stableChangelog, "0.1.0")).toBe(
      "### Added\n\n- First stable Sandlot release.\n",
    );
  });

  it("preserves Markdown bytes other than its normalized final newline", () => {
    // Reformatting extracted Markdown would alter release-note content supplied by maintainers.
    expect(extractReleaseNotes("## [0.1.0] - 2026-08-18\n**keep  two spaces**  \n", "0.1.0"))
      .toBe("**keep  two spaces**  \n");
  });

  it.each([
    ["duplicates", `${stableChangelog}## [0.1.0] - 2026-10-01\n\n- Duplicate.\n`],
    ["duplicates the version with an invalid heading", `${stableChangelog}## [0.1.0] - invalid\n\n- Hidden duplicate.\n`],
    ["has an invalid date", "## [0.1.0] - 2026-02-30\n\n- Invalid.\n"],
    ["has an empty body", "## [0.1.0] - 2026-08-18\n\n"],
    ["has a placeholder", "## [0.1.0] - 2026-08-18\n\n- TODO write notes\n"],
    ["has an oversized body", `## [0.1.0] - 2026-08-18\n\n${"x".repeat(65 * 1024)}\n`],
    ["is missing the version", "## [0.2.0] - 2026-08-18\n\n- Other release.\n"],
  ])("rejects a changelog that %s", (_reason, changelog) => {
    // Omitting changelog integrity checks would release incomplete or ambiguous notes.
    expect(() => extractReleaseNotes(changelog, "0.1.0")).toThrow();
  });

  it("rejects a changelog whose complete input exceeds the byte limit", () => {
    // Limiting only the selected section would permit an unbounded changelog parse.
    expect(() => extractReleaseNotes(`${stableChangelog}${"x".repeat(65 * 1024)}`, "0.1.0")).toThrow();
  });

  it.each([
    ["package manifest", { version: "0.2.0" }, { version: "0.1.0", packages: { "": { version: "0.1.0" } } }],
    ["lockfile", { version: "0.1.0" }, { version: "0.2.0", packages: { "": { version: "0.1.0" } } }],
    ["lockfile root package", { version: "0.1.0" }, { version: "0.1.0", packages: { "": { version: "0.2.0" } } }],
  ])("rejects a version mismatch in the %s", (_source, manifest, lockfile) => {
    // Skipping any one metadata source would allow npm-published and tagged versions to diverge.
    expect(() => validateReleaseMetadata(releaseInput({ manifest, lockfile }))).toThrow();
  });

  it("rejects missing and inherited manifest fields", () => {
    // Reading inherited or absent fields would trust values JSON manifests cannot legitimately contain.
    expect(() => validateReleaseMetadata(releaseInput({ manifest: {} }))).toThrow();
    expect(() => validateReleaseMetadata(releaseInput({ manifest: Object.create({ version: "0.1.0" }) }))).toThrow();
  });

  it("returns the release tag and extracted notes for matching metadata", () => {
    // Returning an unprefixed tag or raw changelog would publish the wrong GitHub release metadata.
    expect(validateReleaseMetadata(releaseInput())).toEqual({
      version: "0.1.0",
      tag: "v0.1.0",
      notes: "### Added\n\n- First stable Sandlot release.\n",
    });
  });

  it("writes release artifacts only after real CLI validation succeeds", async () => {
    // Writing outputs before validation would leave trusted-looking artifacts after a failed release check.
    const root = await mkdtemp(join(tmpdir(), "sandlot-release-metadata-"));
    try {
      await writeFixture(root);
      const failed = runCli(root, ["--version", "0.2.0", "--notes-out", "release-notes.md", "--metadata-out", "metadata.json"]);
      expect(failed.status).toBe(1);
      await expect(readFile(join(root, "release-notes.md"), "utf8")).rejects.toThrow();
      await expect(readFile(join(root, "metadata.json"), "utf8")).rejects.toThrow();

      const succeeded = runCli(root, ["--version", "0.1.0", "--notes-out", "release-notes.md", "--metadata-out", "metadata.json"]);
      expect(succeeded.status).toBe(0);
      expect(await readFile(join(root, "release-notes.md"), "utf8"))
        .toBe("### Added\n\n- First stable Sandlot release.\n");
      expect(JSON.parse(await readFile(join(root, "metadata.json"), "utf8"))).toEqual({
        version: "0.1.0",
        tag: "v0.1.0",
        notesFile: "release-notes.md",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink or non-regular CLI output without following it", async () => {
    // Following a symlink or overwriting a directory would let release output escape its trusted directory.
    const root = await mkdtemp(join(tmpdir(), "sandlot-release-metadata-"));
    try {
      await writeFixture(root);
      await writeFile(join(root, "outside.md"), "unchanged\n");
      await symlink(join(root, "outside.md"), join(root, "release-notes.md"));
      await mkdir(join(root, "metadata.json"));
      const result = runCli(root, ["--version", "0.1.0", "--notes-out", "release-notes.md", "--metadata-out", "metadata.json"]);
      expect(result.status).toBe(1);
      expect(await readFile(join(root, "outside.md"), "utf8")).toBe("unchanged\n");

      await rm(join(root, "release-notes.md"));
      const nonRegular = runCli(root, ["--version", "0.1.0", "--notes-out", "release-notes.md", "--metadata-out", "metadata.json"]);
      expect(nonRegular.status).toBe(1);
      await expect(readFile(join(root, "release-notes.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not disclose a filesystem path when rejecting an unsafe CLI parent", async () => {
    // Forwarding filesystem errors would expose a runner path through release-validation diagnostics.
    const root = await mkdtemp(join(tmpdir(), "sandlot-release-metadata-"));
    try {
      await writeFixture(root);
      const result = runCli(root, ["--version", "0.1.0", "--notes-out", "missing/release-notes.md", "--metadata-out", "metadata.json"]);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeFixture(root: string): Promise<void> {
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({
    version: "0.1.0",
    packages: { "": { version: "0.1.0" } },
  }));
  await writeFile(join(root, "CHANGELOG.md"), stableChangelog);
}

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/release-metadata.mjs", import.meta.url)), ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, RUNNER_TEMP: cwd },
  });
}
