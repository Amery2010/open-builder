import type {
  ConversationDesignState,
  PreviewView,
  ProjectFiles,
  ProjectPreviewMode,
} from "../../types";
import type { Message, ToolExecutionOutput } from "../ai/generator-types";
import { isSensitiveProjectPath } from "../utils/project-file-policy";
import {
  EDITABLE_DESIGN_TOKENS,
  findRootTokensPath,
  inspectDesignTokenContract,
  readEditableTokenValues,
} from "./tokens";
import type { DesignRunContext } from "./design-run";
import {
  runDesignSystemAdherenceCheck,
  type DesignAdherenceIssue,
} from "./adherence";
import type {
  DesignBridgeCaptureResult,
  DesignPreviewSemanticElement,
  DesignPreviewSemanticSnapshot,
} from "./preview-bridge";
import {
  captureRegisteredPreview,
  computePreviewGeneration,
  PreviewRuntimeError,
  type PreviewRuntimeErrorCode,
} from "./preview-runtime";
import {
  capturePreviewEvidence,
  isPreviewEvidenceSummary,
  type PreviewEvidenceSummary,
  type PreviewEvidenceSummaryItem,
} from "./preview-evidence";

export type DesignDiagnosticToolName =
  | "inspect_design_consistency"
  | "measure_preview_layout"
  | "audit_accessibility_tree"
  | "compare_preview_states"
  | "trace_design_provenance";

export interface DesignDiagnosticContext {
  conversationId: string;
  files: ProjectFiles;
  beforeFiles?: ProjectFiles;
  template: string;
  previewMode: ProjectPreviewMode;
  designState?: ConversationDesignState;
  contract?: DesignRunContext | null;
  history?: readonly Message[];
  signal?: AbortSignal;
}

const MAX_REPORT_ISSUES = 60;
const PREVIEW_SEMANTIC_ELEMENT_LIMIT = 120;

interface RuntimeInspection {
  generation: string;
  captures: DesignBridgeCaptureResult[];
  errors: string[];
  errorCode?: PreviewRuntimeErrorCode | "unavailable" | "capture_failed";
}

interface DiagnosticElementTarget {
  sampleIndex: number;
  elementId?: string;
  tagName: string;
  role?: string;
  bounds: DesignPreviewSemanticElement["bounds"];
}

function output(
  structuredContent: Record<string, unknown>,
  isError = false,
): ToolExecutionOutput {
  const text = JSON.stringify(structuredContent);
  return {
    text,
    structuredContent,
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text }],
  };
}

