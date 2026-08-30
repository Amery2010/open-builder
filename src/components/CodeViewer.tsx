import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { ViewMode, DeviceSize } from "./code-viewer/ViewToolbar";
import type { ProjectFiles, ProjectPreviewMode } from "../types";
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
import { createDesignTokenSnapshot } from "../lib/design/token-snapshot";
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
  sandpackKey: number;
  onReloadPreview: () => void;
  onApplyDesignSystem?: (id: string) => Promise<void> | void;
  isGenerating?: boolean;
  onDesignReview?: (
    screenshots: readonly DesignReviewScreenshot[],
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
  const [deviceSize, setDeviceSize] = useState<DeviceSize>("desktop");
  const [showConsole, setShowConsole] = useState(false);
  const [requestedScale, setRequestedScale] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [designSystemsOpen, setDesignSystemsOpen] = useState(false);
  const [designTokensOpen, setDesignTokensOpen] = useState(false);
  const [designTokenDraft, setDesignTokenDraft] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [designSelectionActive, setDesignSelectionActive] = useState(false);
  const [designReviewOpen, setDesignReviewOpen] = useState(false);
  const [captureRuntimeSource, setCaptureRuntimeSource] = useState<
    string | null
  >(null);
  const [captureViewport, setCaptureViewport] =
    useState<DesignReviewViewport | null>(null);
  const [desktopActionMessage, setDesktopActionMessage] = useState<
    string | null
  >(null);
  const [designBridgeReady, setDesignBridgeReady] = useState(false);
  const designBridgeReadyRef = useRef(false);
  const captureRuntimeReadyRef = useRef(false);
  const bridgeNonceRef = useRef<string | null>(null);
  const bridgeRetryTimersRef = useRef<number[]>([]);
  const pendingCaptureRef = useRef<PendingDesignCapture | null>(null);
  const captureAbortRef = useRef<AbortController | null>(null);
  const captureTaskRef = useRef<Promise<void> | null>(null);
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
  const previewScale = fixedPreview
    ? captureViewport
      ? fitScale
      : (requestedScale ?? fitScale)
    : 1;

  useEffect(() => {
    if (!previewEnabled) setViewMode("code");
  }, [previewEnabled]);

  useEffect(() => {
    if (!fixedPreview) return;
    const host = previewHostRef.current;
    if (!host) return;
    const update = () => {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setFitScale(
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
  }, [deviceDimensions.height, deviceDimensions.width, fixedPreview, viewMode]);

  const handleDeviceSizeChange = (next: DeviceSize) => {
    setDeviceSize(next);
    setRequestedScale(null);
  };

  const previewFiles = useMemo(
    () =>
      projectFilesForPreview(
        files,
        previewMode === "code-only" ? { includeServerFiles: true } : undefined,
      ),
    [files, previewMode],
  );
  const runtimePreviewFiles = useMemo(
    () =>
      designTokenDraft
        ? { ...previewFiles, [designTokenDraft.path]: designTokenDraft.content }
        : previewFiles,
    [designTokenDraft, previewFiles],
  );
  const bridgeInjection = useMemo(
    () =>
      workspaceMode === "design"
        ? injectDesignBridge(
            runtimePreviewFiles,
            template,
            previewEnabled,
            captureRuntimeSource ?? undefined,
          )
        : { supported: false as const, files: runtimePreviewFiles },
    [
      captureRuntimeSource,
      previewEnabled,
      runtimePreviewFiles,
      template,
      workspaceMode,
    ],
  );
  const sandpackSourceFiles =
    workspaceMode === "design" &&
    effectiveViewMode === "preview" &&
    bridgeInjection.supported
      ? bridgeInjection.files
      : effectiveViewMode === "preview"
        ? runtimePreviewFiles
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
      invalidateAutomaticReview();
      onFileChange(targetConversationId, path, stripDesignBridge(content));
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
    (viewport: DesignReviewViewport, signal: AbortSignal) => {
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
        designBridgeReadyRef.current = true;
        captureRuntimeReadyRef.current =
          message.captureRuntimeAvailable === true;
        setDesignBridgeReady(true);
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

  const handleDesignTokenDraftChange = useCallback(
    (path: string | undefined, content: string | undefined) => {
      setDesignTokenDraft(
        path && content !== undefined ? { path, content } : null,
      );
    },
    [],
  );

  const handleDesignTokenCommit = useCallback(
    (path: string, content: string) => {
      if (files[path] === content) return;
      const nextFiles = { ...files, [path]: content };
      invalidateAutomaticReview();
      onFileChange(conversationId, path, content);
      createDesignTokenSnapshot(
        conversationId,
        nextFiles,
        t.designTokens.snapshotLabel,
      );
      setDesignTokenDraft(null);
    },
    [
      conversationId,
      files,
      invalidateAutomaticReview,
      onFileChange,
      t.designTokens.snapshotLabel,
    ],
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
    async (viewport: DesignReviewViewport, signal: AbortSignal) => {
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
          )
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
          controller.signal.throwIfAborted();
          if (captureRuntimeSource !== runtimeSource) {
            captureRuntimeReadyRef.current = false;
            setCaptureRuntimeSource(runtimeSource);
          }
          setViewMode("preview");
          setShowConsole(false);
          if (previousSelection) deactivateDesignSelection();
          const collection = await collectDesignReviewCaptures({
            signal: controller.signal,
            prepareViewport: async (viewport) => {
              setCaptureViewport(viewport);
              await waitForPreviewViewport(viewport, controller.signal);
            },
            captureViewport: (viewport) =>
              requestPreviewCapture(viewport, controller.signal),
            onProgress: (completed, total, viewport) => {
              useDesignReviewStore.getState().updateCaptureProgress({
                completed,
                total,
                viewport: viewport.name,
              });
            },
            restore: restorePreview,
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
            await onDesignReview?.(screenshots);
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
        } finally {
          await restorePreview();
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
      activateDesignSelection,
      bridgeInjection.supported,
      bridgeUnavailableReason,
      captureRuntimeSource,
      deactivateDesignSelection,
      designSelectionActive,
      onDesignReview,
      onAutomaticDesignReview,
      onAutomaticDesignReviewUnavailable,
      requestPreviewCapture,
      showConsole,
      viewMode,
      waitForPreviewViewport,
    ],
  );

  useEffect(() => {
    if (
      !automaticCaptureRequestId ||
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
    captureDesignReviewScreenshots,
    isGenerating,
    workspaceMode,
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
    if (
      review.automatic &&
      review.status !== "complete" &&
      review.status !== "error"
    ) {
      return;
    }
    if (!review.automatic) {
      review.reset();
    }
    setDesignReviewOpen(true);
  }, []);

  const handleDesignReviewOpenChange = useCallback((open: boolean) => {
    if (!open) {
      captureAbortRef.current?.abort();
      if (useDesignReviewStore.getState().status === "capturing") {
        useDesignReviewStore.getState().reset();
      }
    }
    setDesignReviewOpen(open);
  }, []);

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
        previewScale={previewScale}
        onPreviewZoomIn={() =>
          setRequestedScale(Math.min(1.5, previewScale + 0.1))
        }
        onPreviewZoomOut={() =>
          setRequestedScale(Math.max(0.25, previewScale - 0.1))
        }
        onPreviewFit={() => setRequestedScale(null)}
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
          onDraftChange={handleDesignTokenDraftChange}
          onCommit={handleDesignTokenCommit}
          onUpgrade={handleDesignTokenUpgrade}
          isGenerating={isGenerating}
        />
      )}
      {workspaceMode === "design" && onDesignReview && (
        <DesignReviewDialog
          open={designReviewOpen}
          onOpenChange={handleDesignReviewOpenChange}
          onRunReview={onDesignReview}
          onApplyFixes={applySelectedReviewFixes}
          onCaptureScreenshots={() => captureDesignReviewScreenshots()}
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
                  fixedPreview ? "overflow-auto p-4" : "overflow-hidden",
                )}
              >
                <div
                  className={cn("mx-auto", fixedPreview && "relative")}
                  style={
                    fixedPreview
                      ? {
                          width: deviceDimensions.width * previewScale,
                          height: deviceDimensions.height * previewScale,
                        }
                      : { width: "100%", height: "100%" }
                  }
                >
                  <div
                    className={cn(
                      "grid grid-rows-3 h-full",
                      fixedPreview &&
                        "absolute left-0 top-0 overflow-hidden rounded-lg border bg-background shadow-lg",
                      captureViewport &&
                        "rounded-none border-0 shadow-none transition-none",
                    )}
                    style={
                      fixedPreview
                        ? {
                            width: deviceDimensions.width,
                            height: deviceDimensions.height,
                            transform: `scale(${previewScale})`,
                            transformOrigin: "top left",
                          }
                        : undefined
                    }
                  >
                    <div
                      className={cn(
                        "transition-[width,height,transform,opacity] duration-300 ease-in-out",
                        showConsole ? "row-span-2" : "row-span-3",
                      )}
                    >
                      <SandpackPreview
                        showNavigator={!captureViewport}
                        showOpenInCodeSandbox={false}
                        showRefreshButton={false}
                        showRestartButton={false}
                        actionsChildren={
                          <>
                            <SandpackActionButton
                              label={
                                showConsole ? t.console.hide : t.console.show
                              }
                              pressed={showConsole}
                              onClick={() =>
                                setShowConsole((visible) => !visible)
                              }
                            >
                              <Terminal size={16} />
                            </SandpackActionButton>
                            <SandpackRefreshAction
                              label={t.toolbar.reloadPreview}
                              onBeforeRefresh={() =>
                                flushPendingSandpackFileChanges(conversationId)
                              }
                            />
                          </>
                        }
                      />
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
