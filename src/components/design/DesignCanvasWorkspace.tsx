import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Check,
  Focus,
  Hand,
  Info,
  LayoutGrid,
  Maximize,
  Minus,
  MousePointer2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useT } from "../../i18n";
import {
  arrangeCanvasRow,
  fitCanvas,
  snapCanvasBoard,
  zoomCanvasAt,
  type CanvasCamera,
  type CanvasPoint,
  type CanvasSnapGuide,
  type CanvasSnapRect,
} from "../../lib/design/canvas-geometry";
import type { CanvasPreviewSnapshot } from "../../lib/design/canvas-preview";
import type { ConversationIdentity } from "../../lib/conversation/branches";
import { isConversationIdentityCurrent } from "../../lib/conversation/branches";
import { useConversationStore } from "../../store/conversation";
import {
  designWorkspaceLayoutKey,
  useProjectDesignWorkspaceStore,
  type DesignCanvasLayout,
} from "../../store/project-design-workspace";
import "./design-canvas.css";

export interface DesignCanvasBoard {
  id: string;
  name: string;
  responsibility?: string;
  issue?: string;
  previewKey?: string;
}

interface DesignCanvasWorkspaceProps {
  identity: ConversationIdentity;
  parentBranchId?: string;
  boards: readonly DesignCanvasBoard[];
  viewport: { width: number; height: number };
  previews: CanvasPreviewSnapshot;
  selectedPageId?: string;
  active: boolean;
  focusRequest?: { pageId: string; requestId: number };
  emptyMessage?: string;
  onSelect: (id: string) => void;
  onPlay: (id: string) => void;
  onRetry: (key: string) => void;
  onVisiblePages: (ids: string[]) => void;
}

function CanvasButton({
  label,
  children,
  selected,
  ...props
}: {
  label: string;
  children: ReactNode;
  selected?: boolean;
} & React.ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...props}
          size="icon-sm"
          variant={selected ? "secondary" : "ghost"}
          aria-label={label}
          aria-pressed={selected}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type Drag =
  | {
      kind: "pan";
      start: CanvasPoint;
      camera: CanvasCamera;
    }
  | {
      kind: "board";
      start: CanvasPoint;
      camera: CanvasCamera;
      id: string;
      origin: CanvasPoint;
      element: HTMLElement;
      size: { width: number; height: number };
      peers: CanvasSnapRect[];
    }
  | {
      kind: "pinch";
      camera: CanvasCamera;
      anchor: CanvasPoint;
      distance: number;
    };

