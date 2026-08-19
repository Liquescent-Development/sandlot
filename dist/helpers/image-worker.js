import { isMainThread, parentPort, workerData } from "node:worker_threads";
async function runImageWorker(data) {
    try {
        if (typeof data.moduleUrl !== "string" || !data.moduleUrl.startsWith("file://")) {
            throw new Error("Pi image worker module URL is invalid");
        }
        if (!(data.bytes instanceof Uint8Array) || typeof data.mimeType !== "string") {
            throw new Error("Pi image worker input is invalid");
        }
        const module = await import(data.moduleUrl);
        if (typeof module.processImage !== "function")
            throw new Error("Pi image processor is unavailable");
        const value = await module.processImage(Buffer.from(data.bytes), data.mimeType, { autoResizeImages: true });
        parentPort?.postMessage({ ok: true, value });
    }
    catch (error) {
        const message = error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "Pi image processor failed";
        parentPort?.postMessage({ ok: false, error: message });
    }
}
if (!isMainThread)
    await runImageWorker(workerData);
