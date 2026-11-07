export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasCamera extends CanvasPoint {
  zoom: number;
}

export interface CanvasRect extends CanvasPoint {
  width: number;
  height: number;
}

export interface CanvasSnapRect extends CanvasRect {
  id: string;
}

export interface CanvasSnapGuide {
  axis: "x" | "y";
  coordinate: number;
  start: number;
  end: number;
}

export const MIN_CANVAS_ZOOM = 0.1;
export const MAX_CANVAS_ZOOM = 2;
export const CANVAS_BOARD_GAP = 96;
export const CANVAS_SNAP_DISTANCE = 8;

/** Snap in screen pixels so the same gesture works at every camera zoom. */
export function snapCanvasBoard(
  moving: CanvasSnapRect,
  peers: readonly CanvasSnapRect[],
  zoom: number,
): { position: CanvasPoint; guides: CanvasSnapGuide[] } {
  const position = { x: moving.x, y: moving.y };
  const guides: CanvasSnapGuide[] = [];
  if (!Number.isFinite(zoom) || zoom <= 0) return { position, guides };
  const threshold = CANVAS_SNAP_DISTANCE / zoom;
  const matches: Partial<
    Record<
      "x" | "y",
      { delta: number; coordinate: number; peer: CanvasSnapRect }
    >
  > = {};
  for (const axis of ["x", "y"] as const) {
    const dimension = axis === "x" ? "width" : "height";
    for (const peer of peers) {
      if (peer.id === moving.id) continue;
      for (const offset of [0, 0.5, 1]) {
        const anchor = moving[axis] + moving[dimension] * offset;
        for (const peerOffset of [0, 0.5, 1]) {
          const coordinate = peer[axis] + peer[dimension] * peerOffset;
          const delta = coordinate - anchor;
          if (Math.abs(delta) > threshold) continue;
          const previous = matches[axis];
          if (
            !previous ||
            Math.abs(delta) < Math.abs(previous.delta) ||
            (Math.abs(delta) === Math.abs(previous.delta) &&
              (coordinate < previous.coordinate ||
                (coordinate === previous.coordinate &&
                  peer.id < previous.peer.id)))
          ) {
            matches[axis] = { delta, coordinate, peer };
          }
        }
      }
    }
    if (matches[axis]) position[axis] += matches[axis].delta;
  }
  for (const axis of ["x", "y"] as const) {
    const match = matches[axis];
    if (!match) continue;
    const cross = axis === "x" ? "y" : "x";
    const dimension = axis === "x" ? "height" : "width";
    guides.push({
      axis,
      coordinate: match.coordinate,
      start: Math.min(position[cross], match.peer[cross]),
      end: Math.max(
        position[cross] + moving[dimension],
        match.peer[cross] + match.peer[dimension],
      ),
    });
  }
  return { position, guides };
}

export function clampCanvasZoom(zoom: number): number {
  return Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM, zoom));
}

export function canvasPoint(
  camera: CanvasCamera,
  point: CanvasPoint,
): CanvasPoint {
  return {
    x: (point.x - camera.x) / camera.zoom,
    y: (point.y - camera.y) / camera.zoom,
  };
}

export function zoomCanvasAt(
  camera: CanvasCamera,
  anchor: CanvasPoint,
  zoom: number,
): CanvasCamera {
  const point = canvasPoint(camera, anchor);
  const nextZoom = clampCanvasZoom(zoom);
  return {
    x: anchor.x - point.x * nextZoom,
    y: anchor.y - point.y * nextZoom,
    zoom: nextZoom,
  };
}

export function arrangeCanvasRow(
  ids: readonly string[],
  width: number,
): Record<string, CanvasPoint> {
  return Object.fromEntries(
    ids.map((id, index) => [
      id,
      { x: index * (width + CANVAS_BOARD_GAP), y: 0 },
    ]),
  );
}

export function fitCanvas(
  boards: readonly CanvasRect[],
  viewport: { width: number; height: number },
): CanvasCamera {
  if (!boards.length || viewport.width <= 0 || viewport.height <= 0)
    return { x: 64, y: 96, zoom: 0.5 };
  const left = Math.min(...boards.map((board) => board.x));
  const top = Math.min(...boards.map((board) => board.y));
  const width =
    Math.max(...boards.map((board) => board.x + board.width)) - left;
  const height =
    Math.max(...boards.map((board) => board.y + board.height)) - top;
  const zoom = clampCanvasZoom(
    Math.min(
      1,
      Math.max(1, viewport.width - 96) / width,
      Math.max(1, viewport.height - 200) / height,
    ),
  );
  return {
    x: (viewport.width - width * zoom) / 2 - left * zoom,
    y: 96 + Math.max(0, viewport.height - 200 - height * zoom) / 2 - top * zoom,
    zoom,
  };
}
