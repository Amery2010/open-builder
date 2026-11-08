// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { DesignCanvasWorkspace } from "./DesignCanvasWorkspace";
import { TooltipProvider } from "../ui/tooltip";
import type { DesignCanvasLayout } from "../../store/project-design-workspace";
import { en } from "../../i18n/en";
import type { CanvasPreviewSnapshot } from "../../lib/design/canvas-preview";
import type { DesignBridgeCaptureResult } from "../../lib/design/preview-bridge";

const state = vi.hoisted(() => ({
  layout: {} as DesignCanvasLayout,
  save: vi.fn(),
  conversation: { id: "test", activeBranchId: "main", checkoutEpoch: 0 },
}));
vi.mock("../../i18n", () => ({ useT: () => en }));
vi.mock("../../store/conversation", () => ({
  useConversationStore: {
    getState: () => ({ conversations: { test: state.conversation } }),
  },
}));
vi.mock("../../store/project-design-workspace", () => {
  const getState = () => ({
    _hasHydrated: true,
    persistenceError: null,
    layouts: { '["test","main"]': state.layout },
    ensureLayout: () => state.layout,
    setLayout: (
      _conversationId: string,
      _branchId: string,
      layout: DesignCanvasLayout,
    ) => {
      state.layout = layout;
      state.save(layout);
    },
  });
  return {
    designWorkspaceLayoutKey: (conversation: string, branch: string) =>
      JSON.stringify([conversation, branch]),
    useProjectDesignWorkspaceStore: Object.assign(
      (selector: (value: ReturnType<typeof getState>) => unknown) =>
        selector(getState()),
      { getState },
    ),
  };
});

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, options: PointerEventInit = {}) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
  }
}

beforeEach(() => {
  state.layout = {
    camera: { x: 20, y: 20, zoom: 0.5 },
    positions: { home: { x: 0, y: 0 }, detail: { x: 1000, y: 500 } },
  };
  state.conversation = { id: "test", activeBranchId: "main", checkoutEpoch: 0 };
  state.save.mockClear();
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  const captures = new Set<number>();
  HTMLElement.prototype.setPointerCapture = (id) => {
    captures.add(id);
  };
  HTMLElement.prototype.releasePointerCapture = (id) => {
    captures.delete(id);
  };
  HTMLElement.prototype.hasPointerCapture = (id) => captures.has(id);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(
  overrides: Partial<ComponentProps<typeof DesignCanvasWorkspace>> = {},
) {
  const props: ComponentProps<typeof DesignCanvasWorkspace> = {
    identity: { conversationId: "test", branchId: "main", checkoutEpoch: 0 },
    boards: [
      { id: "home", name: "Home" },
      { id: "detail", name: "Detail" },
    ],
    viewport: { width: 400, height: 300 },
    previews: {},
    selectedPageId: "home",
    active: true,
    onSelect: vi.fn(),
    onPlay: vi.fn(),
    onRetry: vi.fn(),
    onVisiblePages: vi.fn(),
    ...overrides,
  };
  const view = render(<DesignCanvasWorkspace {...props} />, {
    wrapper: TooltipProvider,
  });
  const canvas = screen.getByTestId("design-canvas");
  const board = canvas.querySelector<HTMLElement>(
    '[data-canvas-board="home"]',
  )!;
  const handle = board.querySelector<HTMLElement>("[data-canvas-drag-handle]")!;
  return { ...view, props, canvas, board, handle };
}
function camera(canvas: HTMLElement) {
  return ["x", "y", "zoom"].map((name) =>
    canvas.style.getPropertyValue(`--canvas-${name}`),
  );
}
function beginDrag(handle: HTMLElement, canvas: HTMLElement, x = 300, y = 250) {
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    clientX: 50,
    clientY: 50,
  });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x, clientY: y });
}

