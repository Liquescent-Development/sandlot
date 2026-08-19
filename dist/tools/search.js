import { DEFAULT_MAX_BYTES, createFindTool, createFindToolDefinition, createGrepTool, createGrepToolDefinition, formatSize, truncateHead, } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
const DEFAULT_FIND_LIMIT = 1_000;
const DEFAULT_GREP_LIMIT = 100;
const SEARCH_MAX_LINE_CHARS = 2_000;
/**
 * Keeps Pi's find schema, metadata, and renderers while creating fresh
 * worker-backed operations per call.  Pi's custom find path resolver is
 * lexical only; every existence check and glob search crosses the worker.
 */
export function createSandlotFindTool(dependencies) {
    const definition = createFindToolDefinition(process.cwd(), { operations: rejectingFindOperations() });
    return {
        ...definition,
        async execute(toolCallId, input, signal, onUpdate, context) {
            const snapshot = dependencies.runtime.snapshot();
            if (snapshot.state === "disabled-by-user") {
                const local = (dependencies.createLocalFindTool ?? createFindTool)(context.cwd);
                return local.execute(toolCallId, input, signal, onUpdate);
            }
            const workerContext = captureWorkerContext(snapshot, toolCallId, signal);
            return executeReadyFind(input, context.cwd, dependencies.client, workerContext);
        },
    };
}
/**
 * Pi 0.84.2's public GrepOperations still starts `rg` on the host.  Retain
 * its public definition/renderers, but own its executor so the only rg spawn
 * occurs in the fixed search worker inside Sandbox Runtime.
 */
