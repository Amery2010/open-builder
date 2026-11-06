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
import { projectStaticPreview } from "./code-viewer/sandpack-static-preview";
import { projectSandpackRuntime } from "./code-viewer/sandpack-runtime-preview";
import {
  SandpackRuntimeSync,
  type SandpackRuntimeSyncHandle,
} from "./code-viewer/SandpackRuntimeSync";
import type { ProjectFileChangeGuard } from "./code-viewer/sandpack-file-changes";
import { ViewToolbar } from "./code-viewer/ViewToolbar";
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
import { ProjectDesignOutlineDialog } from "./design/ProjectDesignOutlineDialog";
import { useDesignSelectionStore } from "../store/design-selection";
import {
  createDesignBridgeNonce,
  designBridgeRuntimeRevision,
  DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS,
  DESIGN_BRIDGE_TIMEOUT_ATTEMPTS,
  DESIGN_BRIDGE_MARKER,
  DESIGN_BRIDGE_PAYLOAD_MAX_BYTES,
  DESIGN_BRIDGE_PROTOCOL_VERSION,
  DESIGN_BRIDGE_VIRTUAL_PATH,
  DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH,
  getDesignBridgeTargetOrigin,
  injectDesignBridge,
  isDesignBridgeOriginAllowed,
  parseDesignBridgeCaptureResponse,
  parseDesignBridgeNavigationResponse,
  parseDesignBridgeRouteMessage,
  sanitizeDesignSelectionPayload,
  stripDesignBridge,
  type DesignBridgeCaptureExpectation,
  type DesignBridgeCaptureResult,
  type DesignBridgeNavigationExpectation,
  type DesignBridgeParentMessage,
} from "../lib/design/preview-bridge";
import {
  collectDesignReviewCaptures,
  DESIGN_REVIEW_VIEWPORTS,
  isDesignReviewViewportReady,
  loadDesignCaptureRuntimeSource,
  waitForPreviewReadiness,
  type DesignReviewViewport,
} from "../lib/design/preview-capture";
import {
  computePreviewGeneration,
  registerPreviewRuntime,
  PreviewRuntimeError,
  withPreviewCaptureLock,
  type PreviewCaptureCollection,
  type PreviewRuntimeAdapter,
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
import {
  isDesignReviewTerminalStatus,
  type DesignReviewRun,
} from "../lib/design/review-jobs/types";
import { DEFAULT_TITLE } from "../store/conversation";
import {
  applyProjectDesignUpdate,
  deriveImpactPages,
  PROJECT_DESIGN_PATH,
  readProjectDesign,
  resolveProjectDesignPreviewTarget,
  resolveProjectDesignPreviewRoute,
  type ProjectDesign,
} from "../lib/design/project-design";
import { isPrototypeProject } from "../lib/design/prototype-starter";
import { buildPrototypeReviewCapturePlan } from "../lib/design/prototype-review-plan";
import { createIsolatedPreviewSession } from "../lib/design/prototype-preview-session";
import {
  ProjectDesignNavigator,
  type ProjectDesignReviewStatus,
} from "./design/ProjectDesignNavigator";
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
  resolve: (result: DesignBridgeCaptureResult) => void;
  reject: (error: Error) => void;
  timeout: number;
  removeAbortListener: () => void;
}

interface PendingDesignNavigation {
  expectation: DesignBridgeNavigationExpectation;
  resolve: (target: PrototypePreviewTarget) => void;
  reject: (error: Error) => void;
  timeout: number;
  removeAbortListener: () => void;
}

const EMPTY_DESIGN_REVIEW_RUNS: readonly DesignReviewRun[] = [];
const EMPTY_PROJECT_ASSETS: ProjectAssets = {};
// The iframe bundler avoids the static service-worker relay's stale responses
// in desktop webviews. Keep this setup stable across file updates.
const DESKTOP_STATIC_PREVIEW_SETUP = { environment: "parcel" } as const;

