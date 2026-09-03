import type {
  ProjectFiles,
  ProjectPreviewMode,
  PreviewView,
} from "../../types";
import type { ToolExecutionOutput } from "../ai/generator-types";
import { mcpToolExecutionOutputToModelOutput } from "../mcp/tool-output";
import {
  captureRegisteredPreview,
  computePreviewGeneration,
  PreviewRuntimeError,
} from "./preview-runtime";
import type {
  DesignBridgeCaptureResult,
  DesignPreviewSemanticSnapshot,
} from "./preview-bridge";

export const PREVIEW_EVIDENCE_KIND = "preview_evidence_v1" as const;

export interface PreviewEvidenceSummaryItem {
  view: PreviewView;
  image: {
    mimeType: "image/webp";
    bytes: number;
    digest: string;
  };
  viewport: DesignBridgeCaptureResult["viewport"];
  semantic: {
    route: string;
    title?: string;
    horizontalOverflow: boolean;
    fonts: DesignPreviewSemanticSnapshot["document"]["fonts"];
    elementCount: number;
  };
}

export interface PreviewEvidenceSummary {
  kind: typeof PREVIEW_EVIDENCE_KIND;
  status: "complete" | "partial" | "error";
  generation: string;
  evidence: PreviewEvidenceSummaryItem[];
  errors: string[];
  placeholder: string;
  errorCode?: string;
}

export function isPreviewEvidenceSummary(
  value: unknown,
): value is PreviewEvidenceSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PreviewEvidenceSummary>;
  if (
    candidate.kind !== PREVIEW_EVIDENCE_KIND ||
    (candidate.status !== "complete" &&
      candidate.status !== "partial" &&
      candidate.status !== "error") ||
    typeof candidate.generation !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.generation) ||
    !Array.isArray(candidate.evidence) ||
    candidate.evidence.length > 3 ||
    !Array.isArray(candidate.errors) ||
    candidate.errors.length > 3 ||
    !candidate.errors.every(
      (error) => typeof error === "string" && error.length <= 400,
    ) ||
    typeof candidate.placeholder !== "string" ||
    candidate.placeholder.length > 200 ||
    (candidate.errorCode !== undefined &&
      (typeof candidate.errorCode !== "string" ||
        !/^[a-z0-9_-]{1,64}$/.test(candidate.errorCode)))
  ) {
    return false;
  }
  const views = new Set(candidate.evidence.map((entry) => entry?.view));
  if (views.size !== candidate.evidence.length) return false;
  if (
    (candidate.status === "complete" &&
      (candidate.evidence.length === 0 || candidate.errors.length !== 0)) ||
    (candidate.status === "partial" &&
      (candidate.evidence.length === 0 || candidate.errors.length === 0)) ||
    (candidate.status === "error" &&
      (candidate.evidence.length !== 0 || candidate.errors.length === 0))
  ) {
    return false;
  }
  const viewportDimensions = {
    desktop: { width: 1_440, height: 900 },
    tablet: { width: 768, height: 1_024 },
    mobile: { width: 375, height: 667 },
  } as const;
  return candidate.evidence.every((entry) => {
    if (
      !entry ||
      (entry.view !== "desktop" &&
        entry.view !== "tablet" &&
        entry.view !== "mobile")
    ) {
      return false;
    }
    const expected = viewportDimensions[entry.view];
    return (
      entry.image?.mimeType === "image/webp" &&
      Number.isInteger(entry.image.bytes) &&
      entry.image.bytes > 0 &&
      entry.image.bytes <= 1_500 * 1024 &&
      typeof entry.image.digest === "string" &&
      /^[a-f0-9]{64}$/.test(entry.image.digest) &&
      entry.viewport?.name === entry.view &&
      entry.viewport.width === expected.width &&
      entry.viewport.height === expected.height &&
      Number.isInteger(entry.viewport.capturedHeight) &&
      entry.viewport.capturedHeight >= expected.height &&
      entry.viewport.capturedHeight <= 4_096 &&
      Number.isInteger(entry.viewport.fullHeight) &&
      entry.viewport.fullHeight >= entry.viewport.capturedHeight &&
      entry.viewport.fullHeight <= 1_000_000 &&
      entry.viewport.truncated ===
        entry.viewport.capturedHeight < entry.viewport.fullHeight &&
      typeof entry.semantic?.route === "string" &&
      entry.semantic.route.startsWith("/") &&
      entry.semantic.route.length <= 256 &&
      (entry.semantic.title === undefined ||
        (typeof entry.semantic.title === "string" &&
          entry.semantic.title.length <= 200)) &&
      typeof entry.semantic.horizontalOverflow === "boolean" &&
      (entry.semantic.fonts === "ready" ||
        entry.semantic.fonts === "loading" ||
        entry.semantic.fonts === "unsupported") &&
      Number.isInteger(entry.semantic.elementCount) &&
      entry.semantic.elementCount >= 0 &&
      entry.semantic.elementCount <= 120
    );
  });
}

