// @vitest-environment jsdom

import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  act,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
} from "@testing-library/react";
import { TooltipProvider } from "../ui/tooltip";
import { Toaster, toast } from "sonner";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import type { CSSProperties, PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasPreviewRequest } from "../../lib/design/canvas-preview";
import { useSettingsStore } from "../../store/settings";
import { projectDesignSchema } from "../../lib/design/project-design";
import { projectFilesForPreview } from "../../lib/utils/project-file-policy";
import { capturePreviewImage } from "../../lib/preview-annotation/capture";
import { exportProjectToUniqueDirectory } from "../../lib/design/desktop";
import type { DesignBridgeCaptureResult } from "../../lib/design/preview-bridge";

function render(ui: ReactNode) {
  return renderWithTestingLibrary(ui, { wrapper: TooltipProvider });
}

let sandpackProviderError: Error | null = null;
const projectFilesForSandpackMock = vi.hoisted(() => vi.fn());
const getProjectAssetBlobMock = vi.hoisted(() => vi.fn());
const canvasPreviewFixture = vi.hoisted(() => ({
  retry: vi.fn(),
  capture: undefined as
    | Parameters<
        typeof import("../design/useCanvasPreviews").useCanvasPreviews
      >[0]["capture"]
    | undefined,
  input: null as
    | Parameters<
        typeof import("../design/useCanvasPreviews").useCanvasPreviews
      >[0]
    | null,
}));
vi.mock("../design/useCanvasPreviews", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../design/useCanvasPreviews")>();
  return {
    ...actual,
    useCanvasPreviews: (
      input: Parameters<typeof actual.useCanvasPreviews>[0],
    ) => {
      canvasPreviewFixture.input = input;
      const current = actual.useCanvasPreviews({
        ...input,
        capture: canvasPreviewFixture.capture ?? input.capture,
      });
      return {
        ...current,
        retry: (key: string) => {
          canvasPreviewFixture.retry(key);
          current.retry(key);
        },
      };
    },
  };
});
const bridgeProjectionFixture = vi.hoisted(() => ({
  files: {} as Record<string, { code: string }>,
  onFileChange: undefined as
    | ((conversationId: string, path: string, content: string) => void)
    | undefined,
}));
const captureRuntimeFixture = vi.hoisted(() => ({
  enabled: false,
  synchronized: false,
  restart: vi.fn(),
  adapter: null as
    import("../../lib/design/preview-runtime").PreviewRuntimeAdapter | null,
}));
const reviewCaptureFixture = vi.hoisted(() => ({
  capture: undefined as (() => Promise<void>) | undefined,
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
  SandpackProvider: ({
    children,
    files,
  }: PropsWithChildren<{
    files: Record<string, { code: string }>;
  }>) => {
    if (sandpackProviderError) throw sandpackProviderError;
    bridgeProjectionFixture.files = files;
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
          bootstrapIsolatedPreview: async () => () => undefined,
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

vi.mock("./SandpackListener", () => ({
  SandpackListener: (props: {
    onFileChange: typeof bridgeProjectionFixture.onFileChange;
  }) => {
    bridgeProjectionFixture.onFileChange = props.onFileChange;
    return null;
  },
}));
vi.mock("./FileExplorer", () => ({ FileExplorer: () => null }));
vi.mock("../design/DesignSystemPanel", () => ({
  DesignSystemPanel: () => null,
}));
vi.mock("../design/DesignTokenPanel", () => ({
  DesignTokenPanel: () => null,
}));
vi.mock("../design/DesignReviewDialog", () => ({
  DesignReviewDialog: ({
    onCaptureScreenshots,
  }: {
    onCaptureScreenshots?: () => Promise<void>;
  }) => {
    reviewCaptureFixture.capture = onCaptureScreenshots;
    return null;
  },
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
    onExportDirectory: () => void;
    designWorkspace?: unknown;
  }) => (
    <div>
      <output data-testid="view-mode">{props.viewMode}</output>
      <output data-testid="workspace-kind">
        {props.designWorkspace ? "canvas" : "preview"}
      </output>
      <output data-testid="device-size">{props.deviceSize}</output>
      <output data-testid="preview-scale">
        {Math.round(props.previewScale * 100)}
      </output>
      <button onClick={props.onPreviewZoomOut}>Zoom out</button>
      <button onClick={props.onExportDirectory}>Export directory</button>
      <button onClick={props.onPreviewZoomIn}>Zoom in</button>
      <button onClick={() => props.onViewModeChange("code")}>Code view</button>
      <button onClick={() => props.onViewModeChange("preview")}>
        Preview view
      </button>
      <button onClick={() => props.onDeviceSizeChange("tablet")}>
        Tablet device
      </button>
      <button onClick={() => props.onDeviceSizeChange("desktop")}>
        Desktop device
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
    "conversation-a": {
      id: "conversation-a",
      workspaceMode: "auto",
      title: "A",
      assets: {},
    },
    "conversation-b": {
      id: "conversation-b",
      workspaceMode: "auto",
      title: "B",
      assets: {},
    },
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
  automatic: undefined as ReturnType<
    typeof import("../../store/design-review").useDesignReviewStore.getState
  >["automatic"],
  dialogRequestId: 0,
  status: "idle",
  reset: vi.fn(),
  selectRun: vi.fn(),
  beginCapture: vi.fn(),
  failAutomatic: vi.fn(),
  finishAutomatic: vi.fn(),
  clearAutomatic: vi.fn(),
  fail: vi.fn(),
};

vi.mock("../../store/design-review", () => {
  const useDesignReviewStore = Object.assign(
    (selector: (state: typeof designReviewState) => unknown) =>
      selector(designReviewState),
    { getState: () => designReviewState, setState: vi.fn() },
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

const canvasBlueprint = JSON.stringify({
  schemaVersion: "open-builder-design-project/v3",
  revision: 1,
  pages: [
    { id: "home", name: "Home", route: "/", filePaths: ["index.html"] },
    { id: "draft", name: "Draft" },
  ],
});
const canvasFiles = (source: string) => ({
  "index.html": source,
  "design-project.json": canvasBlueprint,
});

function fastCrypto() {
  vi.stubGlobal("crypto", {
    randomUUID: () => webcrypto.randomUUID(),
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle: {
      digest: async (_algorithm: string, bytes: Uint8Array) =>
        new Uint8Array(createHash("sha256").update(bytes).digest()).buffer,
    },
  });
}

const automaticEvidence = (requestId: string) =>
  ({
    conversationId: "conversation-a",
    requestId,
    contract: {},
  }) as import("../../lib/design/automatic-review").AutomaticDesignReviewEvidence;

describe("CodeViewer preview scale", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, autoQaEnabled: true },
    }));
    canvasPreviewFixture.input = null;
    reviewCaptureFixture.capture = undefined;
    canvasPreviewFixture.capture = undefined;
    canvasPreviewFixture.retry.mockClear();
    bridgeProjectionFixture.files = {};
    bridgeProjectionFixture.onFileChange = undefined;
    captureRuntimeFixture.enabled = false;
    captureRuntimeFixture.synchronized = false;
    captureRuntimeFixture.adapter = null;
    captureRuntimeFixture.restart.mockReset();
    designReviewState.automatic = undefined;
    designReviewState.dialogRequestId = 0;
    designReviewState.beginCapture.mockClear();
    designReviewState.reset.mockClear();
    designReviewState.failAutomatic.mockClear();
    designReviewState.finishAutomatic.mockClear();
    designReviewState.fail.mockClear();
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

  it.each(["success", "failure"])(
    "does not publish a late export %s after leaving the project",
    async (outcome) => {
      type ExportResult = Awaited<
        ReturnType<typeof exportProjectToUniqueDirectory>
      >;
      let complete!: (result: ExportResult) => void;
      let fail!: (error: Error) => void;
      const pending = new Promise<ExportResult>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      vi.mocked(exportProjectToUniqueDirectory).mockReturnValueOnce(pending);
      const success = vi.spyOn(toast, "success");
      const error = vi.spyOn(toast, "error");
      const { unmount } = render(
        <CodeViewer {...baseProps} conversationId="conversation-a" />,
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Export directory" }),
      );
      unmount();
      await act(async () => {
        if (outcome === "success") {
          complete({
            path: "/tmp/exported-project",
            directoryName: "exported-project",
            fileCount: 1,
          });
        } else {
          fail(new Error("Export failed"));
        }
        await pending.catch(() => undefined);
      });
      expect(success).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("shows the traditional preview for a single design page and preserves the chosen Code view when pages change", async () => {
    fastCrypto();
    conversationState.conversations["conversation-a"].workspaceMode = "design";
    const props = {
      ...baseProps,
      conversationId: "conversation-a",
      template: "static",
      files: { "index.html": "<h1>Single</h1>" },
    };
    const { rerender } = render(<CodeViewer {...props} />);
    expect(screen.getByTestId("workspace-kind")).toHaveTextContent("preview");
    expect(screen.queryByTestId("design-canvas")).toBeNull();
    const single = JSON.parse(canvasBlueprint);
    single.pages = [single.pages[0]];
    rerender(
      <CodeViewer
        {...props}
        files={{
          ...props.files,
          "design-project.json": JSON.stringify(single),
        }}
      />,
    );
    expect(screen.queryByTestId("design-canvas")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Code view" }));
    rerender(
      <CodeViewer {...props} files={canvasFiles(props.files["index.html"])} />,
    );
    expect(screen.getByTestId("workspace-kind")).toHaveTextContent("canvas");
    expect(screen.getByTestId("view-mode")).toHaveTextContent("code");
    await userEvent.click(screen.getByRole("button", { name: "Preview view" }));
    expect(screen.getByTestId("design-canvas")).toBeVisible();
    rerender(
      <CodeViewer
        {...props}
        files={{
          ...props.files,
          "design-project.json": JSON.stringify(single),
        }}
      />,
    );
    expect(screen.getByTestId("workspace-kind")).toHaveTextContent("preview");
    expect(screen.queryByTestId("design-canvas")).toBeNull();
    expect(
      conversationState.conversations["conversation-a"].workspaceMode,
    ).toBe("design");
  });

  it.each([
    "{invalid",
    JSON.stringify({
      schemaVersion: "open-builder-design-project/v3",
      revision: 1,
      pages: [],
    }),
  ])(
    "keeps the canvas error or empty state for an unusable blueprint: %s",
    (blueprint) => {
      conversationState.conversations["conversation-a"].workspaceMode =
        "design";
      render(
        <CodeViewer
          {...baseProps}
          conversationId="conversation-a"
          template="static"
          files={{
            "index.html": "<h1>Page</h1>",
            "design-project.json": blueprint,
          }}
        />,
      );
      expect(screen.getByTestId("design-canvas")).toBeVisible();
      expect(screen.getByTestId("workspace-kind")).toHaveTextContent("canvas");
    },
  );

  it("does not consume automatic screenshot requests while QA is off", async () => {
    fastCrypto();
    useSettingsStore.setState((state) => ({
      system: { ...state.system, autoQaEnabled: false },
    }));
    conversationState.conversations["conversation-a"].workspaceMode = "design";
    designReviewState.automatic = {
      captureRequestId: 100,
      stage: "capturing",
      evidence: automaticEvidence("qa-off"),
    };
    const unavailable = vi.fn();
    render(
      <CodeViewer
        {...baseProps}
        conversationId="conversation-a"
        template="static"
        files={{ "index.html": "<h1>Single</h1>" }}
        onAutomaticDesignReviewUnavailable={unavailable}
      />,
    );
    await act(async () => {});
    expect(designReviewState.beginCapture).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("captures after two quiet seconds during generation, without an initial bridge notification", async () => {
    fastCrypto();
    const { loadDesignCaptureRuntimeSource } =
      await import("../../lib/design/preview-capture");
    await loadDesignCaptureRuntimeSource();
    vi.useFakeTimers();
    conversationState.conversations["conversation-a"].workspaceMode = "design";
    const capture = vi.fn(
      async (request: CanvasPreviewRequest) =>
        ({
          generation: request.generation,
          dataUrl: "data:image/png;base64,cGFnZQ==",
          viewport: { ...request.viewport, fullHeight: 900 },
        }) as DesignBridgeCaptureResult,
    );
    canvasPreviewFixture.capture = capture;
    const props = {
      ...baseProps,
      conversationId: "conversation-a",
      template: "static",
      files: canvasFiles("<html><body>First</body></html>"),
      isGenerating: true,
    };
    const { rerender, unmount } = render(<CodeViewer {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(capture).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(screen.getByRole("img")).toBeInTheDocument();
    rerender(
      <CodeViewer
        {...props}
        files={canvasFiles("<html><body>Second</body></html>")}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    rerender(
      <CodeViewer
        {...props}
        files={canvasFiles("<html><body>Latest</body></html>")}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(screen.getByRole("img")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(capture).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(capture).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hides a failed automatic notice after eight seconds without clearing its state", async () => {
    fastCrypto();
    vi.useFakeTimers();
    conversationState.conversations["conversation-a"].workspaceMode = "design";
    designReviewState.automatic = {
      stage: "unavailable",
      captureRequestId: 1,
      evidence: automaticEvidence("failed-a"),
    };
    const { getT } = await import("../../i18n");
    const message = getT().designReview.automaticStages.unavailable;
    render(
      <>
        <Toaster />
        <CodeViewer {...baseProps} conversationId="conversation-a" />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: getT().designReview.openWorkspace }),
    ).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7999);
    });
    expect(screen.getByText(message)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(201);
    });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(designReviewState.automatic?.stage).toBe("unavailable");
    expect(designReviewState.reset).not.toHaveBeenCalled();
  });

  it("waits for the initial preview generation before consuming an automatic capture request", async () => {
    fastCrypto();
    vi.useFakeTimers();
    conversationState.conversations["conversation-a"].workspaceMode = "design";
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(crypto.subtle, "digest").mockImplementation(
      async (algorithm, bytes) => {
        if (
          new TextDecoder()
            .decode(bytes as ArrayBuffer)
            .startsWith('{"template":')
        )
          await pending;
        return digest(algorithm, bytes);
      },
    );
    designReviewState.automatic = {
      stage: "capturing",
      captureRequestId: 2,
      evidence: automaticEvidence("pending-a"),
    };
    const unavailable = vi.fn();
    const { unmount } = render(
      <CodeViewer
        {...baseProps}
        conversationId="conversation-a"
        template="static"
        files={{ "index.html": "<html><body>Review</body></html>" }}
        onAutomaticDesignReviewUnavailable={unavailable}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(unavailable).not.toHaveBeenCalled();
    expect(designReviewState.beginCapture).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(designReviewState.beginCapture).toHaveBeenCalledOnce();
    expect(unavailable).not.toHaveBeenCalled();
    unmount();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
  });

  it("actively requests bridge readiness again and accepts only its current nonce", async () => {
    fastCrypto();
    vi.useFakeTimers();
    captureRuntimeFixture.enabled = true;
    captureRuntimeFixture.synchronized = true;
    conversationState.conversations["conversation-a"].workspaceMode = "design";
    canvasPreviewFixture.capture = vi.fn(
      async (request) =>
        ({ generation: request.generation }) as DesignBridgeCaptureResult,
    );
    render(
      <CodeViewer
        {...baseProps}
        conversationId="conversation-a"
        template="static"
        files={canvasFiles("<html><body>Page</body></html>")}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const iframe = screen.getByTitle("Sandpack Preview") as HTMLIFrameElement;
    Object.defineProperties(iframe, {
      src: { value: "https://preview.example.test/", configurable: true },
      clientWidth: { value: 1440, configurable: true },
      clientHeight: { value: 900, configurable: true },
    });
    const sent: Array<Record<string, unknown>> = [];
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(
      (message) => {
        sent.push(message);
      },
    );
    const controller = new AbortController();
    const generation = captureRuntimeFixture.adapter!.getGeneration()!;
    expect(generation).toBeTruthy();
    let failure: unknown;
    const capture = capturePreviewImage(
      "conversation-a",
      controller.signal,
      "viewport",
      "screenshot",
    ).catch((error: unknown) => {
      failure = error;
      return error;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const requests = () =>
      sent.filter(
        (message) => message.type === "open-builder:design-bridge-readiness",
      );
    expect(
      requests().length,
      failure instanceof Error ? failure.message : String(failure),
    ).toBeGreaterThan(1);
    const reply = (nonce: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          origin: "https://preview.example.test",
          data: {
            ...requests()[0],
            type: "open-builder:design-bridge-ready",
            nonce,
            captureRuntimeAvailable: true,
            route: "#/",
          },
        }),
      );
    await act(async () => {
      reply("stale-nonce");
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(
      sent.some(
        (message) => message.type === "open-builder:design-bridge-capture",
      ),
    ).toBe(false);
    await act(async () => {
      reply(requests()[0].nonce);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(
      sent.filter(
        (message) => message.type === "open-builder:design-bridge-capture",
      ),
    ).toHaveLength(1);
    await act(async () => {
      controller.abort();
    });
    expect(await capture).toMatchObject({ name: "AbortError" });
  });

  it("resumes a pending automatic request when a manual capture releases its slot", async () => {
    fastCrypto();
    vi.useFakeTimers();
    conversationState.conversations["conversation-a"].workspaceMode = "design";
    captureRuntimeFixture.enabled = true;
    const props = {
      ...baseProps,
      conversationId: "conversation-a",
      template: "static",
      files: { "index.html": "<html><body>Review</body></html>" },
      onDesignReview: vi.fn(),
    };
    const { rerender, unmount } = render(<CodeViewer {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    let failManual!: (error: Error) => void;
    const captureModule = await import("../../lib/design/preview-capture");
    vi.spyOn(
      captureModule,
      "loadDesignCaptureRuntimeSource",
    ).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failManual = reject;
        }),
    );
    const manual = reviewCaptureFixture.capture!();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(designReviewState.beginCapture).toHaveBeenCalledOnce();
    designReviewState.automatic = {
      stage: "capturing",
      captureRequestId: 3,
      evidence: automaticEvidence("after-manual"),
    };
    rerender(<CodeViewer {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(designReviewState.beginCapture).toHaveBeenCalledOnce();
    await act(async () => {
      failManual(new Error("Manual capture failed"));
      await manual;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(designReviewState.beginCapture).toHaveBeenCalledTimes(2);
    rerender(<CodeViewer {...props} />);
    expect(designReviewState.beginCapture).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
  });

  it("bounds readiness waiting and ignores an obsolete automatic request", async () => {
    fastCrypto();
    vi.useFakeTimers();
    conversationState.conversations["conversation-a"].workspaceMode = "design";
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, bytes) =>
      new TextDecoder().decode(bytes as ArrayBuffer).startsWith('{"template":')
        ? new Promise(() => undefined)
        : digest(algorithm, bytes),
    );
    designReviewState.automatic = {
      stage: "capturing",
      captureRequestId: 4,
      evidence: automaticEvidence("old-request"),
    };
    const unavailable = vi.fn();
    const props = {
      ...baseProps,
      conversationId: "conversation-a",
      template: "static",
      files: { "index.html": "<html><body>Review</body></html>" },
      onAutomaticDesignReviewUnavailable: unavailable,
    };
    const { rerender, unmount } = render(<CodeViewer {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    designReviewState.automatic = {
      stage: "capturing",
      captureRequestId: 5,
      evidence: automaticEvidence("latest-request"),
    };
    rerender(<CodeViewer {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(unavailable).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(unavailable).toHaveBeenCalledOnce();
    expect(unavailable.mock.calls[0][0].requestId).toBe("latest-request");
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["digest", "capture"])(
    "ends the old automatic request when source changes during %s",
    async (phase) => {
      fastCrypto();
      vi.useFakeTimers();
      captureRuntimeFixture.enabled = true;
      captureRuntimeFixture.synchronized = true;
      conversationState.conversations["conversation-a"].workspaceMode =
        "design";
      const files = { "index.html": "<html><body>Before</body></html>" };
      const evidence = automaticEvidence(`changed-during-${phase}`);
      const { computeDesignReviewSourceDigest } =
        await import("../../lib/design/review-jobs/digest");
      evidence.sourceDigest = await computeDesignReviewSourceDigest({
        files,
        designSystem: null,
        designContract: evidence.contract,
      });
      const unavailable = vi.fn();
      const review = vi.fn();
      const props = {
        ...baseProps,
        conversationId: "conversation-a",
        template: "static",
        files,
        onAutomaticDesignReviewUnavailable: unavailable,
        onAutomaticDesignReview: review,
      };
      const { rerender, unmount } = render(<CodeViewer {...props} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (phase === "digest") {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        vi.spyOn(crypto.subtle, "digest").mockImplementation(
          async (algorithm, bytes) => {
            if (
              new TextDecoder()
                .decode(bytes as ArrayBuffer)
                .startsWith('{"designContract":')
            )
              await gate;
            return digest(algorithm, bytes);
          },
        );
      } else {
        const captureModule = await import("../../lib/design/preview-capture");
        const source = await captureModule.loadDesignCaptureRuntimeSource();
        vi.spyOn(
          captureModule,
          "loadDesignCaptureRuntimeSource",
        ).mockImplementationOnce(async () => {
          await gate;
          return source;
        });
      }
      designReviewState.automatic = {
        stage: "capturing",
        captureRequestId: 6,
        evidence,
      };
      rerender(<CodeViewer {...props} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(designReviewState.beginCapture).toHaveBeenCalledOnce();
      rerender(
        <CodeViewer
          {...props}
          files={{ "index.html": "<html><body>After</body></html>" }}
        />,
      );
      await act(async () => {
        release();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(unavailable).toHaveBeenCalledOnce();
      expect(unavailable.mock.calls[0][2]).toBe("superseded");
      expect(review).not.toHaveBeenCalled();
      unmount();
    },
  );

  it("keys canvas pictures by source and environment, independently of viewport navigation and metadata", async () => {
    vi.stubGlobal("crypto", webcrypto);
    conversationState.conversations["conversation-a"].workspaceMode = "design";
    const { computeCanvasPreviewSources } =
      await import("../../lib/design/canvas-preview-source");
    const { computePreviewGeneration } =
      await import("../../lib/design/preview-runtime");
    const files = canvasFiles("<h1>Cached page</h1>");
    const expected = await computeCanvasPreviewSources({
      files: projectFilesForPreview(files),
      assets: {},
      template: "static",
      previewMode: "sandpack",
      design: projectDesignSchema.parse(JSON.parse(canvasBlueprint)),
    });
    const props = {
      ...baseProps,
      files,
      template: "static",
      conversationId: "conversation-a",
      isGenerating: true,
    };
    const { rerender } = render(<CodeViewer {...props} />);
    const current = () => canvasPreviewFixture.input!;
    await waitFor(() =>
      expect(JSON.parse(current().requests[0].key).at(-1)).toBe(
        expected["home"],
      ),
    );
    const scope = current().scopeKey;
    const desktopKey = current().requests[0].key;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Code view" }));
    await user.click(screen.getByRole("button", { name: "Preview view" }));
    expect(canvasPreviewFixture.retry).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Tablet device" }));
    expect(current().scopeKey).toBe(scope);
    expect(current().requests[0].key).not.toBe(desktopKey);
    await user.click(screen.getByRole("button", { name: "Desktop device" }));
    expect(current().requests[0].key).toBe(desktopKey);
    const withDocs = { ...files, "README.md": "Documentation changed" };
    const generation = await computePreviewGeneration({
      files: withDocs,
      template: "static",
      previewMode: "sandpack",
    });
    rerender(<CodeViewer {...props} files={withDocs} />);
    await waitFor(() =>
      expect(current().requests[0].generation).toBe(generation),
    );
    expect(current().scopeKey).toBe(scope);
    expect(current().requests[0].key).toBe(desktopKey);
    rerender(
      <CodeViewer {...props} files={canvasFiles("<h1>Changed source</h1>")} />,
    );
    await waitFor(() => expect(current().requests[0].key).not.toBe(desktopKey));
    expect(current().scopeKey).toBe(scope);
    rerender(<CodeViewer {...props} sandpackKey={2} />);
    expect(current().scopeKey).not.toBe(scope);
  });

  it.each([
    {
      template: "nextjs",
      previewMode: "sandpack" as const,
      error:
        "Preview capture is not supported for the nextjs preview template.",
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

  it("restores a selected template's script entry before saving Sandpack edits", async () => {
    const source = 'export const title = "Before";\n';
    const onFileChange = vi.fn();
    render(
      <CodeViewer
        {...baseProps}
        conversationId="conversation-a"
        template="vue"
        currentFile="src/main.js"
        files={{
          "package.json": '{"main":"/src/main.js"}',
          "src/main.js": source,
        }}
        onFileChange={onFileChange}
      />,
    );
    await waitFor(() =>
      expect(bridgeProjectionFixture.files["/src/main.js"]?.code).toContain(
        "open-builder-design-bridge:start",
      ),
    );
    const projected = bridgeProjectionFixture.files["/src/main.js"].code;
    act(() => {
      bridgeProjectionFixture.onFileChange?.(
        "conversation-a",
        "src/main.js",
        projected,
      );
      bridgeProjectionFixture.onFileChange?.(
        "conversation-a",
        "__open_builder_design_bridge__.js",
        "runtime",
      );
    });
    expect(onFileChange).not.toHaveBeenCalled();
    act(() =>
      bridgeProjectionFixture.onFileChange?.(
        "conversation-a",
        "src/main.js",
        projected.replace("Before", "After"),
      ),
    );
    expect(onFileChange).toHaveBeenCalledExactlyOnceWith(
      "conversation-a",
      "src/main.js",
      source.replace("Before", "After"),
      { expectedContent: source },
    );
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
