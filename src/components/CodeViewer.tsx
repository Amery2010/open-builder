import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  SandpackProvider,
  SandpackLayout,
  SandpackCodeEditor,
  SandpackPreview,
  SandpackConsole,
} from "@codesandbox/sandpack-react";
import type { SandpackPredefinedTemplate } from "@codesandbox/sandpack-react";
import { Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { useT } from "../i18n";
import { SandpackListener } from "./code-viewer/SandpackListener";
import { ViewToolbar } from "./code-viewer/ViewToolbar";
import { FileExplorer } from "./code-viewer/FileExplorer";
import {
  clampPreviewScale,
  PREVIEW_SCALE_STEP,
  type DeviceSize,
  type ViewMode,
} from "./code-viewer/ViewToolbar";
import type { PreviewView, ProjectFiles, ProjectPreviewMode } from "../types";
import { normalizePreviewView } from "../types";
import {
  hasSensitiveProjectFileContent,
  projectFilesForPreview,
} from "../lib/utils/project-file-policy";
import { useConversationStore } from "../store/conversation";
import { DesignSystemPanel } from "./design/DesignSystemPanel";
import { DesignTokenPanel } from "./design/DesignTokenPanel";
import { DesignReviewDialog } from "./design/DesignReviewDialog";
import { useDesignSelectionStore } from "../store/design-selection";
import {
  createDesignBridgeNonce,
  DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS,
  DESIGN_BRIDGE_MARKER,
  DESIGN_BRIDGE_PAYLOAD_MAX_BYTES,
  DESIGN_BRIDGE_PROTOCOL_VERSION,
  DESIGN_BRIDGE_VIRTUAL_PATH,
  DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH,
  getDesignBridgeTargetOrigin,
  injectDesignBridge,
  isDesignBridgeOriginAllowed,
  parseDesignBridgeCaptureResponse,
  sanitizeDesignSelectionPayload,
  stripDesignBridge,
  type DesignBridgeCaptureExpectation,
  type DesignBridgeCaptureResult,
  type DesignBridgeParentMessage,
} from "../lib/design/preview-bridge";
import {
  collectDesignReviewCaptures,
  DESIGN_REVIEW_VIEWPORTS,
  isDesignReviewViewportReady,
  loadDesignCaptureRuntimeSource,
  type DesignReviewViewport,
} from "../lib/design/preview-capture";
import {
  computePreviewGeneration,
  registerPreviewRuntime,
  withPreviewCaptureLock,
  type PreviewCaptureCollection,
  type PreviewRuntimeAdapter,
} from "../lib/design/preview-runtime";
import type { DesignTokenChange } from "../lib/design/token-mutation";
import { mutateConversationDesignTokens } from "../lib/design/token-mutation-host";
import {
  exportProjectToUniqueDirectory,
  supportsDesktopDesignTools,
} from "../lib/design/desktop";
import type {
  DesignReviewFinding,
  DesignReviewScreenshot,
} from "../lib/design/review";
import { useDesignReviewStore } from "../store/design-review";
import type { AutomaticDesignReviewEvidence } from "../lib/design/automatic-review";
import type { DesignReviewRun } from "../lib/design/review-jobs/types";
import { DEFAULT_TITLE } from "../store/conversation";
import { flushPendingSandpackFileChanges } from "./code-viewer/sandpack-file-changes";
import {
  SandpackActionButton,
  SandpackRefreshAction,
  SandpackRefreshRegistration,
} from "./code-viewer/SandpackPreviewActions";

interface PendingDesignCapture {
  expectation: DesignBridgeCaptureExpectation;
  resolve: (result: DesignBridgeCaptureResult) => void;
  reject: (error: Error) => void;
  timeout: number;
  removeAbortListener: () => void;
}

function afterPreviewPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 100);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

export function getSandpackFileContentToCommit(
  canonicalContent: string | undefined,
  sandpackContent: string,
): string | undefined {
  const content = stripDesignBridge(sandpackContent);
  return canonicalContent !== undefined && canonicalContent === content
    ? undefined
    : content;
}

export function resolvePreviewScale({
  captureActive,
  requestedScale,
}: {
  captureActive: boolean;
  requestedScale: number;
}): number {
  return captureActive ? 1 : requestedScale;
}

export function resolvePreviewIframeHeight(scale: number): string {
  const normalizedScale = clampPreviewScale(scale);
  const percentage = Math.round((100 / normalizedScale) * 100) / 100;
  return `${percentage}%`;
}

interface CodeViewerProps {
  conversationId: string;
  files: ProjectFiles;
  currentFile: string;
  onFileSelect: (path: string) => void;
  onFileChange: (conversationId: string, path: string, content: string) => void;
  onRenameFile: (oldPath: string, newPath: string) => void;
  onDeleteFile: (path: string) => void;
  onMoveFile: (sourcePath: string, targetFolder: string) => void;
  template: string;
  previewMode?: ProjectPreviewMode;
  /** Persisted project preference; toolbar changes are mount-local only. */
  defaultPreviewView?: PreviewView;
  sandpackKey: number;
  onReloadPreview: () => void;
  onApplyDesignSystem?: (id: string) => Promise<void> | void;
  isGenerating?: boolean;
  onDesignReview?: (
    screenshots: readonly DesignReviewScreenshot[],
    options?: { retryOf?: string },
  ) => Promise<void> | void;
  onAutomaticDesignReview?: (
    screenshots: readonly DesignReviewScreenshot[],
    evidence: AutomaticDesignReviewEvidence,
    captureErrors: readonly string[],
  ) => Promise<void> | void;
  onAutomaticDesignReviewUnavailable?: (
    evidence: AutomaticDesignReviewEvidence,
    message: string,
  ) => Promise<void> | void;
  onApplyDesignReviewFixes?: (
    findings: readonly DesignReviewFinding[],
  ) => Promise<void> | void;
}

