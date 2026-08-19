import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const shim = new URL("../../bin/mktemp", import.meta.url);
const describeDarwin = process.platform === "darwin" ? describe : describe.skip;

describeDarwin("macOS mktemp shim argv contract", () => {
  const directories: string[] = [];

  afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  it("rewrites combined and long implicit -p/-t forms under the confined TMPDIR", async () => {
    const temporary = await temporaryDirectory();
    const result = await runShim(["--directory", `--tmpdir=${temporary}`, "-t", "long-prefix"] , temporary);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(new RegExp(`^${escapeRegex(temporary)}/long-prefix\\.`));
    expect((await stat(result.stdout.trim())).isDirectory()).toBe(true);
  });

  it("keeps explicit templates while rewriting the additional -t product under TMPDIR", async () => {
    const temporary = await temporaryDirectory();
    const args = ["-p", temporary, "-t", "explicit-prefix", `${temporary}/one.XXXXXXXX`, `${temporary}/two.XXXXXXXX`];
    const shimResult = await runShim(args, temporary);

    expect(shimResult.code).toBe(0);
    expect(shimResult.stdout.trim().split("\n")).toHaveLength(3);
    for (const path of shimResult.stdout.trim().split("\n")) expect(path.startsWith(`${temporary}/`)).toBe(true);
  });

  it("characterizes native --dry-run and keeps its implicit product confined", async () => {
    const temporary = await temporaryDirectory();
    const [shimResult, nativeResult] = await Promise.all([
      runShim(["--dry-run"], temporary),
      runNative(["--dry-run"], temporary),
    ]);

    expect(nativeResult.code).toBe(0);
    expect(shimResult.code).toBe(0);
    expect(shimResult.stdout.trim()).toMatch(new RegExp(`^${escapeRegex(temporary)}/sandlot-mktemp\\.`));
    await expect(stat(shimResult.stdout.trim())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("matches native empty -t result count while keeping the product confined", async () => {
    const temporary = await temporaryDirectory();
    const [shimResult, nativeResult] = await Promise.all([
      runShim(["--dry-run", "-d", "-t", ""], temporary),
      runNative(["--dry-run", "-d", "-t", ""], temporary),
    ]);

    expect(shimResult.code).toBe(nativeResult.code);
    expect(nativeResult.code).toBe(0);
    expect(shimResult.stdout.trim().split("\n")).toHaveLength(1);
    expect(nativeResult.stdout.trim().split("\n")).toHaveLength(1);
    expect(shimResult.stdout.trim()).toMatch(new RegExp(`^${escapeRegex(temporary)}/\\.`));
  });

  it("matches native --tmpdir= result count while keeping the product confined", async () => {
    const temporary = await temporaryDirectory();
    const [shimResult, nativeResult] = await Promise.all([
      runShim(["--dry-run", "--tmpdir="], temporary),
      runNative(["--dry-run", "--tmpdir="], temporary),
    ]);

    expect(shimResult.code).toBe(nativeResult.code);
    expect(nativeResult.code).toBe(0);
    expect(shimResult.stdout.trim().split("\n")).toHaveLength(1);
    expect(nativeResult.stdout.trim().split("\n")).toHaveLength(1);
    expect(shimResult.stdout.trim()).toMatch(new RegExp(`^${escapeRegex(temporary)}/tmp\\.`));
  });

  it("matches native success for bare --tmpdir with an implicit dry-run -t product", async () => {
    const temporary = await temporaryDirectory();
    const [shimTmpdir, nativeTmpdir] = await Promise.all([
      runShim(["--dry-run", "--tmpdir", "-t", "bare-tmpdir"], temporary),
      runNative(["--dry-run", "--tmpdir", "-t", "bare-tmpdir"], temporary),
    ]);

    expect(shimTmpdir.code).toBe(nativeTmpdir.code);
    expect(nativeTmpdir.code).toBe(0);
    expect(shimTmpdir.stderr).toBe(nativeTmpdir.stderr);
    expect(shimTmpdir.stdout.trim()).toMatch(new RegExp(`^${escapeRegex(temporary)}/bare-tmpdir\\.`));
  });

  it("rejects nonexistent --unsafe", async () => {
    const temporary = await temporaryDirectory();
    const unsafe = await runShim(["--unsafe"], temporary);

    expect(unsafe.code).toBe(64);
    expect(unsafe.stderr).toMatch(/unsupported option --unsafe/i);
  });

  it.each([
    [["-t", "../escape"], /prefix/i],
    [["--tmpdir=/private/tmp"], /confined TMPDIR/i],
  ])("rejects malformed or unsafe constructed input %j", async (args, message) => {
    const temporary = await temporaryDirectory();
    const result = await runShim(args, temporary);

    expect(result.code).toBe(64);
    expect(result.stderr).toMatch(message);
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "sandlot-mktemp-shim-"));
    directories.push(directory);
    return directory;
  }
});

async function runShim(args: string[], temporary: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(new URL(shim).pathname, args, temporary);
}

async function runNative(args: string[], temporary: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("/usr/bin/mktemp", args, temporary);
}

async function run(command: string, args: string[], temporary: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, { env: { PATH: "/usr/bin:/bin", TMPDIR: temporary, TMP: temporary, TEMP: temporary } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
