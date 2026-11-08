import {
  PreviewRuntimeError,
  withPreviewCaptureLock,
  type PreviewCaptureScope,
} from "../design/preview-runtime";

/** Freeze the selected region of the mounted page without navigation or reload. */
export function capturePreviewImage(
  conversationId: string,
  signal: AbortSignal,
  scope: PreviewCaptureScope = "viewport",
  owner: "annotation" | "screenshot" = "annotation",
) {
  return withPreviewCaptureLock({
    conversationId,
    owner,
    signal,
    run: async (adapter, captureSignal) => {
      const generation = adapter.getGeneration();
      if (
        !generation ||
        !adapter.prepareCurrent ||
        !adapter.captureAnnotation
      ) {
        throw new PreviewRuntimeError(
          "preview_unavailable",
          "Current preview capture is unavailable.",
        );
      }
      const assertCurrent = () => {
        captureSignal.throwIfAborted();
        if (adapter.getGeneration() !== generation) {
          throw new PreviewRuntimeError(
            "stale_generation",
            "The preview changed during capture.",
          );
        }
      };
      assertCurrent();
      await adapter.prepareCurrent(generation, captureSignal);
      assertCurrent();
      const capture = await adapter.captureAnnotation(
        generation,
        captureSignal,
        scope,
      );
      assertCurrent();
      if (capture.generation !== generation) {
        throw new PreviewRuntimeError(
          "stale_generation",
          "The captured image belongs to an older preview.",
        );
      }
      return capture;
    },
  });
}

export function captureAnnotationPreview(
  conversationId: string,
  signal: AbortSignal,
  scope: PreviewCaptureScope = "viewport",
) {
  return capturePreviewImage(conversationId, signal, scope, "annotation");
}
