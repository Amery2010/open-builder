import { isCompressibleImageMimeType } from "../images/formats";
import { isPreviewViewportSize } from "../design/preview-bridge";
import type { ToolExecutionOutput } from "../ai/generator-types";
import {
  ASK_USER_ANSWERS_KIND,
  type AskUserAnswersStructuredContent,
} from "./tool-result";
import {
  isSensitiveProjectPath,
  redactProjectFileSecrets,
} from "./project-file-policy";
import { redactSecrets } from "../security/redact";

export const REDACTED_VALUE = "[REDACTED]";
const OMITTED_PROTECTED_RESULT =
  "[Protected tool result omitted from persisted conversation replay]";
const PREVIEW_EVIDENCE_PLACEHOLDER =
  "Screenshot bytes and full semantic element text were retained for this run only.";
const SUMMARY_ONLY_MAX_CHARS = 4_096;

function boundSummaryOnlyText(text: string): string {
  if (text.length <= SUMMARY_ONLY_MAX_CHARS) return text;
  return `${text.slice(0, SUMMARY_ONLY_MAX_CHARS)}\n[summary truncated]`;
}

export function redactSensitiveText(text: string): string {
  return redactSecrets(redactProjectFileSecrets(text), {
    placeholder: REDACTED_VALUE,
  });
}

function parseArguments(raw: string | unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function summarizeProjectDesignArguments(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const document =
    value.document &&
    typeof value.document === "object" &&
    !Array.isArray(value.document)
      ? (value.document as Record<string, unknown>)
      : undefined;
  return {
    ...(value.expected_revision !== undefined
      ? { expected_revision: value.expected_revision }
      : {}),
    document: document
      ? {
          schemaVersion: document.schemaVersion,
          revision: document.revision,
          pageCount: Array.isArray(document.pages) ? document.pages.length : 0,
          flowCount: Array.isArray(document.flows) ? document.flows.length : 0,
          scenarioCount: Array.isArray(document.scenarios)
            ? document.scenarios.length
            : 0,
        }
      : {},
  };
}

export function sanitizeToolArguments(
  toolName: string,
  raw: string | unknown,
): unknown {
  const parsed = parseArguments(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }
  const record = parsed as Record<string, unknown>;
  if (toolName === "update_project_design") {
    return summarizeProjectDesignArguments(record);
  }
  if (toolName !== "manage_env") return parsed;
  const operations = Array.isArray(record.operations)
    ? record.operations.map((operation) => {
        if (!operation || typeof operation !== "object") return operation;
        const safe = { ...(operation as Record<string, unknown>) };
        if ("value" in safe) safe.value = REDACTED_VALUE;
        return safe;
      })
    : record.operations;
  return { ...record, operations };
}

function sanitizePrototypeTargetMetadata(
  value: unknown,
): { pageId: string; route: string; scenarioId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const target = value as Record<string, unknown>;
  if (
    typeof target.pageId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(target.pageId) ||
    typeof target.scenarioId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(target.scenarioId) ||
    typeof target.route !== "string" ||
    target.route.length > 256 ||
    !/^#\/(?:[A-Za-z0-9._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*$/.test(
      target.route,
    ) ||
    target.route.includes("//") ||
    target.route
      .slice(2)
      .split("?", 1)[0]
      .split("/")
      .some((segment) => segment === "." || segment === "..") ||
    /(?:javascript|data|vbscript)\s*:/i.test(target.route)
  ) {
    return undefined;
  }
  return {
    pageId: target.pageId,
    route: target.route,
    scenarioId: target.scenarioId,
  };
}

export function serializeToolArgumentsForHistory(
  toolName: string,
  args: unknown,
): string {
  return JSON.stringify(sanitizeToolArguments(toolName, args));
}

function readsProtectedFiles(
  toolName: string,
  rawArguments: string | unknown,
): boolean {
  if (toolName !== "read_files") return false;
  const parsed = parseArguments(rawArguments);
  if (!parsed || typeof parsed !== "object") return false;
  const paths = (parsed as { paths?: unknown }).paths;
  return (
    Array.isArray(paths) &&
    paths.some(
      (path) => typeof path === "string" && isSensitiveProjectPath(path),
    )
  );
}

function stripProtectedSearchLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const match = /^(.+?):\d+:/.exec(line);
      return !match || !isSensitiveProjectPath(match[1]);
    })
    .join("\n");
}

export function sanitizeToolResultForHistory(
  toolName: string,
  rawArguments: string | unknown,
  result: string,
): string {
  if (readsProtectedFiles(toolName, rawArguments)) {
    return OMITTED_PROTECTED_RESULT;
  }
  const withoutProtectedSearchLines =
    toolName === "search_in_files" ? stripProtectedSearchLines(result) : result;
  return redactSensitiveText(withoutProtectedSearchLines);
}

export function shouldOmitRichToolOutput(
  toolName: string,
  rawArguments: string | unknown,
): boolean {
  return (
    readsProtectedFiles(toolName, rawArguments) ||
    toolName === "get_console_logs" ||
    toolName === "project_health_check"
  );
}

