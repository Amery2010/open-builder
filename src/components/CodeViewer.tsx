import {
  useCallback,
  useEffect,
  useId,
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
import { toast } from "sonner";
import {
  DesignCanvasWorkspace,
  type DesignCanvasBoard,
} from "./design/DesignCanvasWorkspace";
import { DesignCanvasActions } from "./design/DesignCanvasActions";
import { useCanvasPreviews } from "./design/useCanvasPreviews";
import type { CanvasPreviewRequest } from "../lib/design/canvas-preview";
import { computeCanvasPreviewSources } from "../lib/design/canvas-preview-source";
import {
  defaultBranchId,
  isConversationIdentityCurrent,
} from "../lib/conversation/branches";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { useT } from "../i18n";
import { SandpackListener } from "./code-viewer/SandpackListener";
import { projectStaticPreview } from "./code-viewer/sandpack-static-preview";
import { projectSandpackRuntime } from "./code-viewer/sandpack-runtime-preview";
import { projectReactPreview } from "./code-viewer/sandpack-react-preview";
import { type SandpackRuntimeSyncHandle } from "./code-viewer/SandpackRuntimeSync";
import {
  CodeOnlyPreviewNotice,
  PreviewCompilationStatus,
} from "./code-viewer/PreviewCompilationStatus";
import { assessProjectRuntime } from "../lib/project-runtime/capabilities";
import type { ProjectFileChangeGuard } from "./code-viewer/sandpack-file-changes";
import { ViewToolbar } from "./code-viewer/ViewToolbar";
import { PreviewAnnotation } from "./code-viewer/PreviewAnnotation";
import {
  PreviewScreenshot,
  type ScreenshotMode,
} from "./code-viewer/PreviewScreenshot";
import { useSettingsStore } from "../store/settings";
import { useAttachmentIntakeContext } from "./chat/chat-input/AttachmentIntakeContext";
import { FileExplorer } from "./code-viewer/FileExplorer";
import { ProjectAssetList } from "./code-viewer/ProjectAssetList";
import {
  clampPreviewScale,
  PREVIEW_SCALE_STEP,
  type DeviceSize,
  type ViewMode,
} from "./code-viewer/ViewToolbar";
import type {
  PreviewView,
  ProjectAssets,
  ProjectFiles,
  ProjectPreviewMode,
} from "../types";
import { normalizePreviewView } from "../types";
import {
  hasSensitiveProjectFileContent,
  projectFilesForPreview,
} from "../lib/utils/project-file-policy";
import { useConversationStore } from "../store/conversation";
import { DesignSystemPanel } from "./design/DesignSystemPanel";
import { DesignTokenPanel } from "./design/DesignTokenPanel";
import { DesignReviewDialog } from "./design/DesignReviewDialog";
import { AutomaticDesignReviewNotice } from "./design/AutomaticDesignReviewNotice";
import { resolvePageSource } from "../lib/design/page-source";
import { useDesignSelectionStore } from "../store/design-selection";
import {
  createDesignBridgeNonce,
  designBridgeRuntimeRevision,
  DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS,
  DESIGN_BRIDGE_TIMEOUT_ATTEMPTS,
  DESIGN_BRIDGE_PAYLOAD_MAX_BYTES,
  DESIGN_BRIDGE_PROTOCOL_VERSION,
  DESIGN_BRIDGE_VIRTUAL_PATH,
  DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH,
  getDesignBridgeTargetOrigin,
  injectDesignBridge,
  isDesignBridgeOriginAllowed,
  parseDesignBridgeCaptureResponse,
  parseDesignBridgeAnnotationResponse,
  parseDesignBridgeNavigationResponse,
  parseDesignBridgeRouteMessage,
  sanitizeDesignSelectionPayload,
  stripDesignBridge,
  type DesignBridgeCaptureExpectation,
  type DesignBridgeCaptureResult,
  type DesignBridgeAnnotationCaptureResult,
  type DesignBridgeNavigationExpectation,
  type DesignBridgeParentMessage,
} from "../lib/design/preview-bridge";
import {
  collectDesignReviewCaptures,
  DESIGN_REVIEW_VIEWPORTS,
  isDesignReviewViewportReady,
  loadDesignCaptureRuntimeSource,
  waitForPreviewReadiness,
  waitForPreviewSynchronization,
  type DesignReviewViewport,
} from "../lib/design/preview-capture";
import {
  computePreviewGeneration,
  registerPreviewRuntime,
  cancelPreviewCapture,
  PreviewRuntimeError,
  withPreviewCaptureLock,
  type PreviewCaptureCollection,
  type PreviewRuntimeAdapter,
  type PreviewCaptureScope,
  type PreviewCaptureOptions,
  type PrototypePreviewTarget,
} from "../lib/design/preview-runtime";
import type { DesignTokenChange } from "../lib/design/token-mutation";
import { mutateConversationDesignTokens } from "../lib/design/token-mutation-host";
import {
  exportProjectToUniqueDirectory,
  supportsDesktopDesignTools,
} from "../lib/design/desktop";
import {
  type DesignReviewFinding,
  type DesignReviewScreenshot,
} from "../lib/design/review";
import { useDesignReviewStore } from "../store/design-review";
import { useProjectDesignWorkspaceStore } from "../store/project-design-workspace";
import type { AutomaticDesignReviewEvidence } from "../lib/design/automatic-review";
import { computeDesignReviewSourceDigest } from "../lib/design/review-jobs/digest";
import { type DesignReviewRun } from "../lib/design/review-jobs/types";
import { DEFAULT_TITLE } from "../store/conversation";
import {
  readProjectDesign,
  resolveProjectDesignPreview,
  resolveProjectDesignPreviewRoute,
} from "../lib/design/project-design";
import { isPrototypeProject } from "../lib/design/prototype-starter";
import { buildPrototypeReviewCaptureReport } from "../lib/design/prototype-review-plan";
import { createIsolatedPreviewSession } from "../lib/design/prototype-preview-session";

import { flushPendingSandpackFileChanges } from "./code-viewer/sandpack-file-changes";
import {
  SandpackActionButton,
  SandpackRefreshAction,
  SandpackRefreshRegistration,
} from "./code-viewer/SandpackPreviewActions";
import {
  PreviewErrorBoundary,
  type PreviewErrorBoundaryFallbackProps,
} from "./code-viewer/PreviewErrorBoundary";
import { projectFilesForSandpack } from "../lib/project-assets/core";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getNewFileInitialContent } from "./code-viewer/new-file-content";

interface PendingDesignCapture {
  expectation: DesignBridgeCaptureExpectation;
  resolve: (
    result: DesignBridgeCaptureResult | DesignBridgeAnnotationCaptureResult,
  ) => void;
  reject: (error: Error) => void;
  timeout: number;
  removeAbortListener: () => void;
}

type CaptureResult<Output> = Output extends "annotation"
  ? DesignBridgeAnnotationCaptureResult
  : DesignBridgeCaptureResult;

interface PendingDesignNavigation {
  expectation: DesignBridgeNavigationExpectation;
  resolve: (target: PrototypePreviewTarget) => void;
  reject: (error: Error) => void;
  timeout: number;
  removeAbortListener: () => void;
}

const EMPTY_PROJECT_ASSETS: ProjectAssets = {};
const EMPTY_CANVAS_REQUESTS: readonly CanvasPreviewRequest[] = [];
// The iframe bundler avoids the static service-worker relay's stale responses
// in desktop webviews. Keep this setup stable across file updates.
const DESKTOP_STATIC_PREVIEW_SETUP = { environment: "parcel" } as const;

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

function normalizeProjectPath(path: string): string {
  return path.replace(/^\/+/, "");
}

function getProjectFileContent(files: ProjectFiles, path: string): string {
  const normalized = normalizeProjectPath(path);
  return files[normalized] ?? files[`/${normalized}`] ?? "";
}

function findInvalidJsonFile(files: ProjectFiles): string | undefined {
  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalizeProjectPath(rawPath);
    if (!path.toLowerCase().endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(content);
      const lowerPath = path.toLowerCase();
      const isPackageJson =
        lowerPath === "package.json" || lowerPath.endsWith("/package.json");
      if (
        isPackageJson &&
        (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        return path;
      }
    } catch {
      return path;
    }
  }
  return undefined;
}

interface PreviewErrorFallbackProps extends PreviewErrorBoundaryFallbackProps {
  conversationId: string;
  files: ProjectFiles;
  canonicalFiles: ProjectFiles;
  currentFile: string;
  onFileSelect: (path: string) => void;
  onFileChange: (
    conversationId: string,
    path: string,
    content: string,
    guard?: ProjectFileChangeGuard,
  ) => void;
  onDeleteFile: (path: string) => void;
  onRetry: () => void;
}

function PreviewErrorFallback({
  error,
  conversationId,
  files,
  canonicalFiles,
  currentFile,
  onFileSelect,
  onFileChange,
  onDeleteFile,
  onRetry,
}: PreviewErrorFallbackProps) {
  const t = useT();
  const invalidFile = findInvalidJsonFile(files);
  const initialPath = invalidFile ?? normalizeProjectPath(currentFile);
  const [editingPath, setEditingPath] = useState(initialPath);
  const [draft, setDraft] = useState(() =>
    getProjectFileContent(files, initialPath),
  );

  useEffect(() => {
    setEditingPath(initialPath);
    setDraft(getProjectFileContent(files, initialPath));
  }, [files, initialPath]);

  const repairProtected =
    Boolean(editingPath) &&
    getProjectFileContent(canonicalFiles, editingPath) !==
      getProjectFileContent(files, editingPath);

  const handleRepair = () => {
    if (!editingPath || repairProtected) return;
    onFileChange(conversationId, editingPath, draft);
    onFileSelect(editingPath);
  };

  const handleOpenCode = () => {
    if (!editingPath) return;
    onFileSelect(editingPath);
    document.getElementById("preview-error-editor")?.focus();
  };

  const errorDetail = error.message.trim().slice(0, 300);
  const fileName = editingPath.split("/").pop() ?? editingPath;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto bg-background p-4 sm:p-6">
      <div
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"
        role="alert"
        aria-live="assertive"
      >
        <h2 className="text-sm font-semibold text-foreground">
          {t.previewRecovery.unavailableTitle}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t.previewRecovery.renderDescription}
        </p>
        {errorDetail && (
          <p className="mt-2 break-words font-mono text-xs text-destructive">
            {errorDetail}
          </p>
        )}
      </div>

      {editingPath ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <label htmlFor="preview-error-editor" className="text-sm font-medium">
            {t.previewRecovery.editFile.replace("{name}", fileName)}
          </label>
          <Textarea
            id="preview-error-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-48 flex-1 resize-none font-mono text-xs leading-relaxed"
            spellCheck={false}
            aria-label={t.previewRecovery.editPath.replace(
              "{path}",
              editingPath,
            )}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={handleRepair}
              disabled={repairProtected}
            >
              {t.previewRecovery.repair}
            </Button>
            <Button type="button" variant="outline" onClick={handleOpenCode}>
              {t.previewRecovery.focusEditor}
            </Button>
            {invalidFile && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => onDeleteFile(invalidFile)}
              >
                {t.previewRecovery.removeFile.replace("{name}", fileName)}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onRetry}>
              {t.previewRecovery.retry}
            </Button>
          </div>
          {repairProtected && (
            <p className="text-xs text-destructive" role="note">
              {t.previewRecovery.protectedContent}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{editingPath}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t.previewRecovery.openCodeHint}
        </p>
      )}
    </div>
  );
}

