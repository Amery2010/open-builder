export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationRect extends AnnotationPoint {
  width: number;
  height: number;
}

export type AnnotationTool =
  "crop" | "arrow" | "rectangle" | "ellipse" | "line" | "text" | "brush";

export interface AnnotationStyle {
  color: string;
  width: number;
}

export type AnnotationMark = AnnotationStyle &
  (
    | {
        tool: "arrow" | "rectangle" | "ellipse" | "line";
        start: AnnotationPoint;
        end: AnnotationPoint;
      }
    | { tool: "brush"; points: readonly AnnotationPoint[] }
    | { tool: "text"; point: AnnotationPoint; text: string }
  );

export interface AnnotationDocument {
  marks: readonly AnnotationMark[];
  crop: AnnotationRect | null;
}

export interface AnnotationHistory {
  past: readonly AnnotationDocument[];
  present: AnnotationDocument;
  future: readonly AnnotationDocument[];
}

export function createAnnotationHistory(): AnnotationHistory {
  return { past: [], present: { marks: [], crop: null }, future: [] };
}

export function commitAnnotation(
  history: AnnotationHistory,
  document: AnnotationDocument,
): AnnotationHistory {
  return {
    past: [...history.past, history.present],
    present: document,
    future: [],
  };
}

export function undoAnnotation(history: AnnotationHistory): AnnotationHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoAnnotation(history: AnnotationHistory): AnnotationHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export function annotationPoint(
  client: AnnotationPoint,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  image: { width: number; height: number },
): AnnotationPoint {
  return {
    x: Math.max(
      0,
      Math.min(
        image.width,
        ((client.x - bounds.left) / bounds.width) * image.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        image.height,
        ((client.y - bounds.top) / bounds.height) * image.height,
      ),
    ),
  };
}

export function annotationCrop(
  start: AnnotationPoint,
  end: AnnotationPoint,
  image: { width: number; height: number },
): AnnotationRect | null {
  const x = Math.max(0, Math.floor(Math.min(start.x, end.x)));
  const y = Math.max(0, Math.floor(Math.min(start.y, end.y)));
  const right = Math.min(image.width, Math.ceil(Math.max(start.x, end.x)));
  const bottom = Math.min(image.height, Math.ceil(Math.max(start.y, end.y)));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function annotationTextSize(style: AnnotationStyle): number {
  return 16 + style.width * 2;
}

/** Draw only user marks. Selection guides and editor UI never cross this seam. */
export function drawAnnotationMarks(
  context: CanvasRenderingContext2D,
  marks: readonly AnnotationMark[],
): void {
  for (const mark of marks) {
    context.save();
    context.strokeStyle = mark.color;
    context.fillStyle = mark.color;
    context.lineWidth = mark.width;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    if (mark.tool === "text") {
      const size = annotationTextSize(mark);
      context.font = `${size}px sans-serif`;
      context.textBaseline = "top";
      mark.text.split("\n").forEach((line, index) => {
        context.fillText(line, mark.point.x, mark.point.y + index * size * 1.4);
      });
    } else if (mark.tool === "brush") {
      const first = mark.points[0];
      if (first) {
        context.moveTo(first.x, first.y);
        for (const point of mark.points.slice(1))
          context.lineTo(point.x, point.y);
        if (mark.points.length === 1) {
          context.arc(first.x, first.y, mark.width / 2, 0, Math.PI * 2);
          context.fill();
        } else context.stroke();
      }
    } else {
      const { start, end } = mark;
      if (mark.tool === "rectangle") {
        context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      } else if (mark.tool === "ellipse") {
        context.ellipse(
          (start.x + end.x) / 2,
          (start.y + end.y) / 2,
          Math.abs(end.x - start.x) / 2,
          Math.abs(end.y - start.y) / 2,
          0,
          0,
          Math.PI * 2,
        );
        context.stroke();
      } else {
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        if (mark.tool === "arrow") {
          const angle = Math.atan2(end.y - start.y, end.x - start.x);
          const length = Math.max(12, mark.width * 4);
          for (const offset of [-Math.PI / 6, Math.PI / 6]) {
            context.moveTo(end.x, end.y);
            context.lineTo(
              end.x - length * Math.cos(angle + offset),
              end.y - length * Math.sin(angle + offset),
            );
          }
        }
        context.stroke();
      }
    }
    context.restore();
  }
}

export function loadAnnotationImage(
  dataUrl: string,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      image.src = "";
      reject(signal.reason);
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("Could not decode the preview image."));
    };
    signal.addEventListener("abort", abort, { once: true });
    image.src = dataUrl;
  });
}

export async function exportAnnotation(
  image: HTMLImageElement,
  document: AnnotationDocument,
  signal: AbortSignal,
): Promise<File> {
  signal.throwIfAborted();
  const crop = document.crop ?? {
    x: 0,
    y: 0,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
  const canvas = window.document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.translate(-crop.x, -crop.y);
    context.drawImage(image, 0, 0);
    drawAnnotationMarks(context, document.marks);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error("Could not encode the annotation.")),
        "image/png",
      );
    });
    signal.throwIfAborted();
    return new File([blob], "preview-annotation.png", { type: "image/png" });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
