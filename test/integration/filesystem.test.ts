import { access, lstat, readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { expectFileWorkerDenial } from "./assertions.js";
import { createSecurityHarness, type SecurityHarness } from "./harness.js";
import { describeIntegration } from "./preflight.js";

describeIntegration("real Sandbox Runtime filesystem enforcement", () => {
  let harness: SecurityHarness | undefined;

  beforeEach(async () => { harness = await createSecurityHarness(); });
  afterEach(async () => { await harness?.dispose(); });

  it("allows worker reads and writes only inside the isolated workspace", async () => {
    expect(await harness!.read(harness!.paths.workspaceFile)).toBe("workspace-readable");

    const created = `${harness!.workspace}/created-by-worker.txt`;
    await harness!.write(created, "workspace-write");

    expect(await readFile(created, "utf8")).toBe("workspace-write");
  });

  it("denies real worker reads of fake home and Pi credentials", async () => {
    await expectFileWorkerDenial(harness!.read(harness!.paths.homeCredential), harness!.paths.homeCredential, "read");
    await expectFileWorkerDenial(harness!.read(harness!.paths.homePiCredential), harness!.paths.homePiCredential, "read");
    expect(await readFile(harness!.paths.homeCredential, "utf8")).toBe("fake-home-private-key");
    expect(await readFile(harness!.paths.homePiCredential, "utf8")).toBe("fake-pi-token");
  });

  it("denies outside, .pi, Git hook/config, and environment-file writes", async () => {
    const protectedFiles = [
      [harness!.paths.outsideFile, "outside-secret"],
      [harness!.paths.projectPiFile, "pi-policy"],
      [harness!.paths.gitHook, "protected-hook"],
      [harness!.paths.gitConfig, "protected-config"],
      [harness!.paths.environmentFile, "protected-env"],
    ] as const;

    for (const [path, original] of protectedFiles) {
      await expectFileWorkerDenial(harness!.write(path, "overwritten"), path, "write");
      expect(await readFile(path, "utf8")).toBe(original);
    }
  });

  it("denies OS-level write and rename attacks on immutable helper, executable, and package roots", async () => {
    const targets = [harness!.paths.immutableHelper, harness!.paths.immutableExecutable];
    for (const target of targets) {
      const overwrite = await harness!.run(`printf hacked > ${quote(target)}`);
      expect(overwrite.exitCode).not.toBe(0);
      const rename = await harness!.run(`mv ${quote(target)} ${quote(`${target}.moved`)}`);
      expect(rename.exitCode).not.toBe(0);
      await expect(access(target)).resolves.toBeUndefined();
      await expect(access(`${target}.moved`)).rejects.toThrow();
    }

    const packageWrite = `${harness!.paths.immutablePackageRoot}/injected.js`;
    const createInPackage = await harness!.run(`printf hacked > ${quote(packageWrite)}`);
    expect(createInPackage.exitCode).not.toBe(0);
    await expect(access(packageWrite)).rejects.toThrow();

    const packageRename = await harness!.run(
      `mv ${quote(harness!.paths.immutablePackageRoot)} ${quote(`${harness!.paths.immutablePackageRoot}.moved`)}`,
    );
    expect(packageRename.exitCode).not.toBe(0);
    await expect(access(harness!.paths.immutablePackageRoot)).resolves.toBeUndefined();
    await expect(access(`${harness!.paths.immutablePackageRoot}.moved`)).rejects.toThrow();
  });

  it("rejects a writable trusted package topology before it can become ready", async () => {
    const probe = await harness!.probeUnsafeTrustTopology();

    expect(probe).toMatchObject({ state: "failed", managerInitialized: false });
    expect(probe.error).toMatch(/trusted host code.*immutable|writable.*trusted|allowWrite/i);
  });

  it("uses the macOS mktemp shim for implicit forms without granting arbitrary private tmp writes", async () => {
    const privateTmpSibling = "/private/tmp/sandlot-temp-runtime-denied";
    const harness = await createSecurityHarness({ useProductionBoundary: true });
    let sessionDirectory = "";
    try {
      const created = await harness.run("umask 022 && nested=\"$TMPDIR/routine-nested\" && mkdir \"$nested\" && printf 'literal-nested-content' > \"$nested/content.txt\" && bare=$(mktemp) && made_dir=$(mktemp -d) && prefixed=$(mktemp -t sandlot) && explicit=$(mktemp \"$TMPDIR/tmp.XXXXXXXX\") && printf '%s|%s|%s|%s|%s|%s|%s|%s' \"$TMPDIR\" \"$TMP\" \"$TEMP\" \"$bare\" \"$made_dir\" \"$prefixed\" \"$explicit\" \"$nested/content.txt\"");

      expect(created.exitCode, `stdout=${created.stdout}\nstderr=${created.stderr}`).toBe(0);
      expect(created.stdout).toMatch(/^\/tmp\/sandlot\/\d+\/session-[^/]+\|\/tmp\/sandlot\/\d+\/session-[^/]+\|\/tmp\/sandlot\/\d+\/session-[^/]+\|\/tmp\/sandlot\/\d+\/session-[^/]+\/sandlot-mktemp\.[^/]+\|\/tmp\/sandlot\/\d+\/session-[^/]+\/sandlot-mktemp\.[^/]+\|\/tmp\/sandlot\/\d+\/session-[^/]+\/sandlot\.[^/]+\|\/tmp\/sandlot\/\d+\/session-[^/]+\/tmp\.[^/]+\|\/tmp\/sandlot\/\d+\/session-[^/]+\/routine-nested\/content\.txt$/);
      const [tmpdir, tmp, temp, _bareFile, madeDirectory, _prefixedFile, _explicitFile, nestedFile] = created.stdout.split("|");
      sessionDirectory = tmpdir!;
      expect([tmpdir, tmp, temp]).toEqual([sessionDirectory, sessionDirectory, sessionDirectory]);
      expect((await lstat(madeDirectory!)).isDirectory()).toBe(true);
      expect(await readFile(nestedFile!, "utf8")).toBe("literal-nested-content");

      const denied = await harness.run(`printf blocked > ${quote(privateTmpSibling)}`);
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stderr).toContain("Blocked by Sandlot:");
      expect(denied.stderr).not.toContain("<sandbox_violations>");
      await expect(access(privateTmpSibling)).rejects.toThrow();
    } finally {
      await harness.dispose();
    }
    await expect(access(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describeIntegration("real control-plane alias and future-path enforcement", () => {
  it("denies unlink and recreation of a lexical .pi symlink alias", async () => {
    const harness = await createSecurityHarness({ symlinkProjectControlPlane: true });
    try {
      expect((await lstat(`${harness.workspace}/.pi`)).isSymbolicLink()).toBe(true);

      const attack = await harness.run(
        `rm -rf ${quote(`${harness.workspace}/.pi`)} && mkdir ${quote(`${harness.workspace}/.pi`)}`,
      );

      expect(attack.exitCode).not.toBe(0);
      expect((await lstat(`${harness.workspace}/.pi`)).isSymbolicLink()).toBe(true);
      expect(await readFile(harness.paths.projectPiFile, "utf8")).toBe("pi-policy");
    } finally {
      await harness.dispose();
    }
  });

  it("denies mandatory control files created only after the runtime wrapped", async () => {
    const harness = await createSecurityHarness({ useProductionBoundary: true });
    const futureControlFile = `${harness.workspace}/.bashrc`;
    try {
      await expect(access(futureControlFile)).rejects.toMatchObject({ code: "ENOENT" });

      const attack = await harness.run(`printf injected > ${quote(futureControlFile)}`);

      expect(attack.exitCode).not.toBe(0);
      await expect(access(futureControlFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await harness.dispose();
    }
  });
});

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
