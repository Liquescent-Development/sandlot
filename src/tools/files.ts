import {
  DEFAULT_MAX_BYTES,
  formatSize,
  createEditTool,
  createEditToolDefinition,
  createLsTool,
  createLsToolDefinition,
  createReadTool,
  createReadToolDefinition,
  createWriteTool,
  createWriteToolDefinition,
  getPackageDir,
  truncateHead,
  type EditOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { buildOuterEnvironment } from "../environment.js";
import type { AtomicImageRead, FileWorkerCallContext, FileWorkerClient } from "../helpers/file-worker.js";
import type { RuntimeController, RuntimeSnapshot } from "../runtime.js";

export interface FileToolDependencies {
  readonly client: FileWorkerClient;
  readonly runtime: Pick<RuntimeController, "snapshot">;
  /** Optional test boundary, invoked only after explicit user disable. */
  readonly createLocalReadOperations?: () => ReadOperations;
  /** Optional test boundary, invoked only after explicit user disable. */
  readonly createLocalWriteOperations?: () => WriteOperations;
  /** Optional test boundary, invoked only after explicit user disable. */
  readonly createLocalEditOperations?: () => EditOperations;
  /** Optional test boundary, invoked only after explicit user disable. */
  readonly createLocalLsOperations?: () => LsOperations;
  /** Trusted test seam; production uses the pinned Pi image processor. */
  readonly processImage?: SandlotImageProcessor;
}

export interface FileOperations {
  readonly read: ReadOperations & { readImage(path: string): Promise<AtomicImageRead> };
  readonly write: WriteOperations;
  readonly edit: EditOperations;
  readonly ls: LsOperations;
}

/**
 * Pi's operations are deliberately small transport seams. Keeping all file IO
 * here means Pi retains its native path resolution, limits, edit queue, and
 * rendered result shapes while the worker retains the sandbox boundary.
 */
export function createFileOperations(client: FileWorkerClient, context?: FileWorkerCallContext): FileOperations {
  return {
    read: {
      readFile: (path) => client.read(path, context),
      access: (path) => client.access(path, "read", context),
      detectImageMimeType: (path) => client.mime(path, context),
      readImage: (path) => client.readImage(path, context),
    },
    write: {
      writeFile: (path, content) => client.write(path, content, true, context),
      mkdir: (path) => client.mkdir(path, true, context),
    },
    edit: {
      readFile: (path) => client.read(path, context),
      access: (path) => client.access(path, "write", context),
      writeFile: (path, content) => client.write(path, content, false, context),
    },
    ls: {
      exists: (path) => client.exists(path, context),
      stat: async (path) => {
        const value = await client.stat(path, context);
        return { isDirectory: () => value.kind === "directory" };
      },
      readdir: (path) => client.readdir(path, context),
    },
  };
}

/** Preserves Pi's registered read definition, binding its execution cwd late. */
export function createSandlotReadTool(dependencies: FileToolDependencies): ReturnType<typeof createReadToolDefinition> {
  const operations = createFileOperations(dependencies.client).read;
  const definition = createReadToolDefinition(process.cwd(), { operations });
  return {
    ...definition,
    async execute(toolCallId, input, signal, onUpdate, context) {
      const snapshot = dependencies.runtime.snapshot();
      if (snapshot.state === "disabled-by-user") {
        return executeWithPiContext(
          createLocalReadTool(context.cwd, dependencies.createLocalReadOperations),
          toolCallId,
          input,
          signal,
          onUpdate,
          context,
        );
      }
      throwIfAborted(signal);
      try {
        const result = await executeReadyReadWithAbort(
          input,
          context.cwd,
          signal,
          createFileOperations(dependencies.client, captureWorkerContext(snapshot, toolCallId, signal)).read,
          context,
          dependencies.processImage ?? processImageWithPinnedPi,
        ) as Awaited<ReturnType<typeof definition.execute>>;
        const current = dependencies.runtime.snapshot();
        if (current.state !== "ready" || current.generation !== snapshot.generation) {
          throw new Error(`Sandlot runtime stale generation for ${toolCallId}`);
        }
        return result;
      } catch (error) {
        if (signal?.aborted) throw new Error("Operation aborted");
        throw error;
      }
    },
  };
}

/** Preserves Pi's registered write definition, binding its execution cwd late. */
export function createSandlotWriteTool(dependencies: FileToolDependencies): ReturnType<typeof createWriteToolDefinition> {
  const operations = createFileOperations(dependencies.client).write;
  const definition = createWriteToolDefinition(process.cwd(), { operations });
  return {
    ...definition,
    async execute(toolCallId, input, signal, onUpdate, context) {
      const snapshot = dependencies.runtime.snapshot();
      const tool = snapshot.state === "disabled-by-user"
        ? createLocalWriteTool(context.cwd, dependencies.createLocalWriteOperations)
        : createReadyWriteTool(context.cwd, dependencies.client, captureWorkerContext(snapshot, toolCallId, signal));
      return executeWithPiContext(tool, toolCallId, input, signal, onUpdate, context);
    },
  };
}

/** Preserves Pi's edit factory, including its process-wide mutation queue. */
export function createSandlotEditTool(dependencies: FileToolDependencies): ReturnType<typeof createEditToolDefinition> {
  const operations = createFileOperations(dependencies.client).edit;
  const definition = createEditToolDefinition(process.cwd(), { operations });
  return {
    ...definition,
    async execute(toolCallId, input, signal, onUpdate, context) {
      const snapshot = dependencies.runtime.snapshot();
      const tool = snapshot.state === "disabled-by-user"
        ? createLocalEditTool(context.cwd, dependencies.createLocalEditOperations)
        : createReadyEditTool(context.cwd, dependencies.client, captureWorkerContext(snapshot, toolCallId, signal));
      return executeWithPiContext(tool, toolCallId, input, signal, onUpdate, context);
    },
    // Pi's edit preview reads model-controlled paths through host fs before
    // execute. Keep the native renderer but mark partial args to suppress that
    // speculative preview; execution-produced diffs still reach renderResult.
    renderCall(args, theme, context) {
      if (definition.renderCall === undefined) throw new Error("Pi edit renderer is unavailable");
      return definition.renderCall(args, theme, { ...context, argsComplete: false });
    },
  };
}

/** Preserves Pi's registered ls definition, binding its execution cwd late. */
export function createSandlotLsTool(dependencies: FileToolDependencies): ReturnType<typeof createLsToolDefinition> {
  const operations = createFileOperations(dependencies.client).ls;
  const definition = createLsToolDefinition(process.cwd(), { operations });
  return {
    ...definition,
    async execute(toolCallId, input, signal, onUpdate, context) {
      const snapshot = dependencies.runtime.snapshot();
      const tool = snapshot.state === "disabled-by-user"
        ? createLocalLsTool(context.cwd, dependencies.createLocalLsOperations)
        : createReadyLsTool(context.cwd, dependencies.client, captureWorkerContext(snapshot, toolCallId, signal));
      return executeWithPiContext(tool, toolCallId, input, signal, onUpdate, context);
    },
  };
}

function captureWorkerContext(snapshot: RuntimeSnapshot, toolCallId: string, signal: AbortSignal | undefined): FileWorkerCallContext {
  if (snapshot.state !== "ready") throw new Error(`Sandlot runtime is not ready (${snapshot.state})`);
  let childCount = 0;
  return {
    expectedGeneration: snapshot.generation,
    signal,
    nextInvocationId: () => {
      const childIndex = childCount++;
      return childIndex === 0 ? toolCallId : `${toolCallId}:${childIndex}`;
    },
  };
}

function createReadyWriteTool(cwd: string, client: FileWorkerClient, context: FileWorkerCallContext) {
  return createWriteTool(cwd, { operations: createFileOperations(client, context).write });
}

interface SandlotReadInput {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface PiImageProcessResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly hints?: readonly string[];
}
export type SandlotImageProcessor = (
  bytes: Buffer,
  mimeType: string,
  options?: { readonly signal?: AbortSignal },
) => Promise<PiImageProcessResult>;
export interface PinnedPiImagePaths {
  readonly piPackageRoot: string;
  readonly piVersion: "0.84.2";
  readonly hostAnchored: true;
  readonly imageModuleCount: 7;
  readonly imageProcessorPath: string;
  readonly photonEntryPath: string;
  readonly photonWasmPath: string;
}
export interface ImageProcessorWorkerOptions {
  readonly moduleUrl: string;
  readonly bytes: Buffer;
  readonly mimeType: string;
}

export interface ImageProcessorWorkerLike {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  off(event: "message", listener: (message: unknown) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

type ImageProcessorWorkerFactory = (options: ImageProcessorWorkerOptions) => ImageProcessorWorkerLike;

interface ActiveImageExecution {
  readonly completion: Promise<PiImageProcessResult>;
  abort(): Promise<void>;
}

/** Session-bound importer: initialization supplies the already validated canonical module. */
export class PinnedPiImageProcessor {
  #moduleUrl: string | undefined;
  readonly #active = new Set<ActiveImageExecution>();

  constructor(private readonly createWorker: ImageProcessorWorkerFactory = createImageProcessorWorker) {}

  bind(imageProcessorPath: string): void {
    if (!isAbsolute(imageProcessorPath)) throw new Error("Validated Pi image processor path must be absolute");
    const moduleUrl = pathToFileURL(imageProcessorPath).href;
    if (this.#moduleUrl === moduleUrl) return;
    this.#moduleUrl = moduleUrl;
  }

  clear(): void {
    this.#moduleUrl = undefined;
  }

  readonly process: SandlotImageProcessor = async (bytes, mimeType, options = {}) => {
    const moduleUrl = this.#moduleUrl;
    if (moduleUrl === undefined) {
      throw new Error("Pi image processor is not bound to the validated Sandlot session graph");
    }
    const execution = this.startExecution(this.createWorker({ moduleUrl, bytes, mimeType }), options.signal);
    this.#active.add(execution);
    try {
      return await execution.completion;
    } finally {
      this.#active.delete(execution);
    }
  };

  async abortAll(): Promise<void> {
    const active = [...this.#active];
    const terminations = await Promise.allSettled(active.map((execution) => execution.abort()));
    await Promise.allSettled(active.map((execution) => execution.completion));
    const failure = terminations.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }

  private startExecution(worker: ImageProcessorWorkerLike, signal: AbortSignal | undefined): ActiveImageExecution {
    let settled = false;
    let aborted = false;
    let received: { ok: true; value: PiImageProcessResult } | { ok: false; error: Error } | undefined;
    let terminatePromise: Promise<number> | undefined;
    let resolveCompletion!: (value: PiImageProcessResult) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<PiImageProcessResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onSignalAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const reject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectCompletion(error);
    };
    const resolve = (value: PiImageProcessResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveCompletion(value);
    };
    const abort = async (): Promise<void> => {
      if (settled) return;
      aborted = true;
      try {
        await (terminatePromise ??= worker.terminate());
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      reject(new Error("Operation aborted"));
    };
    const onSignalAbort = (): void => { void abort().catch(() => undefined); };
    const onMessage = (message: unknown): void => {
      received = parseImageWorkerResponse(message);
    };
    const onError = (error: Error): void => reject(error);
    const onExit = (code: number): void => {
      if (aborted) return;
      if (code !== 0) {
        reject(new Error(`Pi image worker exited with code ${code}`));
      } else if (received === undefined) {
        reject(new Error("Pi image worker exited without a response"));
      } else if (received.ok) {
        resolve(received.value);
      } else {
        reject(received.error);
      }
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    signal?.addEventListener("abort", onSignalAbort, { once: true });
    if (signal?.aborted) onSignalAbort();
    return { completion, abort };
  }
}

function createImageProcessorWorker(options: ImageProcessorWorkerOptions): ImageProcessorWorkerLike {
  return new Worker(new URL("../helpers/image-worker.js", import.meta.url), {
    workerData: options,
    env: buildOuterEnvironment(process.platform, process.env),
  });
}

function parseImageWorkerResponse(
  message: unknown,
): { ok: true; value: PiImageProcessResult } | { ok: false; error: Error } {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return { ok: false, error: new Error("Pi image worker returned an invalid response") };
  }
  const record = message as Record<string, unknown>;
  if (record.ok === true && typeof record.value === "object" && record.value !== null) {
    return { ok: true, value: record.value as PiImageProcessResult };
  }
  if (record.ok === false && typeof record.error === "string" && record.error.trim() !== "") {
    return { ok: false, error: new Error(record.error) };
  }
  return { ok: false, error: new Error("Pi image worker returned an invalid response") };
}

export const pinnedPiImageProcessor = new PinnedPiImageProcessor();
/**
 * Executes Pi's observable read behavior without Pi's pre-operation host
 * `resolveReadPathAsync()` probing. All model-path I/O begins at `operations`.
 */
async function executeReadyRead(
  input: SandlotReadInput,
  cwd: string,
  signal: AbortSignal | undefined,
  operations: ReadOperations,
  context: unknown,
  processImage: SandlotImageProcessor,
): Promise<unknown> {
  throwIfAborted(signal);
  const absolutePath = resolveReadPathLexically(input.path, cwd);
  await operations.access(absolutePath);
  throwIfAborted(signal);
  const atomicRead = await (operations as ReadOperations & { readImage(path: string): Promise<AtomicImageRead> })
    .readImage(absolutePath);
  const { bytes: buffer, mimeType } = atomicRead;
  const nonVisionImageNote = getNonVisionImageNote(context);

  if (mimeType) {
    throwIfAborted(signal);
    const processed = await processImage(buffer, mimeType, { signal });
    throwIfAborted(signal);
    if (!processed.ok || processed.data === undefined || processed.mimeType === undefined || processed.hints === undefined) {
      let text = `Read image file [${mimeType}]\n${processed.message ?? "[Image omitted: could not be processed.]"}`;
      if (nonVisionImageNote !== undefined) text += `\n${nonVisionImageNote}`;
      return { content: [{ type: "text", text }], details: undefined };
    }
    let text = `Read image file [${processed.mimeType}]`;
    if (processed.hints.length > 0) text += `\n${processed.hints.join("\n")}`;
    if (nonVisionImageNote !== undefined) text += `\n${nonVisionImageNote}`;
    return {
      content: [
        { type: "text", text },
        { type: "image", data: processed.data, mimeType: processed.mimeType },
      ],
      details: undefined,
    };
  }

  throwIfAborted(signal);
  const allLines = buffer.toString("utf-8").split("\n");
  const totalFileLines = allLines.length;
  const startLine = input.offset ? Math.max(0, input.offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) {
    throw new Error(`Offset ${input.offset} is beyond end of file (${allLines.length} lines total)`);
  }
  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (input.limit !== undefined) {
    const endLine = Math.min(startLine + input.limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }
  const truncation = truncateHead(selectedContent);
  let text: string;
  let details: { truncation: ReturnType<typeof truncateHead> } | undefined;
  if (truncation.firstLineExceedsLimit) {
    text = `[Line ${startLineDisplay} is ${formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"))}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${input.path} | head -c ${DEFAULT_MAX_BYTES}]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    text = truncation.content;
    text += truncation.truncatedBy === "lines"
      ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
      : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    text = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    text = truncation.content;
  }
  return { content: [{ type: "text", text }], details };
}

async function executeReadyReadWithAbort(
  input: SandlotReadInput,
  cwd: string,
  signal: AbortSignal | undefined,
  operations: ReadOperations,
  context: unknown,
  processImage: SandlotImageProcessor,
): Promise<unknown> {
  throwIfAborted(signal);
  return executeReadyRead(input, cwd, signal, operations, context, processImage);
}

function resolveReadPathLexically(input: string, cwd: string): string {
  let value = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = homedir();
  else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
  if (value.startsWith("file://")) value = fileURLToPath(value);
  return isAbsolute(value) ? resolvePath(value) : resolvePath(cwd, value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

function getNonVisionImageNote(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null || !("model" in context)) return undefined;
  const model = context.model;
  if (typeof model !== "object" || model === null || !("input" in model) || !Array.isArray(model.input)) return undefined;
  return model.input.includes("image") ? undefined : "[Current model does not support images. The image will be omitted from this request.]";
}

async function processImageWithPinnedPi(bytes: Buffer, mimeType: string): Promise<PiImageProcessResult> {
  return pinnedPiImageProcessor.process(bytes, mimeType);
}

/** Resolve every package entry that Pi's image pipeline loads after a read. */
export function resolvePinnedPiImagePaths(piPackageDirectory?: string): PinnedPiImagePaths {
  let piPackageRoot: string;
  try {
    piPackageRoot = realpathSync(resolvePath(piPackageDirectory ?? getPackageDir()));
  } catch (error: unknown) {
    throw pinnedImageGraphError("Pinned host Pi package", error);
  }
  assertPackageMetadata(
    join(piPackageRoot, "package.json"),
    "@earendil-works/pi-coding-agent",
    "0.84.2",
    "Pinned host Pi package",
  );
  const imageModules = [
    "image-process.js",
    "image-convert.js",
    "image-resize.js",
    "image-resize-core.js",
    "image-resize-worker.js",
    "exif-orientation.js",
    "photon.js",
  ].map((name) => requiredHostGraphFile(join(piPackageRoot, "dist", "utils", name), `Pinned Pi image module ${name}`));
  const photonPackageRoot = join(
    piPackageRoot,
    "node_modules",
    "@silvia-odwyer",
    "photon-node",
  );
  assertPackageMetadata(
    join(photonPackageRoot, "package.json"),
    "@silvia-odwyer/photon-node",
    "0.3.4",
    "Pinned Photon package",
  );
  const photonEntryPath = requiredHostGraphFile(
    join(photonPackageRoot, "photon_rs.js"),
    "Pinned Photon image module",
  );
  const photonWasmPath = requiredHostGraphFile(
    join(photonPackageRoot, "photon_rs_bg.wasm"),
    "Pinned Photon WASM",
  );
  return Object.freeze({
    piPackageRoot,
    piVersion: "0.84.2",
    hostAnchored: true,
    imageModuleCount: 7,
    imageProcessorPath: imageModules[0]!,
    photonEntryPath,
    photonWasmPath,
  });
}

function assertPackageMetadata(
  packageJsonPath: string,
  expectedName: string,
  expectedVersion: string,
  label: string,
): void {
  const canonicalPath = requiredHostGraphFile(packageJsonPath, `${label} metadata`);
  let metadata: { name?: unknown; version?: unknown };
  try {
    metadata = JSON.parse(readFileSync(canonicalPath, "utf8")) as typeof metadata;
  } catch (error: unknown) {
    throw pinnedImageGraphError(`${label} metadata`, error);
  }
  if (metadata.name !== expectedName || metadata.version !== expectedVersion) {
    throw new Error(
      `${label} must be ${expectedName}@${expectedVersion}; reinstall the exact pinned Pi 0.84.2 host package`,
    );
  }
}

function requiredHostGraphFile(path: string, label: string): string {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error: unknown) {
    throw pinnedImageGraphError(label, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file in the pinned host Pi package graph: ${path}`);
  }
  const canonical = realpathSync(path);
  if (canonical !== path) {
    throw new Error(`${label} escaped its canonical pinned host Pi package graph: ${canonical}`);
  }
  return canonical;
}

function pinnedImageGraphError(label: string, cause: unknown): Error {
  return new Error(
    `${label} is unavailable in the pinned host image graph; reinstall @earendil-works/pi-coding-agent@0.84.2 and restart Pi`,
    { cause },
  );
}

function createReadyEditTool(cwd: string, client: FileWorkerClient, context: FileWorkerCallContext) {
  return createEditTool(cwd, { operations: createFileOperations(client, context).edit });
}

function createReadyLsTool(cwd: string, client: FileWorkerClient, context: FileWorkerCallContext) {
  return createLsTool(cwd, { operations: createFileOperations(client, context).ls });
}

function createLocalReadTool(cwd: string, createOperations: (() => ReadOperations) | undefined) {
  return createOperations === undefined ? createReadTool(cwd) : createReadTool(cwd, { operations: createOperations() });
}

function createLocalWriteTool(cwd: string, createOperations: (() => WriteOperations) | undefined) {
  return createOperations === undefined ? createWriteTool(cwd) : createWriteTool(cwd, { operations: createOperations() });
}

function createLocalEditTool(cwd: string, createOperations: (() => EditOperations) | undefined) {
  return createOperations === undefined ? createEditTool(cwd) : createEditTool(cwd, { operations: createOperations() });
}

function createLocalLsTool(cwd: string, createOperations: (() => LsOperations) | undefined) {
  return createOperations === undefined ? createLsTool(cwd) : createLsTool(cwd, { operations: createOperations() });
}

/** Pi's runtime wrapper accepts context at runtime although its AgentTool type omits it. */
function executeWithPiContext<T>(
  tool: { readonly execute: unknown },
  toolCallId: string,
  input: unknown,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  context: unknown,
): Promise<T> {
  return (tool.execute as (
    id: string,
    args: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown,
  ) => Promise<T>)(toolCallId, input, signal, onUpdate, context);
}