function cleanText(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

function checkedViewports(
  args: unknown,
  options: { required: boolean },
): PreviewView[] {
  const value =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as { viewports?: unknown }).viewports
      : undefined;
  if (value === undefined && !options.required) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new Error("Select between 1 and 3 preview viewports.");
  }
  const result: PreviewView[] = [];
  for (const viewport of value) {
    if (
      viewport !== "desktop" &&
      viewport !== "tablet" &&
      viewport !== "mobile"
    ) {
      throw new Error(`Unsupported preview viewport: ${String(viewport)}`);
    }
    if (result.includes(viewport)) {
      throw new Error(`Duplicate preview viewport: ${viewport}`);
    }
    result.push(viewport);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectRuntime(
  context: DesignDiagnosticContext,
  viewports: readonly PreviewView[],
): Promise<RuntimeInspection> {
  const generation = await computePreviewGeneration(context);
  if (context.previewMode === "code-only") {
    return {
      generation,
      captures: [],
      errors: ["Preview diagnostics are unavailable for code-only projects."],
      errorCode: "unavailable",
    };
  }
  try {
    const result = await captureRegisteredPreview({
      conversationId: context.conversationId,
      generation,
      viewports,
      signal: context.signal,
    });
    return {
      generation,
      captures: result.captures,
      errors: result.errors,
      ...(result.captures.length === 0
        ? { errorCode: "capture_failed" as const }
        : {}),
    };
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw error;
    return {
      generation,
      captures: [],
      errors: [errorMessage(error)],
      errorCode:
        error instanceof PreviewRuntimeError ? error.code : "capture_failed",
    };
  }
}

function diagnosticStatus(
  runtime: RuntimeInspection,
): "complete" | "partial" | "error" {
  if (runtime.captures.length === 0) return "error";
  return runtime.errors.length ? "partial" : "complete";
}

function issueRank(severity: string): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

function targetFor(
  element: DesignPreviewSemanticElement,
  sampleIndex: number,
): DiagnosticElementTarget {
  return {
    sampleIndex,
    ...(element.elementId ? { elementId: element.elementId } : {}),
    tagName: element.tagName,
    ...(element.role ? { role: element.role } : {}),
    bounds: { ...element.bounds },
  };
}

function componentFamily(
  element: DesignPreviewSemanticElement,
): string | undefined {
  if (/^h[1-6]$/.test(element.tagName)) return "heading";
  if (element.accessibility?.interactive) {
    return element.role || element.tagName || "interactive";
  }
  if (
    ["header", "nav", "main", "section", "footer"].includes(element.tagName)
  ) {
    return element.role || element.tagName;
  }
  return undefined;
}

function runtimeVariantInventory(
  snapshots: readonly DesignPreviewSemanticSnapshot[],
) {
  const families = new Map<
    string,
    Map<string, { count: number; styles: Record<string, string> }>
  >();
  for (const snapshot of snapshots) {
    for (const element of snapshot.elements) {
      const family = componentFamily(element);
      if (!family) continue;
      const styles = Object.fromEntries(
        Object.entries(element.styles ?? {}).filter(([, value]) =>
          Boolean(value),
        ),
      ) as Record<string, string>;
      const signature = JSON.stringify(styles);
      const signatures = families.get(family) ?? new Map();
      const existing = signatures.get(signature);
      if (existing) existing.count += 1;
      else signatures.set(signature, { count: 1, styles });
      families.set(family, signatures);
    }
  }
  return [...families.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 20)
    .map(([family, signatures]) => ({
      family,
      distinctStyleSignatures: signatures.size,
      signatures: [...signatures.values()]
        .sort((left, right) => right.count - left.count)
        .slice(0, 8),
    }));
}

async function inspectDesignConsistency(
  args: unknown,
  context: DesignDiagnosticContext,
): Promise<ToolExecutionOutput> {
  const viewports = checkedViewports(args, { required: false });
  const runtime = viewports.length
    ? await inspectRuntime(context, viewports)
    : undefined;
  const snapshots = runtime?.captures.map(
    (capture) => capture.semanticSnapshot,
  );
  const report = runDesignSystemAdherenceCheck({
    files: context.files,
    beforeFiles: context.beforeFiles,
    designState: context.designState,
    contract: context.contract,
    ...(snapshots?.length ? { runtimeSnapshots: snapshots } : {}),
  });
  const issues = [...report.issues]
    .sort(
      (left, right) =>
        issueRank(left.severity) - issueRank(right.severity) ||
        left.code.localeCompare(right.code) ||
        (left.path ?? "").localeCompare(right.path ?? ""),
    )
    .slice(0, MAX_REPORT_ISSUES);
  return output({
    kind: "design_consistency_v1",
    status:
      runtime && runtime.captures.length === 0
        ? "partial"
        : runtime?.errors.length
          ? "partial"
          : "complete",
    summary: report.summary,
    ok: report.ok && (!runtime || runtime.errors.length === 0),
    issues,
    ...(report.issues.length > issues.length ? { truncated: true } : {}),
    tokenUsage: report.tokenUsage,
    runtime: runtime
      ? {
          coverage:
            runtime.captures.length === viewports.length
              ? "complete"
              : runtime.captures.length
                ? "partial"
                : "unavailable",
          generation: runtime.generation,
          requestedViewports: viewports,
          capturedViewports: runtime.captures.map(
            (capture) => capture.viewport.name,
          ),
          errors: runtime.errors,
          componentVariants: runtimeVariantInventory(snapshots ?? []),
        }
      : { coverage: "not_requested" },
  });
}

type LayoutIssue = {
  severity: "error" | "warning" | "info";
  code:
    | "document_horizontal_overflow"
    | "sampled_element_outside_viewport"
    | "sampled_control_target_small"
    | "capture_truncated";
  message: string;
  target?: DiagnosticElementTarget;
};

function layoutIssues(capture: DesignBridgeCaptureResult): LayoutIssue[] {
  const snapshot = capture.semanticSnapshot;
  const issues: LayoutIssue[] = [];
  if (snapshot.document.horizontalOverflow) {
    issues.push({
      severity: "error",
      code: "document_horizontal_overflow",
      message: `Document scroll width ${snapshot.document.scrollWidth}px exceeds viewport width ${snapshot.viewport.width}px.`,
    });
  }
  if (capture.viewport.truncated && capture.capture?.scope !== "viewport") {
    issues.push({
      severity: "info",
      code: "capture_truncated",
      message: `Evidence was capped at ${capture.viewport.capturedHeight}px of ${capture.viewport.fullHeight}px.`,
    });
  }
  for (const [index, element] of snapshot.elements.entries()) {
    const { x, width, height } = element.bounds;
    if (x < -1 || x + width > snapshot.viewport.width + 1) {
      issues.push({
        severity: "warning",
        code: "sampled_element_outside_viewport",
        message: "A sampled semantic element extends beyond the viewport edge.",
        target: targetFor(element, index),
      });
    }
    if (
      element.accessibility?.interactive &&
      !element.accessibility.disabled &&
      (width < 44 || height < 44)
    ) {
      issues.push({
        severity: "warning",
        code: "sampled_control_target_small",
        message:
          "A sampled interactive target is smaller than 44 by 44 CSS pixels.",
        target: targetFor(element, index),
      });
    }
  }
  return issues;
}

async function measurePreviewLayout(
  args: unknown,
  context: DesignDiagnosticContext,
): Promise<ToolExecutionOutput> {
  const viewports = checkedViewports(args, { required: true });
  const runtime = await inspectRuntime(context, viewports);
  const reports = runtime.captures.map((capture) => {
    const issues = layoutIssues(capture);
    return {
      view: capture.viewport.name,
      route: capture.semanticSnapshot.route,
      viewport: capture.semanticSnapshot.viewport,
      document: capture.semanticSnapshot.document,
      capture: {
        ...(capture.capture
          ? {
              ...capture.capture,
              imageWidth: Math.max(
                1,
                Math.floor(
                  capture.capture.region.width * capture.capture.scale,
                ),
              ),
              imageHeight: Math.max(
                1,
                Math.floor(
                  capture.capture.region.height * capture.capture.scale,
                ),
              ),
            }
          : {}),
        capturedHeight: capture.viewport.capturedHeight,
        fullHeight: capture.viewport.fullHeight,
        truncated: capture.viewport.truncated,
      },
      coverage: {
        kind: "sampled_semantic_elements",
        sampledElements: capture.semanticSnapshot.elements.length,
        sampleLimit: PREVIEW_SEMANTIC_ELEMENT_LIMIT,
        mayBeTruncated:
          capture.semanticSnapshot.elements.length >=
          PREVIEW_SEMANTIC_ELEMENT_LIMIT,
      },
      summary: {
        errors: issues.filter((issue) => issue.severity === "error").length,
        warnings: issues.filter((issue) => issue.severity === "warning").length,
        info: issues.filter((issue) => issue.severity === "info").length,
        totalIssues: issues.length,
      },
      issues: issues.slice(0, MAX_REPORT_ISSUES),
      ...(issues.length > MAX_REPORT_ISSUES ? { truncated: true } : {}),
    };
  });
  return output(
    {
      kind: "preview_layout_measurement_v1",
      status: diagnosticStatus(runtime),
      generation: runtime.generation,
      requestedViewports: viewports,
      reports,
      errors: runtime.errors,
      limitation:
        "Reports bounded semantic samples; it does not prove whole-DOM overlap, occlusion, or nested scroll-container behavior.",
      ...(runtime.errorCode ? { errorCode: runtime.errorCode } : {}),
    },
    runtime.captures.length === 0,
  );
}

type AccessibilityIssue = {
  severity: "error" | "warning";
  code:
    | "document_title_missing"
    | "document_language_missing"
    | "main_landmark_missing"
    | "h1_missing"
    | "heading_level_skipped"
    | "interactive_name_missing"
    | "form_label_missing"
    | "keyboard_unreachable"
    | "image_alt_missing"
    | "target_size_below_24px";
  message: string;
  target?: DiagnosticElementTarget;
};

function likelyInteractive(element: DesignPreviewSemanticElement): boolean {
  return (
    element.accessibility?.interactive === true ||
    ["button", "input", "select", "textarea", "summary"].includes(
      element.tagName,
    ) ||
    [
      "button",
      "link",
      "checkbox",
      "radio",
      "switch",
      "tab",
      "menuitem",
      "textbox",
      "combobox",
    ].includes(element.role ?? "")
  );
}

function accessibilityIssues(
  snapshot: DesignPreviewSemanticSnapshot,
): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  if (!snapshot.title) {
    issues.push({
      severity: "warning",
      code: "document_title_missing",
      message: "The preview document has no non-empty title.",
    });
  }
  if (!snapshot.document.language) {
    issues.push({
      severity: "warning",
      code: "document_language_missing",
      message: "The preview document root has no lang attribute.",
    });
  }
  if (
    !snapshot.elements.some(
      (element) => element.tagName === "main" || element.role === "main",
    )
  ) {
    issues.push({
      severity: "warning",
      code: "main_landmark_missing",
      message: "No main landmark was found in the sampled semantic elements.",
    });
  }
  const headings = snapshot.elements.filter((element) =>
    /^h[1-6]$/.test(element.tagName),
  );
  if (!headings.some((element) => element.tagName === "h1")) {
    issues.push({
      severity: "warning",
      code: "h1_missing",
      message: "No h1 was found in the sampled semantic elements.",
    });
  }
  let previousHeadingLevel = 0;
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    if (previousHeadingLevel && level > previousHeadingLevel + 1) {
      issues.push({
        severity: "warning",
        code: "heading_level_skipped",
        message: `Heading order skips from h${previousHeadingLevel} to h${level}.`,
        target: targetFor(heading, snapshot.elements.indexOf(heading)),
      });
    }
    previousHeadingLevel = level;
  }

  for (const [index, element] of snapshot.elements.entries()) {
    const metadata = element.accessibility;
    if (element.tagName === "img" && metadata?.imageAlt === "missing") {
      issues.push({
        severity: "error",
        code: "image_alt_missing",
        message:
          "An image in the sampled semantic elements has no alt attribute.",
        target: targetFor(element, index),
      });
    }
    if (!likelyInteractive(element) || metadata?.disabled) continue;
    if (!element.name) {
      issues.push({
        severity: "error",
        code: "interactive_name_missing",
        message: "A sampled interactive element has no accessible name.",
        target: targetFor(element, index),
      });
    }
    if (
      ["input", "select", "textarea"].includes(element.tagName) &&
      (!metadata ||
        metadata.nameSource === "none" ||
        metadata.nameSource === "placeholder")
    ) {
      issues.push({
        severity: "error",
        code: "form_label_missing",
        message:
          "A sampled form control has no associated label or ARIA label; placeholder text is not a label.",
        target: targetFor(element, index),
      });
    }
    if (metadata && !metadata.focusable) {
      issues.push({
        severity: "error",
        code: "keyboard_unreachable",
        message: "A sampled interactive element is not keyboard-focusable.",
        target: targetFor(element, index),
      });
    }
    if (element.bounds.width < 24 || element.bounds.height < 24) {
      issues.push({
        severity: "warning",
        code: "target_size_below_24px",
        message:
          "A sampled interactive target is smaller than 24 by 24 CSS pixels.",
        target: targetFor(element, index),
      });
    }
  }
  return issues;
}

