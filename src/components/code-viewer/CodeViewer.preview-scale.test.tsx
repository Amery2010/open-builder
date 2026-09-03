// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CSSProperties, PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@codesandbox/sandpack-react", () => ({
  SandpackProvider: ({ children }: PropsWithChildren) => <>{children}</>,
  SandpackLayout: ({ children }: PropsWithChildren) => <>{children}</>,
  SandpackCodeEditor: () => <div data-testid="sandpack-editor" />,
  SandpackPreview: ({
    className,
    style,
  }: {
    className?: string;
    style?: CSSProperties;
  }) => (
    <div data-testid="sandpack-preview" className={className} style={style}>
      <nav data-testid="sandpack-navigator" className="sp-navigator" />
      <div className="sp-preview-container">
        <iframe title="Sandpack Preview" className="sp-preview-iframe" />
        <div data-testid="sandpack-actions" className="sp-preview-actions" />
      </div>
    </div>
  ),
  SandpackConsole: () => <div data-testid="sandpack-console" />,
}));

vi.mock("./SandpackListener", () => ({ SandpackListener: () => null }));
vi.mock("./FileExplorer", () => ({ FileExplorer: () => null }));
vi.mock("../design/DesignSystemPanel", () => ({
  DesignSystemPanel: () => null,
}));
vi.mock("../design/DesignTokenPanel", () => ({
  DesignTokenPanel: () => null,
}));
vi.mock("../design/DesignReviewDialog", () => ({
  DesignReviewDialog: () => null,
}));
vi.mock("./SandpackPreviewActions", () => ({
  SandpackActionButton: ({
    children,
    label,
  }: PropsWithChildren<{ label: string }>) => (
    <button aria-label={label}>{children}</button>
  ),
  SandpackRefreshAction: ({ label }: { label: string }) => (
    <button aria-label={label} />
  ),
  SandpackRefreshRegistration: () => null,
}));

vi.mock("./ViewToolbar", () => ({
  MIN_PREVIEW_SCALE: 0.25,
  MAX_PREVIEW_SCALE: 1.5,
  PREVIEW_SCALE_STEP: 0.1,
  clampPreviewScale: (scale: number) =>
    Math.round(Math.min(1.5, Math.max(0.25, scale)) * 100) / 100,
  ViewToolbar: (props: {
    viewMode: "preview" | "code";
    deviceSize: "desktop" | "tablet" | "mobile";
    previewScale: number;
    onViewModeChange: (mode: "preview" | "code") => void;
    onDeviceSizeChange: (device: "desktop" | "tablet" | "mobile") => void;
    onPreviewZoomIn: () => void;
    onPreviewZoomOut: () => void;
  }) => (
    <div>
      <output data-testid="view-mode">{props.viewMode}</output>
      <output data-testid="device-size">{props.deviceSize}</output>
      <output data-testid="preview-scale">
        {Math.round(props.previewScale * 100)}
      </output>
      <button onClick={props.onPreviewZoomOut}>Zoom out</button>
      <button onClick={props.onPreviewZoomIn}>Zoom in</button>
      <button onClick={() => props.onViewModeChange("code")}>Code view</button>
      <button onClick={() => props.onViewModeChange("preview")}>
        Preview view
      </button>
      <button onClick={() => props.onDeviceSizeChange("tablet")}>
        Tablet device
      </button>
      <button onClick={() => props.onDeviceSizeChange("mobile")}>
        Mobile device
      </button>
    </div>
  ),
}));

vi.mock("@/hooks/useTheme", () => ({ useTheme: () => false }));
vi.mock("../../lib/design/desktop", () => ({
  supportsDesktopDesignTools: () => false,
  exportProjectToUniqueDirectory: vi.fn(),
}));

const conversationState = {
  conversations: {
    "conversation-a": { workspaceMode: "auto", title: "A" },
    "conversation-b": { workspaceMode: "auto", title: "B" },
  },
};

vi.mock("../../store/conversation", () => {
  const useConversationStore = Object.assign(
    (selector: (state: typeof conversationState) => unknown) =>
      selector(conversationState),
    { getState: () => conversationState },
  );
  return { useConversationStore, DEFAULT_TITLE: "New Project" };
});

const designReviewState = {
  automatic: undefined,
  dialogRequestId: 0,
  status: "idle",
  reset: vi.fn(),
  selectRun: vi.fn(),
};

vi.mock("../../store/design-review", () => {
  const useDesignReviewStore = Object.assign(
    (selector: (state: typeof designReviewState) => unknown) =>
      selector(designReviewState),
    { getState: () => designReviewState },
  );
  return { useDesignReviewStore };
});

