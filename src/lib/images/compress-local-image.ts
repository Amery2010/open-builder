import { isCompressibleImageMimeType } from "./formats";
import { normalizeImageCompressionQuality } from "./settings";
import type {
  CompressionWorkerRequest,
  CompressionWorkerResponse,
} from "./worker-protocol";

export interface ImageCompressionSettings {
  enabled: boolean;
  quality: number;
}

let queueTail: Promise<void> = Promise.resolve();
const WORKER_TIMEOUT_MS = 30_000;

function abortError(): DOMException {
  return new DOMException("Image compression was aborted.", "AbortError");
}

function enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let started = false;
  let cancelled = signal?.aborted ?? false;
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const onAbort = () => {
    if (started || cancelled) return;
    cancelled = true;
    rejectResult(abortError());
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (cancelled) rejectResult(abortError());

  const run = async () => {
    if (cancelled) return;
    started = true;
    signal?.removeEventListener("abort", onAbort);
    try {
      resolveResult(await task());
    } catch (error) {
      rejectResult(error);
    }
  };
  queueTail = queueTail.then(run, run).then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function runInWorker(
  file: File,
  quality: number,
  signal?: AbortSignal,
): Promise<CompressionWorkerResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./compress-local-image.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      resolve({ id: "", status: "unsupported" });
      return;
    }

    const id =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      settle(() => resolve({ id, status: "unsupported" }));
    }, WORKER_TIMEOUT_MS);
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => settle(() => reject(abortError()));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener(
      "message",
      (event: MessageEvent<CompressionWorkerResponse>) => {
        if (event.data.id !== id) return;
        settle(() => resolve(event.data));
      },
    );
    worker.addEventListener("error", () => {
      settle(() => resolve({ id, status: "unsupported" }));
    });

    const request: CompressionWorkerRequest = { id, file, quality };
    try {
      worker.postMessage(request);
    } catch {
      settle(() => resolve({ id, status: "unsupported" }));
    }
  });
}

async function compressSerially(
  file: File,
  quality: number,
  signal?: AbortSignal,
): Promise<File> {
  if (signal?.aborted) throw abortError();
  if (typeof Worker === "function") {
    const response = await runInWorker(file, quality, signal);
    if (response.status === "compressed") return response.file;
    if (response.status === "unchanged") return file;
  }

  const { compressImageOnce, ImageCompressionCapabilityError } =
    await import("./compression-core");
  try {
    const result = await compressImageOnce(file, quality, signal);
    return result.status === "compressed" ? result.file : file;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    if (error instanceof ImageCompressionCapabilityError) return file;
    return file;
  }
}

export async function compressLocalImage(
  file: File,
  settings: ImageCompressionSettings,
  signal?: AbortSignal,
): Promise<File> {
  if (signal?.aborted) throw abortError();
  if (!settings.enabled || !isCompressibleImageMimeType(file.type)) return file;
  const quality = normalizeImageCompressionQuality(settings.quality);
  return enqueue(() => compressSerially(file, quality, signal), signal);
}