async function auditAccessibilityTree(
  args: unknown,
  context: DesignDiagnosticContext,
): Promise<ToolExecutionOutput> {
  const viewports = checkedViewports(args, { required: true });
  const runtime = await inspectRuntime(context, viewports);
  const reports = runtime.captures.map((capture) => {
    const issues = accessibilityIssues(capture.semanticSnapshot);
    return {
      view: capture.viewport.name,
      route: capture.semanticSnapshot.route,
      engine: "open-builder-dom-semantics-v1",
      coverage: {
        kind: "sampled_semantic_elements",
        sampledElements: capture.semanticSnapshot.elements.length,
        sampleLimit: PREVIEW_SEMANTIC_ELEMENT_LIMIT,
        mayBeTruncated:
          capture.semanticSnapshot.elements.length >=
          PREVIEW_SEMANTIC_ELEMENT_LIMIT,
      },
      summary: {
        errors: issues.filter((issue) => issue.severity === "error").length,
        warnings: issues.filter((issue) => issue.severity === "warning").length,
        totalIssues: issues.length,
      },
      issues: issues.slice(0, MAX_REPORT_ISSUES),
      ...(issues.length > MAX_REPORT_ISSUES ? { truncated: true } : {}),
    };
  });
  return output(
    {
      kind: "preview_accessibility_audit_v1",
      status: diagnosticStatus(runtime),
      generation: runtime.generation,
      requestedViewports: viewports,
      reports,
      errors: runtime.errors,
      conformance: "not_assessed",
      limitation:
        "This is a bounded DOM-derived semantic audit, not a browser-native accessibility tree or a WCAG conformance claim.",
      ...(runtime.errorCode ? { errorCode: runtime.errorCode } : {}),
    },
    runtime.captures.length === 0,
  );
}

