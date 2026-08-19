import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSandlotSessionTemporaryDirectory,
  type SandlotSessionTemporaryDirectory,
  type SandlotSessionTemporaryDirectoryCreationResult,
  type SandlotTemporaryDirectoryFileSystem,
  type SandlotTemporaryDirectoryStatus,
} from "../../src/session-temporary-directory.js";

describe("Sandlot session temporary directory", () => {
  it("creates an exact current-uid-owned private root, uid directory, and session", async () => {
    const result = await createSandlotSessionTemporaryDirectory();
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const temporary = result.directory;
    try {
      const userDirectory = dirname(temporary.path);
      const root = dirname(userDirectory);

      expect(temporary.path).toMatch(/^\/tmp\/sandlot\/\d+\/session-[^/]+$/);
      expect((await lstat(root)).mode & 0o7777).toBe(0o700);
      expect((await lstat(userDirectory)).mode & 0o7777).toBe(0o700);
      expect((await lstat(temporary.path)).mode & 0o7777).toBe(0o700);
    } finally {
      await temporary.cleanup();
    }
    await expect(access(temporary.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns aggregate creation and rollback errors with retained cleanup authority", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sandlot-temp-rollback-"));
    const root = join(parent, "sandlot");
    const uid = process.getuid!();
    const user = join(root, String(uid));
    const session = join(user, "session-partial");
    let corruptSessionMode = true;
    let failUserRemoval = true;
    const filesystem = {
      mkdir: async (path: string, mode: number) => { await mkdir(path, { mode }); },
      chmod,
      lstat: async (path: string) => {
        const status = await lstat(path);
        if (path === session && corruptSessionMode) {
          corruptSessionMode = false;
          return new Proxy(status, {
            get(target, property) {
              if (property === "mode") return (target.mode & ~0o7777) | 0o755;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }
        return status;
      },
      readdir: async (path: string) => readdir(path, { withFileTypes: true }),
      rmdir: async (path: string) => {
        if (path === user && failUserRemoval) {
          failUserRemoval = false;
          throw new Error("deterministic uid rollback failure");
        }
        await rmdir(path);
      },
      unlink,
    };

    try {
      const result = await createSandlotSessionTemporaryDirectory({
        root,
        uid,
        sessionId: "partial",
        filesystem,
      });

      expect(result).toMatchObject({ ok: false });
      if (!("ok" in result) || result.ok) throw new Error("expected failed creation result");
      expect(result.error).toBeInstanceOf(AggregateError);
      expect((result.error as AggregateError).errors.map(String)).toEqual([
        "Error: Sandlot temporary session directory has unsafe permissions",
        "Error: deterministic uid rollback failure",
      ]);
      expect(result.cleanupAuthority).toBeDefined();
      await expect(access(session)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(user)).resolves.toBeUndefined();
      await expect(access(root)).resolves.toBeUndefined();

      await result.cleanupAuthority!.cleanup();

      await expect(access(user)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("creates exact 0700 directories despite umask and injected special permission bits", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sandlot-temp-mode-"));
    const root = join(parent, "sandlot");
    const uid = process.getuid!();
    const previousUmask = process.umask(0o077);
    const filesystem = realFilesystem({
      mkdir: async (path, mode) => {
        await mkdir(path, { mode });
        await chmod(path, 0o1700);
      },
    });
    let temporary: SandlotSessionTemporaryDirectory | undefined;
    try {
      temporary = await requireCreated(createSandlotSessionTemporaryDirectory({
        root,
        uid,
        sessionId: "mode",
        filesystem,
      }));
      expect((await lstat(root)).mode & 0o7777).toBe(0o700);
      expect((await lstat(join(root, String(uid)))).mode & 0o7777).toBe(0o700);
      expect((await lstat(temporary.path)).mode & 0o7777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
      await temporary?.cleanup();
      await rm(parent, { recursive: true, force: true });
    }
  });

  for (const level of ["root", "uid", "session"] as const) {
    it(`rejects a non-directory at the ${level} boundary without deleting it`, async () => {
      const fixture = await hierarchyFixture(`non-directory-${level}`);
      try {
        await createHierarchyTo(fixture, level);
        const target = fixture[level];
        await writeFile(target, `literal-${level}-file`, { mode: 0o600 });

        const result = await createSandlotSessionTemporaryDirectory(fixture.options);

        expect(failureMessage(result)).toBe(`Sandlot temporary ${levelLabel(level)} is not a directory`);
        expect(await readFile(target, "utf8")).toBe(`literal-${level}-file`);
      } finally {
        await rm(fixture.parent, { recursive: true, force: true });
      }
    });

    it(`rejects a symbolic link at the ${level} boundary without traversing it`, async () => {
      const fixture = await hierarchyFixture(`symlink-${level}`);
      const target = join(fixture.parent, `${level}-target`);
      try {
        await createHierarchyTo(fixture, level);
        await mkdir(target, { mode: 0o700 });
        await writeFile(join(target, "sentinel"), `literal-${level}-target`, { mode: 0o600 });
        await symlink(target, fixture[level]);

        const result = await createSandlotSessionTemporaryDirectory(fixture.options);

        expect(failureMessage(result)).toBe(`Sandlot temporary ${levelLabel(level)} is a symbolic link`);
        expect(await readFile(join(target, "sentinel"), "utf8")).toBe(`literal-${level}-target`);
        expect((await lstat(fixture[level])).isSymbolicLink()).toBe(true);
      } finally {
        await rm(fixture.parent, { recursive: true, force: true });
      }
    });

    it(`rejects wrong ownership at the ${level} boundary through the lstat ownership seam`, async () => {
      const fixture = await hierarchyFixture(`ownership-${level}`);
      try {
        await createHierarchyTo(fixture, nextLevel(level));
        const filesystem = realFilesystem({
          lstat: async (path) => statusWith(
            await lstat(path),
            path === fixture[level] ? { uid: fixture.numericUid + 1 } : {},
          ),
        });

        const result = await createSandlotSessionTemporaryDirectory({ ...fixture.options, filesystem });

        expect(failureMessage(result)).toBe(`Sandlot temporary ${levelLabel(level)} has wrong ownership`);
        await expect(access(fixture[level])).resolves.toBeUndefined();
      } finally {
        await rm(fixture.parent, { recursive: true, force: true });
      }
    });

    it(`rejects non-exact permissions at the ${level} boundary without changing them`, async () => {
      const fixture = await hierarchyFixture(`permissions-${level}`);
      try {
        await createHierarchyTo(fixture, nextLevel(level));
        await chmod(fixture[level], level === "session" ? 0o1700 : 0o750);
        const literalMode = level === "session" ? 0o1700 : 0o750;

        const result = await createSandlotSessionTemporaryDirectory(fixture.options);

        expect(failureMessage(result)).toBe(`Sandlot temporary ${levelLabel(level)} has unsafe permissions`);
        expect((await lstat(fixture[level])).mode & 0o7777).toBe(literalMode);
      } finally {
        await rm(fixture.parent, { recursive: true, force: true });
      }
    });
  }

  it("unlinks a session-child symlink without traversing its target", async () => {
    const fixture = await hierarchyFixture("cleanup-symlink");
    const target = join(fixture.parent, "outside-target");
    try {
      const temporary = await requireCreated(createSandlotSessionTemporaryDirectory(fixture.options));
      await mkdir(target, { mode: 0o700 });
      await writeFile(join(target, "sentinel"), "literal-outside-data", { mode: 0o600 });
      await symlink(target, join(temporary.path, "outside-link"));

      await temporary.cleanup();

      await expect(access(temporary.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(target, "sentinel"), "utf8")).toBe("literal-outside-data");
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it("cleans current-uid nested directories created with routine default permissions", async () => {
    const fixture = await hierarchyFixture("cleanup-default-nested-mode");
    const previousUmask = process.umask(0o022);
    try {
      const temporary = await requireCreated(createSandlotSessionTemporaryDirectory(fixture.options));
      const nested = join(temporary.path, "routine-nested");
      const deeper = join(nested, "deeper");
      await mkdir(nested);
      await mkdir(deeper);
      await writeFile(join(deeper, "content.txt"), "literal-routine-content");

      expect((await lstat(temporary.path)).mode & 0o7777).toBe(0o700);
      expect((await lstat(nested)).mode & 0o7777).toBe(0o755);
      expect((await lstat(deeper)).mode & 0o7777).toBe(0o755);

      await temporary.cleanup();

      await expect(access(temporary.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.umask(previousUmask);
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it("refuses a routine-mode nested directory reported as owned by another uid", async () => {
    const fixture = await hierarchyFixture("cleanup-nested-wrong-owner");
    const nested = join(fixture.session, "routine-nested");
    const filesystem = realFilesystem({
      lstat: async (path) => statusWith(
        await lstat(path),
        path === nested ? { uid: fixture.numericUid + 1 } : {},
      ),
    });
    try {
      const temporary = await requireCreated(createSandlotSessionTemporaryDirectory({
        ...fixture.options,
        filesystem,
      }));
      await mkdir(nested, { mode: 0o755 });
      await writeFile(join(nested, "sentinel"), "literal-untrusted-owner");

      await expect(temporary.cleanup()).rejects.toThrow(
        `Sandlot temporary session child is unsafe: ${nested}`,
      );

      expect(await readFile(join(nested, "sentinel"), "utf8")).toBe("literal-untrusted-owner");
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it("verifies a nested directory's stable identity before traversing it", async () => {
    const fixture = await hierarchyFixture("cleanup-nested-identity");
    const nested = join(fixture.session, "routine-nested");
    let nestedStatusReads = 0;
    const filesystem = realFilesystem({
      lstat: async (path) => {
        const status = await lstat(path);
        if (path !== nested || ++nestedStatusReads === 1) return status;
        return statusWith(status, { ino: status.ino + 1 });
      },
    });
    try {
      const temporary = await requireCreated(createSandlotSessionTemporaryDirectory({
        ...fixture.options,
        filesystem,
      }));
      await mkdir(nested, { mode: 0o755 });
      await writeFile(join(nested, "sentinel"), "literal-recorded-child");

      await expect(temporary.cleanup()).rejects.toThrow(
        `Sandlot temporary session child identity changed; refusing cleanup: ${nested}`,
      );

      expect(await readFile(join(nested, "sentinel"), "utf8")).toBe("literal-recorded-child");
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it("refuses a replacement session identity and safely retries the recorded identity", async () => {
    const fixture = await hierarchyFixture("identity-replacement");
    const saved = `${fixture.session}-recorded`;
    try {
      const temporary = await requireCreated(createSandlotSessionTemporaryDirectory(fixture.options));
      await writeFile(join(temporary.path, "recorded"), "literal-recorded-data", { mode: 0o600 });
      await rename(temporary.path, saved);
      await mkdir(temporary.path, { mode: 0o700 });
      await writeFile(join(temporary.path, "replacement"), "literal-replacement-data", { mode: 0o600 });

      await expect(temporary.cleanup()).rejects.toThrow(
        "Sandlot temporary session directory identity changed; refusing cleanup",
      );
      expect(await readFile(join(temporary.path, "replacement"), "utf8")).toBe("literal-replacement-data");
      expect(await readFile(join(saved, "recorded"), "utf8")).toBe("literal-recorded-data");

      await rm(temporary.path, { recursive: true });
      await rename(saved, temporary.path);
      await temporary.cleanup();
      await expect(access(temporary.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it("retains partial rollback identities across a replacement refusal and later retry", async () => {
    const fixture = await partialRollbackFailureFixture();
    const savedUser = `${fixture.user}-recorded`;
    try {
      expect(fixture.result.ok).toBe(false);
      if (fixture.result.ok || fixture.result.cleanupAuthority === undefined) {
        throw new Error("expected retained partial rollback authority");
      }
      await rename(fixture.user, savedUser);
      await mkdir(fixture.user, { mode: 0o700 });
      await writeFile(join(fixture.user, "replacement"), "literal-replacement-data", { mode: 0o600 });

      await expect(fixture.result.cleanupAuthority.cleanup()).rejects.toThrow(
        "Sandlot temporary uid directory identity changed; refusing cleanup",
      );
      expect(await readFile(join(fixture.user, "replacement"), "utf8")).toBe("literal-replacement-data");

      await rm(fixture.user, { recursive: true });
      await rename(savedUser, fixture.user);
      await fixture.result.cleanupAuthority.cleanup();
      await expect(access(fixture.user)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });
});

type HierarchyLevel = "root" | "uid" | "session";

interface HierarchyFixture {
  readonly parent: string;
  readonly root: string;
  readonly uid: string;
  readonly session: string;
  readonly numericUid: number;
  readonly options: { readonly root: string; readonly uid: number; readonly sessionId: string };
}

async function hierarchyFixture(name: string): Promise<HierarchyFixture> {
  const parent = await mkdtemp(join(tmpdir(), `sandlot-temp-${name}-`));
  const root = join(parent, "sandlot");
  const numericUid = process.getuid!();
  const uid = join(root, String(numericUid));
  const session = join(uid, "session-literal");
  return {
    parent,
    root,
    uid,
    session,
    numericUid,
    options: { root, uid: numericUid, sessionId: "literal" },
  };
}

async function createHierarchyTo(fixture: HierarchyFixture, level: HierarchyLevel | "after-session"): Promise<void> {
  if (level === "root") return;
  await mkdir(fixture.root, { mode: 0o700 });
  if (level === "uid") return;
  await mkdir(fixture.uid, { mode: 0o700 });
  if (level === "session") return;
  await mkdir(fixture.session, { mode: 0o700 });
}

function nextLevel(level: HierarchyLevel): HierarchyLevel | "after-session" {
  if (level === "root") return "uid";
  if (level === "uid") return "session";
  return "after-session";
}

function levelLabel(level: HierarchyLevel): string {
  if (level === "root") return "root";
  if (level === "uid") return "uid directory";
  return "session directory";
}

function failureMessage(result: SandlotSessionTemporaryDirectoryCreationResult): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failed temporary-directory creation");
  return result.error.message;
}

async function requireCreated(
  resultPromise: Promise<SandlotSessionTemporaryDirectoryCreationResult>,
): Promise<SandlotSessionTemporaryDirectory> {
  const result = await resultPromise;
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.directory;
}

function realFilesystem(
  overrides: Partial<SandlotTemporaryDirectoryFileSystem> = {},
): SandlotTemporaryDirectoryFileSystem {
  return {
    mkdir: async (path, mode) => { await mkdir(path, { mode }); },
    chmod,
    lstat,
    readdir: async (path) => readdir(path, { withFileTypes: true }),
    rmdir,
    unlink,
    ...overrides,
  };
}

function statusWith(
  status: SandlotTemporaryDirectoryStatus,
  overrides: Partial<Pick<SandlotTemporaryDirectoryStatus, "uid" | "mode" | "ino">>,
): SandlotTemporaryDirectoryStatus {
  return new Proxy(status, {
    get(target, property) {
      if (property === "uid" && overrides.uid !== undefined) return overrides.uid;
      if (property === "mode" && overrides.mode !== undefined) return overrides.mode;
      if (property === "ino" && overrides.ino !== undefined) return overrides.ino;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function partialRollbackFailureFixture(): Promise<{
  readonly parent: string;
  readonly root: string;
  readonly user: string;
  readonly result: SandlotSessionTemporaryDirectoryCreationResult;
}> {
  const parent = await mkdtemp(join(tmpdir(), "sandlot-temp-partial-retry-"));
  const root = join(parent, "sandlot");
  const uid = process.getuid!();
  const user = join(root, String(uid));
  const session = join(user, "session-partial-retry");
  let corruptSessionMode = true;
  let failUserRemoval = true;
  const filesystem = realFilesystem({
    lstat: async (path) => {
      const status = await lstat(path);
      if (path === session && corruptSessionMode) {
        corruptSessionMode = false;
        return statusWith(status, { mode: 0o755 });
      }
      return status;
    },
    rmdir: async (path) => {
      if (path === user && failUserRemoval) {
        failUserRemoval = false;
        throw new Error("deterministic retained rollback failure");
      }
      await rmdir(path);
    },
  });
  const result = await createSandlotSessionTemporaryDirectory({
    root,
    uid,
    sessionId: "partial-retry",
    filesystem,
  });
  return { parent, root, user, result };
}
