import type {
  DesignBridgeCaptureResult,
  DesignReviewViewportName,
} from "./preview-bridge";
import {
  DESIGN_BRIDGE_TIMEOUT_ATTEMPTS,
  DESIGN_CAPTURE_RUNTIME_GLOBAL,
  isPreviewViewportSize,
} from "./preview-bridge";
import { PreviewRuntimeError } from "./preview-runtime";

class PreviewReadinessTimeoutError extends Error {}

/** Keep waiting for the same preview operation across three timeout windows. */
export async function waitForPreviewReadiness({
  isReady,
  isCurrent = () => true,
  signal,
  timeoutMs,
  errorMessage,
  pollIntervalMs = 25,
}: {
  isReady: () => boolean;
  isCurrent?: () => boolean;
  signal: AbortSignal;
  timeoutMs: number;
  errorMessage: string | (() => string);
  pollIntervalMs?: number;
}): Promise<void> {
  const deadline =
    performance.now() + timeoutMs * DESIGN_BRIDGE_TIMEOUT_ATTEMPTS;
  for (;;) {
    signal.throwIfAborted();
    if (!isCurrent()) {
      throw new PreviewRuntimeError(
        "stale_generation",
        "Preview generation was replaced.",
      );
    }
    if (isReady()) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new PreviewReadinessTimeoutError(
        typeof errorMessage === "function" ? errorMessage() : errorMessage,
      );
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        Math.min(pollIntervalMs, remaining),
      );
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

/** Recover a stalled delivery once, without replacing the mounted capture adapter. */
export async function waitForPreviewSynchronization({
  isReady,
  canRestart,
  restart,
  isCurrent,
  signal,
  timeoutMs,
}: {
  isReady: () => boolean;
  canRestart: () => boolean;
  restart: () => Promise<void>;
  isCurrent: () => boolean;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<void> {
  try {
    await waitForPreviewReadiness({
      isReady,
      isCurrent,
      signal,
      timeoutMs,
      errorMessage:
        "Screenshot runtime has not reached the current preview client.",
    });
    return;
  } catch (error) {
    signal.throwIfAborted();
    if (!isCurrent()) {
      throw new PreviewRuntimeError(
        "stale_generation",
        "Preview generation was replaced.",
      );
    }
    if (!(error instanceof PreviewReadinessTimeoutError) || !canRestart())
      throw error;
  }

  let restarted = false;
  let restartError: Error | undefined;
  // The readiness deadline includes client creation. Sandpack cannot cancel
  // it, so handle late settlements without resuming an ended capture.
  void Promise.resolve()
    .then(() => {
      signal.throwIfAborted();
      if (!isCurrent()) {
        throw new PreviewRuntimeError(
          "stale_generation",
          "Preview generation was replaced.",
        );
      }
      return restart();
    })
    .then(
      () => {
        restarted = true;
      },
      (error: unknown) => {
        restartError = new Error(
          `Preview client restart failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  await waitForPreviewReadiness({
    isReady: () => {
      if (restartError) throw restartError;
      return restarted && isReady();
    },
    isCurrent,
    signal,
    timeoutMs,
    errorMessage:
      "Screenshot runtime is still not synchronized after restarting the preview client.",
  });
}

export interface DesignReviewViewport {
  name: DesignReviewViewportName;
  width: number;
  height: number;
}

interface DesignReviewPreviewReadiness {
  bridgeReady: boolean;
  captureRuntimeReady: boolean;
  width?: number;
  height?: number;
}

export function isDesignReviewViewportReady(
  readiness: DesignReviewPreviewReadiness,
  viewport: DesignReviewViewport,
): boolean {
  return (
    readiness.bridgeReady &&
    readiness.captureRuntimeReady &&
    readiness.width !== undefined &&
    readiness.height !== undefined &&
    isPreviewViewportSize(viewport.name, readiness.width, readiness.height)
  );
}

export const DESIGN_REVIEW_VIEWPORTS: readonly DesignReviewViewport[] = [
  { name: "desktop", width: 1_440, height: 900 },
  { name: "tablet", width: 768, height: 1_024 },
  { name: "mobile", width: 375, height: 667 },
] as const;

export interface DesignReviewCaptureCollection {
  captures: DesignBridgeCaptureResult[];
  errors: string[];
}

interface CollectDesignReviewCapturesOptions {
  viewports?: readonly DesignReviewViewport[];
  prepareViewport: (viewport: DesignReviewViewport) => Promise<void>;
  captureViewport: (
    viewport: DesignReviewViewport,
  ) => Promise<DesignBridgeCaptureResult>;
  restore: () => Promise<void> | void;
  onProgress?: (
    completed: number,
    total: number,
    viewport: DesignReviewViewport,
  ) => void;
  signal?: AbortSignal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectDesignReviewCaptures({
  viewports = DESIGN_REVIEW_VIEWPORTS,
  prepareViewport,
  captureViewport,
  restore,
  onProgress,
  signal,
}: CollectDesignReviewCapturesOptions): Promise<DesignReviewCaptureCollection> {
  const captures: DesignBridgeCaptureResult[] = [];
  const errors: string[] = [];

  try {
    for (const [index, viewport] of viewports.entries()) {
      signal?.throwIfAborted();
      onProgress?.(index, viewports.length, viewport);
      try {
        await prepareViewport(viewport);
        signal?.throwIfAborted();
        captures.push(await captureViewport(viewport));
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(`${viewport.name}: ${errorMessage(error)}`);
      }
      onProgress?.(index + 1, viewports.length, viewport);
    }
  } finally {
    await restore();
  }

  return { captures, errors };
}

let captureRuntimePromise: Promise<string> | null = null;

export function loadDesignCaptureRuntimeSource(): Promise<string> {
  captureRuntimePromise ??= Promise.all([
    import("html-to-image/dist/html-to-image.js?raw"),
    import("./capture-canvas-adapter.js?raw"),
  ])
    .then(
      ([module, adapter]) => `;(function () {
  var captureExports = {};
  (function (exports, module, define) {
${module.default.replace(/\n?\/\/# sourceMappingURL=.*$/m, "")}
  })(captureExports, { exports: captureExports }, undefined);
${adapter.default.replace(/^export default /m, "")}
  installCaptureCanvasAdapter(captureExports);
  globalThis[${JSON.stringify(DESIGN_CAPTURE_RUNTIME_GLOBAL)}] = captureExports;
  if (typeof globalThis.dispatchEvent === "function") {
    globalThis.dispatchEvent(new Event("open-builder:capture-runtime-ready"));
  }
})();\n`,
    )
    .catch((error) => {
      captureRuntimePromise = null;
      throw error;
    });
  return captureRuntimePromise;
}
