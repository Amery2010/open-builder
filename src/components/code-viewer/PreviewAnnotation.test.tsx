// @vitest-environment jsdom
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { useSettingsStore } from "../../store/settings";
import { TooltipProvider } from "../ui/tooltip";
import { PreviewAnnotation } from "./PreviewAnnotation";
import type { AnnotationDocument } from "../../lib/preview-annotation/document";
import type { PreviewCaptureScope } from "../../lib/design/preview-runtime";

const mock = vi.hoisted(() => ({
  capture: vi.fn(),
  load: vi.fn(),
  export: vi.fn(),
  intake: vi.fn(),
}));
vi.mock("../../lib/preview-annotation/capture", () => ({
  captureAnnotationPreview: mock.capture,
}));
vi.mock("../../lib/preview-annotation/document", async (original) => ({
  ...(await original<typeof import("../../lib/preview-annotation/document")>()),
  loadAnnotationImage: mock.load,
  exportAnnotation: mock.export,
}));
vi.mock("../chat/chat-input/AttachmentIntakeContext", () => ({
  useAttachmentIntakeContext: () => ({
    available: true,
    busy: false,
    intake: mock.intake,
  }),
}));

let conversationId: string;
beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  useConversationStore.setState({ activeId: null, conversations: {} });
  useSettingsStore.setState((state) => ({
    system: { ...state.system, language: "en" },
  }));
  conversationId = useConversationStore.getState().createConversation();
  mock.capture.mockResolvedValue({
    blob: new Blob(["png"], { type: "image/png" }),
  });
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => "blob:annotation-image"),
      revokeObjectURL: vi.fn(),
    }),
  );
  const image = new Image();
  image.src = "data:image/png;base64,AA==";
  Object.defineProperties(image, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  mock.load.mockResolvedValue(image);
  mock.export.mockResolvedValue(
    new File(["png"], "preview-annotation.png", { type: "image/png" }),
  );
  mock.intake.mockResolvedValue({ ok: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, options: PointerEventInit) {
        super(type, options);
        this.pointerId = options.pointerId ?? 1;
      }
    },
  );
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue({ left: 0, top: 0, width: 300, height: 200 } as DOMRect);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    new Proxy(
      {},
      { get: (_target, key) => (key === "canvas" ? undefined : vi.fn()) },
    ) as CanvasRenderingContext2D,
  );
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  HTMLCanvasElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(strict = false, scope: PreviewCaptureScope = "viewport") {
  const close = vi.fn();
  const editor = (
    <TooltipProvider>
      <PreviewAnnotation
        conversationId={conversationId}
        scope={scope}
        onClose={close}
      />
    </TooltipProvider>
  );
  render(strict ? <StrictMode>{editor}</StrictMode> : editor);
  await screen.findByLabelText("Draw on the preview image");
  return close;
}
function drag(start = { x: 30, y: 40 }, end = { x: 180, y: 160 }) {
  const canvas = screen.getByLabelText("Draw on the preview image");
  fireEvent.pointerDown(canvas, {
    clientX: start.x,
    clientY: start.y,
    pointerId: 1,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    clientX: end.x,
    clientY: end.y,
    pointerId: 1,
  });
  fireEvent.pointerUp(canvas, { clientX: end.x, clientY: end.y, pointerId: 1 });
}

