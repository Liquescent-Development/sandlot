import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const workerPath = resolve("dist/helpers/file-worker.js");
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "sandlot-worker-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file worker process", () => {
  it("round-trips arbitrary file bytes as base64", async () => {
    const path = join(directory, "bytes.bin");
    await writeFile(path, Buffer.from([0, 255, 1, 128]));

    const result = await runWorker({ version: 1, operation: "read", path });

    expect(result).toEqual({ version: 1, ok: true, value: { encoding: "base64", data: "AP8BgA==" } });
  });

  it("creates write parents only when requested", async () => {
    const withoutParents = join(directory, "missing", "without.txt");
    const denied = await runWorker({
      version: 1,
      operation: "write",
      path: withoutParents,
      content: "no",
      createParents: false,
    });
    expect(denied).toMatchObject({ version: 1, ok: false, error: { code: "ENOENT" } });

    const withParents = join(directory, "created", "with.txt");
    expect(await runWorker({
      version: 1,
      operation: "write",
      path: withParents,
      content: "hello",
      createParents: true,
    })).toEqual({ version: 1, ok: true, value: null });
    await expect(readFile(withParents, "utf8")).resolves.toBe("hello");
  });

  it("returns filesystem access errors as structured responses", async () => {
    const result = await runWorker({ version: 1, operation: "access", path: join(directory, "absent"), mode: "read" });
    expect(result).toMatchObject({ version: 1, ok: false, error: { code: "ENOENT", message: expect.any(String) } });
  });

  it("serializes file, directory, and other stat kinds", async () => {
    const file = join(directory, "status.txt");
    await writeFile(file, "ok");

    expect(await runWorker({ version: 1, operation: "stat", path: file }))
      .toEqual({ version: 1, ok: true, value: { kind: "file" } });
    expect(await runWorker({ version: 1, operation: "stat", path: directory }))
      .toEqual({ version: 1, ok: true, value: { kind: "directory" } });
    expect(await runWorker({ version: 1, operation: "stat", path: "/dev/null" }))
      .toEqual({ version: 1, ok: true, value: { kind: "other" } });
  });

  it("returns directory entry names as plain strings", async () => {
    const entries = join(directory, "entries");
    await runWorker({ version: 1, operation: "mkdir", path: entries, recursive: false });
    await writeFile(join(entries, "a.txt"), "a");
    await writeFile(join(entries, ".hidden"), "h");

    const result = await runWorker({ version: 1, operation: "readdir", path: entries });
    expect(result).toEqual({ version: 1, ok: true, value: expect.arrayContaining(["a.txt", ".hidden"]) });
    expect((result as { value: unknown[] }).value.every((entry) => typeof entry === "string")).toBe(true);
  });

  it.each([
    ["PNG", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WQAAAABJRU5ErkJggg==", "base64"), "image/png"],
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["GIF", Buffer.from("GIF89a", "ascii"), "image/gif"],
    ["WebP", Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii")]), "image/webp"],
    ["BMP", validBmp(), "image/bmp"],
  ])("detects %s MIME using magic bytes", async (name, bytes, mime) => {
    const path = join(directory, `${name}.wrong-extension`);
    await writeFile(path, bytes);
    expect(await runWorker({ version: 1, operation: "mime", path }))
      .toEqual({ version: 1, ok: true, value: mime });
  });

  it("returns null for unsupported file magic", async () => {
    const path = join(directory, "plain.png");
    await writeFile(path, "not really png");
    expect(await runWorker({ version: 1, operation: "mime", path }))
      .toEqual({ version: 1, ok: true, value: null });
  });

  it.each([
    ["JPEG XL", Buffer.from([0xff, 0xd8, 0xff, 0xf7])],
    ["truncated PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ])("matches Pi by rejecting %s image magic", async (name, bytes) => {
    const path = join(directory, `${name}.bin`);
    await writeFile(path, bytes);
    expect(await runWorker({ version: 1, operation: "mime", path }))
      .toEqual({ version: 1, ok: true, value: null });
  });

  it("returns MIME and bytes from one atomic image read", async () => {
    const path = join(directory, "atomic.bmp");
    const bytes = validBmp();
    await writeFile(path, bytes);

    expect(await runWorker({ version: 1, operation: "readImage", path })).toEqual({
      version: 1,
      ok: true,
      value: { encoding: "base64", data: bytes.toString("base64"), mimeType: "image/bmp" },
    });
  });

  it("accepts exactly 8 MiB and rejects the next byte before unbounded allocation", async () => {
    const exact = join(directory, "exact.bin");
    const oversized = join(directory, "oversized.bin");
    await Promise.all([
      writeFile(exact, Buffer.alloc(8 * 1024 * 1024, 0x61)),
      writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1, 0x62)),
    ]);

    const accepted = await runWorker({ version: 1, operation: "read", path: exact });
    expect(Buffer.from((accepted as { value: { data: string } }).value.data, "base64")).toHaveLength(8 * 1024 * 1024);
    expect(await runWorker({ version: 1, operation: "read", path: oversized })).toMatchObject({
      version: 1,
      ok: false,
      error: { code: "EFBIG", message: expect.stringMatching(/8\d*-byte read limit|8388608-byte/i) },
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["unsupported version", '{"version":2,"operation":"read","path":"/tmp/a"}'],
    ["unknown operation", '{"version":1,"operation":"remove","path":"/tmp/a"}'],
    ["unknown field", '{"version":1,"operation":"read","path":"/tmp/a","extra":true}'],
  ])("exits nonzero with exactly one structured response for %s", async (_case, stdin) => {
    const result = await runRaw(stdin);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      ok: false,
      error: { code: "PROTOCOL_ERROR", message: expect.any(String) },
    });
    expect(() => JSON.parse(result.stdout.slice(JSON.stringify(JSON.parse(result.stdout)).length))).toThrow();
  });

  it("rejects stdin above 8 MiB", async () => {
    const result = await runRaw(" ".repeat(8 * 1024 * 1024 + 1));
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      ok: false,
      error: { code: "PROTOCOL_ERROR", message: expect.stringMatching(/request.*limit/i) },
    });
  });
});

async function runWorker(request: unknown): Promise<unknown> {
  const result = await runRaw(JSON.stringify(request));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function validBmp(): Buffer {
  const bmp = Buffer.alloc(54);
  bmp.write("BM", 0, "ascii");
  bmp.writeUInt32LE(100, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  return bmp;
}

async function runRaw(stdin: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveResult({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(stdin);
  });
}