/** The canvas owns geometry; page facts and the live runtime stay outside it. */
export function DesignCanvasWorkspace({
  identity,
  parentBranchId,
  boards,
  viewport,
  previews,
  selectedPageId,
  active,
  focusRequest,
  emptyMessage,
  onSelect,
  onPlay,
  onRetry,
  onVisiblePages,
}: DesignCanvasWorkspaceProps) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const key = designWorkspaceLayoutKey(
    identity.conversationId,
    identity.branchId,
  );
  const hydrated = useProjectDesignWorkspaceStore(
    (state) => state._hasHydrated,
  );
  const persistenceError = useProjectDesignWorkspaceStore(
    (state) => state.persistenceError,
  );
  const saved = useProjectDesignWorkspaceStore((state) => state.layouts[key]);
  const layout = useRef<DesignCanvasLayout>({
    camera: { x: 64, y: 96, zoom: 0.4 },
    positions: {},
  });
  const [initialized, setInitialized] = useState(false);
  const initializedRef = useRef(false);
  const [tool, setTool] = useState<"select" | "hand">("select");
  const handledFocusRequest = useRef<number | undefined>(undefined);
  const [showPersistenceError, setShowPersistenceError] = useState(false);
  const dragged = useRef(false);
  const userMovedCamera = useRef(false);
  const finalFitDone = useRef(false);
  const space = useRef(false);
  const pointers = useRef(new Map<number, CanvasPoint>());
  const drag = useRef<Drag | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const latest = useRef({
    boards,
    previews,
    viewport,
    onVisiblePages,
    identity,
  });
  latest.current = { boards, previews, viewport, onVisiblePages, identity };

  const dimensions = useCallback((board: DesignCanvasBoard) => {
    const result = board.previewKey
      ? latest.current.previews[board.previewKey]?.result
      : undefined;
    return {
      width: latest.current.viewport.width,
      height: result
        ? ((result.capture?.region.height ?? result.viewport.fullHeight) *
            latest.current.viewport.width) /
          (result.capture?.region.width ?? result.viewport.width)
        : latest.current.viewport.height,
    };
  }, []);

  const reportVisible = useCallback(() => {
    const host = root.current;
    if (!host) return;
    const { camera, positions } = layout.current;
    latest.current.onVisiblePages(
      latest.current.boards
        .filter((board) => {
          const position = positions[board.id];
          if (!position) return false;
          const size = dimensions(board);
          return (
            camera.x + (position.x + size.width) * camera.zoom >= 0 &&
            camera.x + position.x * camera.zoom <= host.clientWidth &&
            camera.y + (position.y + size.height) * camera.zoom >= 0 &&
            camera.y + position.y * camera.zoom <= host.clientHeight
          );
        })
        .map((board) => board.id),
    );
  }, [dimensions]);

  const paintCamera = useCallback((camera: CanvasCamera) => {
    layout.current.camera = camera;
    root.current?.style.setProperty("--canvas-x", `${camera.x}px`);
    root.current?.style.setProperty("--canvas-y", `${camera.y}px`);
    root.current?.style.setProperty("--canvas-zoom", String(camera.zoom));
    const output = root.current?.querySelector("[data-canvas-zoom-output]");
    if (output) output.textContent = `${Math.round(camera.zoom * 100)}%`;
  }, []);

  const paintGuides = useCallback((guides: readonly CanvasSnapGuide[]) => {
    for (const axis of ["x", "y"] as const) {
      const element = root.current?.querySelector<HTMLElement>(
        `[data-canvas-guide="${axis}"]`,
      );
      if (!element) continue;
      const guide = guides.find((value) => value.axis === axis);
      element.style.display = guide ? "block" : "none";
      if (!guide) continue;
      element.style.left = `${axis === "x" ? guide.coordinate : guide.start}px`;
      element.style.top = `${axis === "y" ? guide.coordinate : guide.start}px`;
      element.style.width =
        axis === "x"
          ? "calc(1px / var(--canvas-zoom))"
          : `${guide.end - guide.start}px`;
      element.style.height =
        axis === "y"
          ? "calc(1px / var(--canvas-zoom))"
          : `${guide.end - guide.start}px`;
    }
  }, []);

  const rollbackBoard = useCallback(() => {
    const current = drag.current;
    if (current?.kind !== "board") return;
    layout.current.positions[current.id] = current.origin;
    current.element.style.setProperty("--board-x", `${current.origin.x}px`);
    current.element.style.setProperty("--board-y", `${current.origin.y}px`);
    paintGuides([]);
  }, [paintGuides]);

  const save = useCallback(() => {
    clearTimeout(saveTimer.current);
    if (!initializedRef.current) return;
    const currentIdentity = latest.current.identity;
    const conversation =
      useConversationStore.getState().conversations[
        currentIdentity.conversationId
      ];
    if (!isConversationIdentityCurrent(currentIdentity, conversation)) return;
    useProjectDesignWorkspaceStore
      .getState()
      .setLayout(currentIdentity.conversationId, currentIdentity.branchId, {
        camera: { ...layout.current.camera },
        positions: {
          ...layout.current.positions,
          ...(drag.current?.kind === "board"
            ? { [drag.current.id]: drag.current.origin }
            : {}),
        },
      });
  }, []);

  const settle = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      reportVisible();
      save();
    }, 250);
  }, [reportVisible, save]);

  const finishGesture = useCallback(
    (cancel = false) => {
      if (cancel) rollbackBoard();
      drag.current = null;
      paintGuides([]);
      const host = root.current;
      const pointerIds = [...pointers.current.keys()];
      pointers.current.clear();
      for (const pointerId of pointerIds) {
        if (host?.hasPointerCapture(pointerId))
          host.releasePointerCapture(pointerId);
      }
      if (host) host.dataset.dragging = "false";
      reportVisible();
      save();
    },
    [paintGuides, reportVisible, rollbackBoard, save],
  );

  const fit = useCallback(
    (selectedOnly = false, deliberate = true) => {
      const host = root.current;
      if (!host?.clientWidth) return;
      if (deliberate) userMovedCamera.current = true;
      const rectangles = latest.current.boards
        .filter((board) => !selectedOnly || board.id === selectedPageId)
        .flatMap((board) => {
          const point = layout.current.positions[board.id];
          return point ? [{ ...point, ...dimensions(board) }] : [];
        });
      paintCamera(
        fitCanvas(rectangles, {
          width: host.clientWidth,
          height: host.clientHeight,
        }),
      );
      settle();
    },
    [selectedPageId, dimensions, paintCamera, settle],
  );

  useLayoutEffect(() => {
    if (!hydrated || initialized || !active || !root.current?.clientWidth)
      return;
    const initial = {
      camera: fitCanvas(
        boards.map((_, index) => ({
          x: index * (viewport.width + 96),
          y: 0,
          width: viewport.width,
          height: viewport.height,
        })),
        { width: root.current.clientWidth, height: root.current.clientHeight },
      ),
      positions: arrangeCanvasRow(
        boards.map((board) => board.id),
        viewport.width,
      ),
    };
    const restored = useProjectDesignWorkspaceStore
      .getState()
      .ensureLayout(
        identity.conversationId,
        identity.branchId,
        initial,
        parentBranchId,
      );
    if (!restored) return;
    layout.current = {
      camera: { ...restored.camera },
      positions: { ...restored.positions },
    };
    userMovedCamera.current = Boolean(
      saved ||
      (parentBranchId &&
        useProjectDesignWorkspaceStore.getState().layouts[
          designWorkspaceLayoutKey(identity.conversationId, parentBranchId)
        ]),
    );
    paintCamera(restored.camera);
    initializedRef.current = true;
    setInitialized(true);
  }, [
    hydrated,
    initialized,
    active,
    boards,
    viewport,
    identity,
    parentBranchId,
    saved,
    paintCamera,
  ]);

  useLayoutEffect(() => {
    if (!initialized) return;
    let nextX = Math.max(
      -96 - viewport.width,
      ...Object.values(layout.current.positions).map((point) => point.x),
    );
    let changed = false;
    for (const board of boards) {
      if (layout.current.positions[board.id]) continue;
      nextX += viewport.width + 96;
      layout.current.positions[board.id] = { x: nextX, y: 0 };
      changed = true;
    }
    if (changed) save();
    reportVisible();
  }, [initialized, boards, viewport.width, reportVisible, save]);

  useLayoutEffect(() => {
    if (!active || !initialized || !focusRequest) return;
    if (handledFocusRequest.current === focusRequest.requestId) return;
    const board = boards.find((value) => value.id === focusRequest.pageId);
    const host = root.current;
    if (
      !board ||
      !layout.current.positions[focusRequest.pageId] ||
      !host?.clientWidth
    )
      return;
    finishGesture(true);
    const position = layout.current.positions[focusRequest.pageId];
    handledFocusRequest.current = focusRequest.requestId;
    userMovedCamera.current = true;
    paintCamera(
      fitCanvas([{ ...position, ...dimensions(board) }], {
        width: host.clientWidth,
        height: host.clientHeight,
      }),
    );
    settle();
  }, [
    active,
    initialized,
    focusRequest,
    boards,
    dimensions,
    finishGesture,
    paintCamera,
    settle,
  ]);

  useEffect(() => {
    if (!initialized || !active || !boards.length || finalFitDone.current)
      return;
    const complete = boards.every(
      (board) =>
        board.issue ||
        (board.previewKey &&
          ["ready", "error"].includes(previews[board.previewKey]?.status)),
    );
    if (!complete) return;
    finalFitDone.current = true;
    if (!userMovedCamera.current) fit(false, false);
  }, [boards, previews, initialized, active, fit]);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      if (active) reportVisible();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [active, reportVisible]);

  useEffect(() => {
    if (persistenceError) setShowPersistenceError(true);
  }, [persistenceError]);

  useEffect(() => {
    if (!active && initialized) finishGesture(true);
    const flush = () => save();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      save();
    };
  }, [active, initialized, finishGesture, save]);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest("[data-canvas-ui]")) return;
      event.preventDefault();
      if (drag.current) return;
      userMovedCamera.current = true;
      const camera = layout.current.camera;
      if (event.ctrlKey || event.metaKey) {
        const rect = host.getBoundingClientRect();
        paintCamera(
          zoomCanvasAt(
            camera,
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            camera.zoom * Math.exp(-event.deltaY * 0.008),
          ),
        );
      } else {
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? host.clientHeight
              : 1;
        paintCamera({
          ...camera,
          x: camera.x - event.deltaX * unit,
          y: camera.y - event.deltaY * unit,
        });
      }
      settle();
    };
    host.addEventListener("wheel", wheel, { passive: false });
    return () => host.removeEventListener("wheel", wheel);
  }, [paintCamera, settle]);

  const localPoint = (event: ReactPointerEvent) => {
    const rect = root.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      (event.target as Element).closest("[data-canvas-ui]") ||
      (event.button !== 0 && event.button !== 1)
    )
      return;
    event.preventDefault();
    root.current?.focus({ preventScroll: true });
    clearTimeout(saveTimer.current);
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    dragged.current = false;
    if (pointers.current.size === 2) {
      rollbackBoard();
      for (const pointerId of pointers.current.keys())
        root.current?.setPointerCapture(pointerId);
      const [a, b] = [...pointers.current.values()];
      const anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      drag.current = {
        kind: "pinch",
        camera: { ...layout.current.camera },
        anchor,
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      };
      userMovedCamera.current = true;
      dragged.current = true;
      return;
    }
    if (pointers.current.size > 2) return;
    const board = (event.target as Element).closest<HTMLElement>(
      "[data-canvas-board]",
    );
    const id = board?.dataset.canvasBoard;
    const boardModel = boards.find((value) => value.id === id);
    const pan = tool === "hand" || space.current || event.button === 1;
    if (id && !pan) onSelect(id);
    if (
      id &&
      boardModel &&
      layout.current.positions[id] &&
      !pan &&
      (event.target as Element).closest("[data-canvas-drag-handle]")
    ) {
      drag.current = {
        kind: "board",
        start: point,
        camera: { ...layout.current.camera },
        id,
        origin: layout.current.positions[id],
        element: board!,
        size: dimensions(boardModel),
        peers: boards.flatMap((peer) => {
          const position = layout.current.positions[peer.id];
          return position && peer.id !== id
            ? [{ id: peer.id, ...position, ...dimensions(peer) }]
            : [];
        }),
      };
    } else if (!id || pan) {
      drag.current = {
        kind: "pan",
        start: point,
        camera: { ...layout.current.camera },
      };
    }
    root.current!.dataset.dragging = String(!!drag.current);
    if (drag.current) root.current?.setPointerCapture(event.pointerId);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    const current = drag.current;
    if (!current) return;
    if (current.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const next = zoomCanvasAt(
        current.camera,
        current.anchor,
        (current.camera.zoom * Math.hypot(a.x - b.x, a.y - b.y)) /
          current.distance,
      );
      paintCamera({
        ...next,
        x: next.x + center.x - current.anchor.x,
        y: next.y + center.y - current.anchor.y,
      });
      dragged.current = true;
      return;
    }
    const dx = point.x - current.start.x;
    const dy = point.y - current.start.y;
    if (Math.hypot(dx, dy) > 3) dragged.current = true;
    if (!dragged.current) return;
    if (current.kind === "pan") {
      userMovedCamera.current = true;
      paintCamera({
        ...current.camera,
        x: current.camera.x + dx,
        y: current.camera.y + dy,
      });
    } else {
      const { position, guides } = snapCanvasBoard(
        {
          id: current.id,
          ...current.size,
          x: current.origin.x + dx / current.camera.zoom,
          y: current.origin.y + dy / current.camera.zoom,
        },
        current.peers,
        current.camera.zoom,
      );
      layout.current.positions[current.id] = position;
      current.element.style.setProperty("--board-x", `${position.x}px`);
      current.element.style.setProperty("--board-y", `${position.y}px`);
      paintGuides(guides);
    }
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    finishGesture();
  };

  const zoom = (factor: number) => {
    userMovedCamera.current = true;
    const host = root.current!;
    paintCamera(
      zoomCanvasAt(
        layout.current.camera,
        { x: host.clientWidth / 2, y: host.clientHeight / 2 },
        layout.current.camera.zoom * factor,
      ),
    );
    settle();
  };

  const selected = boards.find((board) => board.id === selectedPageId);
  return (
    <div
      ref={root}
      role="region"
      aria-label={t.designCanvas.title}
      tabIndex={0}
      className="design-canvas"
      data-testid="design-canvas"
      data-tool={tool}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={() => finishGesture(true)}
      onLostPointerCapture={(event) => {
        if (pointers.current.has(event.pointerId)) finishGesture(true);
      }}
      onBlur={() => {
        space.current = false;
      }}
      onKeyUp={(event) => {
        if (event.code === "Space") space.current = false;
      }}
      onKeyDown={(event) => {
        if (
          (event.target as Element).closest(
            "input, textarea, select, [contenteditable=true]",
          )
        )
          return;
        if (event.key === "Escape") {
          event.preventDefault();
          finishGesture(true);
          return;
        }
        if (drag.current) return;
        if (
          event.code === "Space" &&
          (event.target as Element).closest("[data-canvas-ui]")
        )
          return;
        if (event.code === "Space") {
          event.preventDefault();
          space.current = true;
        } else if (event.key.toLowerCase() === "v") setTool("select");
        else if (event.key.toLowerCase() === "h") setTool("hand");
        else if (event.shiftKey && event.code === "Digit1") {
          event.preventDefault();
          fit();
        } else if (event.shiftKey && event.code === "Digit2") {
          event.preventDefault();
          fit(true);
        } else if (["+", "="].includes(event.key)) {
          event.preventDefault();
          zoom(1.2);
        } else if (event.key === "-") {
          event.preventDefault();
          zoom(1 / 1.2);
        }
      }}
    >
      {showPersistenceError && (
        <button
          data-canvas-ui
          type="button"
          role="status"
          className="design-canvas-storage-message design-canvas-panel"
          onClick={() => setShowPersistenceError(false)}
        >
          {t.designCanvas.persistenceError}
        </button>
      )}
      <div className="design-canvas-world">
        <div
          className="design-canvas-guide"
          data-canvas-guide="x"
          aria-hidden="true"
        />
        <div
          className="design-canvas-guide"
          data-canvas-guide="y"
          aria-hidden="true"
        />
        {boards.map((board, index) => {
          const state = board.previewKey
            ? previews[board.previewKey]
            : undefined;
          const point = layout.current.positions[board.id] ?? {
            x: index * (viewport.width + 96),
            y: 0,
          };
          const size = dimensions(board);
          return (
            <article
              key={board.id}
              data-canvas-board={board.id}
              data-selected={selectedPageId === board.id}
              data-preview-status={
                board.issue ? "unavailable" : (state?.status ?? "queued")
              }
              className="design-canvas-board"
              style={
                {
                  "--board-x": `${point.x}px`,
                  "--board-y": `${point.y}px`,
                  width: size.width,
                  height: size.height,
                } as CSSProperties
              }
            >
              <div
                className="design-canvas-board-caption"
                data-canvas-drag-handle
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{board.name}</span>
                  {state?.status === "ready" && (
                    <Check
                      size={12}
                      className="shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span className="design-canvas-board-caption-size">
                  {Math.round(size.width)} × {Math.round(size.height)}
                </span>
              </div>
              <div
                className="design-canvas-board-content"
                role="button"
                tabIndex={0}
                aria-label={board.name}
                aria-pressed={selectedPageId === board.id}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelect(board.id);
                    if (!board.issue) onPlay(board.id);
                  } else if (event.code === "Space") {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelect(board.id);
                  }
                }}
                onDoubleClick={(event) => {
                  if ((event.target as Element).closest("[data-canvas-ui]"))
                    return;
                  if (!dragged.current && !board.issue) onPlay(board.id);
                }}
              >
                {state?.result && !board.issue ? (
                  <>
                    <img
                      src={state.result.dataUrl}
                      alt={t.designCanvas.previewAlt.replace(
                        "{name}",
                        board.name,
                      )}
                      draggable={false}
                      className="design-canvas-page-image"
                    />
                    {state.status !== "ready" && (
                      <div
                        data-canvas-ui
                        role="status"
                        className="design-canvas-panel design-canvas-preview-status"
                      >
                        <p>
                          {state.status === "error"
                            ? t.designCanvas.updateFailed
                            : t.designCanvas.updating}
                        </p>
                        {state.status === "error" && board.previewKey && (
                          <>
                            <p className="text-muted-foreground">
                              {state.error}
                            </p>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(event) => {
                                event.stopPropagation();
                                onRetry(board.previewKey!);
                              }}
                            >
                              {t.designCanvas.retry}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="design-canvas-placeholder">
                    {board.issue || state?.status === "error" ? (
                      <div className="design-canvas-board-message">
                        <AlertCircle size={32} />
                        <h3>
                          {board.issue
                            ? t.designCanvas.unavailable
                            : t.designCanvas.failed}
                        </h3>
                        <p>{board.issue ?? state?.error}</p>
                        {!board.issue && board.previewKey && (
                          <Button
                            data-canvas-ui
                            variant="outline"
                            onClick={() => onRetry(board.previewKey!)}
                          >
                            <RefreshCw size={16} />
                            {t.designCanvas.retry}
                          </Button>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="design-canvas-skeleton">
                          <span />
                          <span />
                          <span />
                          <span />
                        </div>
                        <p className="design-canvas-loading-label">
                          {state?.status === "loading"
                            ? t.designCanvas.loading
                            : t.designCanvas.waiting}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!boards.length && (
        <div className="design-canvas-empty" data-canvas-ui>
          <LayoutGrid size={32} strokeWidth={1.5} />
          <h2>{emptyMessage ?? t.designCanvas.noPages}</h2>
          <p>{t.designCanvas.noPagesDescription}</p>
        </div>
      )}
      <div className="design-canvas-bottom" data-canvas-ui>
        <div className="design-canvas-panel flex items-center gap-1 p-1">
          <CanvasButton
            label={t.designCanvas.select}
            selected={tool === "select"}
            onClick={() => setTool("select")}
          >
            <MousePointer2 size={16} />
          </CanvasButton>
          <CanvasButton
            label={t.designCanvas.hand}
            selected={tool === "hand"}
            onClick={() => setTool("hand")}
          >
            <Hand size={16} />
          </CanvasButton>
          <span className="mx-1 h-4 border-l" />
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label={t.designCanvas.shortcuts}
                className="design-canvas-help"
              >
                <Info size={14} />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t.designCanvas.shortcutDescription}
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="design-canvas-hint">{t.designCanvas.hint}</p>
        <div className="design-canvas-panel flex items-center gap-1 p-1">
          <CanvasButton
            label={t.designCanvas.zoomOut}
            onClick={() => zoom(1 / 1.2)}
          >
            <Minus size={14} />
          </CanvasButton>
          <output
            data-canvas-zoom-output
            aria-label={t.designCanvas.zoom}
            className="min-w-12 text-center font-mono text-xs tabular-nums"
          >
            {Math.round(layout.current.camera.zoom * 100)}%
          </output>
          <CanvasButton label={t.designCanvas.zoomIn} onClick={() => zoom(1.2)}>
            <Plus size={14} />
          </CanvasButton>
          <span className="mx-1 h-4 border-l" />
          <CanvasButton label={t.designCanvas.fitAll} onClick={() => fit()}>
            <Maximize size={16} />
          </CanvasButton>
          <CanvasButton
            label={t.designCanvas.fitSelected}
            disabled={!selected}
            onClick={() => fit(true)}
          >
            <Focus size={16} />
          </CanvasButton>
        </div>
      </div>
    </div>
  );
}