export function createSandlotGrepTool(dependencies) {
    const definition = createGrepToolDefinition(process.cwd(), { operations: rejectingGrepOperations() });
    return {
        ...definition,
        async execute(toolCallId, input, signal, _onUpdate, context) {
            const snapshot = dependencies.runtime.snapshot();
            if (snapshot.state === "disabled-by-user") {
                const local = (dependencies.createLocalGrepTool ?? createGrepTool)(context.cwd);
                return local.execute(toolCallId, input, signal, _onUpdate);
            }
            const workerContext = captureWorkerContext(snapshot, toolCallId, signal);
            const request = normalizeGrepInput(input, context.cwd);
            try {
                const result = await awaitWithAbort(dependencies.client.grep(request, workerContext), signal);
                if (signal?.aborted)
                    throw new Error("Operation aborted");
                return formatGrepResult(result.matches, result.matchLimitReached, request.limit);
            }
            catch (error) {
                if (signal?.aborted || (error instanceof Error && error.message === "aborted"))
                    throw new Error("Operation aborted");
                throw error;
            }
        },
    };
}
function rejectingFindOperations() {
    return {
        exists: async () => { throw new Error("Sandlot find registration executor is unavailable"); },
        glob: async () => { throw new Error("Sandlot find registration executor is unavailable"); },
    };
}
function rejectingGrepOperations() {
    return {
        isDirectory: async () => { throw new Error("Sandlot grep registration executor is unavailable"); },
        readFile: async () => { throw new Error("Sandlot grep registration executor is unavailable"); },
    };
}
async function executeReadyFind(input, cwd, client, context) {
    const limit = input.limit ?? DEFAULT_FIND_LIMIT;
    if (!Number.isFinite(limit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
        throw new Error("Invalid find limit: must be a safe integer between 1 and 1000000");
    }
    const root = resolveModelPath(input.path ?? ".", cwd);
    if (!(await awaitWithAbort(client.exists(root, context), context.signal)))
        throw new Error(`Path not found: ${root}`);
    const result = await awaitWithAbort(client.find(input.pattern, root, { ignore: ["**/node_modules/**", "**/.git/**"], limit }, context), context.signal);
    if (context.signal?.aborted)
        throw new Error("Operation aborted");
    if (result.paths.length === 0)
        return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
    const truncation = truncateHead(result.paths.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    let text = truncation.content;
    const details = {};
    const notices = [];
    if (result.limitReached) {
        details.resultLimitReached = limit;
        notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    }
    if (truncation.truncated) {
        details.truncation = truncation;
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    }
    if (notices.length > 0)
        text += `\n\n[${notices.join(". ")}]`;
    return { content: [{ type: "text", text }], details: Object.keys(details).length === 0 ? undefined : details };
}
function awaitWithAbort(work, signal) {
    if (signal?.aborted)
        return Promise.reject(new Error("Operation aborted"));
    if (signal === undefined)
        return work;
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error("Operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void work.catch(() => undefined);
    return Promise.race([work, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}
function captureWorkerContext(snapshot, toolCallId, signal) {
    if (snapshot.state !== "ready")
        throw new Error(`Sandlot runtime is not ready (${snapshot.state})`);
    let childCount = 0;
    return {
        expectedGeneration: snapshot.generation,
        signal,
        nextInvocationId: () => {
            const child = childCount++;
            return child === 0 ? toolCallId : `${toolCallId}:${child}`;
        },
    };
}
function normalizeGrepInput(input, cwd) {
    if (!Number.isFinite(input.context ?? 0) || !Number.isSafeInteger(input.context ?? 0) || (input.context ?? 0) < 0) {
        throw new Error("Invalid grep context: must be a non-negative safe integer");
    }
    const requestedLimit = input.limit ?? DEFAULT_GREP_LIMIT;
    if (!Number.isFinite(requestedLimit) || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1_000_000) {
        throw new Error("Invalid grep limit: must be a safe integer between 1 and 1000000");
    }
    return {
        cwd: resolveModelPath(input.path ?? ".", cwd),
        pattern: input.pattern,
        ...(input.glob === undefined ? {} : { glob: input.glob }),
        ignoreCase: input.ignoreCase ?? false,
        literal: input.literal ?? false,
        context: input.context ?? 0,
        limit: requestedLimit,
    };
}
function formatGrepResult(matches, matchLimitReached, limit) {
    if (matches.length === 0)
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };
    let linesTruncated = false;
    const outputLines = matches.map((match) => {
        const truncated = truncateSearchLine(match.text);
        linesTruncated ||= truncated.wasTruncated;
        return match.kind === "match"
            ? `${match.path}:${match.line}: ${truncated.text}`
            : `${match.path}-${match.line}- ${truncated.text}`;
    });
    const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    let text = truncation.content;
    const details = {};
    const notices = [];
    if (matchLimitReached) {
        details.matchLimitReached = limit;
        notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    }
    if (truncation.truncated) {
        details.truncation = truncation;
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    }
    if (linesTruncated) {
        details.linesTruncated = true;
        notices.push(`Some lines truncated to ${SEARCH_MAX_LINE_CHARS} chars. Use read tool to see full lines`);
    }
    if (notices.length > 0)
        text += `\n\n[${notices.join(". ")}]`;
    return { content: [{ type: "text", text }], details: Object.keys(details).length === 0 ? undefined : details };
}
/** Sandlot v1 contract intentionally uses 2,000 chars, not Pi 0.84.2's 500. */
function truncateSearchLine(line) {
    return line.length > SEARCH_MAX_LINE_CHARS
        ? { text: `${line.slice(0, SEARCH_MAX_LINE_CHARS)}... [truncated]`, wasTruncated: true }
        : { text: line, wasTruncated: false };
}
function resolveModelPath(value, cwd) {
    let path = value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
    if (path.startsWith("@"))
        path = path.slice(1);
    if (path === "~")
        path = homedir();
    else if (path.startsWith("~/"))
        path = join(homedir(), path.slice(2));
    if (path.startsWith("file://"))
        path = fileURLToPath(path);
    return isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);
}
export const SEARCH_LIMITS = Object.freeze({ find: DEFAULT_FIND_LIMIT, grep: DEFAULT_GREP_LIMIT, lineChars: SEARCH_MAX_LINE_CHARS });
