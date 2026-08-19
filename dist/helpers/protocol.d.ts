export declare const WORKER_PROTOCOL_VERSION: 1;
export declare const MAX_WORKER_REQUEST_BYTES: number;
export declare const MAX_WORKER_RESPONSE_BYTES: number;
export type FileWorkerRequest = {
    version: 1;
    operation: "read";
    path: string;
} | {
    version: 1;
    operation: "readImage";
    path: string;
} | {
    version: 1;
    operation: "access";
    path: string;
    mode: "read" | "write";
} | {
    version: 1;
    operation: "write";
    path: string;
    content: string;
    createParents: boolean;
} | {
    version: 1;
    operation: "mkdir";
    path: string;
    recursive: boolean;
} | {
    version: 1;
    operation: "stat";
    path: string;
} | {
    version: 1;
    operation: "readdir";
    path: string;
} | {
    version: 1;
    operation: "mime";
    path: string;
};
export type SearchWorkerRequest = {
    version: 1;
    operation: "find";
    cwd: string;
    pattern: string;
    ignore: string[];
    limit: number;
} | {
    version: 1;
    operation: "grep";
    cwd: string;
    pattern: string;
    glob?: string;
    ignoreCase: boolean;
    literal: boolean;
    context: number;
    limit: number;
};
export type WorkerRequest = FileWorkerRequest | SearchWorkerRequest;
export type WorkerResponse<T = unknown> = {
    version: 1;
    ok: true;
    value: T;
} | {
    version: 1;
    ok: false;
    error: {
        code: string;
        message: string;
    };
};
export declare class WorkerProtocolError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare function encodeRequest(request: WorkerRequest): string;
export declare function decodeRequest(encoded: string): WorkerRequest;
export declare function decodeResponse<T = unknown>(encoded: string): WorkerResponse<T>;