export function CodeViewer({
  conversationId,
  files,
  currentFile,
  onFileSelect,
  onFileChange,
  onRenameFile,
  onDeleteFile,
  onMoveFile,
  template,
  previewMode = "sandpack",
  defaultPreviewView = "desktop",
  sandpackKey,
  onApplyDesignSystem,
  isGenerating = false,
  onDesignReview,
  onAutomaticDesignReview,
  onAutomaticDesignReviewUnavailable,
  onApplyDesignReviewFixes,
}: CodeViewerProps) {
  const t = useT();
  const previewEnabled = previewMode !== "code-only";
  const [viewMode, setViewMode] = useState<ViewMode>(
    previewEnabled ? "preview" : "code",
  );
  const normalizedDefaultPreviewView = normalizePreviewView(defaultPreviewView);
  const [deviceSize, setDeviceSize] = useState<DeviceSize>(
    normalizedDefaultPreviewView,
  );
  const manualDeviceOverrideRef = useRef(false);
  const [showConsole, setShowConsole] = useState(false);
  const [requestedScale, setRequestedScale] = useState(1);
  const [captureFitScale, setCaptureFitScale] = useState(1);
  const [designSystemsOpen, setDesignSystemsOpen] = useState(false);
  const [designTokensOpen, setDesignTokensOpen] = useState(false);
  const [designSelectionActive, setDesignSelectionActive] = useState(false);
  const [designReviewOpen, setDesignReviewOpen] = useState(false);
  const [captureRuntimeSource, setCaptureRuntimeSource] = useState<
    string | null
  >(null);
  const [captureViewport, setCaptureViewport] =
    useState<DesignReviewViewport | null>(null);
  const [previewGeneration, setPreviewGeneration] = useState<
    string | undefined
  >(undefined);
  const [desktopActionMessage, setDesktopActionMessage] = useState<
    string | null
  >(null);
  const [designBridgeReady, setDesignBridgeReady] = useState(false);
  const designBridgeReadyRef = useRef(false);
  const bridgeGenerationRef = useRef<string | undefined>(undefined);
  const previewGenerationRef = useRef<string | undefined>(undefined);
  const captureRuntimeReadyRef = useRef(false);
  const bridgeNonceRef = useRef<string | null>(null);
  const bridgeRetryTimersRef = useRef<number[]>([]);
  const pendingCaptureRef = useRef<PendingDesignCapture | null>(null);
  const captureAbortRef = useRef<AbortController | null>(null);
  const captureTaskRef = useRef<Promise<void> | null>(null);
  const manualRetryOfRef = useRef<string | null>(null);
  const softRefreshRef = useRef<(() => void) | null>(null);
  const previewHostRef = useRef<HTMLDivElement>(null);
  const isDark = useTheme();
  const effectiveViewMode = previewEnabled ? viewMode : "code";
  const workspaceMode = useConversationStore(
    (state) => state.conversations[conversationId]?.workspaceMode ?? "auto",
  );
  const designState = useConversationStore(
    (state) => state.conversations[conversationId]?.designState,
  );
  const conversationTitle = useConversationStore(
    (state) => state.conversations[conversationId]?.title ?? DEFAULT_TITLE,
  );
  const desktopMode = supportsDesktopDesignTools();
  const setDesignSelection = useDesignSelectionStore(
    (state) => state.setSelection,
  );
  const automaticCaptureRequestId = useDesignReviewStore(
    (state) => state.automatic?.captureRequestId,
  );
  const automaticCaptureConversationId = useDesignReviewStore(
    (state) => state.automatic?.evidence.conversationId,
  );
  const automaticStage = useDesignReviewStore(
    (state) => state.automatic?.stage,
  );
  const dialogRequestId = useDesignReviewStore(
    (state) => state.dialogRequestId,
  );
  const handledAutomaticCaptureRef = useRef<number | undefined>(undefined);
  const handledDialogRequestRef = useRef(0);

  const deviceDimensions = captureViewport
    ? { width: captureViewport.width, height: captureViewport.height }
    : deviceSize === "tablet"
      ? { width: 768, height: 1024 }
      : { width: 375, height: 667 };
  const fixedPreview = captureViewport !== null || deviceSize !== "desktop";
  const previewScale = resolvePreviewScale({
    captureActive: captureViewport !== null,
    requestedScale,
  });

  useEffect(() => {
    if (!previewEnabled) setViewMode("code");
  }, [previewEnabled]);

  useEffect(() => {
    manualDeviceOverrideRef.current = false;
    setDeviceSize(normalizedDefaultPreviewView);
    setRequestedScale(1);
  }, [conversationId, previewMode, sandpackKey]);

  useEffect(() => {
    if (manualDeviceOverrideRef.current) return;
    setDeviceSize(normalizedDefaultPreviewView);
    setRequestedScale(1);
  }, [normalizedDefaultPreviewView]);

  useEffect(() => {
    if (!captureViewport) return;
    const host = previewHostRef.current;
    if (!host) return;
    const update = () => {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setCaptureFitScale(
        Math.min(
          1,
          Math.max(
            0.25,
            Math.min(
              (rect.width - 32) / deviceDimensions.width,
              (rect.height - 32) / deviceDimensions.height,
            ),
          ),
        ),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [
    captureViewport,
    deviceDimensions.height,
    deviceDimensions.width,
    viewMode,
  ]);

  const handleDeviceSizeChange = (next: DeviceSize) => {
    manualDeviceOverrideRef.current = true;
    setDeviceSize(next);
    setRequestedScale(1);
  };

  const previewFiles = useMemo(
    () =>
      projectFilesForPreview(
        files,
        previewMode === "code-only" ? { includeServerFiles: true } : undefined,
      ),
    [files, previewMode],
  );
  useEffect(() => {
    let cancelled = false;
    previewGenerationRef.current = undefined;
    setPreviewGeneration(undefined);
    void computePreviewGeneration({ files, template, previewMode }).then(
      (generation) => {
        if (cancelled) return;
        previewGenerationRef.current = generation;
        setPreviewGeneration(generation);
      },
      () => {
        if (cancelled) return;
        previewGenerationRef.current = undefined;
        setPreviewGeneration(undefined);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [conversationId, files, previewMode, template]);
  const bridgeInjection = useMemo(
    () =>
      workspaceMode === "design"
        ? injectDesignBridge(
            previewFiles,
            template,
            previewEnabled,
            captureRuntimeSource ?? undefined,
            previewGeneration ?? "pending",
          )
        : { supported: false as const, files: previewFiles },
    [
      captureRuntimeSource,
      previewEnabled,
      previewFiles,
      previewGeneration,
      template,
      workspaceMode,
    ],
  );
  const sandpackSourceFiles =
    workspaceMode === "design" &&
    effectiveViewMode === "preview" &&
    bridgeInjection.supported
      ? bridgeInjection.files
      : previewFiles;
  const invalidateAutomaticReview = useCallback(() => {
    const review = useDesignReviewStore.getState();
    if (review.automatic) review.reset();
  }, []);
  const handleSandpackFileChange = useCallback(
    (targetConversationId: string, path: string, content: string) => {
      if (
        path === DESIGN_BRIDGE_VIRTUAL_PATH ||
        path === DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH
      ) {
        return;
      }
      if (
        bridgeInjection.supported &&
        path === bridgeInjection.indexPath &&
        content.includes(DESIGN_BRIDGE_MARKER)
      ) {
        return;
      }
      const canonical = files[path];
      if (
        canonical !== undefined &&
        hasSensitiveProjectFileContent(canonical)
      ) {
        return;
      }
      const nextContent = getSandpackFileContentToCommit(canonical, content);
      if (nextContent === undefined) return;
      invalidateAutomaticReview();
      onFileChange(targetConversationId, path, nextContent);
    },
    [bridgeInjection, files, invalidateAutomaticReview, onFileChange],
  );
  const sandpackFiles = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(sandpackSourceFiles).map(([path, content]) => [
          path.startsWith("/") ? path : `/${path}`,
          { code: content },
        ]),
      ),
    [sandpackSourceFiles],
  );

  const clearBridgeRetryTimers = useCallback(() => {
    for (const timer of bridgeRetryTimersRef.current)
      window.clearTimeout(timer);
    bridgeRetryTimersRef.current = [];
  }, []);

  const getPreviewIframe = useCallback(
    () =>
      previewHostRef.current?.querySelector<HTMLIFrameElement>("iframe") ??
      null,
    [],
  );

  const clearPendingCapture = useCallback((pending: PendingDesignCapture) => {
    window.clearTimeout(pending.timeout);
    pending.removeAbortListener();
    if (pendingCaptureRef.current === pending) pendingCaptureRef.current = null;
  }, []);

  const postBridgeControl = useCallback(
    (active: boolean, nonce: string) => {
      const iframe = getPreviewIframe();
      if (!iframe?.contentWindow) return false;
      const targetOrigin = getDesignBridgeTargetOrigin(
        iframe.src,
        window.location.href,
      );
      if (!targetOrigin) return false;
      iframe.contentWindow.postMessage(
        {
          type: "open-builder:design-bridge-control",
          version: DESIGN_BRIDGE_PROTOCOL_VERSION,
          nonce,
          active,
        },
        targetOrigin,
      );
      return true;
    },
    [getPreviewIframe],
  );

  const deactivateDesignSelection = useCallback(() => {
    clearBridgeRetryTimers();
    const nonce = bridgeNonceRef.current;
    if (nonce) postBridgeControl(false, nonce);
    bridgeNonceRef.current = null;
    setDesignSelectionActive(false);
  }, [clearBridgeRetryTimers, postBridgeControl]);

  const activateDesignSelection = useCallback(() => {
    if (!bridgeInjection.supported) return;
    clearBridgeRetryTimers();
    const nonce = createDesignBridgeNonce();
    bridgeNonceRef.current = nonce;
    setDesignSelectionActive(true);
    postBridgeControl(true, nonce);
    for (const delay of designBridgeReady ? [] : [250, 750]) {
      bridgeRetryTimersRef.current.push(
        window.setTimeout(() => {
          if (bridgeNonceRef.current === nonce) postBridgeControl(true, nonce);
        }, delay),
      );
    }
  }, [
    bridgeInjection.supported,
    clearBridgeRetryTimers,
    designBridgeReady,
    postBridgeControl,
  ]);

  const requestPreviewCapture = useCallback(
    (
      viewport: DesignReviewViewport,
      generation: string,
      signal: AbortSignal,
    ) => {
      const iframe = getPreviewIframe();
      if (!iframe?.contentWindow) {
        return Promise.reject(new Error("Preview iframe is not available."));
      }
      const targetOrigin = getDesignBridgeTargetOrigin(
        iframe.src,
        window.location.href,
      );
      if (!targetOrigin) {
        return Promise.reject(new Error("Preview iframe origin is invalid."));
      }
      if (pendingCaptureRef.current) {
        return Promise.reject(
          new Error("A preview capture request is already running."),
        );
      }
      const expectation: DesignBridgeCaptureExpectation = {
        generation,
        nonce: createDesignBridgeNonce(),
        requestId: createDesignBridgeNonce(),
        viewportName: viewport.name,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      };
      return new Promise<DesignBridgeCaptureResult>((resolve, reject) => {
        const abort = () => {
          const pending = pendingCaptureRef.current;
          if (!pending || pending.expectation !== expectation) return;
          clearPendingCapture(pending);
          reject(
            new DOMException("Preview capture was cancelled.", "AbortError"),
          );
        };
        const timeout = window.setTimeout(() => {
          const pending = pendingCaptureRef.current;
          if (!pending || pending.expectation !== expectation) return;
          clearPendingCapture(pending);
          reject(new Error("Preview capture timed out."));
        }, DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS);
        const pending: PendingDesignCapture = {
          expectation,
          resolve,
          reject,
          timeout,
          removeAbortListener: () => signal.removeEventListener("abort", abort),
        };
        pendingCaptureRef.current = pending;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        try {
          iframe.contentWindow?.postMessage(
            {
              type: "open-builder:design-bridge-capture",
              version: DESIGN_BRIDGE_PROTOCOL_VERSION,
              generation,
              nonce: expectation.nonce,
              requestId: expectation.requestId,
              viewport: {
                name: viewport.name,
                width: viewport.width,
                height: viewport.height,
              },
            },
            targetOrigin,
          );
        } catch (error) {
          clearPendingCapture(pending);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    [clearPendingCapture, getPreviewIframe],
  );

  useEffect(() => {
    const handleBridgeMessage = (event: MessageEvent) => {
      const iframe = getPreviewIframe();
      if (!iframe?.contentWindow || event.source !== iframe.contentWindow)
        return;
      if (
        !isDesignBridgeOriginAllowed(
          iframe.src,
          window.location.href,
          event.origin,
        )
      ) {
        return;
      }
      const message = event.data as DesignBridgeParentMessage | undefined;
      const pending = pendingCaptureRef.current;
      if (
        pending &&
        (message?.type === "open-builder:design-bridge-capture-result" ||
          message?.type === "open-builder:design-bridge-capture-error")
      ) {
        const response = parseDesignBridgeCaptureResponse(
          message,
          pending.expectation,
        );
        if (!response) return;
        clearPendingCapture(pending);
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new Error(response.error));
        return;
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(event.data);
      } catch {
        return;
      }
      if (
        new TextEncoder().encode(serialized).byteLength >
        DESIGN_BRIDGE_PAYLOAD_MAX_BYTES
      ) {
        return;
      }
      if (!message || message.version !== DESIGN_BRIDGE_PROTOCOL_VERSION)
        return;
      if (message.type === "open-builder:design-bridge-ready") {
        bridgeGenerationRef.current = message.generation;
        designBridgeReadyRef.current =
          message.generation === previewGenerationRef.current;
        captureRuntimeReadyRef.current =
          designBridgeReadyRef.current &&
          message.captureRuntimeAvailable === true;
        setDesignBridgeReady(designBridgeReadyRef.current);
        const nonce = bridgeNonceRef.current;
        if (nonce && designSelectionActive) postBridgeControl(true, nonce);
        return;
      }
      const nonce = bridgeNonceRef.current;
      if (!nonce || message.nonce !== nonce) return;
      if (message.type === "open-builder:design-bridge-exit") {
        deactivateDesignSelection();
        return;
      }
      if (message.type === "open-builder:design-bridge-selection") {
        const selection = sanitizeDesignSelectionPayload(message.payload);
        if (!selection) return;
        setDesignSelection(conversationId, selection);
        deactivateDesignSelection();
      }
    };
    window.addEventListener("message", handleBridgeMessage);
    return () => window.removeEventListener("message", handleBridgeMessage);
  }, [
    conversationId,
    clearPendingCapture,
    deactivateDesignSelection,
    designSelectionActive,
    getPreviewIframe,
    postBridgeControl,
    setDesignSelection,
  ]);

  useEffect(() => {
    designBridgeReadyRef.current = false;
    bridgeGenerationRef.current = undefined;
    captureRuntimeReadyRef.current = false;
    setDesignBridgeReady(false);
    deactivateDesignSelection();
    if (workspaceMode !== "design") {
      captureAbortRef.current?.abort();
      useDesignReviewStore.getState().reset();
    }
  }, [conversationId, deactivateDesignSelection, sandpackKey, workspaceMode]);

  useEffect(
    () => () => {
      captureAbortRef.current?.abort();
    },
    [conversationId],
  );

  useEffect(
    () => () => {
      clearBridgeRetryTimers();
      captureAbortRef.current?.abort();
      const pending = pendingCaptureRef.current;
      if (pending) {
        clearPendingCapture(pending);
        pending.reject(
          new DOMException("Preview capture was cancelled.", "AbortError"),
        );
      }
    },
    [clearBridgeRetryTimers, clearPendingCapture],
  );

  const bridgeUnavailableReason =
    bridgeInjection.reason === "code-only"
      ? t.toolbar.selectionCodeOnly
      : bridgeInjection.reason === "unsupported-template"
        ? t.toolbar.selectionUnsupportedTemplate.replace("{template}", template)
        : bridgeInjection.reason === "missing-index"
          ? t.toolbar.selectionMissingIndex
          : bridgeInjection.reason === "reserved-path"
            ? t.toolbar.selectionReservedPath
            : undefined;

  const handleDesignTokenCommit = useCallback(
    async (changes: readonly DesignTokenChange[]) => {
      const result = await mutateConversationDesignTokens({
        conversationId,
        changes,
        principal: "user",
        snapshotLabel: t.designTokens.snapshotLabel,
      });
      if (!result.ok) throw new Error(result.error);
    },
    [conversationId, t.designTokens.snapshotLabel],
  );

  const handleDesignTokenUpgrade = useCallback(() => {
    setDesignTokensOpen(false);
    setDesignSystemsOpen(true);
  }, []);

  const handleExportDirectory = useCallback(async () => {
    if (isGenerating) return;
    setDesktopActionMessage(null);
    try {
      const result = await exportProjectToUniqueDirectory(
        files,
        conversationTitle === DEFAULT_TITLE
          ? "open-builder-project"
          : conversationTitle,
      );
      if (result) {
        setDesktopActionMessage(
          t.toolbar.exportedDirectory.replace("{path}", result.path),
        );
      }
    } catch (error) {
      setDesktopActionMessage(
        t.toolbar.exportDirectoryFailed.replace(
          "{message}",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }, [conversationTitle, files, isGenerating, t.toolbar]);

  const waitForPreviewViewport = useCallback(
    async (
      viewport: DesignReviewViewport,
      generation: string,
      signal: AbortSignal,
    ) => {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        signal.throwIfAborted();
        const iframe = getPreviewIframe();
        if (
          iframe?.contentWindow &&
          isDesignReviewViewportReady(
            {
              bridgeReady: designBridgeReadyRef.current,
              captureRuntimeReady: captureRuntimeReadyRef.current,
              width: iframe.clientWidth,
              height: iframe.clientHeight,
            },
            viewport,
          ) &&
          bridgeGenerationRef.current === generation &&
          previewGenerationRef.current === generation
        ) {
          await afterPreviewPaint();
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      }
      throw new Error(
        `Preview did not become ready at ${viewport.width}px width.`,
      );
    },
    [getPreviewIframe],
  );

  const preparePreviewRuntime = useCallback(
    async (generation: string, signal: AbortSignal) => {
      const deadline = performance.now() + 5_000;
      while (
        previewGenerationRef.current !== generation &&
        performance.now() < deadline
      ) {
        signal.throwIfAborted();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
      }
      if (previewGenerationRef.current !== generation) {
        throw new Error(
          "The mounted preview did not reach the current project generation.",
        );
      }
      designBridgeReadyRef.current = false;
      captureRuntimeReadyRef.current = false;
      bridgeGenerationRef.current = undefined;
      setDesignBridgeReady(false);
      flushPendingSandpackFileChanges(conversationId);
      softRefreshRef.current?.();
      await afterPreviewPaint();
    },
    [conversationId],
  );

  const capturePreviewCollection = useCallback(
    async (
      viewports: readonly DeviceSize[],
      generation: string,
      signal: AbortSignal,
      onProgress?: (
        completed: number,
        total: number,
        viewport: DesignReviewViewport,
      ) => void,
    ): Promise<PreviewCaptureCollection> => {
      if (!bridgeInjection.supported) {
        throw new Error(
          bridgeUnavailableReason ??
            "Preview capture is unavailable for this project.",
        );
      }
      const requestedViewports = viewports.map((name) => {
        const viewport = DESIGN_REVIEW_VIEWPORTS.find(
          (candidate) => candidate.name === name,
        );
        if (!viewport) throw new Error(`Unsupported viewport: ${name}`);
        return viewport;
      });
      const previousConsole = showConsole;
      const previousSelection = designSelectionActive;
      const previousViewMode = viewMode;
      let restored = false;
      const restorePreview = async () => {
        if (restored) return;
        restored = true;
        setCaptureViewport(null);
        setShowConsole(previousConsole);
        setViewMode(previousViewMode);
        await afterPreviewPaint();
        if (previousSelection) activateDesignSelection();
      };

      try {
        const runtimeSource = await loadDesignCaptureRuntimeSource();
        signal.throwIfAborted();
        if (captureRuntimeSource !== runtimeSource) {
          captureRuntimeReadyRef.current = false;
          setCaptureRuntimeSource(runtimeSource);
        }
        setViewMode("preview");
        setShowConsole(false);
        if (previousSelection) deactivateDesignSelection();
        const collection = await collectDesignReviewCaptures({
          viewports: requestedViewports,
          signal,
          prepareViewport: async (viewport) => {
            setCaptureViewport(viewport);
            await waitForPreviewViewport(viewport, generation, signal);
          },
          captureViewport: (viewport) =>
            requestPreviewCapture(viewport, generation, signal),
          onProgress,
          restore: restorePreview,
        });
        return { generation, ...collection };
      } finally {
        await restorePreview();
      }
    },
    [
      activateDesignSelection,
      bridgeInjection.supported,
      bridgeUnavailableReason,
      captureRuntimeSource,
      deactivateDesignSelection,
      designSelectionActive,
      requestPreviewCapture,
      showConsole,
      viewMode,
      waitForPreviewViewport,
    ],
  );

  const previewRuntimeRef = useRef<{
    conversationId: string;
    adapter: PreviewRuntimeAdapter;
  } | null>(null);
  previewRuntimeRef.current = {
    conversationId,
    adapter: {
      getGeneration: () => previewGenerationRef.current,
      prepare: preparePreviewRuntime,
      capture: (viewports, generation, signal) =>
        capturePreviewCollection(viewports, generation, signal),
    },
  };
  useEffect(() => {
    const currentAdapter = (): PreviewRuntimeAdapter => {
      const current = previewRuntimeRef.current;
      if (!current || current.conversationId !== conversationId) {
        throw new DOMException("Preview conversation changed.", "AbortError");
      }
      return current.adapter;
    };
    return registerPreviewRuntime(conversationId, {
      getGeneration: () => {
        const current = previewRuntimeRef.current;
        return current?.conversationId === conversationId
          ? current.adapter.getGeneration()
          : undefined;
      },
      prepare: (generation, signal) =>
        currentAdapter().prepare(generation, signal),
      capture: (viewports, generation, signal) =>
        currentAdapter().capture(viewports, generation, signal),
    });
  }, [conversationId]);

  const submitManualDesignReview = useCallback(
    (screenshots: readonly DesignReviewScreenshot[]) => {
      const retryOf = manualRetryOfRef.current ?? undefined;
      manualRetryOfRef.current = null;
      return onDesignReview?.(screenshots, retryOf ? { retryOf } : undefined);
    },
    [onDesignReview],
  );

  const captureDesignReviewScreenshots = useCallback(
    (options: { automatic?: boolean } = {}) => {
      if (captureTaskRef.current) return captureTaskRef.current;
      const controller = new AbortController();
      captureAbortRef.current = controller;
      const task = (async () => {
        const reviewStore = useDesignReviewStore.getState();
        const automaticEvidence = options.automatic
          ? reviewStore.automatic?.evidence
          : undefined;
        if (!options.automatic) reviewStore.clearAutomatic();
        reviewStore.beginCapture(DESIGN_REVIEW_VIEWPORTS.length);
        if (!bridgeInjection.supported) {
          const message =
            (bridgeUnavailableReason ??
              "Automatic preview capture is unavailable for this project.") +
            (automaticEvidence
              ? " Static Design-system checks completed; visual evidence is unavailable."
              : "");
          if (automaticEvidence && onAutomaticDesignReviewUnavailable) {
            void Promise.resolve(
              onAutomaticDesignReviewUnavailable(automaticEvidence, message),
            ).catch((error) =>
              useDesignReviewStore
                .getState()
                .failAutomatic(
                  error instanceof Error ? error.message : String(error),
                ),
            );
          } else if (automaticEvidence) {
            reviewStore.failAutomatic(message);
          } else {
            reviewStore.fail(message);
          }
          return;
        }
        try {
          const generation = previewGenerationRef.current;
          if (!generation) {
            throw new Error("The current preview generation is not ready.");
          }
          const collection = await withPreviewCaptureLock({
            conversationId,
            owner: options.automatic ? "automatic-review" : "manual-review",
            signal: controller.signal,
            run: async (adapter, signal) => {
              await adapter.prepare(generation, signal);
              return capturePreviewCollection(
                DESIGN_REVIEW_VIEWPORTS.map((viewport) => viewport.name),
                generation,
                signal,
                (completed, total, viewport) => {
                  useDesignReviewStore.getState().updateCaptureProgress({
                    completed,
                    total,
                    viewport: viewport.name,
                  });
                },
              );
            },
          });
          controller.signal.throwIfAborted();
          const screenshots: DesignReviewScreenshot[] = collection.captures.map(
            (capture) => ({
              dataUrl: capture.dataUrl,
              mimeType: capture.mimeType,
              name: `preview-${capture.viewport.name}-${capture.viewport.width}x${capture.viewport.height}.webp`,
              source: "automatic",
              viewport: capture.viewport,
              semanticSnapshot: capture.semanticSnapshot,
            }),
          );
          if (
            automaticEvidence &&
            useDesignReviewStore.getState().automatic?.evidence.requestId !==
              automaticEvidence.requestId
          ) {
            return;
          }
          if (screenshots.length === 0) {
            const message =
              collection.errors.join(" ") ||
              "Automatic preview capture did not return an image.";
            if (automaticEvidence) {
              if (onAutomaticDesignReviewUnavailable) {
                void Promise.resolve(
                  onAutomaticDesignReviewUnavailable(
                    automaticEvidence,
                    message,
                  ),
                ).catch((error) =>
                  useDesignReviewStore
                    .getState()
                    .failAutomatic(
                      error instanceof Error ? error.message : String(error),
                    ),
                );
              } else {
                useDesignReviewStore.getState().failAutomatic(message);
              }
            } else {
              useDesignReviewStore.getState().fail(message);
            }
            return;
          }
          useDesignReviewStore
            .getState()
            .setScreenshots(screenshots, collection.errors);
          if (automaticEvidence && onAutomaticDesignReview) {
            void Promise.resolve(
              onAutomaticDesignReview(
                screenshots,
                automaticEvidence,
                collection.errors,
              ),
            ).catch((error) => {
              useDesignReviewStore
                .getState()
                .failAutomatic(
                  error instanceof Error ? error.message : String(error),
                );
            });
          } else {
            await submitManualDesignReview(screenshots);
          }
        } catch (error) {
          if ((error as { name?: string })?.name !== "AbortError") {
            const message =
              error instanceof Error ? error.message : String(error);
            if (automaticEvidence) {
              if (onAutomaticDesignReviewUnavailable) {
                void Promise.resolve(
                  onAutomaticDesignReviewUnavailable(
                    automaticEvidence,
                    message,
                  ),
                ).catch((reason) =>
                  useDesignReviewStore
                    .getState()
                    .failAutomatic(
                      reason instanceof Error ? reason.message : String(reason),
                    ),
                );
              } else {
                useDesignReviewStore.getState().failAutomatic(message);
              }
            } else {
              useDesignReviewStore.getState().fail(message);
            }
          }
        }
      })();
      captureTaskRef.current = task;
      void task.then(
        () => {
          if (captureTaskRef.current === task) captureTaskRef.current = null;
          if (captureAbortRef.current === controller)
            captureAbortRef.current = null;
        },
        () => {
          if (captureTaskRef.current === task) captureTaskRef.current = null;
          if (captureAbortRef.current === controller)
            captureAbortRef.current = null;
        },
      );
      return task;
    },
    [
      bridgeInjection.supported,
      bridgeUnavailableReason,
      capturePreviewCollection,
      conversationId,
      onAutomaticDesignReview,
      onAutomaticDesignReviewUnavailable,
      submitManualDesignReview,
    ],
  );

  useEffect(() => {
    if (
      !automaticCaptureRequestId ||
      automaticCaptureConversationId !== conversationId ||
      handledAutomaticCaptureRef.current === automaticCaptureRequestId ||
      isGenerating ||
      workspaceMode !== "design"
    ) {
      return;
    }
    handledAutomaticCaptureRef.current = automaticCaptureRequestId;
    void captureDesignReviewScreenshots({ automatic: true });
  }, [
    automaticCaptureRequestId,
    automaticCaptureConversationId,
    captureDesignReviewScreenshots,
    conversationId,
    isGenerating,
    workspaceMode,
  ]);

  useEffect(() => {
    if (
      !captureTaskRef.current ||
      !automaticCaptureRequestId ||
      automaticCaptureConversationId === conversationId
    ) {
      return;
    }
    captureAbortRef.current?.abort();
    if (handledAutomaticCaptureRef.current === automaticCaptureRequestId) {
      handledAutomaticCaptureRef.current = undefined;
    }
  }, [
    automaticCaptureConversationId,
    automaticCaptureRequestId,
    conversationId,
  ]);

  useEffect(() => {
    if (
      !dialogRequestId ||
      handledDialogRequestRef.current === dialogRequestId
    ) {
      return;
    }
    handledDialogRequestRef.current = dialogRequestId;
    setDesignReviewOpen(true);
  }, [dialogRequestId]);

  const openDesignReview = useCallback(() => {
    const review = useDesignReviewStore.getState();
    if (!review.automatic) {
      review.reset();
    }
    setDesignReviewOpen(true);
  }, []);

  const handleDesignReviewOpenChange = useCallback((open: boolean) => {
    if (!open) {
      const review = useDesignReviewStore.getState();
      if (review.status === "capturing" && !review.automatic) {
        captureAbortRef.current?.abort();
        manualRetryOfRef.current = null;
        review.reset();
      }
    }
    setDesignReviewOpen(open);
  }, []);

  const cancelDesignReviewRun = useCallback((run: DesignReviewRun) => {
    void import("../lib/design/review-jobs/runner").then(
      ({ designReviewJobRunner }) => designReviewJobRunner.cancel(run.id),
    );
  }, []);

  const retryDesignReviewRun = useCallback(
    async (run: DesignReviewRun) => {
      manualRetryOfRef.current = run.id;
      useDesignReviewStore.getState().selectRun(conversationId, undefined);
      await captureDesignReviewScreenshots();
    },
    [captureDesignReviewScreenshots, conversationId],
  );

  const handleReloadPreview = useCallback(() => {
    flushPendingSandpackFileChanges(conversationId);
    softRefreshRef.current?.();
  }, [conversationId]);

  const registerSoftRefresh = useCallback((refresh: (() => void) | null) => {
    softRefreshRef.current = refresh;
  }, []);

  const applySelectedReviewFixes = useCallback(
    async (findings: readonly DesignReviewFinding[]) => {
      setDesignReviewOpen(false);
      await onApplyDesignReviewFixes?.(findings);
      useDesignReviewStore.getState().reset();
    },
    [onApplyDesignReviewFixes],
  );

  const requestedCurrentFile = currentFile.replace(/^\/+/, "");
  const effectiveCurrentFile =
    requestedCurrentFile in previewFiles
      ? requestedCurrentFile
      : (Object.keys(previewFiles)[0] ?? requestedCurrentFile);
  const sandpackCurrentFile = `/${effectiveCurrentFile}`;
  const previewFrameScale = captureViewport ? captureFitScale : 1;
  const previewHostOverflowClass = fixedPreview
    ? "overflow-auto p-4"
    : "overflow-hidden";
  const previewFrameStyle = fixedPreview
    ? {
        width: deviceDimensions.width * previewFrameScale,
        height: deviceDimensions.height * previewFrameScale,
      }
    : { width: "100%", height: "100%" };
  const previewSurfaceStyle = fixedPreview
    ? {
        width: deviceDimensions.width,
        height: deviceDimensions.height,
        ...(captureViewport
          ? {
              transform: `scale(${previewFrameScale})`,
              transformOrigin: "top left",
            }
          : {}),
      }
    : undefined;
  const previewContentStyle = {
    "--ob-preview-scale": String(previewScale),
    "--ob-preview-iframe-height": resolvePreviewIframeHeight(previewScale),
    "--ob-preview-transform-origin":
      previewScale < 1 ? "top center" : "top left",
  } as CSSProperties;

  const handleCreateFile = (path: string) => {
    const p = path.startsWith("/") ? path.slice(1) : path;
    if (!(p in files)) {
      invalidateAutomaticReview();
      onFileChange(conversationId, p, "// New file\n");
      onFileSelect(p);
    }
  };

  const handleCreateFolder = (path: string) => {
    const p = path.startsWith("/") ? path.slice(1) : path;
    // Use trailing "/" to represent empty folder, no .gitkeep needed
    if (!(`${p}/` in files)) {
      invalidateAutomaticReview();
      onFileChange(conversationId, `${p}/`, "");
    }
  };

  return (
    <div className="editor w-full h-full flex flex-col bg-background">
      <ViewToolbar
        viewMode={effectiveViewMode}
        onViewModeChange={setViewMode}
        deviceSize={deviceSize}
        onDeviceSizeChange={handleDeviceSizeChange}
        files={files}
        previewEnabled={previewEnabled}
        previewScale={requestedScale}
        onPreviewZoomIn={() =>
          setRequestedScale((current) =>
            clampPreviewScale(current + PREVIEW_SCALE_STEP),
          )
        }
        onPreviewZoomOut={() =>
          setRequestedScale((current) =>
            clampPreviewScale(current - PREVIEW_SCALE_STEP),
          )
        }
        onReloadPreview={handleReloadPreview}
        designMode={workspaceMode === "design"}
        onOpenDesignTokens={() => setDesignTokensOpen(true)}
        desktopMode={desktopMode}
        onExportDirectory={() => void handleExportDirectory()}
        onOpenDesignReview={onDesignReview ? openDesignReview : undefined}
        isGenerating={isGenerating}
        designSelectionSupported={bridgeInjection.supported}
        designSelectionActive={designSelectionActive}
        onToggleDesignSelection={() =>
          designSelectionActive
            ? deactivateDesignSelection()
            : activateDesignSelection()
        }
        designSelectionUnavailableReason={bridgeUnavailableReason}
      />

      {workspaceMode === "design" && onApplyDesignSystem && (
        <DesignSystemPanel
          open={designSystemsOpen}
          onOpenChange={setDesignSystemsOpen}
          onApply={onApplyDesignSystem}
          isGenerating={isGenerating}
        />
      )}
      {workspaceMode === "design" && (
        <DesignTokenPanel
          open={designTokensOpen}
          onOpenChange={setDesignTokensOpen}
          files={files}
          designState={designState}
          onCommit={handleDesignTokenCommit}
          onUpgrade={handleDesignTokenUpgrade}
          isGenerating={isGenerating}
        />
      )}
      {workspaceMode === "design" && onDesignReview && (
        <DesignReviewDialog
          open={designReviewOpen}
          onOpenChange={handleDesignReviewOpenChange}
          onRunReview={submitManualDesignReview}
          onApplyFixes={applySelectedReviewFixes}
          onCaptureScreenshots={() => captureDesignReviewScreenshots()}
          conversationId={conversationId}
          onCancelRun={cancelDesignReviewRun}
          onRetryRun={retryDesignReviewRun}
          isGenerating={isGenerating}
        />
      )}

      <div className="flex-1 overflow-hidden relative bg-muted/50">
        {workspaceMode === "design" && automaticStage && !designReviewOpen && (
          <div
            role="status"
            className="absolute right-3 top-3 z-40 max-w-md rounded-lg border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
          >
            {t.designReview.automaticStages[automaticStage]}
          </div>
        )}
        {desktopActionMessage && (
          <div
            role="status"
            className="absolute right-3 top-3 z-40 max-w-md rounded-lg border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
          >
            {desktopActionMessage}
          </div>
        )}
        <SandpackProvider
          key={sandpackKey}
          template={
            (previewEnabled ? template : "static") as SandpackPredefinedTemplate
          }
          theme={isDark ? "dark" : "light"}
          files={sandpackFiles}
          options={{ activeFile: sandpackCurrentFile }}
          style={{ height: "100%" }}
        >
          <SandpackRefreshRegistration onChange={registerSoftRefresh} />
          <SandpackListener
            conversationId={conversationId}
            requestedActiveFile={sandpackCurrentFile}
            onFileChange={handleSandpackFileChange}
          />
          <SandpackLayout>
            {/* Preview */}
            {previewEnabled && (
              <div
                ref={previewHostRef}
                className={cn(
                  "h-full w-full",
                  effectiveViewMode === "preview" ? "block" : "hidden",
                  previewHostOverflowClass,
                )}
              >
                <div
                  className={cn("mx-auto", fixedPreview && "relative")}
                  style={previewFrameStyle}
                >
                  <div
                    className={cn(
                      "grid grid-rows-3 h-full",
                      fixedPreview &&
                        "overflow-hidden rounded-lg border bg-background shadow-lg",
                      captureViewport &&
                        "absolute left-0 top-0 rounded-none border-0 shadow-none transition-none",
                    )}
                    style={previewSurfaceStyle}
                  >
                    <div
                      className={cn(
                        "relative transition-[width,height,transform,opacity] duration-300 ease-in-out",
                        showConsole ? "row-span-2" : "row-span-3",
                      )}
                    >
                      <SandpackPreview
                        className={cn(
                          "preview-content-zoom",
                          previewScale !== 1 && "preview-content-scaled",
                        )}
                        style={previewContentStyle}
                        showNavigator={!captureViewport}
                        showOpenInCodeSandbox={false}
                        showRefreshButton={false}
                        showRestartButton={false}
                      />
                      <div className="preview-viewport-actions absolute bottom-2 right-2 z-20 flex gap-2">
                        <SandpackActionButton
                          label={showConsole ? t.console.hide : t.console.show}
                          pressed={showConsole}
                          onClick={() => setShowConsole((visible) => !visible)}
                        >
                          <Terminal size={16} />
                        </SandpackActionButton>
                        <SandpackRefreshAction
                          label={t.toolbar.reloadPreview}
                          onBeforeRefresh={() =>
                            flushPendingSandpackFileChanges(conversationId)
                          }
                        />
                      </div>
                    </div>
                    <div
                      className={cn(
                        "overflow-hidden border-t",
                        showConsole ? "row-span-1" : "max-h-0 border-t-0",
                      )}
                    >
                      <SandpackConsole
                        showSyntaxError={true}
                        showRestartButton={false}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Code editor */}
            <div
              className={cn(
                "h-full w-full overflow-hidden",
                effectiveViewMode === "code" ? "flex" : "hidden",
              )}
            >
              <div className="w-56 border-r h-full shrink-0 overflow-hidden flex flex-col">
                <FileExplorer
                  files={previewFiles}
                  currentFile={currentFile}
                  onFileSelect={onFileSelect}
                  onCreateFile={handleCreateFile}
                  onCreateFolder={handleCreateFolder}
                  onRenameFile={(oldPath, newPath) => {
                    invalidateAutomaticReview();
                    onRenameFile(oldPath, newPath);
                  }}
                  onDeleteFile={(path) => {
                    invalidateAutomaticReview();
                    onDeleteFile(path);
                  }}
                  onMoveFile={(sourcePath, targetFolder) => {
                    invalidateAutomaticReview();
                    onMoveFile(sourcePath, targetFolder);
                  }}
                />
              </div>
              <div className="flex flex-col flex-1 h-full overflow-x-auto min-w-0">
                <SandpackCodeEditor
                  showTabs={false}
                  showLineNumbers
                  showInlineErrors
                  wrapContent={false}
                  closableTabs={false}
                />
              </div>
            </div>
          </SandpackLayout>
        </SandpackProvider>
      </div>
    </div>
  );
}
