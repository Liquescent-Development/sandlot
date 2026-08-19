import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_WORKER_REQUEST_BYTES,
  MAX_WORKER_RESPONSE_BYTES,
  decodeResponse,
  encodeRequest,
} from "../../src/helpers/protocol.js";
import {
  FileWorkerClient,
  detectSupportedImageMimeType,
  resolveFileWorkerPaths,
} from "../../src/helpers/file-worker.js";
import type { RunRequest, RunResult } from "../../src/runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("worker protocol", () => {
  it("encodes a versioned request as one JSON document", () => {
    expect(encodeRequest({ version: 1, operation: "read", path: "/repo/a b'c" }))
      .toBe('{"version":1,"operation":"read","path":"/repo/a b\'c"}');
  });

  it("accepts the atomic image read operation", () => {
    expect(encodeRequest({ version: 1, operation: "readImage", path: "/repo/image" }))
      .toBe('{"version":1,"operation":"readImage","path":"/repo/image"}');
  });

  it("rejects unknown and malformed request fields before execution", () => {
    expect(() => encodeRequest({ version: 1, operation: "read", path: "/repo", extra: true } as never))
      .toThrow(/unexpected field/i);
    expect(() => encodeRequest({ version: 1, operation: "write", path: "/repo", content: "x" } as never))
      .toThrow(/createParents/i);
  });

  it("decodes a valid success response", () => {
    expect(decodeResponse('{"version":1,"ok":true,"value":{"encoding":"base64","data":"aGk="}}'))
      .toEqual({ version: 1, ok: true, value: { encoding: "base64", data: "aGk=" } });
  });

  it("rejects unsupported versions, extra responses, and unknown response fields", () => {
    expect(() => decodeResponse('{"version":2,"ok":true,"value":null}')).toThrow(/protocol version/i);
    expect(() => decodeResponse('{"version":1,"ok":true,"value":null}\n{"version":1,"ok":true,"value":null}'))
      .toThrow(/JSON/i);
    expect(() => decodeResponse('{"version":1,"ok":true,"value":null,"extra":true}'))
      .toThrow(/unexpected field/i);
    expect(() => decodeResponse('{"version":1,"ok":false,"error":{"code":"ENOENT","message":"missing","extra":1}}'))
      .toThrow(/unexpected field/i);
  });

  it("rejects responses above the finite capture bound", () => {
    const oversized = `{"version":1,"ok":true,"value":"${"x".repeat(MAX_WORKER_RESPONSE_BYTES)}"}`;
    expect(() => decodeResponse(oversized)).toThrow(/response.*limit/i);
  });

  it("accepts exactly 8 MiB of UTF-8 request bytes and rejects the next byte", () => {
    const empty = encodeRequest({ version: 1, operation: "write", path: "/repo/file", content: "", createParents: false });
    const exactContent = "x".repeat(MAX_WORKER_REQUEST_BYTES - Buffer.byteLength(empty));
    const exact = encodeRequest({
      version: 1,
      operation: "write",
      path: "/repo/file",
      content: exactContent,
      createParents: false,
    });

    expect(Buffer.byteLength(exact)).toBe(MAX_WORKER_REQUEST_BYTES);
    expect(() => encodeRequest({
      version: 1,
      operation: "write",
      path: "/repo/file",
      content: `${exactContent}x`,
      createParents: false,
    })).toThrow(/request.*limit/i);
  });

  it("counts multibyte request content by UTF-8 bytes rather than characters", () => {
    const empty = encodeRequest({ version: 1, operation: "write", path: "/repo/file", content: "", createParents: false });
    const remaining = MAX_WORKER_REQUEST_BYTES - Buffer.byteLength(empty);
    const content = `${"é".repeat(Math.floor(remaining / 2))}${remaining % 2 === 0 ? "" : "x"}`;
    const exact = encodeRequest({ version: 1, operation: "write", path: "/repo/file", content, createParents: false });

    expect(content.length).toBeLessThan(remaining);
    expect(Buffer.byteLength(exact)).toBe(MAX_WORKER_REQUEST_BYTES);
    expect(() => encodeRequest({
      version: 1,
      operation: "write",
      path: "/repo/file",
      content: `${content}é`,
      createParents: false,
    })).toThrow(/request.*limit/i);
  });
});