vi.mock("../../store/design-selection", () => ({
  useDesignSelectionStore: (
    selector: (state: { setSelection: () => void }) => unknown,
  ) => selector({ setSelection: vi.fn() }),
}));

import {
  CodeViewer,
  resolvePreviewIframeHeight,
  resolvePreviewScale,
} from "../CodeViewer";

const baseProps = {
  files: { "src/App.tsx": "export default function App() {}" },
  currentFile: "src/App.tsx",
  onFileSelect: vi.fn(),
  onFileChange: vi.fn(),
  onRenameFile: vi.fn(),
  onDeleteFile: vi.fn(),
  onMoveFile: vi.fn(),
  template: "vite-react-ts",
  sandpackKey: 1,
  onReloadPreview: vi.fn(),
};

describe("CodeViewer preview scale", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        private readonly callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        observe() {
          this.callback([], this as unknown as ResizeObserver);
        }

        disconnect() {}
        unobserve() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps design captures at their unzoomed logical viewport", () => {
    expect(
      resolvePreviewScale({
        captureActive: true,
        requestedScale: 1.5,
      }),
    ).toBe(1);
    expect(
      resolvePreviewScale({
        captureActive: false,
        requestedScale: 1.5,
      }),
    ).toBe(1.5);
  });

  it.each([
    [0.6, "166.67%"],
    [1, "100%"],
    [1.5, "66.67%"],
  ])("computes the inverse iframe height for %s scale", (scale, height) => {
    expect(resolvePreviewIframeHeight(scale)).toBe(height);
  });

  it("scopes the visual transform and themed backdrop to the preview iframe", () => {
    const stylesheet = readFileSync(resolve("src/index.css"), "utf8");
    const previewRule = stylesheet.match(
      /\.editor \.preview-content-zoom\s*\{([^}]*)\}/,
    )?.[1];
    const iframeRule = stylesheet.match(
      /\.preview-content-zoom \.sp-preview-iframe\s*\{([^}]*)\}/,
    )?.[1];
    const scaledIframeRule = stylesheet.match(
      /\.preview-content-scaled \.sp-preview-iframe\s*\{([^}]*)\}/,
    )?.[1];
    const containerRule = stylesheet.match(
      /\.preview-content-zoom \.sp-preview-container\s*\{([^}]*)\}/,
    )?.[1];

    expect(previewRule).toContain("background-color: var(--background)");
    expect(previewRule).toContain("border: 0");
    expect(previewRule).toContain("gap: 0");
    expect(scaledIframeRule).toContain(
      "transform: scale(var(--ob-preview-scale))",
    );
    expect(scaledIframeRule).toContain(
      "transform-origin: var(--ob-preview-transform-origin)",
    );
    expect(iframeRule).not.toContain("transform:");
    expect(iframeRule).toContain("position: absolute");
    expect(iframeRule).toContain("top: 0");
    expect(iframeRule).toContain("width: 100%");
    expect(iframeRule).toContain(
      "height: var(--ob-preview-iframe-height) !important",
    );
    expect(iframeRule).toContain("min-height: 0");
    expect(iframeRule).toContain("max-height: none");
    expect(iframeRule).toContain("flex: none");
    expect(iframeRule).toContain("border: 0");
    expect(iframeRule).toContain("outline: 0");
    expect(containerRule).toContain("height: 100%");
    expect(containerRule).toContain("min-height: 0");
    expect(containerRule).toContain("overflow-x: auto");
    expect(containerRule).toContain("overflow-y: hidden");
    expect(containerRule).toContain("background-color: var(--background)");
    expect(containerRule).toContain("border: 0");
    expect(stylesheet).not.toMatch(
      /\.preview-content-zoom \.sp-navigator\s*\{[^}]*transform/,
    );
    expect(stylesheet).not.toMatch(
      /\.preview-content-zoom \.sp-preview-actions\s*\{[^}]*transform/,
    );
  });

  it("keeps preview actions outside the horizontally scrolling viewport", () => {
    render(<CodeViewer conversationId="conversation-a" {...baseProps} />);

    const preview = screen.getByTestId("sandpack-preview");
    const scrollingViewport = preview.querySelector(".sp-preview-container");
    const viewportActions = document.querySelector<HTMLElement>(
      ".preview-viewport-actions",
    );

    expect(viewportActions).toBeInTheDocument();
    expect(scrollingViewport).not.toContainElement(viewportActions);
    expect(viewportActions?.parentElement).toBe(preview.parentElement);
    expect(viewportActions?.parentElement).toHaveClass("relative");
    expect(viewportActions).toHaveClass("absolute", "bottom-2", "right-2");
  });

  it("passes inverse iframe heights for the supported zoom levels", async () => {
    const user = userEvent.setup();
    render(<CodeViewer conversationId="conversation-a" {...baseProps} />);

    const preview = screen.getByTestId("sandpack-preview");
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    expect(preview.style.getPropertyValue("--ob-preview-iframe-height")).toBe(
      "100%",
    );
    expect(preview).not.toHaveClass("preview-content-scaled");

    for (let step = 0; step < 4; step += 1) await user.click(zoomOut);
    expect(preview.style.getPropertyValue("--ob-preview-iframe-height")).toBe(
      "166.67%",
    );
    expect(preview).toHaveClass("preview-content-scaled");

    for (let step = 0; step < 4; step += 1) await user.click(zoomIn);
    expect(preview.style.getPropertyValue("--ob-preview-iframe-height")).toBe(
      "100%",
    );
    expect(preview).not.toHaveClass("preview-content-scaled");

    for (let step = 0; step < 5; step += 1) await user.click(zoomIn);
    expect(preview.style.getPropertyValue("--ob-preview-iframe-height")).toBe(
      "66.67%",
    );
    expect(preview).toHaveClass("preview-content-scaled");
  });

  it("zooms only the webpage viewport and resets scale by project or device", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CodeViewer conversationId="conversation-a" {...baseProps} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-scale")).toHaveTextContent("100");
    });
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByTestId("preview-scale")).toHaveTextContent("90");
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("preview-scale")).toHaveTextContent("100");

    for (let step = 0; step < 5; step += 1) {
      await user.click(screen.getByRole("button", { name: "Zoom out" }));
    }
    expect(screen.getByTestId("preview-scale")).toHaveTextContent("50");

    const preview = screen.getByTestId("sandpack-preview");
    const previewSurface = preview.parentElement?.parentElement as HTMLElement;
    const previewFrame = previewSurface.parentElement as HTMLElement;
    expect(preview.style.transform).toBe("");
    expect(previewSurface.style.transform).toBe("");
    expect(previewSurface).not.toHaveClass("rounded-lg", "border", "shadow-lg");
    expect(previewFrame.style.width).toBe("100%");
    expect(previewFrame.style.height).toBe("100%");
    expect(preview).toHaveClass("preview-content-zoom");
    expect(preview).toHaveClass("preview-content-scaled");
    expect(preview.style.getPropertyValue("--ob-preview-scale")).toBe("0.5");
    expect(preview.style.getPropertyValue("--ob-preview-iframe-height")).toBe(
      "200%",
    );
    expect(
      preview.style.getPropertyValue("--ob-preview-transform-origin"),
    ).toBe("top center");
    expect(screen.getByTestId("sandpack-navigator").style.transform).toBe("");
    expect(screen.getByTestId("sandpack-actions").style.transform).toBe("");

    await user.click(screen.getByRole("button", { name: "Code view" }));
    await user.click(screen.getByRole("button", { name: "Preview view" }));
    expect(screen.getByTestId("preview-scale")).toHaveTextContent("50");

    rerender(<CodeViewer conversationId="conversation-b" {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("preview-scale")).toHaveTextContent("100");
    });
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("preview-scale")).toHaveTextContent("110");
    expect(
      preview.style.getPropertyValue("--ob-preview-transform-origin"),
    ).toBe("top left");

    await user.click(screen.getByRole("button", { name: "Tablet device" }));
    await waitFor(() => {
      expect(screen.getByTestId("device-size")).toHaveTextContent("tablet");
      expect(screen.getByTestId("preview-scale")).toHaveTextContent("100");
    });
    expect(previewSurface.style.width).toBe("768px");
    expect(previewSurface.style.height).toBe("1024px");
    expect(previewSurface.style.transform).toBe("");

    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByTestId("preview-scale")).toHaveTextContent("90");
    rerender(<CodeViewer conversationId="conversation-a" {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("preview-scale")).toHaveTextContent("100");
    });

    await user.click(screen.getByRole("button", { name: "Mobile device" }));
    await waitFor(() => {
      expect(screen.getByTestId("device-size")).toHaveTextContent("mobile");
      expect(screen.getByTestId("preview-scale")).toHaveTextContent("100");
    });
    expect(previewSurface.style.width).toBe("375px");
    expect(previewSurface.style.height).toBe("667px");
  });
});
