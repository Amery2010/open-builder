import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  ArrowUpRight,
  Brush,
  Circle,
  Crop,
  Minus,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { getT, useT } from "../../i18n";
import { useConversationStore } from "../../store/conversation";
import {
  captureConversationIdentity,
  isConversationIdentityCurrent,
} from "../../lib/conversation/branches";
import {
  PreviewRuntimeError,
  type PreviewCaptureScope,
} from "../../lib/design/preview-runtime";
import { captureAnnotationPreview } from "../../lib/preview-annotation/capture";
import {
  annotationCrop,
  annotationPoint,
  annotationTextSize,
  commitAnnotation,
  createAnnotationHistory,
  drawAnnotationMarks,
  exportAnnotation,
  loadAnnotationImage,
  redoAnnotation,
  undoAnnotation,
  type AnnotationMark,
  type AnnotationPoint,
  type AnnotationStyle,
  type AnnotationTool,
} from "../../lib/preview-annotation/document";
import { useAttachmentIntakeContext } from "../chat/chat-input/AttachmentIntakeContext";
import { Button } from "../ui/button";
import { TooltipIconButton } from "../ui/tooltip-icon-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { AnnotationColorPicker } from "./AnnotationColorPicker";

const TOOLS = [
  ["crop", Crop],
  ["arrow", ArrowUpRight],
  ["rectangle", Square],
  ["ellipse", Circle],
  ["line", Minus],
  ["text", Type],
  ["brush", Brush],
] as const;

interface Gesture {
  tool: Exclude<AnnotationTool, "text">;
  start: AnnotationPoint;
  end: AnnotationPoint;
  points: readonly AnnotationPoint[];
  style: AnnotationStyle;
  pointerId: number;
}

function gestureMark(gesture: Gesture): AnnotationMark | null {
  if (gesture.tool === "crop") return null;
  if (gesture.tool === "brush") {
    return { tool: "brush", points: gesture.points, ...gesture.style };
  }
  return {
    tool: gesture.tool,
    start: gesture.start,
    end: gesture.end,
    ...gesture.style,
  };
}