function captureToolName(
  history: readonly Message[],
  messageIndex: number,
  toolCallId: string | undefined,
): string | undefined {
  if (!toolCallId) return undefined;
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const message = history[index];
    const call = message.tool_calls?.find(
      (candidate) => candidate.id === toolCallId,
    );
    if (call) return call.function.name;
  }
  return undefined;
}

function findBaselineEvidence(
  history: readonly Message[] | undefined,
  generation: string | undefined,
  viewports: readonly PreviewView[],
): PreviewEvidenceSummary | undefined {
  if (!history) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (
      message.role !== "tool" ||
      captureToolName(history, index, message.tool_call_id) !==
        "capture_preview_evidence" ||
      !isPreviewEvidenceSummary(message.toolOutput?.structuredContent)
    ) {
      continue;
    }
    const summary = message.toolOutput.structuredContent;
    if (generation) {
      if (summary.generation === generation && summary.evidence.length > 0) {
        return summary;
      }
      continue;
    }
    if (
      viewports.every((viewport) =>
        summary.evidence.some((entry) => entry.view === viewport),
      )
    ) {
      return summary;
    }
  }
  return undefined;
}

function evidenceFor(
  summary: PreviewEvidenceSummary,
  view: PreviewView,
): PreviewEvidenceSummaryItem | undefined {
  return summary.evidence.find((entry) => entry.view === view);
}

