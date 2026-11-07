// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CSSProperties, PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sandpackProviderError: Error | null = null;
const projectFilesForSandpackMock = vi.hoisted(() => vi.fn());
const getProjectAssetBlobMock = vi.hoisted(() => vi.fn());
const captureRuntimeFixture = vi.hoisted(() => ({
  enabled: false,
  synchronized: false,
  restart: vi.fn(),
  adapter: null as
    import("../../lib/design/preview-runtime").PreviewRuntimeAdapter | null,
}));
vi.mock("../../lib/design/preview-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/design/preview-runtime")>();
  return {
    ...actual,
    registerPreviewRuntime: (
      conversationId: string,
      adapter: import("../../lib/design/preview-runtime").PreviewRuntimeAdapter,
    ) => {
      captureRuntimeFixture.adapter = adapter;
      return actual.registerPreviewRuntime(conversationId, adapter);
    },
  };
});

vi.mock("@codesandbox/sandpack-react", async (importOriginal) => ({
  SANDBOX_TEMPLATES: (
    await importOriginal<typeof import("@codesandbox/sandpack-react")>()
  ).SANDBOX_TEMPLATES,
  SandpackProvider: ({ children }: PropsWithChildren) => {
    if (sandpackProviderError) throw sandpackProviderError;
    return <>{children}</>;
  },
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

vi.mock("./SandpackRuntimeSync", async () => {
  const { useEffect } = await import("react");
  return {
    SandpackRuntimeSync: ({
      onChange,
    }: {
      onChange: (
        handle:
          import("./SandpackRuntimeSync").SandpackRuntimeSyncHandle | null,
      ) => void;
    }) => {
      useEffect(() => {
        if (!captureRuntimeFixture.enabled) return;
        onChange({
          isSynchronized: () => captureRuntimeFixture.synchronized,
          restart: captureRuntimeFixture.restart,
        });
        return () => onChange(null);
      }, [onChange]);
      return null;
    },
  };
});

vi.mock("../../lib/project-assets/core", () => ({
  projectFilesForSandpack: projectFilesForSandpackMock,
  getProjectAssetBlob: getProjectAssetBlobMock,
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
    "conversation-a": { workspaceMode: "auto", title: "A", assets: {} },
    "conversation-b": { workspaceMode: "auto", title: "B", assets: {} },
  },
  setAssetsForConversation: vi.fn(),
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
    captureRuntimeFixture.enabled = false;
    captureRuntimeFixture.synchronized = false;
    captureRuntimeFixture.adapter = null;
    captureRuntimeFixture.restart.mockReset();
    conversationState.conversations["conversation-a"].workspaceMode = "auto";
    projectFilesForSandpackMock.mockReset();
    projectFilesForSandpackMock.mockImplementation(
      async (files: Record<string, string>) => files,
    );
    getProjectAssetBlobMock.mockReset();
    getProjectAssetBlobMock.mockResolvedValue(null);
    conversationState.setAssetsForConversation.mockReset();
    conversationState.conversations["conversation-a"].assets = {};
    conversationState.conversations["conversation-b"].assets = {};
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
    vi.useRealTimers();
    sandpackProviderError = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    {
      template: "react",
      previewMode: "sandpack" as const,
      error: "Preview capture is not supported for the react preview template.",
    },
    {
      template: "static",
      previewMode: "code-only" as const,
      error: "Preview capture is unavailable in code-only projects.",
    },
  ])(
    "rejects permanently unavailable capture for $template / $previewMode without restarting",
    async ({ template, previewMode, error }) => {
      vi.stubGlobal("crypto", webcrypto);
      captureRuntimeFixture.enabled = true;
      conversationState.conversations["conversation-a"].workspaceMode =
        "design";
      render(
        <CodeViewer
          {...baseProps}
          conversationId="conversation-a"
          template={template}
          previewMode={previewMode}
          files={{ "index.html": "<html><body>Capture fixture</body></html>" }}
        />,
      );
      await waitFor(() =>
        expect(captureRuntimeFixture.adapter?.getGeneration()).toBeTruthy(),
      );
      const adapter = captureRuntimeFixture.adapter!;
      await expect(
        adapter.prepare(adapter.getGeneration()!, new AbortController().signal),
      ).rejects.toMatchObject({ code: "preview_unavailable", message: error });
      expect(captureRuntimeFixture.restart).not.toHaveBeenCalled();
    },
  );

  it("requires the current runtime nonce after recovering a stalled capture client", async () => {
    vi.stubGlobal("crypto", webcrypto);
    captureRuntimeFixture.enabled = true;
    captureRuntimeFixture.restart.mockImplementation(async () => {
      captureRuntimeFixture.synchronized = true;
    });
    conversationState.conversations["conversation-a"].workspaceMode = "design";
    const { loadDesignCaptureRuntimeSource } =
      await import("../../lib/design/preview-capture");
    await loadDesignCaptureRuntimeSource();
    render(
      <CodeViewer
        {...baseProps}
        conversationId="conversation-a"
        template="static"
        files={{ "index.html": "<html><body>Capture fixture</body></html>" }}
      />,
    );
    await waitFor(() =>
      expect(captureRuntimeFixture.adapter?.getGeneration()).toBeTruthy(),
    );
    const adapter = captureRuntimeFixture.adapter!;
    const generation = adapter.getGeneration()!;
    const iframe = screen.getByTitle("Sandpack Preview") as HTMLIFrameElement;
    Object.defineProperty(iframe, "src", {
      value: "https://preview.example.test/",
      configurable: true,
    });
    const sent: Array<Record<string, unknown>> = [];
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(
      (message: unknown) => {
        sent.push(message as Record<string, unknown>);
      },
    );
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    let prepared = false;
    let failure: unknown;
    const preparation = adapter
      .prepare(generation, new AbortController().signal)
      .then(
        () => {
          prepared = true;
        },
        (error: unknown) => {
          failure = error;
        },
      );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(captureRuntimeFixture.restart).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(201);
    });
    expect(captureRuntimeFixture.restart).toHaveBeenCalledOnce();
    const request = sent.find(
      (message) => message.type === "open-builder:design-bridge-readiness",
    );
    expect(request).toMatchObject({
      generation,
      nonce: expect.any(String),
      runtimeRevision: expect.any(String),
    });
    const respond = (nonce: unknown) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          origin: "https://preview.example.test",
          data: {
            ...request,
            type: "open-builder:design-bridge-ready",
            nonce,
            captureRuntimeAvailable: true,
          },
        }),
      );
    };
    await act(async () => {
      respond("obsolete-nonce");
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(prepared).toBe(false);
    await act(async () => {
      respond(request!.nonce);
      await vi.advanceTimersByTimeAsync(250);
    });
    await preparation;
    expect(failure).toBeUndefined();
    expect(prepared).toBe(true);
    expect(captureRuntimeFixture.restart).toHaveBeenCalledOnce();
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

  it("keeps a Sandpack render error recoverable in the code workspace", () => {
    sandpackProviderError = new SyntaxError(
      "Unexpected token / in package.json",
    );
    const onFileChange = vi.fn();
    const onDeleteFile = vi.fn();

    render(
      <CodeViewer
        conversationId="conversation-a"
        {...baseProps}
        files={{
          "package.json": "// invalid package",
          "src/App.tsx": "export default function App() {}",
        }}
        currentFile="src/App.tsx"
        onFileChange={onFileChange}
        onDeleteFile={onDeleteFile}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Preview unavailable");
    expect(screen.getByLabelText("Edit package.json")).toHaveValue(
      "// invalid package",
    );

    screen.getByRole("button", { name: "Remove package.json" }).click();
    expect(onDeleteFile).toHaveBeenCalledWith("package.json");
  });

  it("never writes a redacted preview draft back to the canonical project", () => {
    sandpackProviderError = new Error("Transient preview failure");
    const onFileChange = vi.fn();
    const secretSource = 'export const apiKey = "supersecret123";';

    render(
      <CodeViewer
        conversationId="conversation-a"
        {...baseProps}
        files={{ "src/config.ts": secretSource }}
        currentFile="src/config.ts"
        onFileChange={onFileChange}
      />,
    );

    expect(screen.getByLabelText("Edit src/config.ts")).toHaveValue(
      'export const apiKey = "[REDACTED]";',
    );
    expect(
      screen.getByRole("button", { name: "Repair preview" }),
    ).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(
      /hides protected values/i,
    );
    expect(onFileChange).not.toHaveBeenCalled();
  });

  it("keeps code and asset removal available when Blob projection fails", async () => {
    const user = userEvent.setup();
    const asset = {
      path: "public/logo.png",
      blobRef: `sha256:${"a".repeat(64)}`,
      digest: "a".repeat(64),
      mimeType: "image/png" as const,
      size: 8,
      modulePath: `src/generated-assets/logo-${"b".repeat(64)}.js`,
      publicPath: "/logo.png",
    };
    conversationState.conversations["conversation-a"].assets = {
      [asset.path]: asset,
    };
    projectFilesForSandpackMock.mockRejectedValueOnce(
      new Error("Project asset is unavailable locally."),
    );

    render(<CodeViewer conversationId="conversation-a" {...baseProps} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Project asset is unavailable locally.",
    );
    expect(screen.getByTestId("sandpack-editor")).toBeInTheDocument();
    expect(screen.getByTestId("view-mode")).toHaveTextContent("code");
    await user.click(
      screen.getByRole("button", {
        name: "Remove project image public/logo.png",
      }),
    );
    expect(conversationState.setAssetsForConversation).toHaveBeenCalledWith(
      "conversation-a",
      expect.any(Function),
    );
    const updater = conversationState.setAssetsForConversation.mock.calls[0][1];
    expect(updater({ [asset.path]: asset })).toEqual({});
  });

  it("resets the desktop render boundary through explicit retry", async () => {
    const onReloadPreview = vi.fn();
    sandpackProviderError = new Error("Transient preview failure");

    render(
      <CodeViewer
        conversationId="conversation-a"
        {...baseProps}
        onReloadPreview={onReloadPreview}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Transient preview failure",
    );

    sandpackProviderError = null;
    screen.getByRole("button", { name: "Retry preview" }).click();

    await waitFor(() => expect(onReloadPreview).toHaveBeenCalledOnce());
    expect(await screen.findByTestId("sandpack-preview")).toBeInTheDocument();
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

  it("initializes from the project preference and keeps manual device changes local", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CodeViewer
        conversationId="conversation-a"
        defaultPreviewView="tablet"
        {...baseProps}
      />,
    );

    expect(screen.getByTestId("device-size")).toHaveTextContent("tablet");
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByTestId("preview-scale")).toHaveTextContent("90");

    await user.click(screen.getByRole("button", { name: "Mobile device" }));
    expect(screen.getByTestId("device-size")).toHaveTextContent("mobile");
    expect(screen.getByTestId("preview-scale")).toHaveTextContent("100");

    // An AI preference update must not override a user's temporary device
    // choice for this mounted viewer.
    rerender(
      <CodeViewer
        conversationId="conversation-a"
        defaultPreviewView="desktop"
        {...baseProps}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("device-size")).toHaveTextContent("mobile");
    });

    // A remount/reload starts from the persisted project preference again.
    rerender(
      <CodeViewer
        conversationId="conversation-a"
        defaultPreviewView="desktop"
        {...baseProps}
        sandpackKey={2}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("device-size")).toHaveTextContent("desktop");
      expect(screen.getByTestId("preview-scale")).toHaveTextContent("100");
    });
  });

  it("syncs an AI default update when there is no manual override and resets zoom", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CodeViewer
        conversationId="conversation-a"
        defaultPreviewView="desktop"
        {...baseProps}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByTestId("preview-scale")).toHaveTextContent("90");

    rerender(
      <CodeViewer
        conversationId="conversation-a"
        defaultPreviewView="mobile"
        {...baseProps}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("device-size")).toHaveTextContent("mobile");
      expect(screen.getByTestId("preview-scale")).toHaveTextContent("100");
    });
  });
});
