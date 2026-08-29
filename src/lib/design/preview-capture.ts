import type {
  DesignBridgeCaptureResult,
  DesignReviewViewportName,
} from "./preview-bridge";

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
  prepareViewport,
  captureViewport,
  restore,
  onProgress,
  signal,
}: CollectDesignReviewCapturesOptions): Promise<DesignReviewCaptureCollection> {
  const captures: DesignBridgeCaptureResult[] = [];
  const errors: string[] = [];

  try {
    for (const [index, viewport] of DESIGN_REVIEW_VIEWPORTS.entries()) {
      signal?.throwIfAborted();
      onProgress?.(index, DESIGN_REVIEW_VIEWPORTS.length, viewport);
      try {
        await prepareViewport(viewport);
        signal?.throwIfAborted();
        captures.push(await captureViewport(viewport));
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(`${viewport.name}: ${errorMessage(error)}`);
      }
      onProgress?.(index + 1, DESIGN_REVIEW_VIEWPORTS.length, viewport);
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