interface CodeViewerProps {
  conversationId: string;
  files: ProjectFiles;
  currentFile: string;
  onFileSelect: (path: string) => void;
  onFileChange: (
    conversationId: string,
    path: string,
    content: string,
    guard?: ProjectFileChangeGuard,
  ) => void;
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
    outcome?: "unavailable" | "superseded",
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
  onReloadPreview,
  onApplyDesignSystem,
  isGenerating = false,
  onDesignReview,
  onAutomaticDesignReview,
  onAutomaticDesignReviewUnavailable,
  onApplyDesignReviewFixes,
}: CodeViewerProps) {
  const t = useT();
  const previewEnabled = previewMode !== "code-only";
  const codeOnlyReason = useMemo(
    () =>
      previewEnabled ? undefined : assessProjectRuntime(files).preview.reason,
    [files, previewEnabled],
  );
  const [annotationScope, setAnnotationScope] =
    useState<PreviewCaptureScope | null>(null);
  const annotationOpen = annotationScope !== null;
  const [screenshotMode, setScreenshotMode] = useState<ScreenshotMode | null>(
    null,
  );
  const imageCaptureOpen = annotationOpen || screenshotMode !== null;
  const closeScreenshot = useCallback(() => setScreenshotMode(null), []);
  const [designFocus, setDesignFocus] = useState(false);
  const [canvasRuntimeEpoch, setCanvasRuntimeEpoch] = useState(0);
  const [canvasFocusRequest, setCanvasFocusRequest] = useState<{
    pageId: string;
    requestId: number;
  }>();
  const [pageSourceMissing, setPageSourceMissing] = useState(false);
  const annotationIntake = useAttachmentIntakeContext();
  const closeAnnotation = useCallback(() => setAnnotationScope(null), []);
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
  const [selectedPrototypePageId, setSelectedPrototypePageId] = useState<
    string | undefined
  >();
  const [captureRuntimeSource, setCaptureRuntimeSource] = useState<
    string | null
  >(null);
  const [captureRuntimeSettled, setCaptureRuntimeSettled] = useState(false);
  const previewHasMountedRef = useRef(false);
  const [captureViewport, setCaptureViewport] =
    useState<DesignReviewViewport | null>(null);
  const [previewGeneration, setPreviewGeneration] = useState<
    string | undefined
  >(undefined);
  const desktopActionToastId = useId();
  const desktopActionScopeRef = useRef<symbol | null>(null);
  useEffect(() => {
    desktopActionScopeRef.current = Symbol();
    return () => {
      desktopActionScopeRef.current = null;
      toast.dismiss(desktopActionToastId);
    };
  }, [conversationId, desktopActionToastId]);
  const [designBridgeReady, setDesignBridgeReady] = useState(false);
  const designBridgeReadyRef = useRef(false);
  const bridgeGenerationRef = useRef<string | undefined>(undefined);
  const previewGenerationRef = useRef<string | undefined>(undefined);
  const captureRuntimeReadyRef = useRef(false);
  const bridgeNonceRef = useRef<string | null>(null);
  const bridgeRetryTimersRef = useRef<number[]>([]);
  const pendingCaptureRef = useRef<PendingDesignCapture | null>(null);
  const pendingNavigationRef = useRef<PendingDesignNavigation | null>(null);
  const captureAbortRef = useRef<AbortController | null>(null);
  const prototypeNavigationAbortRef = useRef<AbortController | null>(null);
  const captureTaskRef = useRef<Promise<void> | null>(null);
  const manualRetryOfRef = useRef<string | null>(null);
  const softRefreshRef = useRef<(() => void) | null>(null);
  const runtimeSyncRef = useRef<SandpackRuntimeSyncHandle | null>(null);
  const preparedProjectionRef = useRef<ProjectFiles>({});
  const readinessRequestRef = useRef<string | null>(null);
  const readinessReplyRef = useRef<string | null>(null);
  const lastReadinessMessageRef = useRef<{
    generation: string;
    runtimeRevision: string;
    captureRuntimeAvailable: boolean;
    nonce?: string;
  } | null>(null);
  const previewHostRef = useRef<HTMLDivElement>(null);
  const captureContextRef = useRef({ conversationId, viewMode });
  captureContextRef.current = { conversationId, viewMode };
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
  const projectAssets = useConversationStore(
    (state) =>
      state.conversations[conversationId]?.assets ?? EMPTY_PROJECT_ASSETS,
  );
  const branchId = useConversationStore(
    (state) =>
      state.conversations[conversationId]?.activeBranchId ??
      defaultBranchId(conversationId),
  );
  const checkoutEpoch = useConversationStore(
    (state) => state.conversations[conversationId]?.checkoutEpoch ?? 0,
  );
  const parentBranchId = useConversationStore(
    (state) =>
      state.conversations[conversationId]?.branches?.[branchId]?.parentBranchId,
  );
  const canvasIdentity = useMemo(
    () => ({ conversationId, branchId, checkoutEpoch }),
    [conversationId, branchId, checkoutEpoch],
  );
  const projectDesign = useMemo(() => readProjectDesign(files), [files]);
  const designCanvasEnabled =
    workspaceMode === "design" &&
    previewEnabled &&
    (projectDesign.status === "invalid" ||
      (projectDesign.status === "ready" &&
        projectDesign.design.pages.length !== 1));
  useEffect(() => {
    setDesignFocus(false);
  }, [conversationId, branchId, checkoutEpoch, designCanvasEnabled]);
  const canvasMode =
    designCanvasEnabled && effectiveViewMode === "preview" && !designFocus;
  const canvasModeRef = useRef(canvasMode);
  canvasModeRef.current = canvasMode;
  const desktopMode = supportsDesktopDesignTools();
  const setDesignSelection = useDesignSelectionStore(
    (state) => state.setSelection,
  );
  const setProjectDesignWorkspaceSelection = useProjectDesignWorkspaceStore(
    (state) => state.setSelection,
  );
  const clearProjectDesignWorkspaceSelection = useProjectDesignWorkspaceStore(
    (state) => state.clearSelection,
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
  const autoQaEnabled = useSettingsStore((state) => state.system.autoQaEnabled);
  const explicitPrototypePageRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    explicitPrototypePageRef.current = undefined;
  }, [conversationId]);
  const prototypeProject = isPrototypeProject(files);
  const prototypeWorkspaceEnabled =
    workspaceMode === "design" &&
    (prototypeProject || projectDesign.status !== "missing");
  useEffect(() => {
    if (!prototypeWorkspaceEnabled || projectDesign.status !== "ready") {
      setSelectedPrototypePageId(undefined);
      return;
    }
    const page =
      projectDesign.design.pages.find(
        (candidate) => candidate.id === selectedPrototypePageId,
      ) ?? projectDesign.design.pages[0];
    if (!page) return;
    if (page.id !== selectedPrototypePageId) {
      setSelectedPrototypePageId(page.id);
    }
  }, [projectDesign, prototypeWorkspaceEnabled, selectedPrototypePageId]);
  useEffect(() => {
    if (
      !prototypeWorkspaceEnabled ||
      projectDesign.status !== "ready" ||
      !selectedPrototypePageId
    ) {
      clearProjectDesignWorkspaceSelection(conversationId);
      return;
    }
    // Selection is useful even while a draft page has no executable preview.
    setProjectDesignWorkspaceSelection(conversationId, {
      pageId: selectedPrototypePageId,
      explicit: explicitPrototypePageRef.current === selectedPrototypePageId,
    });
  }, [
    clearProjectDesignWorkspaceSelection,
    conversationId,
    projectDesign,
    prototypeWorkspaceEnabled,
    selectedPrototypePageId,
    setProjectDesignWorkspaceSelection,
  ]);
  const workspaceKey = JSON.stringify(canvasIdentity);
  useEffect(() => {
    setCanvasFocusRequest(undefined);
    setPageSourceMissing(false);
  }, [workspaceKey]);

  const deviceDimensions = captureViewport
    ? { width: captureViewport.width, height: captureViewport.height }
    : canvasMode && deviceSize === "desktop"
      ? { width: 1440, height: 900 }
      : deviceSize === "tablet"
        ? { width: 768, height: 1024 }
        : { width: 375, height: 667 };
  const fixedPreview =
    captureViewport !== null || deviceSize !== "desktop" || canvasMode;
  const previewScale = resolvePreviewScale({
    captureActive: captureViewport !== null,
    requestedScale: canvasMode ? 1 : requestedScale,
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
  const [assetPreviewFiles, setAssetPreviewFiles] =
    useState<ProjectFiles>(previewFiles);
  const [assetProjectionStatus, setAssetProjectionStatus] = useState<
    "loading" | "ready" | "error"
  >(() => (Object.keys(projectAssets).length > 0 ? "loading" : "ready"));
  const [assetProjectionError, setAssetProjectionError] = useState<
    string | null
  >(null);
  const [assetProjectionRetry, setAssetProjectionRetry] = useState(0);
  const [previewRenderRetry, setPreviewRenderRetry] = useState(0);
  const previewBoundaryResetKey = useMemo(
    () => ({ files, previewRenderRetry, sandpackKey }),
    [files, previewRenderRetry, sandpackKey],
  );
  const projectedConversationRef = useRef<string | null>(null);
  const assetProjectionPendingRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setAssetProjectionError(null);
    assetProjectionPendingRef.current = true;
    if (Object.keys(projectAssets).length === 0) {
      setAssetPreviewFiles(previewFiles);
      projectedConversationRef.current = conversationId;
      assetProjectionPendingRef.current = false;
      setAssetProjectionStatus("ready");
      return () => {
        cancelled = true;
      };
    }
    if (projectedConversationRef.current !== conversationId) {
      setAssetProjectionStatus("loading");
    }
    void projectFilesForSandpack(previewFiles, projectAssets).then(
      (derived) => {
        if (cancelled) return;
        setAssetPreviewFiles(derived);
        projectedConversationRef.current = conversationId;
        assetProjectionPendingRef.current = false;
        setAssetProjectionStatus("ready");
      },
      (error) => {
        if (cancelled) return;
        setAssetProjectionError(
          error instanceof Error ? error.message : String(error),
        );
        setAssetProjectionStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [assetProjectionRetry, conversationId, previewFiles, projectAssets]);
  useEffect(() => {
    if (assetProjectionStatus === "error") setViewMode("code");
  }, [assetProjectionStatus]);
  useEffect(() => {
    let cancelled = false;
    previewGenerationRef.current = undefined;
    setPreviewGeneration(undefined);
    cancelPreviewCapture(
      conversationId,
      "The project changed during preview capture.",
    );
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
  useEffect(() => {
    if (!previewEnabled) return;
    let cancelled = false;
    void loadDesignCaptureRuntimeSource().then(
      (source) => {
        if (!cancelled) {
          setCaptureRuntimeSource(source);
          setCaptureRuntimeSettled(true);
        }
      },
      () => {
        if (!cancelled) setCaptureRuntimeSettled(true);
        // Capture reports runtime loading failures without reloading the page.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [previewEnabled]);
  const runtimePreviewProjection = useMemo(
    () => projectSandpackRuntime(assetPreviewFiles, previewEnabled, template),
    [assetPreviewFiles, previewEnabled, template],
  );
  const staticPreviewProjection = useMemo(
    () =>
      projectStaticPreview(
        runtimePreviewProjection.files,
        desktopMode && previewEnabled && template === "static",
      ),
    [runtimePreviewProjection.files, desktopMode, previewEnabled, template],
  );
  const bridgeInjection = useMemo(
    () =>
      injectDesignBridge(
        staticPreviewProjection.files,
        template,
        previewEnabled,
        captureRuntimeSource ?? undefined,
        previewGeneration ?? "pending",
      ),
    [
      captureRuntimeSource,
      previewEnabled,
      staticPreviewProjection.files,
      previewGeneration,
      template,
    ],
  );
  const reactPreviewProjection = useMemo(
    () =>
      projectReactPreview(
        assetPreviewFiles,
        bridgeInjection.supported
          ? bridgeInjection.files
          : staticPreviewProjection.files,
        template,
        previewEnabled,
      ),
    [
      assetPreviewFiles,
      bridgeInjection,
      previewEnabled,
      staticPreviewProjection.files,
      template,
    ],
  );
  const preparingInitialCapture =
    previewEnabled &&
    bridgeInjection.supported &&
    !previewHasMountedRef.current &&
    (!captureRuntimeSettled || !previewGeneration);
  useEffect(() => {
    if (!preparingInitialCapture && assetProjectionStatus === "ready")
      previewHasMountedRef.current = true;
  }, [preparingInitialCapture, assetProjectionStatus]);
  const sandpackSourceFiles = reactPreviewProjection.files;
  preparedProjectionRef.current = sandpackSourceFiles;
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
        Object.values(projectAssets).some((asset) => asset.modulePath === path)
      ) {
        return;
      }
      let editableContent = reactPreviewProjection.restore(path, content);
      if (editableContent === undefined) return;
      editableContent = bridgeInjection.restore(path, editableContent);
      if (editableContent === undefined) return;
      const canonical = files[path];
      if (
        canonical !== undefined &&
        hasSensitiveProjectFileContent(canonical)
      ) {
        return;
      }
      const restoredContent = staticPreviewProjection.restore(
        path,
        editableContent,
      );
      if (restoredContent === undefined) return;
      const runtimeContent = runtimePreviewProjection.restore(
        path,
        restoredContent,
      );
      if (runtimeContent === undefined) return;
      const nextContent = getSandpackFileContentToCommit(
        canonical,
        runtimeContent,
      );
      if (nextContent === undefined) return;
      invalidateAutomaticReview();
      onFileChange(targetConversationId, path, nextContent, {
        expectedContent: canonical,
      });
    },
    [
      bridgeInjection,
      files,
      invalidateAutomaticReview,
      onFileChange,
      projectAssets,
      runtimePreviewProjection,
      reactPreviewProjection,
      staticPreviewProjection,
    ],
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

  const clearPendingNavigation = useCallback(
    (pending: PendingDesignNavigation) => {
      window.clearTimeout(pending.timeout);
      pending.removeAbortListener();
      if (pendingNavigationRef.current === pending) {
        pendingNavigationRef.current = null;
      }
    },
    [],
  );

  const waitForDesignBridge = useCallback(
    (generation: string, signal: AbortSignal) =>
      waitForPreviewReadiness({
        isReady: () =>
          designBridgeReadyRef.current &&
          bridgeGenerationRef.current === generation,
        isCurrent: () => previewGenerationRef.current === generation,
        signal,
        timeoutMs: 5_000,
        errorMessage: "The preview bridge is not ready for navigation.",
      }),
    [],
  );

  const requestPreviewNavigation = useCallback(
    (
      target: PrototypePreviewTarget,
      generation: string,
      signal: AbortSignal,
    ) => {
      const iframe = getPreviewIframe();
      if (!iframe?.contentWindow) {
        return Promise.reject(new Error("Preview iframe is not available."));
      }
      const contentWindow = iframe.contentWindow;
      const targetOrigin = getDesignBridgeTargetOrigin(
        iframe.src,
        window.location.href,
      );
      if (!targetOrigin) {
        return Promise.reject(new Error("Preview iframe origin is invalid."));
      }
      if (pendingNavigationRef.current) {
        return Promise.reject(
          new Error("A preview navigation request is already running."),
        );
      }
      const expectation: DesignBridgeNavigationExpectation = {
        generation,
        nonce: createDesignBridgeNonce(),
        requestId: createDesignBridgeNonce(),
        target,
      };
      return new Promise<PrototypePreviewTarget>((resolve, reject) => {
        const abort = () => {
          const pending = pendingNavigationRef.current;
          if (!pending || pending.expectation !== expectation) return;
          clearPendingNavigation(pending);
          reject(
            new DOMException("Preview navigation was cancelled.", "AbortError"),
          );
        };
        const timeout = window.setTimeout(() => {
          const pending = pendingNavigationRef.current;
          if (!pending || pending.expectation !== expectation) return;
          clearPendingNavigation(pending);
          reject(new Error("Preview navigation timed out."));
        }, DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS * DESIGN_BRIDGE_TIMEOUT_ATTEMPTS);
        const pending: PendingDesignNavigation = {
          expectation,
          resolve,
          reject,
          timeout,
          removeAbortListener: () => signal.removeEventListener("abort", abort),
        };
        pendingNavigationRef.current = pending;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        contentWindow.postMessage(
          {
            type: "open-builder:design-bridge-navigate",
            version: DESIGN_BRIDGE_PROTOCOL_VERSION,
            generation,
            nonce: expectation.nonce,
            requestId: expectation.requestId,
            target,
          },
          targetOrigin,
        );
      });
    },
    [clearPendingNavigation, getPreviewIframe],
  );

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
    function requestCapture<
      Output extends "evidence" | "annotation" = "evidence",
    >(
      viewport: DesignReviewViewport,
      generation: string,
      signal: AbortSignal,
      target?: PrototypePreviewTarget,
      currentViewport = false,
      scope: PreviewCaptureScope = currentViewport ? "viewport" : "full-page",
      output: Output = "evidence" as Output,
    ): Promise<CaptureResult<Output>> {
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
        currentViewport,
        scope,
        output,
        ...(target ? { target } : {}),
      };
      return new Promise<
        DesignBridgeCaptureResult | DesignBridgeAnnotationCaptureResult
      >((resolve, reject) => {
        const cancelRemoteCapture = () => {
          iframe.contentWindow?.postMessage(
            {
              type: "open-builder:design-bridge-cancel-capture",
              version: DESIGN_BRIDGE_PROTOCOL_VERSION,
              generation,
              nonce: expectation.nonce,
              requestId: expectation.requestId,
            },
            targetOrigin,
          );
        };
        const abort = () => {
          const pending = pendingCaptureRef.current;
          if (!pending || pending.expectation !== expectation) return;
          cancelRemoteCapture();
          clearPendingCapture(pending);
          reject(
            new DOMException("Preview capture was cancelled.", "AbortError"),
          );
        };
        const timeout = window.setTimeout(() => {
          const pending = pendingCaptureRef.current;
          if (!pending || pending.expectation !== expectation) return;
          cancelRemoteCapture();
          clearPendingCapture(pending);
          reject(new Error("Preview capture timed out."));
        }, DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS * DESIGN_BRIDGE_TIMEOUT_ATTEMPTS);
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
              currentViewport,
              scope,
              output,
              viewport: {
                name: viewport.name,
                width: viewport.width,
                height: viewport.height,
              },
              ...(target ? { target } : {}),
            },
            targetOrigin,
          );
        } catch (error) {
          clearPendingCapture(pending);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }) as Promise<CaptureResult<Output>>;
    },
    [clearPendingCapture, getPreviewIframe],
  );

  useEffect(() => {
    const capture = pendingCaptureRef.current;
    if (capture && capture.expectation.generation !== previewGeneration) {
      clearPendingCapture(capture);
      capture.reject(
        new PreviewRuntimeError(
          "stale_generation",
          "Preview generation was replaced.",
        ),
      );
    }
    const navigation = pendingNavigationRef.current;
    if (navigation && navigation.expectation.generation !== previewGeneration) {
      clearPendingNavigation(navigation);
      navigation.reject(
        new PreviewRuntimeError(
          "stale_generation",
          "Preview generation was replaced.",
        ),
      );
    }
  }, [previewGeneration, clearPendingCapture, clearPendingNavigation]);

  useEffect(() => {
    const retainExplicitDraft = () => {
      const pageId = explicitPrototypePageRef.current;
      return (
        !!pageId &&
        projectDesign.status === "ready" &&
        projectDesign.design.pages.some((page) => page.id === pageId) &&
        resolveProjectDesignPreview(projectDesign.design, pageId).status ===
          "unavailable"
      );
    };
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
          message?.type === "open-builder:design-bridge-annotation-result" ||
          message?.type === "open-builder:design-bridge-capture-error")
      ) {
        if (pending.expectation.output === "annotation") {
          void parseDesignBridgeAnnotationResponse(message, pending.expectation)
            .then((response) => {
              if (!response || pendingCaptureRef.current !== pending) return;
              clearPendingCapture(pending);
              if (response.ok) pending.resolve(response.result);
              else pending.reject(new Error(response.error));
            })
            .catch(() => {
              if (pendingCaptureRef.current !== pending) return;
              clearPendingCapture(pending);
              pending.reject(
                new Error("Could not validate the preview image."),
              );
            });
          return;
        }
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
      const pendingNavigation = pendingNavigationRef.current;
      if (
        pendingNavigation &&
        (message?.type === "open-builder:design-bridge-navigation-result" ||
          message?.type === "open-builder:design-bridge-navigation-error")
      ) {
        const response = parseDesignBridgeNavigationResponse(
          message,
          pendingNavigation.expectation,
        );
        if (!response) return;
        clearPendingNavigation(pendingNavigation);
        if (response.ok) pendingNavigation.resolve(response.target);
        else pendingNavigation.reject(new Error(response.error));
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
      if (message.type === "open-builder:design-bridge-route") {
        const generation = previewGenerationRef.current;
        const route = generation
          ? parseDesignBridgeRouteMessage(message, generation)
          : null;
        if (
          route &&
          prototypeWorkspaceEnabled &&
          projectDesign.status === "ready"
        ) {
          const target = resolveProjectDesignPreviewRoute(
            projectDesign.design,
            route,
          );
          if (target && !canvasModeRef.current && !retainExplicitDraft()) {
            setSelectedPrototypePageId(target.pageId);
          }
        }
        return;
      }
      if (message.type === "open-builder:design-bridge-ready") {
        if (readinessRequestRef.current)
          lastReadinessMessageRef.current = message;
        bridgeGenerationRef.current = message.generation;
        designBridgeReadyRef.current =
          message.generation === previewGenerationRef.current;
        captureRuntimeReadyRef.current =
          designBridgeReadyRef.current &&
          message.runtimeRevision ===
            designBridgeRuntimeRevision(message.generation, true) &&
          message.captureRuntimeAvailable === true;
        if (
          captureRuntimeReadyRef.current &&
          message.nonce === readinessRequestRef.current
        ) {
          readinessReplyRef.current = message.nonce ?? null;
        }
        setDesignBridgeReady(designBridgeReadyRef.current);
        if (
          designBridgeReadyRef.current &&
          !String(message.nonce ?? "").startsWith("live-") &&
          prototypeWorkspaceEnabled &&
          projectDesign.status === "ready"
        ) {
          const observed = resolveProjectDesignPreviewRoute(
            projectDesign.design,
            message.route,
          );
          const target =
            observed ??
            (() => {
              const firstPage = projectDesign.design.pages[0];
              const preview = firstPage
                ? resolveProjectDesignPreview(
                    projectDesign.design,
                    firstPage.id,
                  )
                : undefined;
              return preview?.status === "ready" ? preview.target : null;
            })();
          if (target && !canvasModeRef.current && !retainExplicitDraft()) {
            setSelectedPrototypePageId(target.pageId);

            if (!observed) {
              const controller = new AbortController();
              void requestPreviewNavigation(
                target,
                message.generation,
                controller.signal,
              ).catch(() => {});
            }
          }
        }
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
    clearPendingNavigation,
    deactivateDesignSelection,
    designSelectionActive,
    getPreviewIframe,
    postBridgeControl,
    projectDesign,
    prototypeWorkspaceEnabled,
    requestPreviewNavigation,
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
      prototypeNavigationAbortRef.current?.abort();
      const navigation = pendingNavigationRef.current;
      if (navigation) {
        clearPendingNavigation(navigation);
        navigation.reject(
          new DOMException("Preview navigation was cancelled.", "AbortError"),
        );
      }
      const pending = pendingCaptureRef.current;
      if (pending) {
        clearPendingCapture(pending);
        pending.reject(
          new DOMException("Preview capture was cancelled.", "AbortError"),
        );
      }
    },
    [clearBridgeRetryTimers, clearPendingCapture, clearPendingNavigation],
  );

  const bridgeUnavailableReason =
    bridgeInjection.reason === "code-only"
      ? t.toolbar.selectionCodeOnly
      : bridgeInjection.reason === "unsupported-template"
        ? t.toolbar.selectionUnsupportedTemplate.replace("{template}", template)
        : bridgeInjection.reason === "missing-index"
          ? t.toolbar.selectionMissingIndex
          : bridgeInjection.reason === "missing-entry"
            ? t.toolbar.selectionMissingEntry
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
    const scope = desktopActionScopeRef.current;
    toast.dismiss(desktopActionToastId);
    try {
      const result = await exportProjectToUniqueDirectory(
        files,
        conversationTitle === DEFAULT_TITLE
          ? "open-builder-project"
          : conversationTitle,
        projectAssets,
      );
      if (result && desktopActionScopeRef.current === scope) {
        toast.success(
          t.toolbar.exportedDirectory.replace("{path}", result.path),
          { id: desktopActionToastId },
        );
      }
    } catch (error) {
      if (desktopActionScopeRef.current !== scope) return;
      toast.error(
        t.toolbar.exportDirectoryFailed.replace(
          "{message}",
          error instanceof Error ? error.message : String(error),
        ),
        { id: desktopActionToastId, duration: 8_000 },
      );
    }
  }, [
    conversationTitle,
    desktopActionToastId,
    files,
    isGenerating,
    projectAssets,
    t.toolbar,
  ]);

  const waitForPreviewViewport = useCallback(
    async (
      viewport: DesignReviewViewport,
      generation: string,
      signal: AbortSignal,
    ) => {
      await waitForPreviewReadiness({
        isReady: () => {
          const iframe = getPreviewIframe();
          return Boolean(
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
            bridgeGenerationRef.current === generation,
          );
        },
        isCurrent: () => previewGenerationRef.current === generation,
        signal,
        timeoutMs: 5_000,
        pollIntervalMs: 50,
        errorMessage: () => {
          const iframe = getPreviewIframe();
          const size = `${iframe?.clientWidth ?? 0}x${iframe?.clientHeight ?? 0}`;
          if (!designBridgeReadyRef.current)
            return `Preview bridge is not ready (actual viewport ${size}).`;
          if (!captureRuntimeReadyRef.current)
            return `Screenshot runtime is not ready (actual viewport ${size}).`;
          return `Preview viewport ${size} does not represent ${viewport.name}.`;
        },
      });
      await afterPreviewPaint();
      signal.throwIfAborted();
    },
    [getPreviewIframe],
  );

  const preparePreviewRuntime = useCallback(
    async (generation: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!previewEnabled) {
        throw new PreviewRuntimeError(
          "preview_unavailable",
          "Preview capture is unavailable in code-only projects.",
        );
      }
      if (bridgeInjection.reason === "unsupported-template") {
        throw new PreviewRuntimeError(
          "preview_unavailable",
          `Preview capture is not supported for the ${template} preview template.`,
        );
      }
      const runtimeSource = await loadDesignCaptureRuntimeSource();
      signal.throwIfAborted();
      const previousMode = captureContextRef.current.viewMode;
      setCaptureRuntimeSource(runtimeSource);
      setViewMode("preview");
      try {
        flushPendingSandpackFileChanges(conversationId);
        await waitForPreviewReadiness({
          isReady: () => previewGenerationRef.current === generation,
          signal,
          timeoutMs: 5_000,
          errorMessage:
            "The mounted preview did not reach the current project generation.",
        });
        const projectionReady = () => {
          const projection = preparedProjectionRef.current;
          return (
            !assetProjectionPendingRef.current &&
            projection[DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH] === runtimeSource &&
            projection[DESIGN_BRIDGE_VIRTUAL_PATH]?.includes(
              designBridgeRuntimeRevision(generation, true),
            ) === true
          );
        };
        await waitForPreviewSynchronization({
          isReady: () =>
            projectionReady() &&
            runtimeSyncRef.current?.isSynchronized(
              preparedProjectionRef.current,
            ) === true,
          canRestart: () =>
            projectionReady() && runtimeSyncRef.current !== null,
          restart: () => {
            const runtime = runtimeSyncRef.current;
            if (!runtime) throw new Error("The preview client is unavailable.");
            setCanvasRuntimeEpoch((epoch) => epoch + 1);
            return runtime.restart();
          },
          isCurrent: () => previewGenerationRef.current === generation,
          signal,
          timeoutMs: 5_000,
        });
        designBridgeReadyRef.current = false;
        captureRuntimeReadyRef.current = false;
        bridgeGenerationRef.current = undefined;
        readinessReplyRef.current = null;
        lastReadinessMessageRef.current = null;
        const requestNonce = createDesignBridgeNonce();
        readinessRequestRef.current = requestNonce;
        setDesignBridgeReady(false);
        await afterPreviewPaint();
        try {
          await waitForPreviewReadiness({
            isReady: () => {
              if (
                readinessReplyRef.current === requestNonce &&
                captureRuntimeReadyRef.current
              )
                return true;
              const iframe = getPreviewIframe();
              const origin =
                iframe &&
                getDesignBridgeTargetOrigin(iframe.src, window.location.href);
              if (iframe?.contentWindow && origin)
                iframe.contentWindow.postMessage(
                  {
                    type: "open-builder:design-bridge-readiness",
                    version: DESIGN_BRIDGE_PROTOCOL_VERSION,
                    generation,
                    runtimeRevision: designBridgeRuntimeRevision(
                      generation,
                      true,
                    ),
                    nonce: requestNonce,
                  },
                  origin,
                );
              return false;
            },
            isCurrent: () => previewGenerationRef.current === generation,
            signal,
            timeoutMs: 5_000,
            pollIntervalMs: 100,
            errorMessage: () => {
              const iframe = getPreviewIframe();
              const size = `${iframe?.clientWidth ?? 0}x${iframe?.clientHeight ?? 0}`;
              const reply = lastReadinessMessageRef.current;
              if (
                reply &&
                (reply.generation !== generation ||
                  reply.runtimeRevision !==
                    designBridgeRuntimeRevision(generation, true))
              ) {
                return `Preview bridge is still running an older project or runtime revision (actual viewport ${size}).`;
              }
              if (reply?.captureRuntimeAvailable === false) {
                return `Preview bridge reported the screenshot runtime unavailable (actual viewport ${size}).`;
              }
              return `Preview bridge did not acknowledge the current capture request (actual viewport ${size}).`;
            },
          });
        } finally {
          if (readinessRequestRef.current === requestNonce)
            readinessRequestRef.current = null;
        }
      } finally {
        if (captureContextRef.current.conversationId === conversationId) {
          setViewMode(previousMode);
          await afterPreviewPaint();
        }
      }
    },
    [
      conversationId,
      getPreviewIframe,
      previewEnabled,
      bridgeInjection.reason,
      template,
    ],
  );

  const capturePreviewCollection = useCallback(
    async (
      viewports: readonly DeviceSize[],
      generation: string,
      signal: AbortSignal,
      target?: PrototypePreviewTarget,
      onProgress?: (
        completed: number,
        total: number,
        viewport: DesignReviewViewport,
      ) => void,
      options?: PreviewCaptureOptions,
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
        if (
          !captureRuntimeReadyRef.current ||
          bridgeGenerationRef.current !== generation
        ) {
          await preparePreviewRuntime(generation, signal);
        }
        signal.throwIfAborted();
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
            requestPreviewCapture(
              viewport,
              generation,
              signal,
              target,
              false,
              options?.scope,
            ),
          onProgress,
          restore: restorePreview,
        });
        return { generation, ...(target ? { target } : {}), ...collection };
      } finally {
        await restorePreview();
      }
    },
    [
      activateDesignSelection,
      bridgeInjection.supported,
      bridgeUnavailableReason,
      preparePreviewRuntime,
      deactivateDesignSelection,
      designSelectionActive,
      requestPreviewCapture,
      showConsole,
      viewMode,
      waitForPreviewViewport,
    ],
  );

  const prepareCurrentPreview = useCallback(
    async (generation: string, signal: AbortSignal) => {
      if (!previewEnabled || !bridgeInjection.supported) {
        throw new PreviewRuntimeError(
          "preview_unavailable",
          "Live capture requires a supported mounted preview.",
        );
      }
      const iframe = getPreviewIframe();
      const origin = iframe
        ? getDesignBridgeTargetOrigin(iframe.src, window.location.href)
        : null;
      if (!iframe?.contentWindow || !origin)
        throw new PreviewRuntimeError(
          "preview_unavailable",
          "The live preview iframe is unavailable.",
        );
      const nonce = `live-${createDesignBridgeNonce()}`;
      readinessRequestRef.current = nonce;
      readinessReplyRef.current = null;
      try {
        await waitForPreviewReadiness({
          isReady: () => {
            if (
              readinessReplyRef.current === nonce &&
              captureRuntimeReadyRef.current &&
              bridgeGenerationRef.current === generation
            )
              return true;
            iframe.contentWindow!.postMessage(
              {
                type: "open-builder:design-bridge-readiness",
                version: DESIGN_BRIDGE_PROTOCOL_VERSION,
                generation,
                runtimeRevision: designBridgeRuntimeRevision(generation, true),
                nonce,
              },
              origin,
            );
            return false;
          },
          isCurrent: () => previewGenerationRef.current === generation,
          signal,
          timeoutMs: 5_000,
          pollIntervalMs: 100,
          errorMessage:
            "The current preview screenshot runtime is not ready. Live capture never reloads the page.",
        });
      } finally {
        if (readinessRequestRef.current === nonce)
          readinessRequestRef.current = null;
      }
    },
    [previewEnabled, bridgeInjection.supported, getPreviewIframe],
  );

  const captureCurrentPreview = useCallback(
    function captureCurrent<
      Output extends "evidence" | "annotation" = "evidence",
    >(
      generation: string,
      signal: AbortSignal,
      scope: PreviewCaptureScope = "viewport",
      output: Output = "evidence" as Output,
    ) {
      const iframe = getPreviewIframe();
      if (!iframe || iframe.clientWidth < 240 || iframe.clientHeight < 240) {
        throw new PreviewRuntimeError(
          "preview_unavailable",
          "The current preview is hidden or has no capturable viewport.",
        );
      }
      const width = iframe.clientWidth;
      let name: DesignReviewViewport["name"] = "desktop";
      if (width < 768) name = "mobile";
      else if (width < 1024) name = "tablet";
      return requestPreviewCapture(
        { name, width, height: iframe.clientHeight },
        generation,
        signal,
        undefined,
        true,
        scope,
        output,
      );
    },
    [getPreviewIframe, requestPreviewCapture],
  );

  const bootstrapIsolatedPreview = useMemo(() => {
    if (
      !reactPreviewProjection.customSetup &&
      !(desktopMode && template === "static")
    )
      return undefined;
    return async (frame: HTMLIFrameElement, signal: AbortSignal) => {
      const runtime = runtimeSyncRef.current;
      if (!runtime)
        throw new PreviewRuntimeError(
          "preview_unavailable",
          "The preview client is not ready.",
        );
      return runtime.bootstrapIsolatedPreview(frame, signal);
    };
  }, [reactPreviewProjection.customSetup, desktopMode, template]);

  const previewRuntimeRef = useRef<{
    conversationId: string;
    adapter: PreviewRuntimeAdapter;
  } | null>(null);
  previewRuntimeRef.current = {
    conversationId,
    adapter: {
      getGeneration: () => previewGenerationRef.current,
      prepare: preparePreviewRuntime,
      prepareCurrent: prepareCurrentPreview,
      captureCurrent: (generation, signal, options) =>
        captureCurrentPreview(generation, signal, options?.scope),
      captureAnnotation: (generation, signal, scope) =>
        captureCurrentPreview(generation, signal, scope, "annotation"),
      navigateToTarget: async (target, generation, signal) => {
        await waitForDesignBridge(generation, signal);
        await requestPreviewNavigation(target, generation, signal);
        signal.throwIfAborted();
        if (softRefreshRef.current) {
          setCanvasRuntimeEpoch((epoch) => epoch + 1);
          softRefreshRef.current();
        }
        await afterPreviewPaint();
        await waitForDesignBridge(generation, signal);
        return requestPreviewNavigation(target, generation, signal);
      },
      capture: (viewports, generation, signal, target, options) =>
        capturePreviewCollection(
          viewports,
          generation,
          signal,
          target,
          undefined,
          options,
        ),
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
      prepareCurrent: (generation, signal) =>
        currentAdapter().prepareCurrent!(generation, signal),
      captureCurrent: (generation, signal, options) =>
        currentAdapter().captureCurrent!(generation, signal, options),
      captureAnnotation: (generation, signal, scope) =>
        currentAdapter().captureAnnotation!(generation, signal, scope),
      navigateToTarget: (target, generation, signal) =>
        currentAdapter().navigateToTarget!(target, generation, signal),
      capture: (viewports, generation, signal, target, options) =>
        currentAdapter().capture(
          viewports,
          generation,
          signal,
          target,
          options,
        ),
    });
  }, [conversationId, requestPreviewNavigation, waitForDesignBridge]);

  const submitManualDesignReview = useCallback(
    (screenshots: readonly DesignReviewScreenshot[]) => {
      const retryOf = manualRetryOfRef.current ?? undefined;
      manualRetryOfRef.current = null;
      return onDesignReview?.(screenshots, retryOf ? { retryOf } : undefined);
    },
    [onDesignReview],
  );

  const reportAutomaticCaptureUnavailable = useCallback(
    async (
      evidence: AutomaticDesignReviewEvidence,
      message: string,
      outcome: "unavailable" | "superseded" = "unavailable",
    ) => {
      const store = useDesignReviewStore.getState();
      if (
        store.automatic?.evidence.requestId !== evidence.requestId ||
        !isConversationIdentityCurrent(
          canvasIdentity,
          useConversationStore.getState().conversations[conversationId],
        )
      )
        return;
      if (onAutomaticDesignReviewUnavailable) {
        await onAutomaticDesignReviewUnavailable(evidence, message, outcome);
      } else if (outcome === "superseded") {
        store.finishAutomatic("superseded");
      } else {
        store.failAutomatic(message);
      }
    },
    [canvasIdentity, conversationId, onAutomaticDesignReviewUnavailable],
  );

  const captureDesignReviewScreenshots = useCallback(
    (options: { automatic?: boolean; signal?: AbortSignal } = {}) => {
      if (captureTaskRef.current) return captureTaskRef.current;
      if (
        options.automatic &&
        !useSettingsStore.getState().system.autoQaEnabled
      )
        return Promise.resolve();
      const controller = new AbortController();
      const automaticRequestId = options.automatic
        ? useDesignReviewStore.getState().automatic?.evidence.requestId
        : undefined;
      const unsubscribeQa = options.automatic
        ? useSettingsStore.subscribe((state) => {
            if (!state.system.autoQaEnabled) controller.abort();
          })
        : undefined;
      const cancel = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      captureAbortRef.current = controller;
      const task = (async () => {
        const reviewStore = useDesignReviewStore.getState();
        const automaticEvidence = options.automatic
          ? reviewStore.automatic?.evidence
          : undefined;
        const isCurrent = () =>
          !controller.signal.aborted &&
          isConversationIdentityCurrent(
            canvasIdentity,
            useConversationStore.getState().conversations[conversationId],
          ) &&
          (!options.automatic ||
            (useSettingsStore.getState().system.autoQaEnabled &&
              !!automaticEvidence &&
              useDesignReviewStore.getState().automatic?.evidence.requestId ===
                automaticEvidence.requestId));
        const assertCurrent = () => {
          if (!isCurrent())
            throw new DOMException(
              "Review capture was replaced.",
              "AbortError",
            );
        };
        const unavailable = (
          message: string,
          outcome: "unavailable" | "superseded" = "unavailable",
        ) => {
          if (!automaticEvidence || !isCurrent()) return;
          return reportAutomaticCaptureUnavailable(
            automaticEvidence,
            message,
            outcome,
          );
        };
        assertCurrent();
        if (!options.automatic) reviewStore.clearAutomatic();
        const prototypePlan =
          prototypeWorkspaceEnabled && projectDesign.status === "ready"
            ? buildPrototypeReviewCaptureReport(
                projectDesign.design,
                automaticEvidence?.affectedPageIds,
              )
            : null;
        const prototypeTargets = prototypePlan?.targets;
        const skippedMessages =
          prototypePlan?.skipped.map(
            (item) =>
              `${item.pageId}: ${t.prototypeWorkspace.previewReasons[item.reason]}`,
          ) ?? [];
        reviewStore.beginCapture(
          prototypeTargets?.length ?? DESIGN_REVIEW_VIEWPORTS.length,
        );
        if (!bridgeInjection.supported) {
          const message =
            (bridgeUnavailableReason ??
              "Automatic preview capture is unavailable for this project.") +
            (automaticEvidence
              ? " Static Design-system checks completed; visual evidence is unavailable."
              : "");
          if (automaticEvidence) {
            await unavailable(message);
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
          if (automaticEvidence?.sourceDigest) {
            const currentDigest = await computeDesignReviewSourceDigest({
              files,
              designSystem: designState?.appliedSystem ?? null,
              designContract: automaticEvidence.contract,
            });
            assertCurrent();
            if (previewGenerationRef.current !== generation) {
              throw new PreviewRuntimeError(
                "stale_generation",
                "The project changed while validating Design Review source.",
              );
            }
            if (currentDigest !== automaticEvidence.sourceDigest) {
              await unavailable(
                "The project changed before automatic Design Review capture started.",
                "superseded",
              );
              return;
            }
          }
          const collection = await withPreviewCaptureLock({
            conversationId,
            owner: options.automatic ? "automatic-review" : "manual-review",
            signal: controller.signal,
            run: async (adapter, signal) => {
              assertCurrent();
              if (adapter.getGeneration() !== generation) {
                throw new PreviewRuntimeError(
                  "stale_generation",
                  "The project changed while waiting for Design Review capture.",
                );
              }
              if (prototypeTargets) {
                if (prototypeTargets.length === 0)
                  return { generation, captures: [], errors: skippedMessages };
                await adapter.prepare(generation, signal);
                const sourceFrame = getPreviewIframe();
                if (!sourceFrame) {
                  throw new Error("Preview iframe is not available.");
                }
                const isolated = await createIsolatedPreviewSession(
                  sourceFrame,
                  generation,
                  signal,
                  bootstrapIsolatedPreview,
                );
                const captures: DesignBridgeCaptureResult[] = [];
                const errors: string[] = [...skippedMessages];
                try {
                  for (const [index, item] of prototypeTargets.entries()) {
                    try {
                      await isolated.setViewport(item.viewport);
                      await isolated.navigate(item.target);
                      captures.push(
                        await isolated.capture(item.viewport, item.target),
                      );
                    } catch (error) {
                      if ((error as { name?: string })?.name === "AbortError") {
                        throw error;
                      }
                      errors.push(
                        `${item.target.pageId}/${item.viewport.name}: ${
                          error instanceof Error ? error.message : String(error)
                        }`,
                      );
                    }
                    useDesignReviewStore.getState().updateCaptureProgress({
                      completed: index + 1,
                      total: prototypeTargets.length,
                      viewport: `${item.target.pageId}/${item.viewport.name}`,
                    });
                  }
                } finally {
                  isolated.dispose();
                }
                if (adapter.getGeneration() !== generation) {
                  throw new PreviewRuntimeError(
                    "stale_generation",
                    "The project changed while prototype review evidence was captured.",
                  );
                }
                return { generation, captures, errors };
              }
              await adapter.prepare(generation, signal);
              return capturePreviewCollection(
                DESIGN_REVIEW_VIEWPORTS.map((viewport) => viewport.name),
                generation,
                signal,
                undefined,
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
          assertCurrent();
          if (
            collection.generation !== generation ||
            previewGenerationRef.current !== generation
          ) {
            throw new PreviewRuntimeError(
              "stale_generation",
              "The project changed before prototype review evidence completed.",
            );
          }
          const screenshots: DesignReviewScreenshot[] = collection.captures.map(
            (capture) => ({
              dataUrl: capture.dataUrl,
              mimeType: capture.mimeType,
              name: capture.semanticSnapshot.prototypeIdentity
                ? `preview-${capture.semanticSnapshot.prototypeIdentity.pageId}-${capture.viewport.name}.${capture.mimeType.slice(6)}`
                : `preview-${capture.viewport.name}-${capture.viewport.width}x${capture.viewport.height}.${capture.mimeType.slice(6)}`,
              source: "automatic",
              viewport: capture.viewport,
              semanticSnapshot: capture.semanticSnapshot,
              ...(capture.semanticSnapshot.prototypeIdentity
                ? { target: capture.semanticSnapshot.prototypeIdentity }
                : {}),
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
              await unavailable(message);
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
              void unavailable(
                error instanceof Error ? error.message : String(error),
              );
            });
          } else {
            await submitManualDesignReview(screenshots);
          }
        } catch (error) {
          if ((error as { name?: string })?.name === "AbortError") {
            if (isCurrent()) {
              if (automaticEvidence)
                await unavailable(
                  "The preview was replaced during Design Review capture.",
                  "superseded",
                );
              else
                reviewStore.fail(
                  "Preview capture was interrupted. Recapture screenshots to retry.",
                );
            }
          } else {
            const message =
              error instanceof Error ? error.message : String(error);
            if (automaticEvidence) {
              await unavailable(
                message,
                error instanceof PreviewRuntimeError &&
                  error.code === "stale_generation"
                  ? "superseded"
                  : "unavailable",
              );
            } else {
              useDesignReviewStore.getState().fail(message);
            }
          }
        }
      })();
      captureTaskRef.current = task;
      const release = () => {
        unsubscribeQa?.();
        options.signal?.removeEventListener("abort", cancel);
        if (
          options.automatic &&
          controller.signal.aborted &&
          captureAbortRef.current === controller
        ) {
          const store = useDesignReviewStore.getState();
          if (
            store.status === "capturing" &&
            (!store.automatic ||
              store.automatic.evidence.requestId === automaticRequestId)
          ) {
            useDesignReviewStore.setState({
              status: "idle",
              captureProgress: undefined,
            });
          }
        }
        if (captureTaskRef.current === task) captureTaskRef.current = null;
        if (captureAbortRef.current === controller)
          captureAbortRef.current = null;
      };
      void task.then(release, release);
      return task;
    },
    [
      bridgeInjection.supported,
      bridgeUnavailableReason,
      capturePreviewCollection,
      bootstrapIsolatedPreview,
      conversationId,
      canvasIdentity,
      designState?.appliedSystem,
      files,
      getPreviewIframe,
      onAutomaticDesignReview,
      reportAutomaticCaptureUnavailable,
      projectDesign,
      submitManualDesignReview,
    ],
  );

  const automaticCaptureLatest = useRef({
    capture: captureDesignReviewScreenshots,
    sourceReady: false,
    error: undefined as string | undefined,
    reportUnavailable: reportAutomaticCaptureUnavailable,
  });
  automaticCaptureLatest.current = {
    capture: captureDesignReviewScreenshots,
    sourceReady:
      !!previewGeneration &&
      !assetProjectionPendingRef.current &&
      assetProjectionStatus === "ready" &&
      (!previewEnabled || captureRuntimeSettled),
    error:
      assetProjectionStatus === "error"
        ? (assetProjectionError ?? "Preview asset projection failed.")
        : undefined,
    reportUnavailable: reportAutomaticCaptureUnavailable,
  };
  const automaticCapturePending =
    automaticStage === "capturing" || automaticStage === "verifying";

  useEffect(() => {
    if (
      !automaticCaptureRequestId ||
      automaticCaptureConversationId !== conversationId ||
      handledAutomaticCaptureRef.current === automaticCaptureRequestId ||
      !automaticCapturePending ||
      isGenerating ||
      !autoQaEnabled ||
      workspaceMode !== "design"
    ) {
      return;
    }
    const evidence = useDesignReviewStore.getState().automatic!.evidence;
    const controller = new AbortController();
    const clearWaitingProgress = () => {
      const store = useDesignReviewStore.getState();
      if (
        !captureTaskRef.current &&
        !store.automatic &&
        store.status === "capturing"
      ) {
        useDesignReviewStore.setState({
          status: "idle",
          captureProgress: undefined,
        });
      }
    };
    const unsubscribeQa = useSettingsStore.subscribe((state) => {
      if (!state.system.autoQaEnabled) {
        handledAutomaticCaptureRef.current = automaticCaptureRequestId;
        controller.abort();
        clearWaitingProgress();
      }
    });
    const isCurrent = () =>
      useSettingsStore.getState().system.autoQaEnabled &&
      useDesignReviewStore.getState().automatic?.captureRequestId ===
        automaticCaptureRequestId &&
      isConversationIdentityCurrent(
        canvasIdentity,
        useConversationStore.getState().conversations[conversationId],
      );
    void (async () => {
      // A manual capture owns its cleanup. Keep the automatic request pending
      // until that task releases the capture slot instead of consuming it.
      if (captureTaskRef.current)
        await captureTaskRef.current.catch(() => undefined);
      controller.signal.throwIfAborted();
      await waitForPreviewReadiness({
        isReady: () => {
          const current = automaticCaptureLatest.current;
          if (current.error) throw new Error(current.error);
          return (
            current.sourceReady &&
            !!previewGenerationRef.current &&
            !assetProjectionPendingRef.current
          );
        },
        isCurrent,
        signal: controller.signal,
        timeoutMs: 5_000,
        errorMessage:
          "The current preview source and assets did not become ready for Design Review.",
      });
      controller.signal.throwIfAborted();
      handledAutomaticCaptureRef.current = automaticCaptureRequestId;
      await automaticCaptureLatest.current.capture({
        automatic: true,
        signal: controller.signal,
      });
    })().catch((error: unknown) => {
      if (
        controller.signal.aborted ||
        !isCurrent() ||
        (error as { name?: string })?.name === "AbortError"
      )
        return;
      handledAutomaticCaptureRef.current = automaticCaptureRequestId;
      void automaticCaptureLatest.current.reportUnavailable(
        evidence,
        error instanceof Error ? error.message : String(error),
      );
    });
    return () => {
      unsubscribeQa();
      controller.abort(
        new DOMException(
          "Automatic review capture was replaced.",
          "AbortError",
        ),
      );
      clearWaitingProgress();
    };
  }, [
    automaticCaptureRequestId,
    automaticCaptureConversationId,
    automaticCapturePending,
    canvasIdentity,
    conversationId,
    isGenerating,
    workspaceMode,
    autoQaEnabled,
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

  const retryPreviewRender = useCallback(() => {
    setPreviewRenderRetry((attempt) => attempt + 1);
    onReloadPreview();
  }, [onReloadPreview]);

  const handleReloadPreview = useCallback(() => {
    flushPendingSandpackFileChanges(conversationId);
    retryPreviewRender();
  }, [conversationId, retryPreviewRender]);

  const navigatePrototype = useCallback(
    async (pageId: string) => {
      if (!prototypeWorkspaceEnabled || projectDesign.status !== "ready") {
        return;
      }
      const page = projectDesign.design.pages.find(
        (candidate) => candidate.id === pageId,
      );
      if (!page) return;
      const scope = desktopActionScopeRef.current;
      toast.dismiss(desktopActionToastId);
      explicitPrototypePageRef.current = pageId;
      prototypeNavigationAbortRef.current?.abort();
      prototypeNavigationAbortRef.current = null;
      setSelectedPrototypePageId(pageId);
      setProjectDesignWorkspaceSelection(conversationId, {
        pageId,
        explicit: true,
      });
      const resolution = resolveProjectDesignPreview(
        projectDesign.design,
        pageId,
      );
      if (resolution.status === "unavailable") {
        toast.warning(t.prototypeWorkspace.previewReasons[resolution.reason], {
          id: desktopActionToastId,
          duration: 8_000,
        });
        return;
      }
      const generation = previewGenerationRef.current;
      if (!generation) return;
      const target = resolution.target;
      const controller = new AbortController();
      prototypeNavigationAbortRef.current = controller;
      setSelectedPrototypePageId(pageId);
      try {
        await waitForDesignBridge(generation, controller.signal);
        await requestPreviewNavigation(target, generation, controller.signal);
        controller.signal.throwIfAborted();
      } catch (error) {
        if (
          desktopActionScopeRef.current === scope &&
          (error as { name?: string })?.name !== "AbortError"
        ) {
          toast.error(error instanceof Error ? error.message : String(error), {
            id: desktopActionToastId,
            duration: 8_000,
          });
        }
      } finally {
        if (prototypeNavigationAbortRef.current === controller) {
          prototypeNavigationAbortRef.current = null;
        }
      }
    },
    [
      conversationId,
      desktopActionToastId,
      projectDesign,
      prototypeWorkspaceEnabled,
      requestPreviewNavigation,
      setProjectDesignWorkspaceSelection,
      t.prototypeWorkspace.previewReasons,
      waitForDesignBridge,
    ],
  );

  const registerRuntimeSync = useCallback(
    (handle: SandpackRuntimeSyncHandle | null) => {
      runtimeSyncRef.current = handle;
    },
    [],
  );

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

  const canvasViewport = useMemo(
    () => DESIGN_REVIEW_VIEWPORTS.find((value) => value.name === deviceSize)!,
    [deviceSize],
  );
  const canvasScopeKey = JSON.stringify([
    canvasIdentity,
    sandpackKey,
    previewRenderRetry,
    canvasRuntimeEpoch,
    template,
    previewMode,
  ]);
  const canvasSourceInput = useMemo(
    () => ({
      files: previewFiles,
      assets: projectAssets,
      template,
      previewMode,
      design: projectDesign.status === "ready" ? projectDesign.design : null,
    }),
    [previewFiles, projectAssets, template, previewMode, projectDesign],
  );
  const [canvasSources, setCanvasSources] = useState<{
    input: typeof canvasSourceInput;
    sources: Record<string, string> | null;
  }>();
  const [settledCanvasSource, setSettledCanvasSource] = useState<{
    input: typeof canvasSourceInput;
    scopeKey: string;
  }>();
  useEffect(() => {
    if (!designCanvasEnabled) return;
    const timer = window.setTimeout(() => {
      setSettledCanvasSource({
        input: canvasSourceInput,
        scopeKey: canvasScopeKey,
      });
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [canvasSourceInput, canvasScopeKey, designCanvasEnabled]);
  useEffect(() => {
    if (!designCanvasEnabled) return;
    let cancelled = false;
    void computeCanvasPreviewSources(canvasSourceInput).then(
      (sources) => {
        if (!cancelled) setCanvasSources({ input: canvasSourceInput, sources });
      },
      () => {
        if (!cancelled)
          setCanvasSources({ input: canvasSourceInput, sources: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [canvasSourceInput, designCanvasEnabled]);
  const canvasTargets = useMemo(
    () =>
      projectDesign.status === "ready"
        ? projectDesign.design.pages.map((page) => ({
            page,
            resolution: resolveProjectDesignPreview(
              projectDesign.design,
              page.id,
            ),
          }))
        : [],
    [projectDesign],
  );
  const canvasRequests = useMemo<CanvasPreviewRequest[]>(() => {
    if (projectDesign.status === "invalid") return [];
    if (projectDesign.status === "missing")
      return [
        {
          key: JSON.stringify([
            canvasScopeKey,
            "current-preview",
            deviceSize,
            canvasSources?.sources?.["current-preview"] ?? previewGeneration,
          ]),
          generation: previewGeneration,
          pageId: "current-preview",
          viewport: canvasViewport,
        },
      ];
    return canvasTargets.flatMap(({ page, resolution }) =>
      resolution.status === "ready"
        ? [
            {
              key: JSON.stringify([
                canvasScopeKey,
                page.id,
                resolution.target.route,
                deviceSize,
                canvasSources?.sources?.[page.id] ?? previewGeneration,
              ]),
              generation: previewGeneration,
              pageId: page.id,
              target: resolution.target,
              viewport: canvasViewport,
            },
          ]
        : [],
    );
  }, [
    canvasScopeKey,
    canvasViewport,
    projectDesign.status,
    canvasTargets,
    canvasSources,
    deviceSize,
    previewGeneration,
  ]);
  const canvasRequestKeys = useRef(new Set<string>());
  canvasRequestKeys.current = new Set(
    canvasRequests.map((request) => request.key),
  );
  const captureCanvasPage = useCallback(
    async (request: CanvasPreviewRequest, signal: AbortSignal) => {
      const generation = previewGenerationRef.current;
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (
          !generation ||
          generation !== request.generation ||
          generation !== previewGenerationRef.current ||
          !canvasRequestKeys.current.has(request.key) ||
          !isConversationIdentityCurrent(
            canvasIdentity,
            useConversationStore.getState().conversations[conversationId],
          )
        )
          throw new DOMException("Canvas preview was replaced.", "AbortError");
      };
      assertCurrent();
      return withPreviewCaptureLock({
        conversationId,
        owner: "canvas",
        signal,
        run: async (_adapter, captureSignal) => {
          // Asset bytes can change without changing the text-only runtime
          // generation. Do not cache a new source key against the old frame.
          await waitForPreviewReadiness({
            isReady: () => {
              assertCurrent();
              return (
                !assetProjectionPendingRef.current &&
                runtimeSyncRef.current?.isSynchronized(
                  preparedProjectionRef.current,
                ) === true
              );
            },
            isCurrent: () =>
              previewGenerationRef.current === generation &&
              canvasRequestKeys.current.has(request.key),
            signal: captureSignal,
            timeoutMs: 5_000,
            errorMessage:
              "The preview has not synchronized its current source and assets.",
          });
          await prepareCurrentPreview(generation!, captureSignal);
          assertCurrent();
          if (!request.target) {
            const result = await captureCurrentPreview(
              generation!,
              captureSignal,
              "full-page",
            );
            assertCurrent();
            return result;
          }
          const source = getPreviewIframe();
          if (!source)
            throw new PreviewRuntimeError(
              "preview_unavailable",
              "The preview iframe is unavailable.",
            );
          const session = await createIsolatedPreviewSession(
            source,
            generation!,
            captureSignal,
            bootstrapIsolatedPreview,
          );
          try {
            await session.setViewport(request.viewport);
            await session.navigate(request.target);
            const result = await session.capture(
              request.viewport,
              request.target,
            );
            assertCurrent();
            return result;
          } finally {
            session.dispose();
          }
        },
      });
    },
    [
      canvasIdentity,
      bootstrapIsolatedPreview,
      conversationId,
      prepareCurrentPreview,
      captureCurrentPreview,
      getPreviewIframe,
    ],
  );
  const {
    previews: canvasPreviews,
    retry: retryCanvasPreview,
    onVisiblePages: prioritizeCanvasPages,
  } = useCanvasPreviews({
    scopeKey: canvasScopeKey,
    requests: designCanvasEnabled ? canvasRequests : EMPTY_CANVAS_REQUESTS,
    paused:
      !canvasMode ||
      !previewGeneration ||
      settledCanvasSource?.input !== canvasSourceInput ||
      settledCanvasSource?.scopeKey !== canvasScopeKey ||
      canvasSources?.input !== canvasSourceInput ||
      assetProjectionPendingRef.current ||
      !captureRuntimeSettled ||
      imageCaptureOpen ||
      designReviewOpen ||
      (!!automaticStage &&
        ["capturing", "reviewing", "fixing", "verifying"].includes(
          automaticStage,
        )) ||
      assetProjectionStatus !== "ready",
    capture: captureCanvasPage,
  });
  const canvasBoards = useMemo<DesignCanvasBoard[]>(() => {
    if (projectDesign.status === "missing")
      return [
        {
          id: "current-preview",
          name: t.designCanvas.currentPage,
          previewKey: canvasRequests[0]?.key,
          ...(!bridgeInjection.supported
            ? { issue: bridgeUnavailableReason }
            : {}),
        },
      ];
    return canvasTargets.map(({ page, resolution }) => ({
      id: page.id,
      name: page.name,
      responsibility: page.responsibility,
      previewKey: canvasRequests.find((request) => request.pageId === page.id)
        ?.key,
      issue:
        resolution.status === "unavailable"
          ? t.prototypeWorkspace.previewReasons[resolution.reason]
          : !bridgeInjection.supported
            ? bridgeUnavailableReason
            : undefined,
    }));
  }, [
    projectDesign.status,
    canvasTargets,
    canvasRequests,
    t,
    bridgeInjection.supported,
    bridgeUnavailableReason,
  ]);
  const selectCanvasBoard = (pageId: string) => {
    if (
      projectDesign.status !== "ready" ||
      !projectDesign.design.pages.some((page) => page.id === pageId)
    )
      return;
    explicitPrototypePageRef.current = pageId;
    setSelectedPrototypePageId(pageId);
    setProjectDesignWorkspaceSelection(conversationId, {
      pageId,
      explicit: true,
    });
  };
  const playCanvasBoard = (pageId: string) => {
    const board = canvasBoards.find((value) => value.id === pageId);
    if (!board || board.issue) return;
    selectCanvasBoard(pageId);
    setDesignFocus(true);
    setViewMode("preview");
    if (pageId !== "current-preview") void navigatePrototype(pageId);
  };
  const focusCanvasPage = (pageId: string) =>
    setCanvasFocusRequest((current) => ({
      pageId,
      requestId: (current?.requestId ?? 0) + 1,
    }));
  const selectPageSource = (pageId: string | undefined) => {
    if (projectDesign.status !== "ready" || !pageId) {
      setPageSourceMissing(false);
      return;
    }
    const page = projectDesign.design.pages.find(
      (candidate) => candidate.id === pageId,
    );
    const source = page
      ? resolvePageSource(page.filePaths, files, previewFiles, currentFile)
      : undefined;
    setPageSourceMissing(!source);
    if (source) onFileSelect(source);
  };
  const changeWorkspaceView = (mode: ViewMode) => {
    if (mode === "code") selectPageSource(selectedPrototypePageId);
    else if (designCanvasEnabled) {
      deactivateDesignSelection();
      setDesignFocus(false);
      if (selectedPrototypePageId) focusCanvasPage(selectedPrototypePageId);
    }
    setViewMode(mode);
  };
  const activeCanvasPageId =
    projectDesign.status === "missing"
      ? "current-preview"
      : selectedPrototypePageId;

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
      onFileChange(conversationId, p, getNewFileInitialContent(p));
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
        interactionLocked={imageCaptureOpen}
        viewMode={
          assetProjectionStatus === "error" ? "code" : effectiveViewMode
        }
        onViewModeChange={changeWorkspaceView}
        deviceSize={deviceSize}
        onDeviceSizeChange={handleDeviceSizeChange}
        files={files}
        assets={projectAssets}
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
        onAnnotate={(scope) => {
          deactivateDesignSelection();
          toast.dismiss(desktopActionToastId);
          setAnnotationScope(scope);
        }}
        annotationUnavailableReason={
          !bridgeInjection.supported
            ? t.annotation.unavailable
            : !annotationIntake.available
              ? t.chat.attachmentErrors.unavailable
              : annotationIntake.busy
                ? t.chat.attachmentErrors.busy
                : undefined
        }
        onScreenshot={(mode) => {
          deactivateDesignSelection();
          toast.dismiss(desktopActionToastId);
          setScreenshotMode(mode);
        }}
        screenshotUnavailableReason={
          !bridgeInjection.supported ||
          !previewGeneration ||
          !captureRuntimeSettled
            ? t.screenshot.unavailable
            : undefined
        }
        designSelectionSupported={bridgeInjection.supported}
        designSelectionActive={designSelectionActive}
        onToggleDesignSelection={() =>
          designSelectionActive
            ? deactivateDesignSelection()
            : activateDesignSelection()
        }
        designSelectionUnavailableReason={bridgeUnavailableReason}
        designWorkspace={
          designCanvasEnabled
            ? {
                focused: designFocus,
                actions: (
                  <DesignCanvasActions
                    device={deviceSize}
                    onDevice={handleDeviceSizeChange}
                    onSystems={
                      onApplyDesignSystem
                        ? () => setDesignSystemsOpen(true)
                        : undefined
                    }
                    onTokens={() => setDesignTokensOpen(true)}
                    onReview={onDesignReview ? openDesignReview : undefined}
                    onExport={
                      desktopMode
                        ? () => void handleExportDirectory()
                        : undefined
                    }
                    busy={isGenerating}
                  />
                ),
              }
            : undefined
        }
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

      <div className="relative flex min-h-0 flex-1 overflow-hidden bg-muted/50">
        <div
          inert={imageCaptureOpen}
          className="relative min-w-0 flex-1 overflow-hidden"
        >
          {workspaceMode === "design" &&
            automaticStage &&
            automaticCaptureConversationId === conversationId && (
              <AutomaticDesignReviewNotice
                key={JSON.stringify([
                  canvasIdentity,
                  automaticCaptureRequestId,
                  automaticStage,
                ])}
                stage={automaticStage}
                visible={!designReviewOpen}
                onOpen={openDesignReview}
              />
            )}
          {designCanvasEnabled && (
            <div
              className={cn(
                "absolute inset-0",
                canvasMode && assetProjectionStatus !== "error"
                  ? "z-10"
                  : "hidden",
              )}
              inert={imageCaptureOpen}
            >
              <DesignCanvasWorkspace
                key={workspaceKey}
                identity={canvasIdentity}
                parentBranchId={parentBranchId}
                boards={canvasBoards}
                viewport={canvasViewport}
                previews={canvasPreviews}
                selectedPageId={activeCanvasPageId}
                focusRequest={canvasFocusRequest}
                active={canvasMode && assetProjectionStatus !== "error"}
                onSelect={selectCanvasBoard}
                onPlay={playCanvasBoard}
                onRetry={retryCanvasPreview}
                onVisiblePages={prioritizeCanvasPages}
                emptyMessage={
                  projectDesign.status === "invalid"
                    ? t.prototypeWorkspace.invalidTitle
                    : undefined
                }
              />
            </div>
          )}
          {assetProjectionStatus === "loading" || preparingInitialCapture ? (
            <div
              className="flex h-full items-center justify-center bg-background p-6 text-sm text-muted-foreground"
              role="status"
            >
              {t.previewRecovery.preparingAssets}
            </div>
          ) : (
            <PreviewErrorBoundary
              resetKey={previewBoundaryResetKey}
              fallback={(props) => (
                <div className={cn("h-full", canvasMode && "relative z-20")}>
                  <PreviewErrorFallback
                    {...props}
                    conversationId={conversationId}
                    files={previewFiles}
                    canonicalFiles={files}
                    currentFile={effectiveCurrentFile}
                    onFileSelect={onFileSelect}
                    onFileChange={onFileChange}
                    onRetry={retryPreviewRender}
                    onDeleteFile={(path) => {
                      invalidateAutomaticReview();
                      onDeleteFile(path);
                    }}
                  />
                </div>
              )}
            >
              <SandpackProvider
                key={`${sandpackKey}:${previewRenderRetry}:${reactPreviewProjection.sourceEntry ?? "node"}`}
                template={
                  (previewEnabled
                    ? template
                    : "static") as SandpackPredefinedTemplate
                }
                customSetup={
                  reactPreviewProjection.customSetup ??
                  (desktopMode && previewEnabled && template === "static"
                    ? DESKTOP_STATIC_PREVIEW_SETUP
                    : undefined)
                }
                theme={isDark ? "dark" : "light"}
                files={sandpackFiles}
                options={{ activeFile: sandpackCurrentFile }}
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <SandpackRefreshRegistration onChange={registerSoftRefresh} />
                {previewEnabled ? (
                  <PreviewCompilationStatus
                    identity={`${conversationId}:${sandpackKey}:${previewRenderRetry}:${previewGeneration ?? "pending"}`}
                    files={sandpackSourceFiles}
                    hidden={canvasMode}
                    onRuntimeChange={registerRuntimeSync}
                    onRetry={handleReloadPreview}
                  />
                ) : (
                  <CodeOnlyPreviewNotice reason={codeOnlyReason} />
                )}
                <SandpackListener
                  conversationId={conversationId}
                  requestedActiveFile={sandpackCurrentFile}
                  onFileChange={handleSandpackFileChange}
                />
                <SandpackLayout style={{ flex: 1, minHeight: 0 }}>
                  {/* Preview */}
                  {previewEnabled && assetProjectionStatus === "ready" && (
                    <div
                      ref={previewHostRef}
                      aria-hidden={canvasMode || undefined}
                      inert={canvasMode}
                      style={
                        canvasMode
                          ? {
                              width: canvasViewport.width + 32,
                              height: canvasViewport.height + 32,
                            }
                          : undefined
                      }
                      className={cn(
                        "h-full w-full",
                        canvasMode
                          ? "design-canvas-runtime"
                          : effectiveViewMode === "preview"
                            ? "block"
                            : "hidden",
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
                              "overflow-hidden rounded-lg bg-background shadow-lg",
                            captureViewport &&
                              "absolute left-0 top-0 rounded-none shadow-none transition-none",
                          )}
                          style={previewSurfaceStyle}
                        >
                          <div
                            className={cn(
                              "relative transition-[width,height,transform,opacity] duration-300 ease-in-out",
                              showConsole && !canvasMode
                                ? "row-span-2"
                                : "row-span-3",
                            )}
                          >
                            <SandpackPreview
                              className={cn(
                                "preview-content-zoom",
                                previewScale !== 1 && "preview-content-scaled",
                              )}
                              style={previewContentStyle}
                              showNavigator={!captureViewport && !canvasMode}
                              showOpenInCodeSandbox={false}
                              showRefreshButton={false}
                              showRestartButton={false}
                            />
                            <div className="preview-viewport-actions absolute bottom-2 right-2 z-20 flex gap-2">
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
                                onReload={handleReloadPreview}
                              />
                            </div>
                          </div>
                          <div
                            className={cn(
                              "overflow-hidden border-t",
                              showConsole && !canvasMode
                                ? "row-span-1"
                                : "max-h-0 border-t-0",
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
                      assetProjectionStatus === "error" ||
                        effectiveViewMode === "code"
                        ? "flex"
                        : "hidden",
                    )}
                  >
                    <div className="w-56 border-r h-full shrink-0 overflow-hidden flex flex-col">
                      <ProjectAssetList
                        assets={projectAssets}
                        onRemove={(path) => {
                          invalidateAutomaticReview();
                          useConversationStore
                            .getState()
                            .setAssetsForConversation(
                              conversationId,
                              (assets) =>
                                Object.fromEntries(
                                  Object.entries(assets).filter(
                                    ([assetPath]) => assetPath !== path,
                                  ),
                                ),
                            );
                        }}
                      />
                      <FileExplorer
                        files={previewFiles}
                        currentFile={currentFile}
                        onFileSelect={(path) => {
                          setPageSourceMissing(false);
                          onFileSelect(path);
                        }}
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
                      {assetProjectionStatus === "error" && (
                        <div
                          className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-3"
                          role="alert"
                          aria-live="assertive"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-foreground">
                              {t.previewRecovery.unavailableTitle}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {t.previewRecovery.assetDescription}
                            </p>
                            {assetProjectionError && (
                              <p className="mt-1 break-words font-mono text-xs text-destructive">
                                {assetProjectionError.slice(0, 300)}
                              </p>
                            )}
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setAssetProjectionRetry((attempt) => attempt + 1)
                            }
                          >
                            {t.previewRecovery.retry}
                          </Button>
                        </div>
                      )}
                      {pageSourceMissing ? (
                        <div
                          role="status"
                          className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground"
                        >
                          {t.prototypeWorkspace.noSource}
                        </div>
                      ) : (
                        <SandpackCodeEditor
                          showTabs={false}
                          showLineNumbers
                          showInlineErrors
                          wrapContent={false}
                          closableTabs={false}
                        />
                      )}
                    </div>
                  </div>
                </SandpackLayout>
              </SandpackProvider>
            </PreviewErrorBoundary>
          )}
        </div>
        {annotationScope && (
          <PreviewAnnotation
            conversationId={conversationId}
            scope={annotationScope}
            onClose={closeAnnotation}
          />
        )}
        {screenshotMode && (
          <PreviewScreenshot
            conversationId={conversationId}
            mode={screenshotMode}
            onClose={closeScreenshot}
          />
        )}
      </div>
    </div>
  );
}
