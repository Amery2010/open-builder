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
import { PreviewScreenshot } from "./PreviewScreenshot";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  load: vi.fn(),
  encode: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../lib/preview-annotation/capture", () => ({
  capturePreviewImage: mocks.capture,
}));
vi.mock("../../lib/preview-annotation/document", async (original) => ({
  ...(await original<typeof import("../../lib/preview-annotation/document")>()),
  loadAnnotationImage: mocks.load,
}));
vi.mock("../../lib/images/png-crop", () => ({ encodePngCrop: mocks.encode }));
vi.mock("../../lib/utils/save-blob", () => ({ saveBlob: mocks.save }));

let conversationId: string;
const pixels = new Blob(["PNG"], { type: "image/png" });
beforeEach(() => {
  vi.resetAllMocks();
  useConversationStore.setState({ activeId: null, conversations: {} });
  conversationId = useConversationStore.getState().createConversation();
  useSettingsStore.setState((state) => ({
    system: { ...state.system, language: "en" },
  }));
  mocks.capture.mockResolvedValue({ blob: pixels });
  mocks.save.mockResolvedValue(true);
  mocks.encode.mockResolvedValue(pixels);
  const image = new Image();
  image.src = "blob:screenshot";
  Object.defineProperties(image, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  mocks.load.mockResolvedValue(image);
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => "blob:screenshot"),
      revokeObjectURL: vi.fn(),
    }),
  );
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
      pointerId = 1;
      isPrimary = true;
    },
  );
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 300,
    height: 200,
  } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("preview screenshot export", () => {
  it.each(["viewport", "full-page"] as const)(
    "saves %s pixels once under StrictMode without decoding or resizing",
    async (mode) => {
      const close = vi.fn();
      render(
        <StrictMode>
          <PreviewScreenshot
            conversationId={conversationId}
            mode={mode}
            onClose={close}
          />
        </StrictMode>,
      );
      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(mocks.capture).toHaveBeenCalledExactlyOnceWith(
        conversationId,
        expect.any(AbortSignal),
        mode,
        "screenshot",
      );
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith(
        pixels,
        expect.stringMatching(new RegExp(`-${mode}-.*\\.png$`)),
        { mimeType: "image/png", extension: "png", description: "PNG" },
        { signal: expect.any(AbortSignal) },
      );
      expect(mocks.load).not.toHaveBeenCalled();
      expect(mocks.encode).not.toHaveBeenCalled();
    },
  );

  it("maps a reverse drag from the scaled viewport to source pixels and exports only the crop", async () => {
    const close = vi.fn();
    const { unmount } = render(
      <PreviewScreenshot
        conversationId={conversationId}
        mode="region"
        onClose={close}
      />,
    );
    const area = await screen.findByRole("img", {
      name: "Select screenshot area",
    });
    const save = screen.getByRole("button", { name: "Export PNG" });
    expect(save).toBeDisabled();
    fireEvent.pointerDown(area, { button: 0, clientX: 250, clientY: 180 });
    fireEvent.pointerMove(area, { clientX: 50, clientY: 30 });
    fireEvent.pointerUp(area, { clientX: 50, clientY: 30 });
    expect(screen.getByText("400 × 300 px")).toBeVisible();
    await userEvent.click(save);
    expect(mocks.encode).toHaveBeenCalledExactlyOnceWith(
      expect.any(HTMLImageElement),
      { x: 100, y: 60, width: 400, height: 300 },
      expect.any(AbortSignal),
    );
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:screenshot");
  });

  it("clips a drag to image bounds and can clear or cancel the selection", async () => {
    render(
      <PreviewScreenshot
        conversationId={conversationId}
        mode="region"
        onClose={vi.fn()}
      />,
    );
    const area = await screen.findByRole("img", {
      name: "Select screenshot area",
    });
    fireEvent.pointerDown(area, { button: 0, clientX: 50, clientY: 30 });
    fireEvent.pointerUp(area, { clientX: 400, clientY: 250 });
    expect(screen.getByText("500 × 340 px")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Reselect area" }),
    );
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeDisabled();
    fireEvent.pointerDown(area, { button: 0, clientX: 50, clientY: 30 });
    fireEvent.pointerMove(area, { clientX: 100, clientY: 100 });
    fireEvent.pointerCancel(area);
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeDisabled();
  });

  it("keeps the frozen selection when the display language changes", async () => {
    render(
      <PreviewScreenshot
        conversationId={conversationId}
        mode="region"
        onClose={vi.fn()}
      />,
    );
    const area = await screen.findByRole("img", {
      name: "Select screenshot area",
    });
    fireEvent.pointerDown(area, { button: 0, clientX: 10, clientY: 20 });
    fireEvent.pointerUp(area, { clientX: 100, clientY: 120 });
    act(() => {
      useSettingsStore.setState((state) => ({
        system: { ...state.system, language: "zh" },
      }));
    });
    expect(screen.getByText("180 × 200 px")).toBeVisible();
    expect(screen.getByRole("button", { name: "导出 PNG" })).toBeEnabled();
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("does not save a late capture after Escape", async () => {
    let finish!: (result: { blob: Blob }) => void;
    mocks.capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const close = vi.fn();
    render(
      <PreviewScreenshot
        conversationId={conversationId}
        mode="viewport"
        onClose={close}
      />,
    );
    await waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    fireEvent.keyDown(
      screen.getByRole("region", { name: "Export screenshot" }),
      { key: "Escape" },
    );
    await act(async () => finish({ blob: pixels }));
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("cancels on checkout changes before a pending capture completes", async () => {
    let finish!: (result: { blob: Blob }) => void;
    mocks.capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const close = vi.fn();
    render(
      <PreviewScreenshot
        conversationId={conversationId}
        mode="full-page"
        onClose={close}
      />,
    );
    await waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    act(() => {
      useConversationStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...state.conversations[conversationId],
            checkoutEpoch:
              (state.conversations[conversationId].checkoutEpoch ?? 0) + 1,
          },
        },
      }));
    });
    await act(async () => finish({ blob: pixels }));
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.capture.mock.calls[0][1].aborted).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("shows a retryable capture failure without downloading a partial image", async () => {
    mocks.capture.mockRejectedValueOnce(new Error("Capture failed"));
    render(
      <PreviewScreenshot
        conversationId={conversationId}
        mode="region"
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not capture",
    );
    expect(mocks.save).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("img", { name: "Select screenshot area" });
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });
});
