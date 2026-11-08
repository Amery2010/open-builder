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

export type IsolatedPreviewBootstrap = (
  frame: HTMLIFrameElement,
  signal: AbortSignal,
) => Promise<() => void>;

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
 * Creates a disposable preview for page images and deterministic review capture.
 * It deliberately clones the active preview instead of navigating it, so a
 * review cannot mutate the user's current route or shared mock-data session.
 */
export function createIsolatedPreviewSession(
  source: HTMLIFrameElement,
  generation: string,
  signal: AbortSignal,
  bootstrap?: IsolatedPreviewBootstrap,
): Promise<IsolatedPreviewSession> {
  if (!getDesignBridgeTargetOrigin(source.src, window.location.href)) {
    return Promise.reject(new Error("Preview iframe origin is invalid."));
  }

  const frame = source.cloneNode(false) as HTMLIFrameElement;
  // The Sandpack marker identifies the one active preview, not this disposable
  // capture frame. Keep active-preview discovery unambiguous during capture.
  frame.classList.remove("sp-preview-iframe");
  frame.setAttribute("data-ob-isolated-preview", "");
  frame.removeAttribute("id");
  frame.removeAttribute("name");
  if (bootstrap) {
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";
  } else {
    const url = new URL(source.src, window.location.href);
    if (
      url.protocol === "https:" &&
      /^[a-z0-9]+-\d+\.nodebox\.codesandbox\.io$/i.test(url.hostname)
    ) {
      // Reusing Vite's document URL can produce an invalid cached response in
      // Nodebox's service worker on WebKit. Only the disposable frame needs a
      // fresh document; keep the active preview and its route untouched.
      url.searchParams.set("__ob_capture", createDesignBridgeNonce());
      frame.src = url.href;
    }
  }
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
  let disposeClient: (() => void) | undefined;
  const dispose = () => {
    lifecycle.abort();
    signal.removeEventListener("abort", dispose);
    const cleanup = disposeClient;
    disposeClient = undefined;
    cleanup?.();
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
      // A compiled preview client may select a different bundler URL while
      // bootstrapping. Bind each request to this iframe's current origin.
      const targetOrigin = getDesignBridgeTargetOrigin(
        frame.src,
        window.location.href,
      );
      if (!targetOrigin) {
        cleanup();
        reject(new Error("Preview iframe origin is invalid."));
        return;
      }
      frame.contentWindow?.postMessage(message, targetOrigin);
      void expectation;
    });

  const ready = new Promise<void>((resolve, reject) => {
    let bridgeReady = false;
    let clientReady = !bootstrap;
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
    const finish = () => {
      if (!bridgeReady || !clientReady || sessionSignal.aborted) return;
      cleanup();
      resolve();
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
      bridgeReady = true;
      finish();
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
    if (bootstrap) {
      void Promise.resolve()
        .then(() => {
          sessionSignal.throwIfAborted();
          return bootstrap(frame, sessionSignal);
        })
        .then(
          (release) => {
            if (sessionSignal.aborted) {
              release();
              return;
            }
            disposeClient = release;
            clientReady = true;
            finish();
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    }
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
