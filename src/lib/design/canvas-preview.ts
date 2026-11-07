import type { DesignBridgeCaptureResult } from "./preview-bridge";
import type { DesignReviewViewport } from "./preview-capture";
import {
  PreviewRuntimeError,
  type PrototypePreviewTarget,
} from "./preview-runtime";

/** The key includes checkout, generation, target, and viewport identity. */
export interface CanvasPreviewRequest {
  key: string;
  pageId: string;
  target?: PrototypePreviewTarget;
  viewport: DesignReviewViewport;
}

export interface CanvasPreviewState {
  status: "queued" | "loading" | "ready" | "error";
  result?: DesignBridgeCaptureResult;
  error?: string;
}

export type CanvasPreviewSnapshot = Readonly<
  Record<string, CanvasPreviewState>
>;

export interface CanvasPreviewQueue {
  setRequests: (
    requests: readonly CanvasPreviewRequest[],
    priorityPageIds?: readonly string[],
  ) => void;
  setPriorityPages: (pageIds: readonly string[]) => void;
  setPaused: (paused: boolean) => void;
  retry: (key: string) => void;
  dispose: () => void;
}

const CAPTURE_RETRY_DELAY_MS = 150;

/**
 * Display-only captures. This module never publishes Preview Evidence or Review
 * Coverage. One callback owns capture and its cleanup; cancellation waits for
 * that callback to settle before another request starts.
 */
export function createCanvasPreviewQueue(options: {
  capture: (
    request: CanvasPreviewRequest,
    signal: AbortSignal,
  ) => Promise<DesignBridgeCaptureResult>;
  onChange: (snapshot: CanvasPreviewSnapshot) => void;
}): CanvasPreviewQueue {
  let requests = new Map<string, CanvasPreviewRequest>();
  let states = new Map<string, CanvasPreviewState>();
  let priorityPages = new Set<string>();
  let active: { key: string; controller: AbortController } | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  let disposed = false;

  const publish = () => {
    if (!disposed) options.onChange(Object.fromEntries(states));
  };
  const cancelRetry = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const pump = () => {
    if (disposed || paused || active || retryTimer !== undefined) return;
    const pending = [...requests.values()].filter(
      (request) => states.get(request.key)?.status === "queued",
    );
    const request =
      pending.find((candidate) => priorityPages.has(candidate.pageId)) ??
      pending[0];
    if (!request) return;
    const task = { key: request.key, controller: new AbortController() };
    active = task;
    states.set(request.key, { status: "loading" });
    publish();
    void (async () => {
      let retryLater = false;
      try {
        task.controller.signal.throwIfAborted();
        const result = await options.capture(request, task.controller.signal);
        task.controller.signal.throwIfAborted();
        if (!disposed && requests.get(request.key) === request) {
          states.set(request.key, { status: "ready", result });
        }
      } catch (error) {
        if (!disposed && requests.get(request.key) === request) {
          const interrupted =
            task.controller.signal.aborted ||
            (error instanceof Error && error.name === "AbortError") ||
            (error instanceof PreviewRuntimeError &&
              error.code === "capture_busy");
          if (interrupted) {
            states.set(request.key, { status: "queued" });
            retryLater = !paused;
          } else {
            states.set(request.key, {
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        active = undefined;
        publish();
        if (!disposed && !paused && retryLater) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            pump();
          }, CAPTURE_RETRY_DELAY_MS);
        } else {
          pump();
        }
      }
    })();
  };

  return {
    setRequests(next, priorityPageIds) {
      if (disposed) return;
      // Stable request objects let an in-flight capture survive harmless React
      // rerenders. A removed key can never accept an earlier request's result.
      const nextRequests = new Map(
        next.map((request) => [
          request.key,
          requests.get(request.key) ?? request,
        ]),
      );
      states = new Map(
        next.map(({ key }) => [key, states.get(key) ?? { status: "queued" }]),
      );
      requests = nextRequests;
      if (priorityPageIds) priorityPages = new Set(priorityPageIds);
      if (active && !requests.has(active.key)) active.controller.abort();
      publish();
      pump();
    },
    setPriorityPages(pageIds) {
      if (disposed) return;
      priorityPages = new Set(pageIds);
      pump();
    },
    setPaused(next) {
      if (disposed || paused === next) return;
      paused = next;
      if (paused) {
        cancelRetry();
        active?.controller.abort();
      } else {
        pump();
      }
    },
    retry(key) {
      if (disposed || !requests.has(key)) return;
      if (active?.key === key) return;
      states.set(key, { status: "queued" });
      cancelRetry();
      publish();
      pump();
    },
    dispose() {
      disposed = true;
      cancelRetry();
      active?.controller.abort();
      requests.clear();
      states.clear();
    },
  };
}