function pageReviewStatus(
  pageId: string,
  runs: readonly DesignReviewRun[],
  blueprintRevision: string | number,
): ProjectDesignReviewStatus {
  const latest = runs.find((run) =>
    run.coverage?.some((entry) => entry.pageId === pageId),
  );
  if (!latest) return "unreviewed";
  if (
    latest.blueprintRevision !== undefined &&
    !Object.is(latest.blueprintRevision, blueprintRevision)
  ) {
    return "stale";
  }
  if (latest.freshness === "stale") return "stale";
  if (!isDesignReviewTerminalStatus(latest.status)) return "in-review";
  const pageCoverage = latest.coverage?.filter(
    (entry) => entry.pageId === pageId,
  );
  if (!pageCoverage?.length) return "unreviewed";
  if (pageCoverage.some((entry) => entry.status === "needs-fix")) {
    return "changes-requested";
  }
  if (pageCoverage.every((entry) => entry.status === "passed")) {
    return "approved";
  }
  return "unreviewed";
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
  const [projectDesignOutlineOpen, setProjectDesignOutlineOpen] =
    useState(false);
  const [selectedPrototypePageId, setSelectedPrototypePageId] = useState<
    string | undefined
  >();
  const [selectedPrototypeScenarioId, setSelectedPrototypeScenarioId] =
    useState<string | undefined>();
  const [prototypeResetPending, setPrototypeResetPending] = useState(false);
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
  const designReviewRuns = useDesignReviewStore(
    (state) =>
      state.runsByConversation?.[conversationId] ?? EMPTY_DESIGN_REVIEW_RUNS,
  );
  const dialogRequestId = useDesignReviewStore(
    (state) => state.dialogRequestId,
  );
  const handledAutomaticCaptureRef = useRef<number | undefined>(undefined);
  const handledDialogRequestRef = useRef(0);
  const projectDesign = useMemo(() => readProjectDesign(files), [files]);
  const prototypeProject = isPrototypeProject(files);
  const prototypeWorkspaceEnabled =
    workspaceMode === "design" && prototypeProject;
  useEffect(() => {
    if (!prototypeWorkspaceEnabled || projectDesign.status !== "ready") {
      setSelectedPrototypePageId(undefined);
      setSelectedPrototypeScenarioId(undefined);
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
    const availableScenarios = new Set([
      page.defaultScenario,
      ...page.scenarioIds,
    ]);
    if (
      !selectedPrototypeScenarioId ||
      !availableScenarios.has(selectedPrototypeScenarioId)
    ) {
      setSelectedPrototypeScenarioId(page.defaultScenario);
    }
  }, [
    projectDesign,
    prototypeWorkspaceEnabled,
    selectedPrototypePageId,
    selectedPrototypeScenarioId,
  ]);
  useEffect(() => {
    if (
      !prototypeWorkspaceEnabled ||
      projectDesign.status !== "ready" ||
      !selectedPrototypePageId ||
      !selectedPrototypeScenarioId
    ) {
      clearProjectDesignWorkspaceSelection(conversationId);
      return;
    }
    const target = resolveProjectDesignPreviewTarget(
      projectDesign.design,
      selectedPrototypePageId,
      selectedPrototypeScenarioId,
    );
    if (!target) {
      clearProjectDesignWorkspaceSelection(conversationId);
      return;
    }
    setProjectDesignWorkspaceSelection(conversationId, {
      pageId: target.pageId,
      scenarioId: target.scenarioId,
    });
  }, [
    clearProjectDesignWorkspaceSelection,
    conversationId,
    projectDesign,
    prototypeWorkspaceEnabled,
    selectedPrototypePageId,
    selectedPrototypeScenarioId,
    setProjectDesignWorkspaceSelection,
  ]);
  const projectDesignNavigatorModel = useMemo(() => {
    if (projectDesign.status !== "ready") {
      return {
        blueprint: {
          status: projectDesign.status,
          ...(projectDesign.status === "invalid"
            ? { message: projectDesign.error }
            : {}),
        },
        pages: [],
      } as const;
    }
    const design = projectDesign.design;
    const scenarios = new Map(
      design.scenarios.map((scenario) => [scenario.id, scenario]),
    );
    const completedPages = new Set(design.buildProgress.completedPageIds);
    const selectedPage = design.pages.find(
      (page) => page.id === selectedPrototypePageId,
    );
    const affectedPages = selectedPage
      ? deriveImpactPages(design, [
          ...(selectedPage.layoutId ? [selectedPage.layoutId] : []),
          ...selectedPage.sharedUiRefs,
        ])
      : [];
    return {
      blueprint: { status: "ready" as const },
      selectedPageId: selectedPrototypePageId,
      selectedSceneId: selectedPrototypeScenarioId,
      pages: design.pages.map((page) => ({
        id: page.id,
        parentId: page.parentId ?? undefined,
        name: page.name,
        responsibility: page.responsibility,
        buildProgress: completedPages.has(page.id) ? 100 : 0,
        buildStatus: completedPages.has(page.id)
          ? ("complete" as const)
          : design.buildProgress.status === "blocked"
            ? ("blocked" as const)
            : ("not-started" as const),
        reviewStatus: pageReviewStatus(
          page.id,
          designReviewRuns,
          design.revision,
        ),
        scenes: [...new Set([page.defaultScenario, ...page.scenarioIds])]
          .map((scenarioId) => scenarios.get(scenarioId))
          .filter((scenario) => scenario !== undefined)
          .map((scenario) => ({
            id: scenario.id,
            name: scenario.name,
            description: scenario.kind,
          })),
      })),
      ...(affectedPages.length > 1
        ? {
            sharedLayoutImpact: {
              description: t.prototypeWorkspace.sharedImpactDescription.replace(
                "{count}",
                String(affectedPages.length),
              ),
              affectedPages: affectedPages.length,
            },
          }
        : {}),
    };
  }, [
    designReviewRuns,
    projectDesign,
    selectedPrototypePageId,
    selectedPrototypeScenarioId,
    t.prototypeWorkspace.sharedImpactDescription,
  ]);

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
    if (workspaceMode !== "design" || !previewEnabled) return;
    let cancelled = false;
    void loadDesignCaptureRuntimeSource().then(
      (source) => {
        if (!cancelled) setCaptureRuntimeSource(source);
      },
      () => {
        // The Review UI reports runtime loading failures when capture starts.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [previewEnabled, workspaceMode]);
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
      workspaceMode === "design"
        ? injectDesignBridge(
            staticPreviewProjection.files,
            template,
            previewEnabled,
            captureRuntimeSource ?? undefined,
            previewGeneration ?? "pending",
          )
        : { supported: false as const, files: staticPreviewProjection.files },
    [
      captureRuntimeSource,
      previewEnabled,
      staticPreviewProjection.files,
      previewGeneration,
      template,
      workspaceMode,
    ],
  );
  const sandpackSourceFiles =
    workspaceMode === "design" && bridgeInjection.supported
      ? bridgeInjection.files
      : staticPreviewProjection.files;
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
      let editableContent = content;
      if (bridgeInjection.supported && path === bridgeInjection.indexPath) {
        if (content === bridgeInjection.files[path]) return;
        const startMarker = `<!-- ${DESIGN_BRIDGE_MARKER}:start -->`;
        const endMarker = `<!-- ${DESIGN_BRIDGE_MARKER}:end -->`;
        const start = content.indexOf(startMarker);
        const end = content.indexOf(endMarker);
        if (start >= 0 || end >= 0) {
          if (start < 0 || end < start) return;
          const afterMarker = end + endMarker.length;
          // Remove the injected block and its own trailing newline only.
          // The canonical HTML's surrounding whitespace belongs to the editor.
          const afterBlock =
            afterMarker + (content[afterMarker] === "\n" ? 1 : 0);
          editableContent = content.slice(0, start) + content.slice(afterBlock);
        }
      }
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

  const postPrototypeDataReset = useCallback(
    (generation: string) => {
      const iframe = getPreviewIframe();
      if (!iframe?.contentWindow) return false;
      const targetOrigin = getDesignBridgeTargetOrigin(
        iframe.src,
        window.location.href,
      );
      if (!targetOrigin) return false;
      iframe.contentWindow.postMessage(
        {
          type: "open-builder:design-bridge-reset-data",
          version: DESIGN_BRIDGE_PROTOCOL_VERSION,
          generation,
          nonce: createDesignBridgeNonce(),
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
      target?: PrototypePreviewTarget,
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
        ...(target ? { target } : {}),
      };
      return new Promise<DesignBridgeCaptureResult>((resolve, reject) => {
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
      });
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
          if (target) {
            setSelectedPrototypePageId(target.pageId);
            setSelectedPrototypeScenarioId(target.scenarioId);
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
          prototypeWorkspaceEnabled &&
          projectDesign.status === "ready"
        ) {
          const observed = resolveProjectDesignPreviewRoute(
            projectDesign.design,
            message.route,
          );
          const target =
            observed ??
            resolveProjectDesignPreviewRoute(
              projectDesign.design,
              projectDesign.design.pages[0]?.route ?? "",
            );
          if (target) {
            setSelectedPrototypePageId(target.pageId);
            setSelectedPrototypeScenarioId(target.scenarioId);
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

  const saveProjectDesignOutline = useCallback(
    async (nextDesign: ProjectDesign) => {
      if (projectDesign.status !== "ready") {
        throw new Error("The project design is not available.");
      }
      const result = applyProjectDesignUpdate(
        files,
        nextDesign,
        projectDesign.design.revision,
      );
      if (!result.ok) throw new Error(result.error);
      invalidateAutomaticReview();
      onFileChange(
        conversationId,
        PROJECT_DESIGN_PATH,
        result.files[PROJECT_DESIGN_PATH],
      );
    },
    [
      conversationId,
      files,
      invalidateAutomaticReview,
      onFileChange,
      projectDesign,
    ],
  );

  const handleExportDirectory = useCallback(async () => {
    if (isGenerating) return;
    setDesktopActionMessage(null);
    try {
      const result = await exportProjectToUniqueDirectory(
        files,
        conversationTitle === DEFAULT_TITLE
          ? "open-builder-project"
          : conversationTitle,
        projectAssets,
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
  }, [conversationTitle, files, isGenerating, projectAssets, t.toolbar]);

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
        await waitForPreviewReadiness({
          isReady: () => {
            const projection = preparedProjectionRef.current;
            return (
              !assetProjectionPendingRef.current &&
              projection[DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH] ===
                runtimeSource &&
              projection[DESIGN_BRIDGE_VIRTUAL_PATH]?.includes(
                designBridgeRuntimeRevision(generation, true),
              ) === true &&
              runtimeSyncRef.current?.isSynchronized(projection) === true
            );
          },
          isCurrent: () => previewGenerationRef.current === generation,
          signal,
          timeoutMs: 5_000,
          errorMessage:
            "Screenshot runtime has not reached the current preview client.",
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
    [conversationId, getPreviewIframe],
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
            requestPreviewCapture(viewport, generation, signal, target),
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

  const previewRuntimeRef = useRef<{
    conversationId: string;
    adapter: PreviewRuntimeAdapter;
  } | null>(null);
  previewRuntimeRef.current = {
    conversationId,
    adapter: {
      getGeneration: () => previewGenerationRef.current,
      prepare: preparePreviewRuntime,
      navigateToTarget: async (target, generation, signal) => {
        await waitForDesignBridge(generation, signal);
        await requestPreviewNavigation(target, generation, signal);
        signal.throwIfAborted();
        softRefreshRef.current?.();
        await afterPreviewPaint();
        await waitForDesignBridge(generation, signal);
        return requestPreviewNavigation(target, generation, signal);
      },
      capture: (viewports, generation, signal, target) =>
        capturePreviewCollection(viewports, generation, signal, target),
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
      navigateToTarget: (target, generation, signal) =>
        currentAdapter().navigateToTarget!(target, generation, signal),
      capture: (viewports, generation, signal, target) =>
        currentAdapter().capture(viewports, generation, signal, target),
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
        const prototypePlan =
          prototypeWorkspaceEnabled && projectDesign.status === "ready"
            ? buildPrototypeReviewCapturePlan(
                projectDesign.design,
                automaticEvidence?.affectedPageIds,
              )
            : null;
        reviewStore.beginCapture(
          prototypePlan?.length ?? DESIGN_REVIEW_VIEWPORTS.length,
        );
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
          if (automaticEvidence?.sourceDigest) {
            const currentDigest = await computeDesignReviewSourceDigest({
              files,
              designSystem: designState?.appliedSystem ?? null,
              designContract: automaticEvidence.contract,
            });
            if (currentDigest !== automaticEvidence.sourceDigest) {
              throw new Error(
                "The project changed before automatic Design Review capture started.",
              );
            }
          }
          const generation = previewGenerationRef.current;
          if (!generation) {
            throw new Error("The current preview generation is not ready.");
          }
          const collection = await withPreviewCaptureLock({
            conversationId,
            owner: options.automatic ? "automatic-review" : "manual-review",
            signal: controller.signal,
            run: async (adapter, signal) => {
              if (prototypePlan) {
                await adapter.prepare(generation, signal);
                const sourceFrame = getPreviewIframe();
                if (!sourceFrame) {
                  throw new Error("Preview iframe is not available.");
                }
                let isolated = await createIsolatedPreviewSession(
                  sourceFrame,
                  generation,
                  signal,
                );
                let activeScenarioId: string | undefined;
                const captures: DesignBridgeCaptureResult[] = [];
                const errors: string[] = [];
                try {
                  for (const [index, item] of prototypePlan.entries()) {
                    try {
                      if (
                        activeScenarioId !== undefined &&
                        activeScenarioId !== item.target.scenarioId
                      ) {
                        isolated.dispose();
                        isolated = await createIsolatedPreviewSession(
                          sourceFrame,
                          generation,
                          signal,
                        );
                      }
                      activeScenarioId = item.target.scenarioId;
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
                        `${item.target.pageId}/${item.target.scenarioId}/${item.viewport.name}: ${
                          error instanceof Error ? error.message : String(error)
                        }`,
                      );
                    }
                    useDesignReviewStore.getState().updateCaptureProgress({
                      completed: index + 1,
                      total: prototypePlan.length,
                      viewport: `${item.target.pageId}/${item.target.scenarioId}/${item.viewport.name}`,
                    });
                  }
                } finally {
                  isolated.dispose();
                }
                if (adapter.getGeneration() !== generation) {
                  throw new Error(
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
          if (
            collection.generation !== generation ||
            previewGenerationRef.current !== generation
          ) {
            throw new Error(
              "The project changed before prototype review evidence completed.",
            );
          }
          const screenshots: DesignReviewScreenshot[] = collection.captures.map(
            (capture) => ({
              dataUrl: capture.dataUrl,
              mimeType: capture.mimeType,
              name: capture.semanticSnapshot.prototypeIdentity
                ? `preview-${capture.semanticSnapshot.prototypeIdentity.pageId}-${capture.semanticSnapshot.prototypeIdentity.scenarioId}-${capture.viewport.name}.${capture.mimeType.slice(6)}`
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
      designState?.appliedSystem,
      files,
      getPreviewIframe,
      onAutomaticDesignReview,
      onAutomaticDesignReviewUnavailable,
      projectDesign,
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

  const retryPreviewRender = useCallback(() => {
    setPreviewRenderRetry((attempt) => attempt + 1);
    onReloadPreview();
  }, [onReloadPreview]);

  const handleReloadPreview = useCallback(() => {
    flushPendingSandpackFileChanges(conversationId);
    retryPreviewRender();
  }, [conversationId, retryPreviewRender]);

  const navigatePrototype = useCallback(
    async (pageId: string, scenarioId?: string) => {
      if (!prototypeWorkspaceEnabled || projectDesign.status !== "ready") {
        return;
      }
      const page = projectDesign.design.pages.find(
        (candidate) => candidate.id === pageId,
      );
      if (!page) return;
      const nextScenarioId = scenarioId ?? page.defaultScenario;
      if (
        !new Set([page.defaultScenario, ...page.scenarioIds]).has(
          nextScenarioId,
        )
      ) {
        return;
      }
      const generation = previewGenerationRef.current;
      if (!generation) return;
      const target: PrototypePreviewTarget = {
        pageId,
        route: `#${page.route}?scenario=${nextScenarioId}`,
        scenarioId: nextScenarioId,
      };
      const resetForScenarioChange =
        selectedPrototypeScenarioId !== nextScenarioId;
      prototypeNavigationAbortRef.current?.abort();
      const controller = new AbortController();
      prototypeNavigationAbortRef.current = controller;
      setSelectedPrototypePageId(pageId);
      setSelectedPrototypeScenarioId(nextScenarioId);
      try {
        await waitForDesignBridge(generation, controller.signal);
        await requestPreviewNavigation(target, generation, controller.signal);
        controller.signal.throwIfAborted();
        if (resetForScenarioChange && !postPrototypeDataReset(generation)) {
          softRefreshRef.current?.();
        }
        if (resetForScenarioChange) await afterPreviewPaint();
      } catch (error) {
        if ((error as { name?: string })?.name !== "AbortError") {
          setDesktopActionMessage(
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        if (prototypeNavigationAbortRef.current === controller) {
          prototypeNavigationAbortRef.current = null;
        }
      }
    },
    [
      projectDesign,
      postPrototypeDataReset,
      prototypeWorkspaceEnabled,
      requestPreviewNavigation,
      selectedPrototypeScenarioId,
      waitForDesignBridge,
    ],
  );

  const resetPrototypeData = useCallback(async () => {
    setPrototypeResetPending(true);
    try {
      flushPendingSandpackFileChanges(conversationId);
      const generation = previewGenerationRef.current;
      if (!generation || !postPrototypeDataReset(generation)) {
        softRefreshRef.current?.();
      }
      await afterPreviewPaint();
    } finally {
      setPrototypeResetPending(false);
    }
  }, [conversationId, postPrototypeDataReset]);

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

  const prototypeToolbarNavigation = useMemo(() => {
    if (!prototypeWorkspaceEnabled || projectDesign.status !== "ready") {
      return undefined;
    }
    const selectedPage = projectDesign.design.pages.find(
      (page) => page.id === selectedPrototypePageId,
    );
    const scenarios = new Map(
      projectDesign.design.scenarios.map((scenario) => [scenario.id, scenario]),
    );
    return {
      pages: projectDesign.design.pages.map((page) => ({
        id: page.id,
        name: page.name,
      })),
      scenarios: selectedPage
        ? [
            ...new Set([
              selectedPage.defaultScenario,
              ...selectedPage.scenarioIds,
            ]),
          ]
            .map((id) => scenarios.get(id))
            .filter((scenario) => scenario !== undefined)
            .map((scenario) => ({ id: scenario.id, name: scenario.name }))
        : [],
      selectedPageId: selectedPrototypePageId,
      selectedScenarioId: selectedPrototypeScenarioId,
      onPageSelect: (pageId: string) => void navigatePrototype(pageId),
      onScenarioSelect: (scenarioId: string) => {
        if (selectedPrototypePageId) {
          void navigatePrototype(selectedPrototypePageId, scenarioId);
        }
      },
    };
  }, [
    navigatePrototype,
    projectDesign,
    selectedPrototypePageId,
    selectedPrototypeScenarioId,
  ]);

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
        viewMode={
          assetProjectionStatus === "error" ? "code" : effectiveViewMode
        }
        onViewModeChange={setViewMode}
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
        designSelectionSupported={bridgeInjection.supported}
        designSelectionActive={designSelectionActive}
        onToggleDesignSelection={() =>
          designSelectionActive
            ? deactivateDesignSelection()
            : activateDesignSelection()
        }
        designSelectionUnavailableReason={bridgeUnavailableReason}
        prototypeNavigation={prototypeToolbarNavigation}
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
      {prototypeWorkspaceEnabled && projectDesign.status === "ready" && (
        <ProjectDesignOutlineDialog
          open={projectDesignOutlineOpen}
          design={projectDesign.design}
          onOpenChange={setProjectDesignOutlineOpen}
          onSave={saveProjectDesignOutline}
        />
      )}

      <div className="relative flex flex-1 overflow-hidden bg-muted/50">
        {prototypeWorkspaceEnabled && effectiveViewMode === "preview" && (
          <ProjectDesignNavigator
            model={projectDesignNavigatorModel}
            onPageSelect={(pageId) => void navigatePrototype(pageId)}
            onSceneSelect={(pageId, scenarioId) =>
              void navigatePrototype(pageId, scenarioId)
            }
            onResetData={resetPrototypeData}
            onEditBlueprint={
              isGenerating ? undefined : () => setProjectDesignOutlineOpen(true)
            }
            resetPending={prototypeResetPending}
            labels={{
              title: t.prototypeWorkspace.title,
              open: t.prototypeWorkspace.open,
              close: t.prototypeWorkspace.close,
              collapse: t.prototypeWorkspace.collapse,
              expand: t.prototypeWorkspace.expand,
              pages: t.prototypeWorkspace.pages,
              pageTree: t.prototypeWorkspace.pageTree,
              pageCount: (count) =>
                t.prototypeWorkspace.pageCount.replace(
                  "{count}",
                  String(count),
                ),
              buildProgress: t.prototypeWorkspace.buildProgress,
              reviewStatus: t.prototypeWorkspace.reviewStatus,
              sharedLayoutImpact: t.prototypeWorkspace.sharedImpact,
              missingBlueprintTitle: t.prototypeWorkspace.missingTitle,
              missingBlueprintDescription:
                t.prototypeWorkspace.missingDescription,
              invalidBlueprintTitle: t.prototypeWorkspace.invalidTitle,
              invalidBlueprintDescription:
                t.prototypeWorkspace.invalidDescription,
              noPagesTitle: t.prototypeWorkspace.noPages,
              noPagesDescription: t.prototypeWorkspace.noPagesDescription,
              noScenes: t.prototypeWorkspace.noScenarios,
              resetData: t.prototypeWorkspace.resetData,
              resetting: t.prototypeWorkspace.resetting,
              resetDataDescription: t.prototypeWorkspace.resetDataDescription,
              editBlueprint: t.prototypeWorkspace.editBlueprint,
              buildStatuses: {
                "not-started": t.prototypeWorkspace.buildStatuses.notStarted,
                "in-progress": t.prototypeWorkspace.buildStatuses.inProgress,
                complete: t.prototypeWorkspace.buildStatuses.complete,
                blocked: t.prototypeWorkspace.buildStatuses.blocked,
              },
              reviewStatuses: {
                unreviewed: t.prototypeWorkspace.reviewStatuses.unreviewed,
                "in-review": t.prototypeWorkspace.reviewStatuses.inReview,
                approved: t.prototypeWorkspace.reviewStatuses.approved,
                "changes-requested":
                  t.prototypeWorkspace.reviewStatuses.changesRequested,
                stale: t.prototypeWorkspace.reviewStatuses.stale,
              },
            }}
          />
        )}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {workspaceMode === "design" &&
            automaticStage &&
            !designReviewOpen && (
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
          {assetProjectionStatus === "loading" ? (
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
              )}
            >
              <SandpackProvider
                key={`${sandpackKey}:${previewRenderRetry}`}
                template={
                  (previewEnabled
                    ? template
                    : "static") as SandpackPredefinedTemplate
                }
                customSetup={
                  desktopMode && previewEnabled && template === "static"
                    ? DESKTOP_STATIC_PREVIEW_SETUP
                    : undefined
                }
                theme={isDark ? "dark" : "light"}
                files={sandpackFiles}
                options={{ activeFile: sandpackCurrentFile }}
                style={{ height: "100%" }}
              >
                <SandpackRefreshRegistration onChange={registerSoftRefresh} />
                {previewEnabled && (
                  <SandpackRuntimeSync onChange={registerRuntimeSync} />
                )}
                <SandpackListener
                  conversationId={conversationId}
                  requestedActiveFile={sandpackCurrentFile}
                  onFileChange={handleSandpackFileChange}
                />
                <SandpackLayout>
                  {/* Preview */}
                  {previewEnabled && assetProjectionStatus === "ready" && (
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
                              "overflow-hidden rounded-lg bg-background shadow-lg",
                            captureViewport &&
                              "absolute left-0 top-0 rounded-none shadow-none transition-none",
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
            </PreviewErrorBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
