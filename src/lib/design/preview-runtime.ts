import type {
  ProjectFiles,
  ProjectPreviewMode,
  PreviewView,
} from "../../types";
import type { DesignBridgeCaptureResult } from "./preview-bridge";

export type PreviewCaptureOwner = "tool" | "manual-review" | "automatic-review";

/**
 * Declarative identity for one page and one named prototype scenario.
 *
 * Routes intentionally use the URL hash form consumed by HashRouter. The
 * route is data only; callers must never evaluate it as code.
 */
export interface PrototypePreviewTarget {
  pageId: string;
  route: string;
  scenarioId: string;
}

export type PrototypePreviewIdentity = PrototypePreviewTarget;

export const PROTOTYPE_PREVIEW_ROUTE_MAX_LENGTH = 256;
export const PROTOTYPE_PREVIEW_ID_MAX_LENGTH = 128;

const PROTOTYPE_PREVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_HASH_ROUTE_PATTERN =
  /^#\/(?:[A-Za-z0-9._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*$/;

/** Returns true only for a bounded, same-document HashRouter route. */
export function isSafePrototypePreviewRoute(value: unknown): boolean {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PROTOTYPE_PREVIEW_ROUTE_MAX_LENGTH &&
    !/(?:javascript|data|vbscript)\s*:/i.test(value) &&
    SAFE_HASH_ROUTE_PATTERN.test(value)
  ) {
    const path = value.slice(2).split("?", 1)[0] ?? "";
    return (
      !value.includes("//") &&
      !path.split("/").some((segment) => segment === "." || segment === "..")
    );
  }
  return false;
}

function isSafePrototypePreviewId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PROTOTYPE_PREVIEW_ID_MAX_LENGTH &&
    PROTOTYPE_PREVIEW_ID_PATTERN.test(value)
  );
}

/** Fail-closed validation for target data crossing the preview boundary. */
export function sanitizePrototypePreviewTarget(
  value: unknown,
): PrototypePreviewTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    !isSafePrototypePreviewId(raw.pageId) ||
    !isSafePrototypePreviewRoute(raw.route) ||
    !isSafePrototypePreviewId(raw.scenarioId)
  ) {
    return null;
  }
  return {
    pageId: raw.pageId,
    route: raw.route as string,
    scenarioId: raw.scenarioId,
  };
}

export function isPrototypePreviewTarget(
  value: unknown,
): value is PrototypePreviewTarget {
  return sanitizePrototypePreviewTarget(value) !== null;
}

export function prototypePreviewTargetsEqual(
  left: unknown,
  right: unknown,
): boolean {
  const leftTarget = sanitizePrototypePreviewTarget(left);
  const rightTarget = sanitizePrototypePreviewTarget(right);
  if (!leftTarget || !rightTarget) return false;
  return (
    leftTarget.pageId === rightTarget.pageId &&
    leftTarget.route === rightTarget.route &&
    leftTarget.scenarioId === rightTarget.scenarioId
  );
}

export type PreviewRuntimeErrorCode =
  | "preview_unavailable"
  | "capture_busy"
  | "stale_generation"
  | "invalid_target"
  | "target_identity_mismatch";

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
  /** Present when capture was requested for a declarative prototype target. */
  target?: PrototypePreviewTarget;
  captures: DesignBridgeCaptureResult[];
  errors: string[];
}

export interface PreviewRuntimeAdapter {
  /** Generation currently rendered by the registered preview. */
  getGeneration: () => string | undefined;
  /** Refresh and wait until the bridge for `generation` is ready. */
  prepare: (
    generation: string,
    signal: AbortSignal,
    target?: PrototypePreviewTarget,
  ) => Promise<void>;
  /** Optional target-specific preparation seam. */
  prepareTarget?: (
    target: PrototypePreviewTarget,
    generation: string,
    signal: AbortSignal,
  ) => Promise<void | PrototypePreviewTarget>;
  /** Optional navigation seam for adapters that separate refresh and routing. */
  navigateToTarget?: (
    target: PrototypePreviewTarget,
    generation: string,
    signal: AbortSignal,
  ) => Promise<void | PrototypePreviewTarget>;
  /** Capture only the requested viewports, preserving their order. */
  capture: (
    viewports: readonly PreviewView[],
    generation: string,
    signal: AbortSignal,
    target?: PrototypePreviewTarget,
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
  target?: PrototypePreviewTarget;
  signal?: AbortSignal;
}): Promise<PreviewCaptureCollection> {
  const target =
    input.target === undefined
      ? undefined
      : sanitizePrototypePreviewTarget(input.target);
  if (input.target !== undefined && !target) {
    throw new PreviewRuntimeError(
      "invalid_target",
      "The preview target is invalid or its route is not a safe hash route.",
    );
  }
  return withPreviewCaptureLock({
    conversationId: input.conversationId,
    owner: "tool",
    signal: input.signal,
    run: async (adapter, signal) => {
      if (target) {
        await adapter.prepare(input.generation, signal, target);
      } else {
        await adapter.prepare(input.generation, signal);
      }
      signal.throwIfAborted();
      if (target) {
        const targetPreparation = adapter.prepareTarget
          ? adapter.prepareTarget(target, input.generation, signal)
          : adapter.navigateToTarget?.(target, input.generation, signal);
        if (targetPreparation) {
          const observedTarget = await targetPreparation;
          if (
            observedTarget !== undefined &&
            (!sanitizePrototypePreviewTarget(observedTarget) ||
              !prototypePreviewTargetsEqual(observedTarget, target))
          ) {
            throw new PreviewRuntimeError(
              "target_identity_mismatch",
              "The preview navigated to a different page or scenario.",
            );
          }
        }
      }
      signal.throwIfAborted();
      if (adapter.getGeneration() !== input.generation) {
        throw new PreviewRuntimeError(
          "stale_generation",
          "The project changed while the preview was preparing evidence.",
        );
      }
      const result = target
        ? await adapter.capture(
            input.viewports,
            input.generation,
            signal,
            target,
          )
        : await adapter.capture(input.viewports, input.generation, signal);
      if (
        result.generation !== input.generation ||
        adapter.getGeneration() !== input.generation
      ) {
        throw new PreviewRuntimeError(
          "stale_generation",
          "The project changed before preview evidence completed.",
        );
      }
      if (!target) return result;

      if (
        result.target !== undefined &&
        (!sanitizePrototypePreviewTarget(result.target) ||
          !prototypePreviewTargetsEqual(result.target, target))
      ) {
        throw new PreviewRuntimeError(
          "target_identity_mismatch",
          "Preview evidence was returned for a different page or scenario.",
        );
      }
      for (const capture of result.captures) {
        const identity =
          capture.semanticSnapshot.prototypeIdentity ??
          capture.semanticSnapshot.prototype;
        if (
          !identity ||
          !sanitizePrototypePreviewTarget(identity) ||
          !prototypePreviewTargetsEqual(identity, target) ||
          capture.semanticSnapshot.route !== target.route
        ) {
          throw new PreviewRuntimeError(
            "target_identity_mismatch",
            "Preview evidence was not bound to the requested page and scenario.",
          );
        }
      }
      return { ...result, target };
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
