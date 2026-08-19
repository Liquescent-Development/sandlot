import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizePolicyPath, isPathContained } from "../../src/paths.js";

describe("policy paths", () => {
  it("uses path-component boundaries", () => {
    expect(isPathContained("/work/app", "/work/app/src")).toBe(true);
    expect(isPathContained("/work/app", "/work/application")).toBe(false);
  });

  it("resolves existing symlinks and relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-paths-"));
    const target = join(root, "target");
    await mkdir(target);
    await symlink(target, join(root, "link"));

    await expect(canonicalizePolicyPath("link", root)).resolves.toBe(await realpath(target));
  });

  it("canonicalizes a nonexistent target below its resolved ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-paths-"));
    const parent = join(root, "parent");
    await mkdir(parent);

    await expect(canonicalizePolicyPath("parent/new/file.txt", root))
      .resolves.toBe(join(await realpath(parent), "new", "file.txt"));
  });

  it("normalizes traversal in a nonexistent suffix that stays under the resolved ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-paths-"));
    const parent = join(root, "parent");
    await mkdir(parent);

    await expect(canonicalizePolicyPath("parent/missing/../child", root))
      .resolves.toBe(join(await realpath(parent), "child"));
  });

  it("rejects a nonexistent suffix that escapes through an intermediate symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-paths-"));
    const target = join(root, "target", "nested");
    await mkdir(target, { recursive: true });
    await symlink(target, join(root, "link"));

    await expect(canonicalizePolicyPath("link/missing/../../escape", root))
      .rejects.toThrow(/escapes its resolved ancestor/);
  });

  it("rejects broken symlinks instead of treating them as future paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandlot-paths-"));
    await symlink(join(root, "missing-target"), join(root, "broken"));

    await expect(canonicalizePolicyPath("broken", root)).rejects.toThrow(/broken symlink/);
  });
});