describe("DesignCanvasWorkspace interactions", () => {
  it("keeps the previous picture visible with update status and an accessible retry", () => {
    const image = {
      dataUrl: "data:image/png;base64,cHJldmlvdXM=",
      viewport: { width: 400, fullHeight: 300 },
    } as DesignBridgeCaptureResult;
    const { props, rerender } = setup({
      boards: [{ id: "home", name: "Home", previewKey: "latest" }],
      previews: { latest: { status: "queued", result: image } },
    });
    expect(screen.getByRole("img")).toHaveAttribute("src", image.dataUrl);
    expect(screen.getByText(en.designCanvas.updating)).toBeVisible();
    rerender(
      <DesignCanvasWorkspace
        {...props}
        previews={{
          latest: {
            status: "error",
            result: image,
            error: "Capture timed out",
          },
        }}
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute("src", image.dataUrl);
    expect(screen.getByText(en.designCanvas.updateFailed)).toBeVisible();
    const retry = screen.getByRole("button", { name: en.designCanvas.retry });
    fireEvent.keyDown(retry, { key: "Enter" });
    fireEvent.click(retry);
    expect(props.onRetry).toHaveBeenCalledExactlyOnceWith("latest");
    expect(props.onPlay).not.toHaveBeenCalled();
  });

  it("selects and drags without moving the camera, saving only that board", () => {
    const { props, canvas, handle } = setup();
    const before = camera(canvas);
    beginDrag(handle, canvas, 547, 297);
    expect(props.onSelect).toHaveBeenCalledWith("home");
    expect(camera(canvas)).toEqual(before);
    expect(canvas.querySelector('[data-canvas-guide="x"]')).toHaveStyle({
      display: "block",
    });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(state.layout.positions).toEqual({
      home: { x: 1000, y: 500 },
      detail: { x: 1000, y: 500 },
    });
    expect(canvas.querySelector('[data-canvas-guide="x"]')).toHaveStyle({
      display: "none",
    });
    expect(
      [...canvas.querySelectorAll<HTMLElement>("[data-canvas-board]")].map(
        (node) => node.dataset.canvasBoard,
      ),
    ).toEqual(["home", "detail"]);
  });

  it.each(["Escape", "pointercancel"])(
    "restores the pre-drag position on %s",
    (cancel) => {
      const { canvas, handle, board } = setup();
      beginDrag(handle, canvas);
      expect(board.style.getPropertyValue("--board-x")).not.toBe("0px");
      if (cancel === "Escape") fireEvent.keyDown(canvas, { key: "Escape" });
      else fireEvent.pointerCancel(canvas, { pointerId: 1 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
      expect(board.style.getPropertyValue("--board-x")).toBe("0px");
      expect(state.layout.positions.home).toEqual({ x: 0, y: 0 });
    },
  );

  it("rolls back a board before beginning a two-pointer pinch", () => {
    const { canvas, handle, board } = setup();
    beginDrag(handle, canvas);
    fireEvent.pointerDown(canvas, {
      pointerId: 2,
      button: 0,
      clientX: 500,
      clientY: 250,
    });
    expect(board.style.getPropertyValue("--board-x")).toBe("0px");
    const before = camera(canvas);
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 600, clientY: 250 });
    fireEvent.pointerUp(canvas, { pointerId: 2 });
    expect(camera(canvas)).not.toEqual(before);
    expect(state.layout.positions.home).toEqual({ x: 0, y: 0 });
  });

  it("does not persist intermediate board positions when the page is hidden", () => {
    const { canvas, handle } = setup();
    beginDrag(handle, canvas);
    fireEvent(window, new Event("pagehide"));
    expect(state.layout.positions.home).toEqual({ x: 0, y: 0 });
    fireEvent.pointerCancel(canvas, { pointerId: 1 });
  });

  it("uses the peer dimensions captured at drag start when an image finishes loading", () => {
    const { canvas, props, handle, rerender } = setup({
      boards: [
        { id: "home", name: "Home" },
        { id: "detail", name: "Detail", previewKey: "detail" },
      ],
    });
    beginDrag(handle, canvas, 300, 220);
    const previews = {
      detail: {
        status: "ready",
        result: {
          dataUrl: "data:image/png;base64,",
          viewport: { width: 400, fullHeight: 900 },
        },
      },
    } as unknown as CanvasPreviewSnapshot;
    rerender(<DesignCanvasWorkspace {...props} previews={previews} />);
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 300, clientY: 447 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(state.layout.positions.home.y).toBe(800);
    expect(state.layout.positions.detail).toEqual({ x: 1000, y: 500 });
  });

  it("does not write a drag into a replaced checkout", () => {
    const { canvas, handle } = setup();
    beginDrag(handle, canvas);
    state.save.mockClear();
    state.conversation.checkoutEpoch = 1;
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(state.save).not.toHaveBeenCalled();
  });

  it("waits for active canvas and accepts repeated requests for the same page", () => {
    const { canvas, props, rerender } = setup({
      active: false,
      focusRequest: { pageId: "detail", requestId: 1 },
    });
    expect(camera(canvas)).toEqual(["", "", ""]);
    rerender(<DesignCanvasWorkspace {...props} active />);
    const focused = camera(canvas);
    fireEvent.wheel(canvas, { deltaX: 100, deltaY: 100 });
    expect(camera(canvas)).not.toEqual(focused);
    rerender(
      <DesignCanvasWorkspace
        {...props}
        active
        focusRequest={{ pageId: "detail", requestId: 1 }}
      />,
    );
    expect(camera(canvas)).not.toEqual(focused);
    rerender(
      <DesignCanvasWorkspace
        {...props}
        active
        focusRequest={{ pageId: "detail", requestId: 2 }}
      />,
    );
    expect(camera(canvas)).toEqual(focused);
  });

  it("keeps board Enter and double-click playback without context controls", () => {
    const { props, canvas } = setup();
    const boardButton = screen.getByRole("button", {
      name: "Home",
    });
    fireEvent.keyDown(boardButton, { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith("home");
    expect(props.onPlay).toHaveBeenCalledWith("home");
    fireEvent.doubleClick(boardButton);
    expect(props.onPlay).toHaveBeenCalledTimes(2);
    expect(canvas.querySelector(".design-canvas-context")).toBeNull();
    expect(canvas.querySelector(".design-canvas-top")).toBeNull();
    expect(screen.queryByRole("button", { name: "Auto arrange" })).toBeNull();
  });
});
