import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildReleaseArtifact,
  parsePackReport,
  sha256File,
  type PackRunner,
} from "../../scripts/build-release-artifact.mjs";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TAR_BYTES = Buffer.from("deterministic release artifact\n", "utf8");
const TAR_NAME = "sandlot-0.1.0.tgz";
const TAR_INTEGRITY = "sha512-WufHeYhYEL1zSqqeoaEPDhDSraZf5zndlOzScl9Gs9iZG8d1mVKzODfJQfuhKtWk4wE4NGzE3Vut1dyeNUpWyA==";

describe("release artifact builder", () => {
  it("parses exactly one matching npm pack report", () => {
    // Accepting a report for another package or artifact would publish unverified bytes.
    expect(parsePackReport(JSON.stringify([{
      name: "sandlot",
      version: "0.1.0",
      filename: TAR_NAME,
      size: TAR_BYTES.length,
      integrity: TAR_INTEGRITY,
    }]), { name: "sandlot", version: "0.1.0" })).toEqual({
      filename: TAR_NAME,
      size: TAR_BYTES.length,
      integrity: TAR_INTEGRITY,
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["multiple entries", JSON.stringify([validReport(), validReport()])],
    ["wrong package", JSON.stringify([validReport({ name: "other" })])],
    ["non-sandlot expected package", JSON.stringify([validReport({ name: "other" })]), { name: "other", version: "0.1.0" }],
    ["wrong version", JSON.stringify([validReport({ version: "0.1.1" })])],
    ["missing requested version", JSON.stringify([validReport({ version: undefined })]), { name: "sandlot" }],
    ["non-string requested version", JSON.stringify([validReport({ version: 1 })]), { name: "sandlot", version: 1 }],
    ["non-stable requested version", JSON.stringify([validReport({ version: "0.1.0-rc.1" })]), { name: "sandlot", version: "0.1.0-rc.1" }],
    ["absolute filename", JSON.stringify([validReport({ filename: "/tmp/evil.tgz" })])],
    ["traversal filename", JSON.stringify([validReport({ filename: "../evil.tgz" })])],
    ["Windows traversal filename", JSON.stringify([validReport({ filename: "..\\evil.tgz" })])],
    ["NUL filename", JSON.stringify([validReport({ filename: "sandlot\0evil.tgz" })])],
    ["non-tarball filename", JSON.stringify([validReport({ filename: "sandlot-0.1.0.zip" })])],
    ["zero size", JSON.stringify([validReport({ size: 0 })])],
    ["unbounded size", JSON.stringify([validReport({ size: 1024 * 1024 * 1024 + 1 })])],
    ["missing integrity", JSON.stringify([validReport({ integrity: undefined })])],
    ["wrong integrity algorithm", JSON.stringify([validReport({ integrity: "sha256-deadbeef" })])],
  ])("rejects a %s pack report", (_reason, raw, expected: unknown = { name: "sandlot", version: "0.1.0" }) => {
    // Weakening report validation could make the handoff name or checksum point outside the packed artifact.
    expect(() => parsePackReport(raw, expected)).toThrow();
  });

  it("hashes a regular file with lowercase SHA-256", async () => {
    // Changing the hashing algorithm or reading a different file would produce an unusable release checksum.
    const root = await mkdtemp(join(tmpdir(), "sandlot-artifact-hash-"));
    try {
      const file = join(root, "known.bin");
      await writeFile(file, "abc");
      await expect(sha256File(file)).resolves.toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a stable checksum and basename-only handoff after script-disabled packing", async () => {
    // Omitting --ignore-scripts or accepting a mismatched tarball would let package lifecycle code alter a release.
    const root = await mkdtemp(join(tmpdir(), "sandlot-artifact-output-"));
    const outDir = join(root, "out");
    await mkdir(outDir, { mode: 0o700 });
    const calls: Parameters<PackRunner>[] = [];
    const runner: PackRunner = async (request) => {
      calls.push([request]);
      await writeFile(join(outDir, TAR_NAME), TAR_BYTES);
      return { code: 0, stdout: JSON.stringify([validReport()]), stderr: "" };
    };
    try {
      const handoff = await buildReleaseArtifact({ root: ROOT, version: "0.1.0", outDir, runPack: runner });
      const digest = "e065982e8048c3ab5afda60b4fcddeb9c284e5615ce27e23388bc8aa6b5a04fa";
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toMatchObject({
        command: "npm",
        args: ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir],
        cwd: resolve(ROOT),
      });
      expect(calls[0]![0].env.npm_config_ignore_scripts).toBe("true");
      expect(await readFile(join(outDir, `${TAR_NAME}.sha256`), "utf8")).toBe(`${digest}  ${TAR_NAME}\n`);
      expect(JSON.parse(await readFile(join(outDir, "release-handoff.json"), "utf8"))).toEqual({
        version: "0.1.0",
        tag: "v0.1.0",
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        tarball: TAR_NAME,
        checksum: `${TAR_NAME}.sha256`,
        tarballBytes: TAR_BYTES.length,
        sha256: digest,
      });
      expect(handoff.tarball).toBe(TAR_NAME);
      expect(handoff.checksum).toBe(`${TAR_NAME}.sha256`);
      expect(basename(handoff.tarball)).toBe(handoff.tarball);
      expect(basename(handoff.checksum)).toBe(handoff.checksum);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the private npm workspace after packing", async () => {
    // Leaving the cache workspace behind would make release construction leak temporary state across runs.
    const root = await mkdtemp(join(tmpdir(), "sandlot-artifact-workspace-"));
    const outDir = join(root, "out");
    await mkdir(outDir, { mode: 0o700 });
    let workspace = "";
    const runner: PackRunner = async (request) => {
      workspace = dirname(request.env.npm_config_cache!);
      await mkdir(join(request.env.npm_config_cache!, "nested"), { recursive: true });
      await writeFile(join(request.env.npm_config_cache!, "nested", "state"), "temporary");
      await writeFile(join(outDir, TAR_NAME), TAR_BYTES);
      return { code: 0, stdout: JSON.stringify([validReport()]), stderr: "" };
    };
    try {
      await buildReleaseArtifact({ root: ROOT, version: "0.1.0", outDir, runPack: runner });
      await expect(lstat(workspace)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing tarball", async (outDir: string) => undefined],
    ["symlinked tarball", async (outDir: string) => symlink(join(outDir, "outside.tgz"), join(outDir, TAR_NAME))],
    ["size mismatch", async (outDir: string) => writeFile(join(outDir, TAR_NAME), Buffer.concat([TAR_BYTES, Buffer.from("x")]))],
    ["unexpected output", async (outDir: string) => Promise.all([writeFile(join(outDir, TAR_NAME), TAR_BYTES), writeFile(join(outDir, "unexpected.txt"), "x")])],
  ])("rejects %s from the pack runner and removes partial outputs", async (_reason, arrange) => {
    // Trusting a missing, linked, altered, or extra output would break the checksum-to-tarball guarantee.
    const root = await mkdtemp(join(tmpdir(), "sandlot-artifact-reject-"));
    const outDir = join(root, "out");
    await mkdir(outDir, { mode: 0o700 });
    const runner: PackRunner = async () => {
      await arrange(outDir);
      return { code: 0, stdout: JSON.stringify([validReport()]), stderr: "" };
    };
    try {
      await expect(buildReleaseArtifact({ root: ROOT, version: "0.1.0", outDir, runPack: runner })).rejects.toThrow();
      await expect(readFile(join(outDir, TAR_NAME))).rejects.toThrow();
      await expect(readFile(join(outDir, `${TAR_NAME}.sha256`))).rejects.toThrow();
      await expect(readFile(join(outDir, "release-handoff.json"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes unexpected nested directories without following internal or escaping symlinks", async () => {
    // Recursive cleanup that follows a pack-controlled symlink could delete files outside the private output directory.
    const root = await mkdtemp(join(tmpdir(), "sandlot-artifact-nested-reject-"));
    const outDir = join(root, "out");
    const outside = join(root, "outside");
    await Promise.all([mkdir(outDir, { mode: 0o700 }), mkdir(outside, { mode: 0o700 })]);
    await writeFile(join(outside, "must-survive"), "outside");
    const runner: PackRunner = async () => {
      const nested = join(outDir, "unexpected", "nested");
      await mkdir(nested, { recursive: true });
      await Promise.all([
        writeFile(join(outDir, TAR_NAME), TAR_BYTES),
        writeFile(join(nested, "partial"), "partial"),
        symlink("nested", join(outDir, "unexpected", "internal-link")),
        symlink(outside, join(outDir, "unexpected", "escape-link")),
      ]);
      return { code: 0, stdout: JSON.stringify([validReport()]), stderr: "" };
    };
    try {
      await expect(buildReleaseArtifact({ root: ROOT, version: "0.1.0", outDir, runPack: runner })).rejects.toThrow();
      expect(await readdir(outDir)).toEqual([]);
      await expect(readFile(join(outside, "must-survive"), "utf8")).resolves.toBe("outside");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("packs the built repository with its public documentation and entrypoints", async () => {
    // A builder that bypasses npm's real file selection could hand GitHub an incomplete package.
    const root = await mkdtemp(join(tmpdir(), "sandlot-artifact-real-"));
    const outDir = join(root, "out");
    await mkdir(outDir, { mode: 0o700 });
    try {
      const handoff = await buildReleaseArtifact({ root: ROOT, version: "0.2.0", outDir });
      const { stdout } = await exec("tar", ["-tzf", join(outDir, handoff.tarball)]);
      const entries = stdout.trim().split("\n");
      expect(entries).toEqual(expect.arrayContaining([
        "package/package.json",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/assets/sandlot-logo.png",
        "package/dist/index.js",
        "package/dist/helpers/file-worker.js",
        "package/dist/helpers/image-worker.js",
        "package/dist/helpers/search-worker.js",
      ]));
      const { stdout: manifest } = await exec("tar", ["-xOf", join(outDir, handoff.tarball), "package/package.json"]);
      expect(JSON.parse(manifest).version).toBe("0.2.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    name: "sandlot",
    version: "0.1.0",
    filename: TAR_NAME,
    size: TAR_BYTES.length,
    integrity: TAR_INTEGRITY,
    ...overrides,
  };
}
