import { randomUUID } from "node:crypto";
import { access as fsAccess, constants, mkdir as fsMkdir, open, readdir as fsReaddir, realpath, stat as fsStat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_WORKER_REQUEST_BYTES, MAX_WORKER_RESPONSE_BYTES, WORKER_PROTOCOL_VERSION, WorkerProtocolError, decodeRequest, decodeResponse, encodeRequest, } from "./protocol.js";
export const MAX_FILE_READ_BYTES = 8 * 1024 * 1024;
export async function resolveFileWorkerPaths(options = {}) {
    const [nodePath, workerPath] = await Promise.all([
        realpath(options.nodePath ?? process.execPath),
        realpath(options.workerPath ?? fileURLToPath(import.meta.url)),
    ]);
    return Object.freeze({
        nodePath,
        workerPath,
        trustedReadPaths: Object.freeze([nodePath, workerPath]),
    });
}
export class FileWorkerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "FileWorkerError";
    }
}
export class FileWorkerClient {
    runner;
    #cwd;
    #env;
    #nodePath;
    #workerPath;
    #createInvocationId;
    #command;
    #trustedReadPaths = [];
    constructor(runner, options = {}) {
        this.runner = runner;
        this.#cwd = options.cwd ?? process.cwd();
        this.#env = options.env ?? {};
        this.#nodePath = options.nodePath ?? process.execPath;
        this.#workerPath = options.workerPath ?? fileURLToPath(import.meta.url);
        this.#createInvocationId = options.createInvocationId ?? randomUUID;
    }
    get trustedReadPaths() {
        return this.#trustedReadPaths;
    }
    async read(path, context) {
        const value = await this.request({ version: 1, operation: "read", path }, context);
        const record = exactRecord(value, ["encoding", "data"], "read response");
        if (record.encoding !== "base64" || typeof record.data !== "string" || !isBase64(record.data)) {
            throw new WorkerProtocolError("invalid read response");
        }
        return Buffer.from(record.data, "base64");
    }
    async readText(path, context) {
        return (await this.read(path, context)).toString("utf8");
    }
    async readImage(path, context) {
        const value = await this.request({ version: 1, operation: "readImage", path }, context);
        const record = exactRecord(value, ["encoding", "data", "mimeType"], "atomic image read response");
        if (record.encoding !== "base64" || typeof record.data !== "string" || !isBase64(record.data)) {
            throw new WorkerProtocolError("invalid atomic image read response");
        }
        const mimeType = parseSupportedImageMimeType(record.mimeType, "atomic image read response");
        return { bytes: Buffer.from(record.data, "base64"), mimeType };
    }
    async access(path, mode, context) {
        requireNull(await this.request({ version: 1, operation: "access", path, mode }, context), "access response");
    }
    async exists(path, context) {
        try {
            await this.stat(path, context);
            return true;
        }
        catch (error) {
            if (error instanceof FileWorkerError && (error.code === "ENOENT" || error.code === "ENOTDIR"))
                return false;
            throw error;
        }
    }
    async write(path, content, createParents, context) {
        requireNull(await this.request({ version: 1, operation: "write", path, content, createParents }, context), "write response");
    }
    async mkdir(path, recursive, context) {
        requireNull(await this.request({ version: 1, operation: "mkdir", path, recursive }, context), "mkdir response");
    }
    async stat(path, context) {
        const record = exactRecord(await this.request({ version: 1, operation: "stat", path }, context), ["kind"], "stat response");
        if (record.kind !== "file" && record.kind !== "directory" && record.kind !== "other") {
            throw new WorkerProtocolError("invalid stat response");
        }
        return { kind: record.kind };
    }
    async readdir(path, context) {
        const value = await this.request({ version: 1, operation: "readdir", path }, context);
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
            throw new WorkerProtocolError("invalid readdir response");
        }
        return value;
    }
    async mime(path, context) {
        const value = await this.request({ version: 1, operation: "mime", path }, context);
        return parseSupportedImageMimeType(value, "mime response");
    }
    async request(request, context) {
        const result = await this.runner.run({
            invocationId: context?.nextInvocationId() ?? this.#createInvocationId(),
            expectedGeneration: context?.expectedGeneration,
            command: await this.command(),
            commandText: "sandlot file worker",
            cwd: this.#cwd,
            env: this.#env,
            signal: context?.signal,
            stdin: encodeRequest(request),
            maxOutputBytes: MAX_WORKER_RESPONSE_BYTES,
            annotateViolations: false,
        });
        if (result.exitCode !== 0)
            throw new WorkerProtocolError(`file worker exited with code ${String(result.exitCode)}`);
        if (result.stderr.length > 0)
            throw new WorkerProtocolError("file worker wrote to stderr");
        const response = decodeResponse(result.stdout);
        if (!response.ok)
            throw new FileWorkerError(response.error.code, response.error.message);
        return response.value;
    }
    command() {
        this.#command ??= resolveFileWorkerPaths({ nodePath: this.#nodePath, workerPath: this.#workerPath }).then((paths) => {
            this.#trustedReadPaths = paths.trustedReadPaths;
            return `${quoteForPosixShell(paths.nodePath)} ${quoteForPosixShell(paths.workerPath)}`;
        });
        return this.#command;
    }
}
async function runWorker() {
    let request;
    try {
        const decoded = decodeRequest(await readStdin());
        if (decoded.operation === "find" || decoded.operation === "grep") {
            throw new WorkerProtocolError("file worker received a non-file request");
        }
        request = decoded;
    }
    catch (error) {
        process.exitCode = 1;
        writeResponse(protocolFailure(error));
        return;
    }
    try {
        writeResponse({ version: WORKER_PROTOCOL_VERSION, ok: true, value: await execute(request) });
    }
    catch (error) {
        writeResponse(operationFailure(error));
    }
}
async function execute(request) {
    switch (request.operation) {
        case "read": {
            const content = await readBounded(request.path);
            return { encoding: "base64", data: content.toString("base64") };
        }
        case "readImage": {
            const content = await readBounded(request.path);
            return {
                encoding: "base64",
                data: content.toString("base64"),
                mimeType: detectSupportedImageMimeType(content),
            };
        }
        case "access":
            await fsAccess(request.path, request.mode === "read" ? constants.R_OK : constants.W_OK);
            return null;
        case "write":
            if (request.createParents)
                await fsMkdir(dirname(request.path), { recursive: true });
            await writeFile(request.path, request.content, "utf8");
            return null;
        case "mkdir":
            await fsMkdir(request.path, { recursive: request.recursive });
            return null;
        case "stat": {
            const status = await fsStat(request.path);
            return { kind: status.isFile() ? "file" : status.isDirectory() ? "directory" : "other" };
        }
        case "readdir":
            return fsReaddir(request.path);
        case "mime":
            return detectMime(request.path);
        default:
            throw new WorkerProtocolError(`unhandled file worker request: ${JSON.stringify(request)}`);
    }
}
async function detectMime(path) {
    const handle = await open(path, "r");
    try {
        const bytes = Buffer.alloc(4_100);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        return detectSupportedImageMimeType(bytes.subarray(0, bytesRead));
    }
    finally {
        await handle.close();
    }
}
async function readBounded(path) {
    const handle = await open(path, "r");
    try {
        const metadata = await handle.stat();
        if (metadata.size > MAX_FILE_READ_BYTES)
            throw fileTooLarge(path);
        const chunks = [];
        let total = 0;
        while (total <= MAX_FILE_READ_BYTES) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_READ_BYTES + 1 - total));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0)
                return Buffer.concat(chunks, total);
            chunks.push(chunk.subarray(0, bytesRead));
            total += bytesRead;
            if (total > MAX_FILE_READ_BYTES)
                throw fileTooLarge(path);
        }
        throw fileTooLarge(path);
    }
    finally {
        await handle.close();
    }
}
function fileTooLarge(path) {
    return Object.assign(new Error(`file exceeds ${MAX_FILE_READ_BYTES}-byte read limit: ${path}`), { code: "EFBIG" });
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function detectSupportedImageMimeType(buffer) {
    if (startsWith(buffer, Buffer.from([0xff, 0xd8, 0xff])))
        return buffer[3] === 0xf7 ? null : "image/jpeg";
    if (startsWith(buffer, PNG_SIGNATURE))
        return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
    if (startsWithAscii(buffer, 0, "GIF"))
        return "image/gif";
    if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP"))
        return "image/webp";
    if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer))
        return "image/bmp";
    return null;
}
function isPng(buffer) {
    return buffer.length >= 16 && buffer.readUInt32BE(PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR");
}
function isAnimatedPng(buffer) {
    let offset = PNG_SIGNATURE.length;
    while (offset + 8 <= buffer.length) {
        const chunkLength = buffer.readUInt32BE(offset);
        const chunkTypeOffset = offset + 4;
        if (startsWithAscii(buffer, chunkTypeOffset, "acTL"))
            return true;
        if (startsWithAscii(buffer, chunkTypeOffset, "IDAT"))
            return false;
        const nextOffset = offset + 8 + chunkLength + 4;
        if (nextOffset <= offset || nextOffset > buffer.length)
            return false;
        offset = nextOffset;
    }
    return false;
}
function isBmp(buffer) {
    if (buffer.length < 26)
        return false;
    const declaredFileSize = buffer.readUInt32LE(2);
    const pixelDataOffset = buffer.readUInt32LE(10);
    const dibHeaderSize = buffer.readUInt32LE(14);
    if (declaredFileSize !== 0 && declaredFileSize < 26)
        return false;
    if (pixelDataOffset < 14 + dibHeaderSize)
        return false;
    if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize)
        return false;
    let colorPlanes;
    let bitsPerPixel;
    if (dibHeaderSize === 12) {
        colorPlanes = buffer.readUInt16LE(22);
        bitsPerPixel = buffer.readUInt16LE(24);
    }
    else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
        if (buffer.length < 30)
            return false;
        colorPlanes = buffer.readUInt16LE(26);
        bitsPerPixel = buffer.readUInt16LE(28);
    }
    else {
        return false;
    }
    return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}
