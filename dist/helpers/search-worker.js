import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { MAX_WORKER_REQUEST_BYTES, MAX_WORKER_RESPONSE_BYTES, WORKER_PROTOCOL_VERSION, WorkerProtocolError, decodeRequest, decodeResponse, encodeRequest, } from "./protocol.js";
import { randomUUID } from "node:crypto";
const SEARCH_RG_ENV = "SANDLOT_SEARCH_RG_PATH";
const MAX_RG_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_RG_STDERR_BYTES = 64 * 1024;
const MAX_RG_LINE_BYTES = 1024 * 1024;
const MAX_RETAINED_RESPONSE_BYTES = MAX_WORKER_RESPONSE_BYTES - 64 * 1024;
export async function resolveSearchWorkerPaths(options = {}) {
    const nodeCandidate = options.nodePath ?? process.execPath;
    const workerCandidate = options.workerPath ?? fileURLToPath(import.meta.url);
    const rgCandidate = options.rgPath ?? await resolveRgPath();
    const [nodePath, workerPath, rgPath] = await Promise.all([realpath(nodeCandidate), realpath(workerCandidate), realpath(rgCandidate)]);
    return Object.freeze({
        nodePath,
        workerPath,
        rgPath,
        trustedReadPaths: Object.freeze([nodePath, workerPath, rgPath]),
        trustedExecutePaths: Object.freeze([nodePath, rgPath]),
    });
}
export class SearchWorkerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "SearchWorkerError";
    }
}
export class SearchWorkerClient {
    runner;
    #cwd;
    #env;
    #nodePath;
    #workerPath;
    #rgPath;
    #createInvocationId;
    #command;
    #trustedReadPaths = [];
    #trustedExecutePaths = [];
    constructor(runner, options = {}) {
        this.runner = runner;
        this.#cwd = options.cwd ?? process.cwd();
        this.#env = options.env ?? {};
        this.#nodePath = options.nodePath ?? process.execPath;
        this.#workerPath = options.workerPath ?? fileURLToPath(import.meta.url);
        this.#rgPath = options.rgPath;
        this.#createInvocationId = options.createInvocationId ?? randomUUID;
    }
    get trustedReadPaths() { return this.#trustedReadPaths; }
    get trustedExecutePaths() { return this.#trustedExecutePaths; }
    /** Rebind the trusted executable only between runtime generations. */
    configureRgPath(rgPath) {
        if (this.#rgPath === rgPath)
            return;
        this.#rgPath = rgPath;
        this.#command = undefined;
        this.#trustedReadPaths = [];
        this.#trustedExecutePaths = [];
    }
    async find(pattern, cwd, options, context) {
        const value = await this.request({ version: 1, operation: "find", cwd, pattern, ignore: [...options.ignore], limit: options.limit }, context);
        const record = exactRecord(value, ["paths", "limitReached"], "find response");
        if (!Array.isArray(record.paths) || !record.paths.every((path) => typeof path === "string") || typeof record.limitReached !== "boolean") {
            throw new WorkerProtocolError("invalid find response");
        }
        return { paths: record.paths, limitReached: record.limitReached };
    }
    async exists(path, context) {
        try {
            await this.find("**", path, { ignore: [], limit: 0 }, context);
            return true;
        }
        catch (error) {
            if (error instanceof SearchWorkerError && (error.code === "ENOENT" || error.code === "ENOTDIR"))
                return false;
            throw error;
        }
    }
    async grep(request, context) {
        const value = await this.request({ version: 1, operation: "grep", ...request }, context);
        const record = exactRecord(value, ["matches", "matchLimitReached"], "grep response");
        if (!Array.isArray(record.matches) || typeof record.matchLimitReached !== "boolean")
            throw new WorkerProtocolError("invalid grep response");
        const matches = record.matches.map((match) => {
            const item = exactRecord(match, ["path", "line", "text", "kind"], "grep match");
            if (typeof item.path !== "string" || !Number.isSafeInteger(item.line) || item.line < 1 || typeof item.text !== "string" || (item.kind !== "match" && item.kind !== "context")) {
                throw new WorkerProtocolError("invalid grep match");
            }
            return { path: item.path, line: item.line, text: item.text, kind: item.kind };
        });
        return { matches, matchLimitReached: record.matchLimitReached };
    }
    async request(request, context) {
        const command = await this.command();
        const result = await this.runner.run({
            invocationId: context.nextInvocationId(),
            expectedGeneration: context.expectedGeneration,
            command: command.command,
            commandText: "sandlot search worker",
            cwd: this.#cwd,
            env: command.env,
            signal: context.signal,
            stdin: encodeRequest(request),
            maxOutputBytes: MAX_WORKER_RESPONSE_BYTES,
            annotateViolations: false,
        });
        if (result.exitCode !== 0)
            throw new WorkerProtocolError(`search worker exited with code ${String(result.exitCode)}`);
        if (result.stderr.length > 0)
            throw new WorkerProtocolError("search worker wrote to stderr");
        const response = decodeResponse(result.stdout);
        if (!response.ok)
            throw new SearchWorkerError(response.error.code, response.error.message);
        return response.value;
    }
    command() {
        this.#command ??= resolveSearchWorkerPaths({ nodePath: this.#nodePath, workerPath: this.#workerPath, rgPath: this.#rgPath }).then((paths) => {
            this.#trustedReadPaths = paths.trustedReadPaths;
            this.#trustedExecutePaths = paths.trustedExecutePaths;
            return {
                command: `${quoteForPosixShell(paths.nodePath)} ${quoteForPosixShell(paths.workerPath)}`,
                env: { ...this.#env, [SEARCH_RG_ENV]: paths.rgPath },
            };
        });
        return this.#command;
    }
}
async function runWorker() {
    let request;
    try {
        const decoded = decodeRequest(await readStdin());
        if (decoded.operation !== "find" && decoded.operation !== "grep")
            throw new WorkerProtocolError("search worker received a non-search request");
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
    const rgPath = process.env[SEARCH_RG_ENV];
    if (rgPath === undefined || rgPath === "")
        throw new SearchWorkerError("RG_PATH", "trusted ripgrep executable is unavailable");
    if (request.operation === "find")
        return executeFind(rgPath, request);
    return executeGrep(rgPath, request);
}
async function executeFind(rgPath, request) {
    const root = await prepareSearchRoot(request.cwd);
    const args = ["--files", "--hidden", "--sort", "path", "--glob", "!.git/**", "--glob", "!**/.git/**", "--glob", request.pattern];
    for (const ignored of request.ignore)
        args.push("--glob", ignored.startsWith("!") ? ignored : `!${ignored}`);
    args.push("--", root.target);
    const paths = [];
    let retainedBytes = 0;
    const outcome = await streamRg(rgPath, args, root.cwd, (line) => {
        if (line === "")
            return true;
        const path = relativeResult(line, request.cwd);
        if (path.split("/").includes(".git"))
            return true;
        retainedBytes = retainBytes(retainedBytes, path);
        paths.push(path);
        return paths.length < request.limit + 1;
    });
    assertRgOutcome(outcome);
    return { paths: paths.slice(0, request.limit), limitReached: paths.length > request.limit };
}
async function executeGrep(rgPath, request) {
    const root = await prepareSearchRoot(request.cwd);
    const args = ["--json", "--line-number", "--hidden", "--glob", "!.git/**", "--glob", "!**/.git/**"];
    if (request.literal)
        args.push("--fixed-strings");
    if (request.ignoreCase)
        args.push("--ignore-case");
    if (request.glob !== undefined)
        args.push("--glob", request.glob);
    if (request.context > 0)
        args.push("--context", String(request.context));
    args.push("--", request.pattern, root.target);
    const events = [];
    const selected = [];
    const endedPaths = new Set();
    const furthestLine = new Map();
    let overflow = false;
    let retainedBytes = 0;
    const outcome = await streamRg(rgPath, args, root.cwd, (line) => {
        if (line === "")
            return true;
        const event = parseRgEvent(line, request.cwd);
        if (event.type === "end" && event.path !== undefined)
            endedPaths.add(event.path);
        if (event.result !== undefined) {
            const result = event.result;
            retainedBytes = retainBytes(retainedBytes, result.path, result.text);
            events.push(result);
            furthestLine.set(result.path, Math.max(furthestLine.get(result.path) ?? 0, result.line));
            if (result.kind === "match") {
                if (selected.length < request.limit)
                    selected.push(result);
                else
                    overflow = true;
            }
        }
        if (!overflow)
            return true;
        if (request.context === 0 || selected.every((match) => {
            const required = match.line + request.context;
            return (furthestLine.get(match.path) ?? 0) >= required || endedPaths.has(match.path);
        }))
            return false;
        return true;
    });
    assertRgOutcome(outcome);
    const selectedKeys = new Set(selected.map((event) => `${event.path}\u0000${event.line}`));
    const byLine = new Map();
    for (const event of events) {
        const key = `${event.path}\u0000${event.line}`;
        const withinSelectedWindow = selected.some((match) => match.path === event.path && Math.abs(match.line - event.line) <= request.context);
        if (!selectedKeys.has(key) && !withinSelectedWindow)
            continue;
        const normalized = selectedKeys.has(key) ? { ...event, kind: "match" } : { ...event, kind: "context" };
        const previous = byLine.get(key);
        if (previous === undefined || normalized.kind === "match")
            byLine.set(key, normalized);
    }
    return { matches: [...byLine.values()], matchLimitReached: overflow };
}
function parseRgEvent(line, cwd) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        throw new WorkerProtocolError("ripgrep emitted invalid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new WorkerProtocolError("ripgrep event must be an object");
    const event = value;
    if (event.type === "begin" || event.type === "summary")
        return { type: "other" };
    if (event.type === "end")
        return { type: "end", path: relativeResult(requiredTextField(requiredRecord(event.data, "ripgrep end data").path, "ripgrep end path"), cwd) };
    if (event.type !== "match" && event.type !== "context")
        throw new WorkerProtocolError(`unknown ripgrep event type: ${String(event.type)}`);
    const record = requiredRecord(event.data, `ripgrep ${event.type} data`);
    const path = relativeResult(requiredTextField(record.path, `ripgrep ${event.type} path`), cwd);
    const text = requiredTextField(record.lines, `ripgrep ${event.type} lines`).replace(/\r?\n$/, "");
    const lineNumber = record.line_number;
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1)
        throw new WorkerProtocolError(`ripgrep ${event.type} line_number is invalid`);
    return { type: "other", result: { path, line: lineNumber, text, kind: event.type } };
}
function requiredRecord(value, context) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new WorkerProtocolError(`${context} must be an object`);
    return value;
}
function requiredTextField(value, context) {
    const record = requiredRecord(value, context);
    if (Object.hasOwn(record, "bytes"))
        throw new WorkerProtocolError(`${context} byte encoding is unsupported`);
    if (typeof record.text !== "string")
        throw new WorkerProtocolError(`${context} text is required`);
    return record.text;
}
function relativeResult(result, root) {
    const relativePath = isAbsolute(result) ? relative(root, result) : result.replace(/^\.\//, "");
    return (relativePath === "" ? basename(result) : relativePath).split("\\").join("/");
}
async function prepareSearchRoot(root) {
    const status = await stat(root);
    return status.isDirectory() ? { cwd: root, target: "." } : { cwd: dirname(root), target: basename(root) };
}
function streamRg(command, args, cwd, onLine) {
    return new Promise((resolveResult, reject) => {
        const child = spawn(command, args, { shell: false, cwd, stdio: ["ignore", "pipe", "pipe"] });
        const decoder = new StringDecoder("utf8");
        let pending = "";
        let pendingBytes = 0;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stderr = "";
        let intentionallyStopped = false;
        let settled = false;
        let failure;
        const stop = () => { if (!intentionallyStopped) {
            intentionallyStopped = true;
            child.kill("SIGTERM");
        } };
        const fail = (error) => { if (failure === undefined) {
            failure = error;
            stop();
        } };
        const processLine = (line) => {
            if (intentionallyStopped)
                return;
            try {
                if (!onLine(line))
                    stop();
            }
            catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
            }
        };
        child.stdout.on("data", (chunk) => {
            if (settled)
                return;
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_RG_STREAM_BYTES) {
                fail(new SearchWorkerError("RG_OUTPUT_LIMIT", "ripgrep stdout exceeded worker limit"));
                return;
            }
            pending += decoder.write(chunk);
            pendingBytes = Buffer.byteLength(pending);
            if (pendingBytes > MAX_RG_LINE_BYTES) {
                fail(new SearchWorkerError("RG_LINE_LIMIT", "ripgrep output line exceeded worker limit"));
                return;
            }
            let newline;
            while (!intentionallyStopped && (newline = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, newline).replace(/\r$/, "");
                pending = pending.slice(newline + 1);
                pendingBytes = Buffer.byteLength(pending);
                processLine(line);
            }
        });
        child.stderr.on("data", (chunk) => {
            stderrBytes += chunk.length;
            if (stderrBytes > MAX_RG_STDERR_BYTES) {
                fail(new SearchWorkerError("RG_STDERR_LIMIT", "ripgrep stderr exceeded worker limit"));
                return;
            }
            stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => fail(new SearchWorkerError("RG_SPAWN", error.message)));
        child.on("close", (code, signal) => {
            if (settled)
                return;
            settled = true;
            if (!intentionallyStopped && failure === undefined) {
                const tail = `${pending}${decoder.end()}`;
                if (tail !== "")
                    processLine(tail.replace(/\r$/, ""));
            }
            if (failure !== undefined) {
                reject(failure);
                return;
            }
            resolveResult({ code, signal, stderr, intentionallyStopped });
        });
    });
}
function assertRgOutcome(outcome) {
    if (outcome.intentionallyStopped && outcome.stderr === "" && (outcome.signal === "SIGTERM" || outcome.code === 0 || outcome.code === 1))
        return;
    const diagnostic = outcome.stderr.trim() || "ripgrep wrote to stderr";
    if (outcome.code !== 0 && outcome.code !== 1)
        throw new SearchWorkerError("RG_FAILED", outcome.stderr === "" ? `ripgrep exited with code ${outcome.code}` : diagnostic);
    if (outcome.stderr !== "")
        throw new SearchWorkerError("RG_FAILED", diagnostic);
}
function retainBytes(current, ...values) {
    const total = current + values.reduce((sum, value) => sum + Buffer.byteLength(value) + 32, 0);
    if (total > MAX_RETAINED_RESPONSE_BYTES)
        throw new SearchWorkerError("RG_RESPONSE_LIMIT", "ripgrep results exceeded worker response limit");
    return total;
}
async function resolveRgPath() {
    const candidates = process.platform === "darwin"
        ? ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"]
        : ["/usr/bin/rg", "/usr/local/bin/rg", "/snap/bin/rg"];
    for (const candidate of candidates) {
        try {
            return await realpath(candidate);
        }
        catch { /* trusted fixed candidate absent */ }
    }
    throw new SearchWorkerError("RG_PATH", "ripgrep executable is unavailable; configure a trusted rgPath");
}
async function readStdin() {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_WORKER_REQUEST_BYTES)
            throw new WorkerProtocolError(`worker request exceeds ${MAX_WORKER_REQUEST_BYTES}-byte limit`);
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
}
function protocolFailure(error) { return { version: 1, ok: false, error: { code: "PROTOCOL_ERROR", message: errorMessage(error) } }; }
function operationFailure(error) {
    const code = error instanceof SearchWorkerError
        ? error.code
        : typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "EUNKNOWN";
    return { version: 1, ok: false, error: { code, message: errorMessage(error) } };
}
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function writeResponse(response) {
    const encoded = JSON.stringify(response);
    if (Buffer.byteLength(encoded) > MAX_WORKER_RESPONSE_BYTES) {
        const fallback = JSON.stringify(protocolFailure(new WorkerProtocolError(`worker response exceeds ${MAX_WORKER_RESPONSE_BYTES}-byte limit`)));
        process.exitCode = 1;
        process.stdout.write(fallback);
        return;
    }
    process.stdout.write(encoded);
}
function quoteForPosixShell(value) { return `'${value.replaceAll("'", `'\"'\"'`)}'`; }
function exactRecord(value, keys, context) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new WorkerProtocolError(`invalid ${context}`);
    const record = value;
    if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
        throw new WorkerProtocolError(`invalid ${context}`);
    return record;
}
const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url)))
    await runWorker();