function compareEvidenceItem(
  view: PreviewView,
  baseline: PreviewEvidenceSummaryItem | undefined,
  current: PreviewEvidenceSummaryItem | undefined,
) {
  if (!baseline || !current) {
    return {
      view,
      status: !baseline ? "baseline_missing" : "current_missing",
    };
  }
  const changes = {
    imageDigestChanged: baseline.image.digest !== current.image.digest,
    imageBytesDelta: current.image.bytes - baseline.image.bytes,
    routeChanged: baseline.semantic.route !== current.semantic.route,
    titleChanged: baseline.semantic.title !== current.semantic.title,
    horizontalOverflowChanged:
      baseline.semantic.horizontalOverflow !==
      current.semantic.horizontalOverflow,
    fontReadinessChanged: baseline.semantic.fonts !== current.semantic.fonts,
    elementCountDelta:
      current.semantic.elementCount - baseline.semantic.elementCount,
    fullHeightDelta: current.viewport.fullHeight - baseline.viewport.fullHeight,
    truncationChanged:
      current.viewport.truncated !== baseline.viewport.truncated,
  };
  return {
    view,
    status: Object.values(changes).some((value) =>
      typeof value === "boolean" ? value : value !== 0,
    )
      ? "changed"
      : "same",
    changes,
    baseline,
    current,
  };
}

