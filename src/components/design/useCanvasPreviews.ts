import { useCallback, useEffect, useRef, useState } from "react";
import {
  createCanvasPreviewQueue,
  type CanvasPreviewQueue,
  type CanvasPreviewRequest,
  type CanvasPreviewSnapshot,
} from "../../lib/design/canvas-preview";
import type { DesignBridgeCaptureResult } from "../../lib/design/preview-bridge";

export function useCanvasPreviews({
  scopeKey,
  requests,
  paused,
  capture,
}: {
  scopeKey: string;
  requests: readonly CanvasPreviewRequest[];
  paused: boolean;
  capture: (
    request: CanvasPreviewRequest,
    signal: AbortSignal,
  ) => Promise<DesignBridgeCaptureResult>;
}) {
  const [previews, setPreviews] = useState<CanvasPreviewSnapshot>({});
  const queue = useRef<CanvasPreviewQueue | null>(null);
  const latest = useRef({ capture, requests, paused });
  latest.current = { capture, requests, paused };
  const priority = useRef<string[]>([]);
  useEffect(() => {
    let disposed = false;
    const current = createCanvasPreviewQueue({
      capture: (request, signal) => latest.current.capture(request, signal),
      onChange: (snapshot) => {
        if (!disposed)
          setPreviews((current) => {
            const keys = Object.keys(snapshot);
            return keys.length === Object.keys(current).length &&
              keys.every((key) => current[key] === snapshot[key])
              ? current
              : snapshot;
          });
      },
    });
    queue.current = current;
    current.setPaused(latest.current.paused);
    current.setRequests(latest.current.requests, priority.current);
    return () => {
      disposed = true;
      current.dispose();
      if (queue.current === current) queue.current = null;
    };
  }, [scopeKey]);
  useEffect(() => {
    queue.current?.setRequests(requests, priority.current);
  }, [requests]);
  useEffect(() => {
    queue.current?.setPaused(paused);
  }, [paused]);
  const onVisiblePages = useCallback((ids: string[]) => {
    priority.current = ids;
    queue.current?.setPriorityPages(ids);
  }, []);
  const retry = useCallback((key: string) => queue.current?.retry(key), []);
  return { previews, retry, onVisiblePages };
}