function startsWith(buffer, prefix) {
    return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}
function startsWithAscii(buffer, offset, text) {
    if (buffer.length < offset + text.length)
        return false;
    for (let index = 0; index < text.length; index++) {
        if (buffer[offset + index] !== text.charCodeAt(index))
            return false;
    }
    return true;
}
async function readStdin() {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_WORKER_REQUEST_BYTES) {
            throw new WorkerProtocolError(`worker request exceeds ${MAX_WORKER_REQUEST_BYTES}-byte limit`);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
}
function protocolFailure(error) {
    return {
        version: WORKER_PROTOCOL_VERSION,
        ok: false,
        error: { code: "PROTOCOL_ERROR", message: errorMessage(error) },
    };
}
function operationFailure(error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : "EUNKNOWN";
    return { version: WORKER_PROTOCOL_VERSION, ok: false, error: { code, message: errorMessage(error) } };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function writeResponse(response) {
    process.stdout.write(JSON.stringify(response));
}
function quoteForPosixShell(value) {
    return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
function exactRecord(value, keys, context) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new WorkerProtocolError(`invalid ${context}`);
    }
    const record = value;
    if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
        throw new WorkerProtocolError(`invalid ${context}`);
    }
    return record;
}
function requireNull(value, context) {
    if (value !== null)
        throw new WorkerProtocolError(`invalid ${context}`);
}
function isBase64(value) {
    return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
function parseSupportedImageMimeType(value, context) {
    if (value === null)
        return undefined;
    if (value === "image/png"
        || value === "image/jpeg"
        || value === "image/gif"
        || value === "image/webp"
        || value === "image/bmp")
        return value;
    throw new WorkerProtocolError(`invalid ${context}`);
}
function assertNever(value) {
    throw new WorkerProtocolError(`unhandled worker request: ${JSON.stringify(value)}`);
}
const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))) {
    await runWorker();
}