describe("preview annotation", () => {
  it("uses custom color and stroke controls while preserving keyboard dismissal", async () => {
    const close = await open();
    const user = userEvent.setup();
    const color = screen.getByRole("button", {
      name: "Annotation color",
    });
    await user.click(color);
    await user.click(screen.getByRole("button", { name: "Blue" }));
    expect(screen.getByRole("button", { name: "Blue" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const hex = screen.getByRole("textbox", { name: "HEX color" });
    await user.clear(hex);
    await user.type(hex, "#zz");
    expect(hex).toHaveAttribute("aria-invalid", "true");
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    expect(color).toHaveFocus();
    drag();
    await user.click(color);
    expect(screen.getByRole("textbox", { name: "HEX color" })).toHaveValue(
      "#3b82f6",
    );
    await user.clear(screen.getByRole("textbox", { name: "HEX color" }));
    await user.type(
      screen.getByRole("textbox", { name: "HEX color" }),
      "#123ABC",
    );
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("combobox", { name: "Stroke width" }));
    await user.click(screen.getByRole("option", { name: "Thick" }));
    drag();
    await user.click(screen.getByRole("combobox", { name: "Stroke width" }));
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Attach image" }));
    await waitFor(() => expect(mock.export).toHaveBeenCalled());
    expect(mock.export.mock.calls[0][1].marks).toMatchObject([
      { color: "#3b82f6", width: 3 },
      { color: "#123abc", width: 6 },
    ]);
  });
  it("captures once under StrictMode and can attach the untouched visible image", async () => {
    const close = await open(true);
    expect(mock.capture).toHaveBeenCalledTimes(1);
    expect(mock.capture).toHaveBeenCalledWith(
      conversationId,
      expect.any(AbortSignal),
      "viewport",
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach image" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(mock.export.mock.calls[0][1]).toEqual({ marks: [], crop: null });
    expect(mock.intake.mock.calls[0][1]).toMatchObject({
      conversationId,
      checkoutEpoch: 0,
    });
  });

  it("keeps a full-page image at width-fit scale and releases its Blob URL", async () => {
    const image = new Image();
    image.src = "blob:annotation-image";
    Object.defineProperties(image, {
      naturalWidth: { value: 600 },
      naturalHeight: { value: 10000 },
    });
    mock.load.mockResolvedValue(image);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(616);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(416);
    await open(false, "full-page");
    expect(mock.capture).toHaveBeenCalledWith(
      conversationId,
      expect.any(AbortSignal),
      "full-page",
    );
    expect(
      screen.getByLabelText("Draw on the preview image").parentElement,
    ).toHaveStyle({
      width: "600px",
      height: "10000px",
    });
    cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:annotation-image");
  });

  it("exports image coordinates, with crop changes included in undo and redo", async () => {
    await open();
    drag();
    await userEvent.click(
      screen.getByRole("button", { name: "Select screenshot area" }),
    );
    drag({ x: 250, y: 180 }, { x: 10, y: 20 });
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByRole("button", { name: "Use full image" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Redo" }));
    await userEvent.click(screen.getByRole("button", { name: "Attach image" }));
    await waitFor(() => expect(mock.export).toHaveBeenCalled());
    const document = mock.export.mock.calls[0][1] as AnnotationDocument;
    expect(document.marks).toEqual([
      {
        tool: "arrow",
        start: { x: 60, y: 80 },
        end: { x: 360, y: 320 },
        color: "#ef4444",
        width: 3,
      },
    ]);
    expect(document.crop).toEqual({ x: 20, y: 40, width: 480, height: 320 });
  });

  it("retains marks after attachment failure and retries without duplicating pending text", async () => {
    const close = await open();
    mock.intake.mockResolvedValueOnce({ ok: false, error: "Storage is full" });
    await userEvent.click(screen.getByRole("button", { name: "Text" }));
    const canvas = screen.getByLabelText("Draw on the preview image");
    fireEvent.pointerDown(canvas, { clientX: 30, clientY: 40, pointerId: 1 });
    await userEvent.type(
      screen.getByRole("textbox", { name: "Enter text" }),
      "Fix this",
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach image" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Storage is full",
    );
    expect(close).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Attach image" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    for (const call of mock.export.mock.calls)
      expect(call[1].marks).toHaveLength(1);
  });

  it("ignores empty text and cancelled pointer gestures", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Text" }));
    const canvas = screen.getByLabelText("Draw on the preview image");
    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 20, pointerId: 1 });
    await userEvent.type(
      screen.getByRole("textbox", { name: "Enter text" }),
      "   {Enter}",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Freehand brush" }),
    );
    fireEvent.pointerDown(canvas, { clientX: 30, clientY: 40, pointerId: 1 });
    fireEvent.pointerCancel(canvas, { pointerId: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Attach image" }));
    await waitFor(() => expect(mock.export).toHaveBeenCalled());
    expect(mock.export.mock.calls[0][1].marks).toEqual([]);
  });

  it("keeps a frozen image through file updates but closes on checkout", async () => {
    const close = await open();
    await act(async () => {
      useConversationStore
        .getState()
        .setFilesForConversation(conversationId, { "index.html": "changed" });
    });
    expect(close).not.toHaveBeenCalled();
    expect(mock.capture).toHaveBeenCalledOnce();
    await act(async () => {
      await useConversationStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...state.conversations[conversationId],
            checkoutEpoch: 1,
          },
        },
      }));
    });
    expect(close).toHaveBeenCalled();
  });

  it("aborts an in-flight attachment when the user cancels", async () => {
    const close = await open();
    let finish!: (value: { ok: true }) => void;
    mock.intake.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach image" }));
    await waitFor(() => expect(mock.intake).toHaveBeenCalledOnce());
    const signal = mock.intake.mock.calls[0][2] as AbortSignal;
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel annotation" }),
    );
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ ok: true }));
    expect(close).toHaveBeenCalledOnce();
  });
});
