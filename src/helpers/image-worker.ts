import { isMainThread, parentPort, workerData } from "node:worker_threads";

interface ImageWorkerData {
  readonly moduleUrl: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

async function runImageWorker(data: ImageWorkerData): Promise<void> {
  try {
    if (typeof data.moduleUrl !== "string" || !data.moduleUrl.startsWith("file://")) {
      throw new Error("Pi image worker module URL is invalid");
    }
    if (!(data.bytes instanceof Uint8Array) || typeof data.mimeType !== "string") {
      throw new Error("Pi image worker input is invalid");
    }
    const module = await import(data.moduleUrl) as { processImage?: unknown };
    if (typeof module.processImage !== "function") throw new Error("Pi image processor is unavailable");
    const value = await (module.processImage as (
      bytes: Buffer,
      mimeType: string,
      options: { autoResizeImages: boolean },
    ) => Promise<unknown>)(Buffer.from(data.bytes), data.mimeType, { autoResizeImages: true });
    parentPort?.postMessage({ ok: true, value });
  } catch (error: unknown) {
    const message = error instanceof Error && error.message.trim() !== ""
      ? error.message
      : "Pi image processor failed";
    parentPort?.postMessage({ ok: false, error: message });
  }
}

if (!isMainThread) await runImageWorker(workerData as ImageWorkerData);