describe("pinned Pi image MIME parity", () => {
  it("rejects JPEG XL, malformed PNG, and APNG while accepting Pi's supported formats", () => {
    const validPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", Buffer.alloc(13)),
      pngChunk("IDAT", Buffer.alloc(0)),
    ]);
    const animatedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", Buffer.alloc(13)),
      pngChunk("acTL", Buffer.alloc(8)),
      pngChunk("IDAT", Buffer.alloc(0)),
    ]);
    const bmp = Buffer.alloc(54);
    bmp.write("BM", 0, "ascii");
    bmp.writeUInt32LE(100, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);

    expect(detectSupportedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xf7]))).toBeNull();
    expect(detectSupportedImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    expect(detectSupportedImageMimeType(animatedPng)).toBeNull();
    expect(detectSupportedImageMimeType(validPng)).toBe("image/png");
    expect(detectSupportedImageMimeType(Buffer.from("GIFbroken", "ascii"))).toBe("image/gif");
    expect(detectSupportedImageMimeType(bmp)).toBe("image/bmp");
  });
});

describe("FileWorkerClient", () => {
  it("resolves canonical executable paths before read-only policy composition", async () => {
    const directory = await makeTemporaryDirectory();
    const nodePath = join(directory, "node");
    const workerPath = join(directory, "file-worker.js");
    await writeFile(nodePath, "node");
    await writeFile(workerPath, "worker");

    await expect(resolveFileWorkerPaths({ nodePath, workerPath })).resolves.toEqual({
      nodePath: await realpath(nodePath),
      workerPath: await realpath(workerPath),
      trustedReadPaths: [await realpath(nodePath), await realpath(workerPath)],
    });
  });

  it("passes only canonical quoted worker paths in the command and model values through JSON stdin", async () => {
    const directory = await makeTemporaryDirectory();
    const nodePath = join(directory, "node's executable");
    const workerPath = join(directory, "worker's file.js");
    await writeFile(nodePath, "node");
    await writeFile(workerPath, "worker");
    const runner = new FakeRunner({
      exitCode: 0,
      stdout: '{"version":1,"ok":true,"value":{"encoding":"base64","data":"aGk="}}',
      stderr: "",
    });
    const client = new FileWorkerClient(runner, {
      cwd: directory,
      env: { PATH: "/trusted/bin" },
      nodePath,
      workerPath,
      createInvocationId: () => "file-7",
    });

    await expect(client.read("/model/'\npath")).resolves.toEqual(Buffer.from("hi"));

    const canonicalNode = await realpath(nodePath);
    const canonicalWorker = await realpath(workerPath);
    expect(runner.requests).toEqual([expect.objectContaining({
      invocationId: "file-7",
      command: `'${canonicalNode.replaceAll("'", `'\"'\"'`)}' '${canonicalWorker.replaceAll("'", `'\"'\"'`)}'`,
      commandText: "sandlot file worker",
      cwd: directory,
      env: { PATH: "/trusted/bin" },
      stdin: encodeRequest({ version: 1, operation: "read", path: "/model/'\npath" }),
      maxOutputBytes: MAX_WORKER_RESPONSE_BYTES,
    })]);
    expect(client.trustedReadPaths).toEqual([canonicalNode, canonicalWorker]);
  });

  it("forwards one Pi call's generation, cancellation signal, and derived child IDs to every worker", async () => {
    // Catches dropping call ownership at the worker boundary, which would make
    // later access/read operations survive replacement or lose attribution.
    const runner = new QueueRunner([
      success(null),
      success({ encoding: "base64", data: "b2s=" }),
    ]);
    const client = await makeClient(runner);
    const controller = new AbortController();
    let child = 0;
    const context = {
      expectedGeneration: 17,
      signal: controller.signal,
      nextInvocationId: () => {
        const childIndex = child++;
        return childIndex === 0 ? "pi-call" : `pi-call:${childIndex}`;
      },
    };

    await client.access("/repo/file", "read", context);
    await client.read("/repo/file", context);

    expect(runner.requests).toEqual([
      expect.objectContaining({ invocationId: "pi-call", expectedGeneration: 17, signal: controller.signal }),
      expect.objectContaining({ invocationId: "pi-call:1", expectedGeneration: 17, signal: controller.signal }),
    ]);
  });

  it.each([
    [{ exitCode: 9, stdout: "", stderr: "" }, /exit.*9/i],
    [{ exitCode: 0, stdout: '{"version":1,"ok":true,"value":null}', stderr: "warning" }, /stderr/i],
    [{ exitCode: 0, stdout: '{"version":2,"ok":true,"value":null}', stderr: "" }, /protocol version/i],
    [{ exitCode: 0, stdout: '{"version":1,"ok":true,"value":null}\n{"version":1,"ok":true,"value":null}', stderr: "" }, /JSON/i],
    [{ exitCode: 0, stdout: `{"version":1,"ok":true,"value":"${"x".repeat(MAX_WORKER_RESPONSE_BYTES)}"}`, stderr: "" }, /response.*limit/i],
  ] as const)("rejects invalid runner result %#", async (result, expected) => {
    const runner = new FakeRunner(result);
    const client = await makeClient(runner);
    await expect(client.read("/repo/file")).rejects.toThrow(expected);
  });

  it("rejects structured worker errors without host fallback", async () => {
    const runner = new FakeRunner({
      exitCode: 0,
      stdout: '{"version":1,"ok":false,"error":{"code":"EACCES","message":"permission denied"}}',
      stderr: "",
    });
    const client = await makeClient(runner);

    await expect(client.access("/secret", "read")).rejects.toMatchObject({ code: "EACCES", message: "permission denied" });
  });

  it("validates operation-specific values before returning them", async () => {
    const runner = new FakeRunner({ exitCode: 0, stdout: '{"version":1,"ok":true,"value":{"data":"%%%"}}', stderr: "" });
    const client = await makeClient(runner);
    await expect(client.read("/repo/file")).rejects.toThrow(/read response/i);
  });

  it("provides all file operations and converts host-facing values", async () => {
    const runner = new QueueRunner([
      success({ encoding: "base64", data: "aMOp" }),
      success(null),
      errorResponse("ENOENT", "missing"),
      success(null),
      success(null),
      success({ kind: "directory" }),
      success(["a.txt", ".env"]),
      success("image/png"),
      success(null),
    ]);
    const client = await makeClient(runner);

    await expect(client.readText("/repo/text")).resolves.toBe("hé");
    await expect(client.access("/repo/text", "write")).resolves.toBeUndefined();
    await expect(client.exists("/repo/missing")).resolves.toBe(false);
    await expect(client.write("/repo/nested/file", "hello", true)).resolves.toBeUndefined();
    await expect(client.mkdir("/repo/nested", true)).resolves.toBeUndefined();
    await expect(client.stat("/repo/nested")).resolves.toEqual({ kind: "directory" });
    await expect(client.readdir("/repo")).resolves.toEqual(["a.txt", ".env"]);
    await expect(client.mime("/repo/image")).resolves.toBe("image/png");
    await expect(client.mime("/repo/text")).resolves.toBeUndefined();

    expect(runner.requests.map(({ stdin }) => JSON.parse(String(stdin)))).toEqual([
      { version: 1, operation: "read", path: "/repo/text" },
      { version: 1, operation: "access", path: "/repo/text", mode: "write" },
      { version: 1, operation: "stat", path: "/repo/missing" },
      { version: 1, operation: "write", path: "/repo/nested/file", content: "hello", createParents: true },
      { version: 1, operation: "mkdir", path: "/repo/nested", recursive: true },
      { version: 1, operation: "stat", path: "/repo/nested" },
      { version: 1, operation: "readdir", path: "/repo" },
      { version: 1, operation: "mime", path: "/repo/image" },
      { version: 1, operation: "mime", path: "/repo/text" },
    ]);
  });
});

class FakeRunner {
  readonly requests: RunRequest[] = [];

  constructor(private readonly result: RunResult) {}

  async run(request: RunRequest): Promise<RunResult> {
    this.requests.push(request);
    return this.result;
  }
}

class QueueRunner {
  readonly requests: RunRequest[] = [];

  constructor(private readonly results: RunResult[]) {}

  async run(request: RunRequest): Promise<RunResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (result === undefined) throw new Error("missing queued result");
    return result;
  }
}

async function makeClient(runner: FakeRunner | QueueRunner): Promise<FileWorkerClient> {
  const directory = await makeTemporaryDirectory();
  const nodePath = join(directory, "node");
  const workerPath = join(directory, "file-worker.js");
  await writeFile(nodePath, "node");
  await writeFile(workerPath, "worker");
  return new FileWorkerClient(runner, { cwd: directory, env: {}, nodePath, workerPath });
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sandlot-protocol-"));
  temporaryDirectories.push(directory);
  return directory;
}

function success(value: unknown): RunResult {
  return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true, value }), stderr: "" };
}

function errorResponse(code: string, message: string): RunResult {
  return { exitCode: 0, stdout: JSON.stringify({ version: 1, ok: false, error: { code, message } }), stderr: "" };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}
