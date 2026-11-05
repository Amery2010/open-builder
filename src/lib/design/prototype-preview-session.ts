import {
  createDesignBridgeNonce,
  DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS,
  DESIGN_BRIDGE_TIMEOUT_ATTEMPTS,
  DESIGN_BRIDGE_PROTOCOL_VERSION,
  getDesignBridgeTargetOrigin,
  isDesignBridgeOriginAllowed,
  parseDesignBridgeCaptureResponse,
  parseDesignBridgeNavigationResponse,
  type DesignBridgeCaptureExpectation,
  type DesignBridgeCaptureResult,
  type DesignBridgeNavigationExpectation,
  type DesignBridgeParentMessage,
} from "./preview-bridge";
import type { DesignReviewViewport } from "./preview-capture";
import {
  PreviewRuntimeError,
  type PrototypePreviewTarget,
} from "./preview-runtime";

export interface IsolatedPreviewSession {
  setViewport: (viewport: DesignReviewViewport) => Promise<void>;
  navigate: (target: PrototypePreviewTarget) => Promise<PrototypePreviewTarget>;
  capture: (
    viewport: DesignReviewViewport,
    target: PrototypePreviewTarget,
  ) => Promise<DesignBridgeCaptureResult>;
  dispose: () => void;
}

function afterIsolatedPreviewPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 100);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

/**
 * Creates a disposable preview used only for deterministic review capture.
 * It deliberately clones the active preview instead of navigating it, so a
 * review cannot mutate the user's current route or shared mock-data session.
 */
export function createIsolatedPreviewSession(
  source: HTMLIFrameElement,
  generation: string,
  signal: AbortSignal,
): Promise<IsolatedPreviewSession> {
  const targetOrigin = getDesignBridgeTargetOrigin(
    source.src,
    window.location.href,
  );
  if (!targetOrigin) {
    return Promise.reject(new Error("Preview iframe origin is invalid."));
  }

  const frame = source.cloneNode(false) as HTMLIFrameElement;
  frame.removeAttribute("id");
  frame.removeAttribute("name");
  frame.title = "Temporary prototype review preview";
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: "fixed",
    left: "-20000px",
    top: "0",
    width: "1440px",
    height: "900px",
    border: "0",
    opacity: "0.01",
    pointerEvents: "none",
  });
  const lifecycle = new AbortController();
  const sessionSignal = lifecycle.signal;
  const dispose = () => {
    lifecycle.abort();
    signal.removeEventListener("abort", dispose);
    frame.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  const invalidateGeneration = () => {
    lifecycle.abort(
      new PreviewRuntimeError(
        "stale_generation",
        "Preview generation was replaced.",
      ),
    );
    dispose();
  };

  const generationReplaced = (event: MessageEvent) => {
    const message = event.data as DesignBridgeParentMessage | undefined;
    return (
      message?.type === "open-builder:design-bridge-ready" &&
      message.version === DESIGN_BRIDGE_PROTOCOL_VERSION &&
      typeof message.generation === "string" &&
      message.generation !== generation
    );
  };

  const request = <T>(
    expectation:
      DesignBridgeNavigationExpectation | DesignBridgeCaptureExpectation,
    message: Record<string, unknown>,
    parse: (
      event: MessageEvent,
    ) => { ok: true; value: T } | { ok: false; error: Error } | null,
  ) =>
    new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        sessionSignal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(sessionSignal.reason);
      };
      const onMessage = (event: MessageEvent) => {
        if (
          event.source !== frame.contentWindow ||
          !isDesignBridgeOriginAllowed(
            frame.src,
            window.location.href,
            event.origin,
          )
        ) {
          return;
        }
        if (generationReplaced(event)) {
          invalidateGeneration();
          return;
        }
        const parsed = parse(event);
        if (!parsed) return;
        cleanup();
        if (parsed.ok) resolve(parsed.value);
        else reject(parsed.error);
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("Temporary prototype preview request timed out."));
      }, DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS * DESIGN_BRIDGE_TIMEOUT_ATTEMPTS);
      window.addEventListener("message", onMessage);
      sessionSignal.addEventListener("abort", onAbort, { once: true });
      if (sessionSignal.aborted) {
        onAbort();
        return;
      }
      frame.contentWindow?.postMessage(message, targetOrigin);
      void expectation;
    });

  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      sessionSignal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      frame.remove();
      reject(sessionSignal.reason);
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.source !== frame.contentWindow ||
        !isDesignBridgeOriginAllowed(
          frame.src,
          window.location.href,
          event.origin,
        )
      ) {
        return;
      }
      if (generationReplaced(event)) {
        invalidateGeneration();
        return;
      }
      const message = event.data as DesignBridgeParentMessage | undefined;
      if (
        message?.type !== "open-builder:design-bridge-ready" ||
        message.version !== DESIGN_BRIDGE_PROTOCOL_VERSION ||
        message.generation !== generation ||
        message.captureRuntimeAvailable !== true
      ) {
        return;
      }
      cleanup();
      resolve();
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      frame.remove();
      reject(new Error("Temporary prototype preview did not become ready."));
    }, DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS * DESIGN_BRIDGE_TIMEOUT_ATTEMPTS);
    window.addEventListener("message", onMessage);
    sessionSignal.addEventListener("abort", onAbort, { once: true });
    if (sessionSignal.aborted) {
      onAbort();
      return;
    }
    document.body.appendChild(frame);
  });

  return ready
    .then<IsolatedPreviewSession>(() => ({
      setViewport: async (viewport) => {
        sessionSignal.throwIfAborted();
        frame.style.width = `${viewport.width}px`;
        frame.style.height = `${viewport.height}px`;
        await afterIsolatedPreviewPaint();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      },
      navigate: (target) => {
        const expectation: DesignBridgeNavigationExpectation = {
          generation,
          nonce: createDesignBridgeNonce(),
          requestId: createDesignBridgeNonce(),
          target,
        };
        return request(
          expectation,
          {
            type: "open-builder:design-bridge-navigate",
            version: DESIGN_BRIDGE_PROTOCOL_VERSION,
            generation,
            nonce: expectation.nonce,
            requestId: expectation.requestId,
            target,
          },
          (event) => {
            const response = parseDesignBridgeNavigationResponse(
              event.data,
              expectation,
            );
            if (!response) return null;
            return response.ok
              ? { ok: true, value: response.target }
              : { ok: false, error: new Error(response.error) };
          },
        );
      },
      capture: (viewport, target) => {
        const expectation: DesignBridgeCaptureExpectation = {
          generation,
          nonce: createDesignBridgeNonce(),
          requestId: createDesignBridgeNonce(),
          viewportName: viewport.name,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          target,
        };
        return request(
          expectation,
          {
            type: "open-builder:design-bridge-capture",
            version: DESIGN_BRIDGE_PROTOCOL_VERSION,
            generation,
            nonce: expectation.nonce,
            requestId: expectation.requestId,
            viewport: {
              name: viewport.name,
              width: viewport.width,
              height: viewport.height,
            },
            target,
          },
          (event) => {
            const response = parseDesignBridgeCaptureResponse(
              event.data,
              expectation,
            );
            if (!response) return null;
            return response.ok
              ? { ok: true, value: response.result }
              : { ok: false, error: new Error(response.error) };
          },
        );
      },
      dispose,
    }))
    .catch((error) => {
      dispose();
      throw error;
    });
}