export interface CapturePreviewEvidenceInput {
  conversationId: string;
  files: ProjectFiles;
  template: string;
  previewMode: ProjectPreviewMode;
  viewports: readonly PreviewView[];
  signal?: AbortSignal;
}

const PLACEHOLDER =
  "Screenshot bytes and full semantic element text were retained for this run only.";

function checkedViewports(values: readonly PreviewView[]): PreviewView[] {
  if (values.length < 1 || values.length > 3) {
    throw new Error("Select between 1 and 3 preview viewports.");
  }
  const accepted = new Set<PreviewView>();
  for (const value of values) {
    if (value !== "desktop" && value !== "tablet" && value !== "mobile") {
      throw new Error(`Unsupported preview viewport: ${String(value)}`);
    }
    if (accepted.has(value)) {
      throw new Error(`Duplicate preview viewport: ${value}`);
    }
    accepted.add(value);
  }
  return [...values];
}

function imageBase64(dataUrl: string): string {
  const match = /^data:image\/webp;base64,([A-Za-z0-9+/]*={0,2})$/.exec(
    dataUrl,
  );
  if (!match)
    throw new Error("Preview evidence did not contain valid WebP data.");
  return match[1];
}

function decodedByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

async function sha256Base64(base64: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 is unavailable in this runtime.");
  }
  const bytes = Uint8Array.from(atob(base64), (character) =>
    character.charCodeAt(0),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function summarizeCapture(
  capture: DesignBridgeCaptureResult,
): Promise<PreviewEvidenceSummaryItem> {
  const base64 = imageBase64(capture.dataUrl);
  return {
    view: capture.viewport.name,
    image: {
      mimeType: capture.mimeType,
      bytes: decodedByteLength(base64),
      digest: await sha256Base64(base64),
    },
    viewport: { ...capture.viewport },
    semantic: {
      route: capture.semanticSnapshot.route,
      ...(capture.semanticSnapshot.title
        ? { title: capture.semanticSnapshot.title }
        : {}),
      horizontalOverflow: capture.semanticSnapshot.document.horizontalOverflow,
      fonts: capture.semanticSnapshot.document.fonts,
      elementCount: capture.semanticSnapshot.elements.length,
    },
  };
}

function errorOutput(
  generation: string,
  errorCode: string,
  message: string,
): ToolExecutionOutput {
  const summary: PreviewEvidenceSummary = {
    kind: PREVIEW_EVIDENCE_KIND,
    status: "error",
    generation,
    evidence: [],
    errors: [message],
    placeholder: PLACEHOLDER,
    errorCode,
  };
  const text = JSON.stringify(summary);
  return {
    text,
    isError: true,
    structuredContent: summary,
    content: [{ type: "text", text }],
    modelOutput: { type: "error-text", value: text },
  };
}

export async function capturePreviewEvidence(
  input: CapturePreviewEvidenceInput,
): Promise<ToolExecutionOutput> {
  const viewports = checkedViewports(input.viewports);
  const generation = await computePreviewGeneration(input);
  if (input.previewMode === "code-only") {
    return errorOutput(
      generation,
      "unavailable",
      "Preview evidence is unavailable for code-only projects.",
    );
  }

  try {
    const collection = await captureRegisteredPreview({
      conversationId: input.conversationId,
      generation,
      viewports,
      signal: input.signal,
    });
    const evidence = await Promise.all(
      collection.captures.map(summarizeCapture),
    );
    if (evidence.length === 0) {
      return errorOutput(
        generation,
        "capture_failed",
        collection.errors.join(" ") || "Preview capture returned no evidence.",
      );
    }

    const summary: PreviewEvidenceSummary = {
      kind: PREVIEW_EVIDENCE_KIND,
      status: collection.errors.length ? "partial" : "complete",
      generation,
      evidence,
      errors: [...collection.errors],
      placeholder: PLACEHOLDER,
    };
    const fullSemanticEvidence = collection.captures.map((capture) => ({
      view: capture.viewport.name,
      viewport: capture.viewport,
      semanticSnapshot: capture.semanticSnapshot,
    }));
    const output: ToolExecutionOutput = {
      text: JSON.stringify(summary),
      structuredContent: summary,
      content: [
        {
          type: "text",
          text: JSON.stringify({ generation, evidence: fullSemanticEvidence }),
        },
        ...collection.captures.map((capture) => ({
          type: "image" as const,
          data: imageBase64(capture.dataUrl),
          mimeType: capture.mimeType,
        })),
      ],
    };
    output.modelOutput = mcpToolExecutionOutputToModelOutput(output);
    return output;
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw error;
    if (error instanceof PreviewRuntimeError) {
      return errorOutput(generation, error.code, error.message);
    }
    return errorOutput(
      generation,
      "capture_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
