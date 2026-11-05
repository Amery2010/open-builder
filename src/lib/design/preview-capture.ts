import type {
  DesignBridgeCaptureResult,
  DesignReviewViewportName,
} from "./preview-bridge";
import { DESIGN_BRIDGE_TIMEOUT_ATTEMPTS } from "./preview-bridge";
import { PreviewRuntimeError } from "./preview-runtime";

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
  errorMessage: string;
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
    if (remaining <= 0) throw new Error(errorMessage);
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
    Math.abs(readiness.width - viewport.width) <= 4 &&
    Math.abs(readiness.height - viewport.height) <= 4
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
  captureRuntimePromise ??= import("html-to-image/dist/html-to-image.js?raw")
    .then((module) => module.default)
    .catch((error) => {
      captureRuntimePromise = null;
      throw error;
    });
  return captureRuntimePromise;
}