async function comparePreviewStates(
  args: unknown,
  context: DesignDiagnosticContext,
): Promise<ToolExecutionOutput> {
  const viewports = checkedViewports(args, { required: true });
  const baselineGeneration =
    args && typeof args === "object" && !Array.isArray(args)
      ? cleanText(
          (args as { baseline_generation?: unknown }).baseline_generation,
          64,
        )
      : undefined;
  if (baselineGeneration && !/^[a-f0-9]{64}$/.test(baselineGeneration)) {
    throw new Error("baseline_generation must be a SHA-256 generation id.");
  }
  const baseline = findBaselineEvidence(
    context.history,
    baselineGeneration,
    viewports,
  );
  const currentOutput = await capturePreviewEvidence({
    conversationId: context.conversationId,
    files: context.files,
    template: context.template,
    previewMode: context.previewMode,
    viewports,
    scope:
      baseline?.evidence.find((entry) => entry.view === viewports[0])?.capture
        ?.scope ?? "full-page",
    signal: context.signal,
  });
  const current = isPreviewEvidenceSummary(currentOutput.structuredContent)
    ? currentOutput.structuredContent
    : undefined;
  if (!current || current.evidence.length === 0) {
    return output(
      {
        kind: "preview_comparison_v1",
        status: "error",
        errorCode: current?.errorCode ?? "capture_failed",
        errors: current?.errors ?? [
          "Current preview evidence was unavailable.",
        ],
      },
      true,
    );
  }
  if (!baseline) {
    return output(
      {
        kind: "preview_comparison_v1",
        status: "error",
        errorCode: "baseline_not_found",
        requestedBaselineGeneration: baselineGeneration,
        current,
        errors: [
          "No matching persisted capture_preview_evidence result exists in this Conversation. Capture a baseline first.",
        ],
      },
      true,
    );
  }
  const comparisons = viewports.map((view) =>
    compareEvidenceItem(
      view,
      evidenceFor(baseline, view),
      evidenceFor(current, view),
    ),
  );
  const partial = comparisons.some(
    (comparison) =>
      comparison.status === "baseline_missing" ||
      comparison.status === "current_missing",
  );
  return output({
    kind: "preview_comparison_v1",
    status: partial
      ? "partial"
      : comparisons.some((comparison) => comparison.status === "changed")
        ? "changed"
        : "same",
    baselineGeneration: baseline.generation,
    currentGeneration: current.generation,
    requestedViewports: viewports,
    comparisons,
    errors: [...baseline.errors, ...current.errors],
    limitation:
      "Comparison is exact-image-digest and metadata based; it does not locate changed pixels or infer perceptual similarity.",
  });
}

function summarizeReference(
  reference: ConversationDesignState["appliedSystem"],
) {
  return reference
    ? {
        id: cleanText(reference.id, 100),
        name: cleanText(reference.name, 160),
        source: reference.source,
        version: cleanText(reference.version, 100),
        digest: cleanText(reference.digest, 64),
      }
    : undefined;
}

