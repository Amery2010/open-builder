import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { Camera, Download, RotateCcw } from "lucide-react";
import { getT, useT } from "../../i18n";
import { useConversationStore } from "../../store/conversation";
import {
  captureConversationIdentity,
  isConversationIdentityCurrent,
} from "../../lib/conversation/branches";
import { PreviewRuntimeError } from "../../lib/design/preview-runtime";
import { capturePreviewImage } from "../../lib/preview-annotation/capture";
import {
  annotationCrop,
  annotationPoint,
  loadAnnotationImage,
  type AnnotationPoint,
  type AnnotationRect,
} from "../../lib/preview-annotation/document";
import { encodePngCrop } from "../../lib/images/png-crop";
import { saveBlob } from "../../lib/utils/save-blob";
import { Button } from "../ui/button";

export type ScreenshotMode = "viewport" | "full-page" | "region";

const PNG_FORMAT = {
  mimeType: "image/png",
  extension: "png",
  description: "PNG",
};

function screenshotName(title: string, mode: ScreenshotMode) {
  const name =
    title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .trim()
      .slice(0, 80) || "project";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${name}-${mode}-${timestamp}.png`;
}

/** Each mount captures once; region mode edits only the frozen viewport image. */
export function PreviewScreenshot({
  conversationId,
  mode,
  onClose,
}: {
  conversationId: string;
  mode: ScreenshotMode;
  onClose: () => void;
}) {
  const t = useT();
  const labels = t.screenshot;
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<AnnotationRect | null>(null);
  const [error, setError] = useState("");
  const [captureFailed, setCaptureFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const session = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const gesture = useRef<{ start: AnnotationPoint; pointerId: number } | null>(
    null,
  );
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [identity] = useState(() => {
    const conversation =
      useConversationStore.getState().conversations[conversationId];
    return conversation ? captureConversationIdentity(conversation) : undefined;
  });
  const [fileName] = useState(() =>
    screenshotName(
      useConversationStore.getState().conversations[conversationId]?.title ??
        "project",
      mode,
    ),
  );

  useEffect(() => {
    root.current?.focus();
  }, [image, captureFailed]);

  useEffect(() => {
    const controller = new AbortController();
    session.current = controller;
    let imageUrl: string | undefined;
    const current = () => {
      const state = useConversationStore.getState();
      return (
        identity &&
        state.activeId === conversationId &&
        isConversationIdentityCurrent(
          identity,
          state.conversations[conversationId],
        )
      );
    };
    const unsubscribe = useConversationStore.subscribe(() => {
      if (!current()) {
        controller.abort();
        closeRef.current();
      }
    });
    void (async () => {
      // Avoid two captures during StrictMode's effect replay.
      await Promise.resolve();
      if (!current()) {
        controller.abort();
        closeRef.current();
        return;
      }
      if (controller.signal.aborted) return;
      setError("");
      setCaptureFailed(false);
      setImage(null);
      setCrop(null);
      let captured = false;
      try {
        const capture = await capturePreviewImage(
          conversationId,
          controller.signal,
          mode === "full-page" ? "full-page" : "viewport",
          "screenshot",
        );
        controller.signal.throwIfAborted();
        captured = true;
        if (mode !== "region") {
          setSaving(true);
          await saveBlob(capture.blob, fileName, PNG_FORMAT, {
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          closeRef.current();
        } else {
          imageUrl = URL.createObjectURL(capture.blob);
          const decoded = await loadAnnotationImage(
            imageUrl,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          setImage(decoded);
        }
      } catch (reason) {
        if (controller.signal.aborted) return;
        const currentLabels = getT();
        setCaptureFailed(true);
        setError(
          reason instanceof PreviewRuntimeError &&
            reason.code === "capture_busy"
            ? currentLabels.annotation.captureBusy
            : reason instanceof PreviewRuntimeError &&
                reason.code === "stale_generation"
              ? currentLabels.annotation.captureChanged
              : captured
                ? currentLabels.screenshot.exportFailed
                : currentLabels.annotation.captureFailed,
        );
      } finally {
        if (!controller.signal.aborted) setSaving(false);
      }
    })();
    return () => {
      controller.abort();
      unsubscribe();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      if (session.current === controller) session.current = null;
    };
  }, [attempt, conversationId, fileName, identity, mode]);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () =>
      setStageSize({
        width: element.clientWidth - 32,
        height: element.clientHeight - 32,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function close() {
    session.current?.abort();
    closeRef.current();
  }

  function point(event: PointerEvent<HTMLDivElement>) {
    return annotationPoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      { width: image!.naturalWidth, height: image!.naturalHeight },
    );
  }

  async function saveRegion() {
    const controller = session.current;
    if (
      !image ||
      !crop ||
      !controller ||
      controller.signal.aborted ||
      savingRef.current
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const blob = await encodePngCrop(image, crop, controller.signal);
      await saveBlob(blob, fileName, PNG_FORMAT, { signal: controller.signal });
      controller.signal.throwIfAborted();
      closeRef.current();
    } catch {
      if (!controller.signal.aborted) setError(labels.exportFailed);
    } finally {
      savingRef.current = false;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  const scale = image
    ? Math.max(
        0,
        Math.min(
          1,
          stageSize.width / image.naturalWidth,
          stageSize.height / image.naturalHeight,
        ),
      )
    : 1;
  return (
    <section
      ref={root}
      role="region"
      aria-label={labels.title}
      tabIndex={-1}
      className="absolute inset-0 z-50 flex min-h-0 flex-col bg-background outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3 text-sm font-medium">
        <Camera size={16} aria-hidden="true" />
        {labels.title}
      </div>
      {mode === "region" && (
        <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">
          {labels.hint}
        </p>
      )}
      <div
        ref={stage}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/50 p-4"
      >
        {image ? (
          <div
            role="img"
            aria-label={labels.selectArea}
            className="relative shrink-0 touch-none select-none cursor-crosshair"
            style={{
              width: image.naturalWidth * scale,
              height: image.naturalHeight * scale,
              pointerEvents: saving ? "none" : undefined,
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return;
              event.preventDefault();
              gesture.current = {
                start: point(event),
                pointerId: event.pointerId,
              };
              setCrop(null);
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (gesture.current?.pointerId !== event.pointerId) return;
              setCrop(
                annotationCrop(gesture.current.start, point(event), {
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                }),
              );
            }}
            onPointerUp={(event) => {
              if (gesture.current?.pointerId !== event.pointerId) return;
              setCrop(
                annotationCrop(gesture.current.start, point(event), {
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                }),
              );
              gesture.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              gesture.current = null;
              setCrop(null);
            }}
            onLostPointerCapture={() => {
              gesture.current = null;
            }}
          >
            <img
              src={image.src}
              alt=""
              draggable={false}
              className="pointer-events-none block h-full w-full"
            />
            {crop && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute border-2 border-dashed border-sky-500 bg-sky-500/10"
                style={{
                  left: `${(crop.x / image.naturalWidth) * 100}%`,
                  top: `${(crop.y / image.naturalHeight) * 100}%`,
                  width: `${(crop.width / image.naturalWidth) * 100}%`,
                  height: `${(crop.height / image.naturalHeight) * 100}%`,
                }}
              />
            )}
          </div>
        ) : (
          !error && (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              {saving ? labels.exporting : t.annotation.capture}
            </p>
          )
        )}
      </div>
      {error && (
        <p role="alert" className="shrink-0 px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-3">
        <span
          role="status"
          className="mr-auto text-xs tabular-nums text-muted-foreground"
        >
          {saving
            ? labels.exporting
            : crop
              ? `${crop.width} × ${crop.height} px`
              : ""}
        </span>
        {captureFailed && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {labels.retry}
          </Button>
        )}
        {mode === "region" && image && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving || !crop}
              onClick={() => {
                setCrop(null);
                gesture.current = null;
              }}
            >
              <RotateCcw size={14} />
              {labels.reselect}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saving || !crop}
              onClick={() => void saveRegion()}
            >
              <Download size={14} />
              {labels.export}
            </Button>
          </>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={close}>
          {labels.cancel}
        </Button>
      </div>
    </section>
  );
}