/** One mount owns one frozen image and one abortable attachment operation. */
export function PreviewAnnotation({
  conversationId,
  scope = "viewport",
  onClose,
}: {
  conversationId: string;
  scope?: PreviewCaptureScope;
  onClose: () => void;
}) {
  const t = useT().annotation;
  const intake = useAttachmentIntakeContext();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [captureError, setCaptureError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<AnnotationTool>("arrow");
  const [style, setStyle] = useState<AnnotationStyle>({
    color: "#ef4444",
    width: 3,
  });
  const [history, setHistory] = useState(createAnnotationHistory);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [textDraft, setTextDraft] = useState<
    (AnnotationStyle & { point: AnnotationPoint; text: string }) | null
  >(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const session = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const identity = useState(() => {
    const conversation =
      useConversationStore.getState().conversations[conversationId];
    return conversation ? captureConversationIdentity(conversation) : undefined;
  })[0];

  useEffect(() => {
    const controller = new AbortController();
    let imageUrl: string | undefined;
    session.current = controller;
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
    if (!current()) {
      controller.abort();
      closeRef.current();
    } else {
      void (async () => {
        try {
          // StrictMode replays effects. Let the discarded mount abort before
          // acquiring the shared preview lock.
          await Promise.resolve();
          controller.signal.throwIfAborted();
          const capture = await captureAnnotationPreview(
            conversationId,
            controller.signal,
            scope,
          );
          controller.signal.throwIfAborted();
          imageUrl = URL.createObjectURL(capture.blob);
          const decoded = await loadAnnotationImage(
            imageUrl,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          setImage(decoded);
        } catch (reason) {
          if (controller.signal.aborted) return;
          const labels = getT().annotation;
          setCaptureError(
            reason instanceof PreviewRuntimeError
              ? reason.code === "capture_busy"
                ? labels.captureBusy
                : reason.code === "stale_generation"
                  ? labels.captureChanged
                  : labels.captureFailed
              : labels.captureFailed,
          );
        }
      })();
    }
    return () => {
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      unsubscribe();
      if (session.current === controller) session.current = null;
    };
  }, [conversationId, identity, scope]);

  useLayoutEffect(() => {
    if (!image || !canvas.current) return;
    const context = canvas.current.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, image.naturalWidth, image.naturalHeight);
    const pending = gesture && gestureMark(gesture);
    drawAnnotationMarks(
      context,
      pending ? [...history.present.marks, pending] : history.present.marks,
    );
  }, [gesture, history.present.marks, image]);

  useEffect(() => {
    stage.current?.focus();
  }, [image]);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () =>
      setStageSize({
        width: element.clientWidth - 16,
        height: element.clientHeight - 16,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (textDraft) textInput.current?.focus();
  }, [textDraft?.point]);

  function close() {
    session.current?.abort();
    onClose();
  }

  function point(event: PointerEvent<HTMLCanvasElement>): AnnotationPoint {
    return annotationPoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      {
        width: image!.naturalWidth,
        height: image!.naturalHeight,
      },
    );
  }

  function commitText() {
    if (textDraft?.text.trim()) {
      const mark: AnnotationMark = { tool: "text", ...textDraft };
      setHistory((previous) =>
        commitAnnotation(previous, {
          ...previous.present,
          marks: [...previous.present.marks, mark],
        }),
      );
    }
    setTextDraft(null);
    stage.current?.focus();
  }

  function startGesture(event: PointerEvent<HTMLCanvasElement>) {
    if (!image || savingRef.current || event.button > 0 || gestureRef.current)
      return;
    event.preventDefault();
    const start = point(event);
    if (textDraft) commitText();
    if (tool === "text") {
      setTextDraft({ point: start, text: "", ...style });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const next: Gesture = {
      tool,
      start,
      end: start,
      points: [start],
      style: { ...style },
      pointerId: event.pointerId,
    };
    gestureRef.current = next;
    setGesture(next);
    stage.current?.focus();
  }

  function moveGesture(event: PointerEvent<HTMLCanvasElement>) {
    const previous = gestureRef.current;
    if (!previous || previous.pointerId !== event.pointerId) return;
    const end = point(event);
    const next = {
      ...previous,
      end,
      points:
        previous.tool === "brush" ? [...previous.points, end] : previous.points,
    };
    gestureRef.current = next;
    setGesture(next);
  }

  function cancelGesture() {
    gestureRef.current = null;
    setGesture(null);
  }

  function endGesture(event: PointerEvent<HTMLCanvasElement>) {
    if (gestureRef.current?.pointerId !== event.pointerId || !image) return;
    moveGesture(event);
    const completed = gestureRef.current!;
    cancelGesture();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (completed.tool === "crop") {
      const crop = annotationCrop(completed.start, completed.end, {
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      if (crop)
        setHistory((previous) =>
          commitAnnotation(previous, { ...previous.present, crop }),
        );
    } else {
      const mark = gestureMark(completed);
      if (
        !mark ||
        (completed.tool !== "brush" &&
          Math.hypot(
            completed.end.x - completed.start.x,
            completed.end.y - completed.start.y,
          ) < 1)
      )
        return;
      setHistory((previous) =>
        commitAnnotation(previous, {
          ...previous.present,
          marks: [...previous.present.marks, mark],
        }),
      );
    }
  }

  async function finish() {
    const controller = session.current;
    if (!controller || !image || !identity || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    let document = history.present;
    if (textDraft?.text.trim()) {
      document = {
        ...document,
        marks: [...document.marks, { tool: "text", ...textDraft }],
      };
      setHistory((previous) => commitAnnotation(previous, document));
    }
    setTextDraft(null);
    try {
      const file = await exportAnnotation(image, document, controller.signal);
      controller.signal.throwIfAborted();
      const result = await intake.intake([file], identity, controller.signal);
      controller.signal.throwIfAborted();
      if (result.ok) close();
      else setError(result.error);
    } catch {
      if (!controller.signal.aborted) setError(t.exportFailed);
    } finally {
      savingRef.current = false;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  const crop =
    image && gesture?.tool === "crop"
      ? annotationCrop(gesture.start, gesture.end, {
          width: image.naturalWidth,
          height: image.naturalHeight,
        })
      : history.present.crop;
  const displayScale = image
    ? Math.max(0, Math.min(1, stageSize.width / image.naturalWidth))
    : 1;

  return (
    <section
      aria-label={t.title}
      className="@container/annotation absolute inset-0 z-50 flex min-h-0 min-w-0 flex-col bg-background"
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLSelectElement
        )
          return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (gestureRef.current) cancelGesture();
          else close();
        } else if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "z" &&
          !savingRef.current &&
          !gestureRef.current
        ) {
          event.preventDefault();
          event.stopPropagation();
          setHistory(event.shiftKey ? redoAnnotation : undoAnnotation);
        }
      }}
    >
      <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">
        {t.hint}
      </p>
      <div
        ref={stage}
        tabIndex={-1}
        className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-muted/50 p-2 outline-none"
      >
        {image ? (
          <div
            className="relative my-auto shrink-0"
            style={{
              width: image.naturalWidth * displayScale,
              height: image.naturalHeight * displayScale,
            }}
          >
            <img
              src={image.src}
              alt=""
              aria-hidden="true"
              className="block h-full w-full select-none"
              draggable={false}
            />
            <canvas
              ref={canvas}
              aria-label={t.canvas}
              width={image.naturalWidth}
              height={image.naturalHeight}
              className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
              style={{ pointerEvents: saving ? "none" : undefined }}
              onPointerDown={startGesture}
              onPointerMove={moveGesture}
              onPointerUp={endGesture}
              onPointerCancel={cancelGesture}
              onLostPointerCapture={cancelGesture}
            />
            {crop && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute border-2 border-dashed border-sky-500 bg-sky-500/5"
                style={{
                  left: `${(crop.x / image.naturalWidth) * 100}%`,
                  top: `${(crop.y / image.naturalHeight) * 100}%`,
                  width: `${(crop.width / image.naturalWidth) * 100}%`,
                  height: `${(crop.height / image.naturalHeight) * 100}%`,
                }}
              />
            )}
            {textDraft && (
              <div
                className="absolute z-10 flex max-w-full flex-col gap-1 rounded-md border bg-background p-1 shadow-sm"
                style={{
                  left: `${Math.min(70, (textDraft.point.x / image.naturalWidth) * 100)}%`,
                  top: `${Math.min(70, (textDraft.point.y / image.naturalHeight) * 100)}%`,
                }}
              >
                <textarea
                  ref={textInput}
                  aria-label={t.textPlaceholder}
                  placeholder={t.textPlaceholder}
                  className="min-h-16 w-40 max-w-full resize rounded-sm bg-background p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{
                    color: textDraft.color,
                    fontSize: annotationTextSize(textDraft),
                    fontFamily: "sans-serif",
                  }}
                  value={textDraft.text}
                  onChange={(event) =>
                    setTextDraft({ ...textDraft, text: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Escape" ||
                      (event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing)
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.key === "Escape") setTextDraft(null);
                      else commitText();
                    }
                  }}
                />
                <div className="flex flex-wrap gap-1">
                  <Button type="button" size="sm" onClick={commitText}>
                    {t.confirmText}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setTextDraft(null)}
                  >
                    {t.cancelText}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p
            role={captureError ? "alert" : "status"}
            className="max-w-sm p-4 text-sm text-muted-foreground"
          >
            {captureError || t.capture}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="shrink-0 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {!saving && (!intake.available || intake.busy) && (
        <p
          role="status"
          className="shrink-0 px-3 py-2 text-xs text-muted-foreground"
        >
          {intake.busy
            ? getT().chat.attachmentErrors.busy
            : getT().chat.attachmentErrors.unavailable}
        </p>
      )}
      <div
        role="toolbar"
        aria-label={t.tools}
        className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-background px-3 py-2"
      >
        <fieldset
          disabled={!image || saving}
          className="flex min-w-0 w-full flex-wrap items-center gap-2 @3xl/annotation:w-auto @3xl/annotation:flex-1"
        >
          <div
            role="group"
            aria-label={t.drawingTools}
            className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5"
          >
            {TOOLS.map(([name, Icon]) => (
              <TooltipIconButton
                key={name}
                type="button"
                label={t[name]}
                size="icon-sm"
                variant={tool === name ? "secondary" : "ghost"}
                aria-pressed={tool === name}
                onClick={() => {
                  commitText();
                  setTool(name);
                }}
              >
                <Icon size={16} />
              </TooltipIconButton>
            ))}
          </div>
          <div
            role="group"
            aria-label={t.strokeStyle}
            className="inline-flex items-center gap-2"
          >
            <AnnotationColorPicker
              value={style.color}
              onChange={(color) =>
                setStyle((previous) => ({ ...previous, color }))
              }
              disabled={!image || saving}
            />
            <Select
              value={String(style.width)}
              disabled={!image || saving}
              onValueChange={(width) =>
                setStyle((previous) => ({ ...previous, width: Number(width) }))
              }
            >
              <SelectTrigger
                size="sm"
                aria-label={t.width}
                className="w-32 bg-background text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                side="top"
                position="popper"
                align="start"
                onKeyDown={(event) => event.stopPropagation()}
              >
                {(
                  [
                    [2, t.thin],
                    [3, t.medium],
                    [6, t.thick],
                  ] as const
                ).map(([width, label]) => (
                  <SelectItem key={width} value={String(width)}>
                    <span className="flex items-center gap-2">
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 20 12"
                        className="h-3 w-5 text-foreground"
                      >
                        <path
                          d="M2 6h16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={width}
                          strokeLinecap="round"
                        />
                      </svg>
                      {label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div
            role="group"
            aria-label={t.editHistory}
            className="inline-flex items-center gap-0.5 rounded-lg border p-0.5"
          >
            <TooltipIconButton
              type="button"
              label={t.undo}
              size="icon-sm"
              variant="ghost"
              disabled={!history.past.length}
              onClick={() => {
                setTextDraft(null);
                setHistory(undoAnnotation);
              }}
            >
              <Undo2 size={16} />
            </TooltipIconButton>
            <TooltipIconButton
              type="button"
              label={t.redo}
              size="icon-sm"
              variant="ghost"
              disabled={!history.future.length}
              onClick={() => {
                setTextDraft(null);
                setHistory(redoAnnotation);
              }}
            >
              <Redo2 size={16} />
            </TooltipIconButton>
            <TooltipIconButton
              type="button"
              label={t.clear}
              size="icon-sm"
              variant="ghost"
              disabled={
                !history.present.marks.length &&
                !history.present.crop &&
                !textDraft
              }
              onClick={() => {
                setTextDraft(null);
                setHistory((previous) =>
                  commitAnnotation(previous, { marks: [], crop: null }),
                );
              }}
            >
              <Trash2 size={16} />
            </TooltipIconButton>
          </div>
          {history.present.crop && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                setHistory((previous) =>
                  commitAnnotation(previous, {
                    ...previous.present,
                    crop: null,
                  }),
                )
              }
            >
              {t.resetCrop}
            </Button>
          )}
        </fieldset>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={close}>
            {t.cancel}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!image || saving || intake.busy || !intake.available}
            onClick={() => void finish()}
          >
            {saving ? t.attaching : t.done}
          </Button>
        </div>
      </div>
    </section>
  );
}
