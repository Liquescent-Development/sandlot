export const WORKER_PROTOCOL_VERSION = 1;
export const MAX_WORKER_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_WORKER_RESPONSE_BYTES = 12 * 1024 * 1024;
export class WorkerProtocolError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "WorkerProtocolError";
    }
}
export function encodeRequest(request) {
    validateRequest(request);
    const encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded) > MAX_WORKER_REQUEST_BYTES) {
        throw new WorkerProtocolError(`worker request exceeds ${MAX_WORKER_REQUEST_BYTES}-byte limit`);
    }
    return encoded;
}
export function decodeRequest(encoded) {
    if (Buffer.byteLength(encoded) > MAX_WORKER_REQUEST_BYTES) {
        throw new WorkerProtocolError(`worker request exceeds ${MAX_WORKER_REQUEST_BYTES}-byte limit`);
    }
    const request = parseJson(encoded, "request");
    validateRequest(request);
    return request;
}
export function decodeResponse(encoded) {
    if (Buffer.byteLength(encoded) > MAX_WORKER_RESPONSE_BYTES) {
        throw new WorkerProtocolError(`worker response exceeds ${MAX_WORKER_RESPONSE_BYTES}-byte limit`);
    }
    const response = parseJson(encoded, "response");
    const record = requireRecord(response, "worker response");
    requireVersion(record.version);
    if (typeof record.ok !== "boolean")
        throw new WorkerProtocolError("worker response ok must be a boolean");
    if (record.ok) {
        requireExactKeys(record, ["version", "ok", "value"], "worker success response");
        return response;
    }
    requireExactKeys(record, ["version", "ok", "error"], "worker error response");
    const error = requireRecord(record.error, "worker response error");
    requireExactKeys(error, ["code", "message"], "worker response error");
    requireString(error.code, "worker response error code");
    requireString(error.message, "worker response error message");
    return response;
}
function validateRequest(value) {
    const request = requireRecord(value, "worker request");
    requireVersion(request.version);
    requireString(request.operation, "worker request operation");
    switch (request.operation) {
        case "read":
        case "readImage":
        case "stat":
        case "readdir":
        case "mime":
            requireString(request.path, "worker request path");
            requireExactKeys(request, ["version", "operation", "path"], `${request.operation} request`);
            return;
        case "access":
            requireString(request.path, "worker request path");
            requireExactKeys(request, ["version", "operation", "path", "mode"], "access request");
            if (request.mode !== "read" && request.mode !== "write") {
                throw new WorkerProtocolError("access request mode must be read or write");
            }
            return;
        case "write":
            requireString(request.path, "worker request path");
            requireExactKeys(request, ["version", "operation", "path", "content", "createParents"], "write request");
            requireString(request.content, "write request content");
            requireBoolean(request.createParents, "write request createParents");
            return;
        case "mkdir":
            requireString(request.path, "worker request path");
            requireExactKeys(request, ["version", "operation", "path", "recursive"], "mkdir request");
            requireBoolean(request.recursive, "mkdir request recursive");
            return;
        case "find":
            requireExactKeys(request, ["version", "operation", "cwd", "pattern", "ignore", "limit"], "find request");
            requireString(request.cwd, "find request cwd");
            requireString(request.pattern, "find request pattern");
            requireStringArray(request.ignore, "find request ignore");
            requireSafeLimit(request.limit, "find request limit");
            return;
        case "grep": {
            requireExactKeys(request, Object.hasOwn(request, "glob")
                ? ["version", "operation", "cwd", "pattern", "glob", "ignoreCase", "literal", "context", "limit"]
                : ["version", "operation", "cwd", "pattern", "ignoreCase", "literal", "context", "limit"], "grep request");
            requireString(request.cwd, "grep request cwd");
            requireString(request.pattern, "grep request pattern");
            if (request.glob !== undefined)
                requireString(request.glob, "grep request glob");
            requireBoolean(request.ignoreCase, "grep request ignoreCase");
            requireBoolean(request.literal, "grep request literal");
            requireSafeLimit(request.context, "grep request context");
            requireSafeLimit(request.limit, "grep request limit");
            return;
        }
        default:
            throw new WorkerProtocolError(`unknown worker operation: ${request.operation}`);
    }
}
function parseJson(encoded, kind) {
    try {
        return JSON.parse(encoded);
    }
    catch (error) {
        throw new WorkerProtocolError(`invalid worker ${kind} JSON`, { cause: error });
    }
}
function requireVersion(value) {
    if (value !== WORKER_PROTOCOL_VERSION) {
        throw new WorkerProtocolError(`unsupported worker protocol version: ${String(value)}`);
    }
}
function requireRecord(value, context) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new WorkerProtocolError(`${context} must be an object`);
    }
    return value;
}
function requireExactKeys(record, expected, context) {
    const expectedSet = new Set(expected);
    const unexpected = Object.keys(record).find((key) => !expectedSet.has(key));
    if (unexpected !== undefined)
        throw new WorkerProtocolError(`${context} has unexpected field: ${unexpected}`);
    const missing = expected.find((key) => !Object.hasOwn(record, key));
    if (missing !== undefined)
        throw new WorkerProtocolError(`${context} is missing field: ${missing}`);
}
function requireString(value, context) {
    if (typeof value !== "string")
        throw new WorkerProtocolError(`${context} must be a string`);
}
function requireBoolean(value, context) {
    if (typeof value !== "boolean")
        throw new WorkerProtocolError(`${context} must be a boolean`);
}
function requireStringArray(value, context) {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        throw new WorkerProtocolError(`${context} must be an array of strings`);
    }
}
function requireSafeLimit(value, context) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
        throw new WorkerProtocolError(`${context} must be a safe integer between 0 and 1000000`);
    }
}
