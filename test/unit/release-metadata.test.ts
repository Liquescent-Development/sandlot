import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
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

  it.each([
    ["a missing manifest version", { manifest: {} }],
    ["a malformed manifest version", { manifest: { version: 1 } }],
    ["an inherited manifest version", { manifest: Object.create({ version: "0.1.0" }) }],
    ["a missing lockfile version", { lockfile: { packages: { "": { version: "0.1.0" } } } }],
    ["a malformed lockfile version", { lockfile: { version: 1, packages: { "": { version: "0.1.0" } } } }],
    ["a missing lockfile packages object", { lockfile: { version: "0.1.0" } }],
    ["a malformed lockfile packages object", { lockfile: { version: "0.1.0", packages: [] } }],
    ["a missing lockfile root package", { lockfile: { version: "0.1.0", packages: {} } }],
    ["a malformed lockfile root package", { lockfile: { version: "0.1.0", packages: { "": 1 } } }],
    ["a missing lockfile root-package version", { lockfile: { version: "0.1.0", packages: { "": {} } } }],
    ["a malformed lockfile root-package version", { lockfile: { version: "0.1.0", packages: { "": { version: 1 } } } }],
  ])("rejects %s", (_reason, overrides) => {
    // Skipping any untrusted manifest shape check would let incomplete release metadata pass validation.
    expect(() => validateReleaseMetadata(releaseInput(overrides))).toThrow();
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
      const failed = await runCli(root, "0.2.0");
      expect(failed.status).toBe(1);
      expect(await readFile(join(root, "release-notes.md"), "utf8")).toBe("");
      expect(await readFile(join(root, "metadata.json"), "utf8")).toBe("");
      await rm(join(root, "release-notes.md"));
      await rm(join(root, "metadata.json"));

      const succeeded = await runCli(root, "0.1.0");
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

  it("rejects a non-regular caller-supplied output descriptor", async () => {
    // Writing to an unchecked descriptor would let a caller direct release metadata to a pipe or directory.
    const root = await mkdtemp(join(tmpdir(), "sandlot-release-metadata-"));
    try {
      await writeFixture(root);
      const [directory, metadata] = await Promise.all([
        open(root, "r"),
        open(join(root, "metadata.json"), "wx", 0o600),
      ]);
      const result = await runCliWithDescriptors(root, "0.1.0", directory.fd, metadata.fd);
      expect(result.status).toBe(1);
      expect(await readFile(join(root, "metadata.json"), "utf8")).toBe("");
      await Promise.all([directory.close(), metadata.close()]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not disclose a filesystem path when rejecting invalid output descriptor arguments", async () => {
    // Forwarding descriptor errors would expose a runner path through release-validation diagnostics.
    const root = await mkdtemp(join(tmpdir(), "sandlot-release-metadata-"));
    try {
      await writeFixture(root);
      const result = runRawCli(root, ["--version", "0.1.0", "--notes-fd", "not-a-fd", "--metadata-fd", "4", "--notes-file", "release-notes.md"]);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps real CLI output on pre-opened descriptors when the runner root is replaced", async () => {
    // Reintroducing pathname output writes would redirect release artifacts through the replacement runner-root symlink.
    const root = await mkdtemp(join(tmpdir(), "sandlot-release-metadata-"));
    const outside = await mkdtemp(join(tmpdir(), "sandlot-release-metadata-outside-"));
    try {
      await writeFixture(root);
      const heldRoot = `${root}-held`;
      const result = await runCliDuringRootReplacement(root, heldRoot, outside);
      expect(result).toBe(0);
      expect(await readdir(outside)).toEqual([]);
      expect(await readFile(join(heldRoot, "release-notes.md"), "utf8"))
        .toBe("### Added\n\n- First stable Sandlot release.\n");
      await rm(root);
      await rename(heldRoot, root);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
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

async function runCli(cwd: string, version: string) {
  const [notes, metadata] = await Promise.all([
    open(join(cwd, "release-notes.md"), "wx", 0o600),
    open(join(cwd, "metadata.json"), "wx", 0o600),
  ]);
  try {
    return await runCliWithDescriptors(cwd, version, notes.fd, metadata.fd);
  } finally {
    await Promise.all([notes.close(), metadata.close()]);
  }
}

async function runCliWithDescriptors(cwd: string, version: string, notesFd: number, metadataFd: number) {
  return runRawCli(cwd, ["--version", version, "--notes-fd", "3", "--metadata-fd", "4", "--notes-file", "release-notes.md"], [notesFd, metadataFd]);
}

function runRawCli(cwd: string, args: string[], descriptors: number[] = []) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/release-metadata.mjs", import.meta.url)), ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, RUNNER_TEMP: cwd },
    stdio: ["ignore", "pipe", "pipe", ...descriptors],
  });
}

async function runCliDuringRootReplacement(root: string, heldRoot: string, outside: string): Promise<number | null> {
  const [notes, metadata] = await Promise.all([
    open(join(root, "release-notes.md"), "wx", 0o600),
    open(join(root, "metadata.json"), "wx", 0o600),
  ]);
  try {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../../scripts/release-metadata.mjs", import.meta.url)),
      "--version", "0.1.0", "--notes-fd", "3", "--metadata-fd", "4", "--notes-file", "release-notes.md",
    ], {
      cwd: root,
      env: { PATH: process.env.PATH, RUNNER_TEMP: root },
      stdio: ["ignore", "pipe", "pipe", notes.fd, metadata.fd],
    });
    await once(child, "spawn");
    await rename(root, heldRoot);
    await symlink(outside, root, "dir");
    const [status] = await once(child, "close");
    return status;
  } finally {
    await Promise.all([notes.close(), metadata.close()]);
  }
}