function sanitizeAskUserAnswersStructuredContent(
  value: unknown,
): AskUserAnswersStructuredContent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AskUserAnswersStructuredContent>;
  if (
    candidate.kind !== ASK_USER_ANSWERS_KIND ||
    !Array.isArray(candidate.selections) ||
    !candidate.selections.every(
      (selection) =>
        Array.isArray(selection) &&
        selection.every((answer) => typeof answer === "string"),
    )
  ) {
    return undefined;
  }
  return {
    kind: ASK_USER_ANSWERS_KIND,
    selections: candidate.selections.map((selection) =>
      selection.map(redactSensitiveText),
    ),
  };
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function sanitizePreviewEvidenceStructuredContent(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.kind !== "preview_evidence_v1" ||
    (raw.status !== "complete" &&
      raw.status !== "partial" &&
      raw.status !== "error") ||
    typeof raw.generation !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.generation) ||
    !Array.isArray(raw.evidence) ||
    raw.evidence.length > 3 ||
    !Array.isArray(raw.errors)
  ) {
    return undefined;
  }
  const evidence = raw.evidence.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (
      item.view !== "desktop" &&
      item.view !== "tablet" &&
      item.view !== "mobile"
    ) {
      return [];
    }
    const image = item.image as Record<string, unknown> | undefined;
    const viewport = item.viewport as Record<string, unknown> | undefined;
    const semantic = item.semantic as Record<string, unknown> | undefined;
    const prototypeIdentity = sanitizePrototypeTargetMetadata(
      semantic?.prototypeIdentity,
    );
    const bytes = boundedNumber(image?.bytes, 1, 1_500 * 1024);
    const width = boundedNumber(viewport?.width, 1, 2_000);
    const height = boundedNumber(viewport?.height, 1, 2_000);
    const capturedHeight = boundedNumber(viewport?.capturedHeight, 1, 4_096);
    const fullHeight = boundedNumber(viewport?.fullHeight, 1, 1_000_000);
    const elementCount = boundedNumber(semantic?.elementCount, 0, 120);
    if (
      typeof image?.mimeType !== "string" ||
      !isCompressibleImageMimeType(image.mimeType) ||
      typeof image.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(image.digest) ||
      !bytes ||
      viewport?.name !== item.view ||
      !width ||
      !height ||
      !capturedHeight ||
      !fullHeight ||
      !isPreviewViewportSize(item.view, width, height) ||
      capturedHeight > fullHeight ||
      viewport.truncated !== capturedHeight < fullHeight ||
      typeof viewport.truncated !== "boolean" ||
      typeof semantic?.route !== "string" ||
      typeof semantic.horizontalOverflow !== "boolean" ||
      (semantic.fonts !== "ready" &&
        semantic.fonts !== "loading" &&
        semantic.fonts !== "unsupported") ||
      elementCount === undefined
    ) {
      return [];
    }
    return [
      {
        view: item.view,
        image: { mimeType: image.mimeType, bytes, digest: image.digest },
        viewport: {
          name: item.view,
          width,
          height,
          capturedHeight,
          fullHeight,
          truncated: viewport.truncated,
        },
        semantic: {
          route: redactSensitiveText(semantic.route).slice(0, 256),
          ...(prototypeIdentity ? { prototypeIdentity } : {}),
          ...(typeof semantic.title === "string"
            ? { title: redactSensitiveText(semantic.title).slice(0, 200) }
            : {}),
          horizontalOverflow: semantic.horizontalOverflow,
          fonts: semantic.fonts,
          elementCount,
        },
      },
    ];
  });
  const errors = raw.errors
    .filter((error): error is string => typeof error === "string")
    .slice(0, 3)
    .map((error) => redactSensitiveText(error).slice(0, 400));
  const errorCode =
    typeof raw.errorCode === "string"
      ? raw.errorCode.replace(/[^a-z0-9_-]/gi, "").slice(0, 64)
      : undefined;
  const target = sanitizePrototypeTargetMetadata(raw.target);
  return {
    kind: "preview_evidence_v1",
    status: raw.status,
    generation: raw.generation,
    evidence,
    errors,
    placeholder: PREVIEW_EVIDENCE_PLACEHOLDER,
    ...(target ? { target } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

export function sanitizeToolExecutionOutputForHistory(
  toolName: string,
  rawArguments: string | unknown,
  output: ToolExecutionOutput | undefined,
): ToolExecutionOutput | undefined {
  if (!output) return undefined;
  const { retention = "full", ...persistableOutput } = output;
  if (toolName === "capture_preview_evidence") {
    const structuredContent = sanitizePreviewEvidenceStructuredContent(
      output.structuredContent,
    );
    const text = structuredContent
      ? JSON.stringify(structuredContent)
      : PREVIEW_EVIDENCE_PLACEHOLDER;
    return {
      text,
      isError: output.isError,
      ...(structuredContent ? { structuredContent } : {}),
      content: Array.isArray(structuredContent?.evidence)
        ? structuredContent.evidence.map((entry) => ({
            type: "placeholder" as const,
            label: `preview-${String((entry as { view?: unknown }).view ?? "evidence")}.webp`,
            reason: PREVIEW_EVIDENCE_PLACEHOLDER,
          }))
        : undefined,
      modelOutput: { type: "text", value: text },
    };
  }
  if (retention === "run-only") {
    const text = `[${toolName} output was retained for this run only]`;
    return {
      text,
      isError: output.isError,
      modelOutput: { type: "text", value: text },
    };
  }
  const text = sanitizeToolResultForHistory(
    toolName,
    rawArguments,
    output.text,
  );
  if (shouldOmitRichToolOutput(toolName, rawArguments)) {
    return {
      text,
      isError: output.isError,
      source: output.source,
      modelOutput: { type: "text", value: text },
    };
  }
  if (toolName === "ask_user_question") {
    const structuredContent = sanitizeAskUserAnswersStructuredContent(
      output.structuredContent,
    );
    const { structuredContent: _structuredContent, ...safeOutput } = output;
    return {
      ...safeOutput,
      text,
      ...(structuredContent ? { structuredContent } : {}),
      modelOutput: { type: "text", value: text },
    };
  }
  if (retention === "summary-only") {
    const summary = boundSummaryOnlyText(text);
    return {
      text: summary,
      isError: output.isError,
      modelOutput: { type: "text", value: summary },
    };
  }
  return { ...persistableOutput, text };
}