function tokenUsageSites(files: ProjectFiles, token: string) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`var\\(\\s*${escaped}(?:\\s*[,)]|\\s*$)`, "gi");
  const sites: Array<{ path: string; occurrences: number }> = [];
  for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      path.toLowerCase() === "tokens.css" ||
      isSensitiveProjectPath(path) ||
      !/\.(?:html|css|scss|sass|less|styl|js|jsx|ts|tsx|vue|svelte|astro)$/i.test(
        path,
      )
    ) {
      continue;
    }
    const occurrences = [...content.matchAll(pattern)].length;
    if (occurrences) sites.push({ path, occurrences });
  }
  return {
    totalFiles: sites.length,
    totalOccurrences: sites.reduce((sum, site) => sum + site.occurrences, 0),
    sites: sites.slice(0, 8),
    ...(sites.length > 8 ? { truncated: true } : {}),
  };
}

function traceDesignProvenance(
  context: DesignDiagnosticContext,
): ToolExecutionOutput {
  const tokenContract = inspectDesignTokenContract(
    context.files,
    context.designState,
  );
  const tokenPath = findRootTokensPath(context.files);
  const tokenValues =
    tokenContract.status === "ready"
      ? readEditableTokenValues(tokenContract.source)
      : {};
  const designPath = Object.keys(context.files).find(
    (path) => !path.includes("/") && path.toLowerCase() === "design.md",
  );
  const applied = context.designState?.appliedSystem;
  const digest = applied?.digest;
  const tokenContractSummary = {
    status: tokenContract.status,
    ...(tokenPath ? { path: tokenPath } : {}),
    ...(tokenContract.status === "invalid"
      ? { error: cleanText(tokenContract.error, 400) }
      : {}),
  };
  return output({
    kind: "design_provenance_v1",
    coverage: {
      state: "current_state",
      history: "file_snapshots_only",
      runtimeElementToSource: "unavailable",
    },
    designSystem: {
      selected: summarizeReference(context.designState?.selectedSystem),
      applied: summarizeReference(applied),
      recommendation: context.designState?.recommendation
        ? {
            systemId: context.designState.recommendation.systemId,
            reason: cleanText(context.designState.recommendation.reason, 400),
            createdAt: context.designState.recommendation.createdAt,
          }
        : undefined,
      files: {
        designContractPath: designPath,
        tokenContractPath: tokenPath,
        designDigestMarkerMatches: Boolean(
          digest &&
          designPath &&
          context.files[designPath].includes(`sha256 ${digest}`),
        ),
        tokenDigestMarkerMatches: Boolean(
          digest &&
          tokenPath &&
          context.files[tokenPath].includes(`sha256 ${digest}`),
        ),
      },
    },
    designRunContext: context.contract
      ? {
          surfaceMode: context.contract.surface_mode,
          changeMode: context.contract.change_mode,
          systemId: context.contract.system_id,
        }
      : null,
    tokenContract: tokenContractSummary,
    tokens: EDITABLE_DESIGN_TOKENS.map((definition) => ({
      token: definition.property,
      group: definition.group,
      value: cleanText(tokenValues[definition.property], 240),
      declarationPath: tokenPath,
      usage: tokenUsageSites(context.files, definition.property),
    })),
  });
}

/** Single deep interface for the five read-only Design diagnostic tools. */
export async function executeDesignDiagnostic(
  name: DesignDiagnosticToolName,
  args: unknown,
  context: DesignDiagnosticContext,
): Promise<ToolExecutionOutput> {
  context.signal?.throwIfAborted();
  switch (name) {
    case "inspect_design_consistency":
      return inspectDesignConsistency(args, context);
    case "measure_preview_layout":
      return measurePreviewLayout(args, context);
    case "audit_accessibility_tree":
      return auditAccessibilityTree(args, context);
    case "compare_preview_states":
      return comparePreviewStates(args, context);
    case "trace_design_provenance":
      return traceDesignProvenance(context);
  }
}

export type { DesignAdherenceIssue };
