import type {
  ProjectFiles,
  ProjectPreviewMode,
  PreviewView,
} from "../../types";
import type { DesignBridgeCaptureResult } from "./preview-bridge";

export type PreviewCaptureOwner = "tool" | "manual-review" | "automatic-review";

export type PreviewRuntimeErrorCode =
  "preview_unavailable" | "capture_busy" | "stale_generation";

export class PreviewRuntimeError extends Error {
  constructor(
    readonly code: PreviewRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewRuntimeError";
  }
}

export interface PreviewCaptureCollection {
  generation: string;
  captures: DesignBridgeCaptureResult[];
  errors: string[];
}

export interface PreviewRuntimeAdapter {
  /** Generation currently rendered by the registered preview. */
  getGeneration: () => string | undefined;
  /** Refresh and wait until the bridge for `generation` is ready. */
  prepare: (generation: string, signal: AbortSignal) => Promise<void>;
  /** Capture only the requested viewports, preserving their order. */
  capture: (
    viewports: readonly PreviewView[],
    generation: string,
    signal: AbortSignal,
  ) => Promise<PreviewCaptureCollection>;
}

interface ActiveCapture {
  owner: PreviewCaptureOwner;
  controller: AbortController;
}

interface PreviewRuntimeRegistration {
  token: symbol;
  adapter: PreviewRuntimeAdapter;
  active?: ActiveCapture;
}

const registrations = new Map<string, PreviewRuntimeRegistration>();

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function relayAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
) {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

/**
 * Register the mounted preview for one conversation. Replacing or removing a
 * registration cancels its capture so results cannot cross conversation mounts.
 */
export function registerPreviewRuntime(
  conversationId: string,
  adapter: PreviewRuntimeAdapter,
): () => void {
  const existing = registrations.get(conversationId);
  existing?.active?.controller.abort(
    abortError("Preview runtime was replaced."),
  );
  const token = Symbol(conversationId);
  registrations.set(conversationId, { token, adapter });
  return () => {
    const current = registrations.get(conversationId);
    if (!current || current.token !== token) return;
    current.active?.controller.abort(
      abortError("Preview runtime was removed."),
    );
    registrations.delete(conversationId);
  };
}

export function cancelPreviewCapture(
  conversationId: string,
  reason = "Preview capture was cancelled.",
): void {
  registrations
    .get(conversationId)
    ?.active?.controller.abort(abortError(reason));
}

export function isPreviewCaptureBusy(conversationId: string): boolean {
  return registrations.get(conversationId)?.active !== undefined;
}

export async function withPreviewCaptureLock<T>(input: {
  conversationId: string;
  owner: PreviewCaptureOwner;
  signal?: AbortSignal;
  run: (adapter: PreviewRuntimeAdapter, signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const registration = registrations.get(input.conversationId);
  if (!registration) {
    throw new PreviewRuntimeError(
      "preview_unavailable",
      "The preview runtime is not mounted for this conversation.",
    );
  }
  if (registration.active) {
    throw new PreviewRuntimeError(
      "capture_busy",
      `Preview capture is busy (${registration.active.owner}).`,
    );
  }

  const controller = new AbortController();
  const removeAbortRelay = relayAbort(input.signal, controller);
  registration.active = { owner: input.owner, controller };
  try {
    controller.signal.throwIfAborted();
    return await input.run(registration.adapter, controller.signal);
  } finally {
    removeAbortRelay();
    if (registration.active?.controller === controller) {
      registration.active = undefined;
    }
  }
}

export async function captureRegisteredPreview(input: {
  conversationId: string;
  generation: string;
  viewports: readonly PreviewView[];
  signal?: AbortSignal;
}): Promise<PreviewCaptureCollection> {
  return withPreviewCaptureLock({
    conversationId: input.conversationId,
    owner: "tool",
    signal: input.signal,
    run: async (adapter, signal) => {
      await adapter.prepare(input.generation, signal);
      signal.throwIfAborted();
      if (adapter.getGeneration() !== input.generation) {
        throw new PreviewRuntimeError(
          "stale_generation",
          "The project changed while the preview was preparing evidence.",
        );
      }
      const result = await adapter.capture(
        input.viewports,
        input.generation,
        signal,
      );
      if (
        result.generation !== input.generation ||
        adapter.getGeneration() !== input.generation
      ) {
        throw new PreviewRuntimeError(
          "stale_generation",
          "The project changed before preview evidence completed.",
        );
      }
      return result;
    },
  });
}

function canonicalProjectSource(input: {
  files: ProjectFiles;
  template: string;
  previewMode: ProjectPreviewMode;
}): string {
  return JSON.stringify({
    template: input.template,
    previewMode: input.previewMode,
    files: Object.fromEntries(
      Object.entries(input.files).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  });
}

/** Stable SHA-256 identity for the exact project state rendered by preview. */
export async function computePreviewGeneration(input: {
  files: ProjectFiles;
  template: string;
  previewMode: ProjectPreviewMode;
}): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 is unavailable in this runtime.");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalProjectSource(input)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
