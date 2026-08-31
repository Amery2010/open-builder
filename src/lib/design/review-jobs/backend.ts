import type { ToolSet } from "ai";
import { createOpenAIGenerator } from "../../ai/client";
import type {
  GenerationBackend,
  GeneratorEvents,
  ProjectFiles,
  ResolvedAttachment,
} from "../../ai/generator-types";
import { buildToolSetForRun } from "../../ai/tools-schema";
import type { RuntimePlatform } from "../../ai/tools-schema";
import { createLocalAgentGenerator } from "../../local-agent/generator";
import {
  buildAutomaticDesignReviewContext,
  type AutomaticDesignReviewEvidence,
} from "../automatic-review";
import {
  buildDesignReviewRequirementsContext,
  buildDesignReviewSemanticContext,
  buildDesignReviewSystemSuffix,
  createSubmitDesignReviewHandler,
  DESIGN_REVIEW_PROTOCOL_REPAIR_REQUEST,
  DESIGN_REVIEW_REQUEST,
  getDesignReviewScreenshotByteLength,
  parseDesignReviewReportText,
  type DesignReviewReport,
  type DesignReviewScreenshot,
} from "../review";
import { SUBMIT_DESIGN_REVIEW_TOOL } from "../review-tool";
import type { Message } from "../../ai/generator-types";
import type { DesignReviewBackendConfig } from "./types";
import type { ResolvedLocale } from "../../../i18n";

const READ_ONLY_TOOL_NAMES = new Set([
  "list_files",
  "read_files",
  "search_in_files",
  "submit_design_review",
]);

export interface IsolatedDesignReviewEvents {
  onRetry?: (attempt: number, maxAttempts: number, error: Error) => void;
  onToolCall?: (name: string) => void;
  onReport?: (report: DesignReviewReport) => void;
}

export interface IsolatedDesignReviewOptions {
  conversationId: string;
  locale: ResolvedLocale;
  files: ProjectFiles;
  screenshots: readonly DesignReviewScreenshot[];
  provider: DesignReviewBackendConfig;
  requirementsMessages?: readonly Message[];
  automaticEvidence?: AutomaticDesignReviewEvidence;
  events?: IsolatedDesignReviewEvents;
}

export interface IsolatedDesignReviewSession {
  backend: GenerationBackend;
  run: () => Promise<DesignReviewReport>;
}

function sameFiles(left: ProjectFiles, right: ProjectFiles): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([path, content]) => right[path] === content)
  );
}

function cleanScreenshotName(value: string | undefined, index: number): string {
  return (
    value
      ?.replace(/[\u0000-\u001f\u007f<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || `screenshot-${index + 1}.png`
  );
}

function screenshotAttachments(
  conversationId: string,
  screenshots: readonly DesignReviewScreenshot[],
): ResolvedAttachment[] {
  return screenshots.map((screenshot, index) => ({
    id: `design-review-${conversationId}-${index}`,
    type: "image",
    name: cleanScreenshotName(screenshot.name, index),
    mimeType: screenshot.mimeType ?? "image/png",
    size: Math.max(1, getDesignReviewScreenshotByteLength(screenshot.dataUrl)),
    content: screenshot.dataUrl,
  }));
}

function providerRef(config: DesignReviewBackendConfig): string {
  if (config.runtime === "local") return config.config.provider;
  return config.config.apiType ?? "openai-compatible";
}

/**
 * Creates an ephemeral generator with only the Design Review read tools. The
 * caller owns cancellation through the returned backend and must discard the
 * session after run() settles.
 */
export function createIsolatedDesignReviewSession(
  options: IsolatedDesignReviewOptions,
): IsolatedDesignReviewSession {
  const initialFiles = { ...options.files };
  let acceptedReport: DesignReviewReport | undefined;
  const acceptReport = (report: DesignReviewReport) => {
    if (acceptedReport) return;
    acceptedReport = report;
    options.events?.onReport?.(report);
  };
  const submitHandler = createSubmitDesignReviewHandler(acceptReport);
  const customTools = { ...SUBMIT_DESIGN_REVIEW_TOOL } satisfies ToolSet;
  const customToolHandler = async (name: string, args: unknown) => {
    if (name === "submit_design_review") return submitHandler(name, args);
    return `Error: tool "${name}" is unavailable in Design Review.`;
  };
  const runtimePlatform: RuntimePlatform =
    options.provider.runtime === "local" ? "desktop" : "web";
  const tools = buildToolSetForRun({
    custom: customTools,
    mode: "chat",
    platform: runtimePlatform,
    profile: "design_review",
  });
  if (
    Object.keys(tools).some((name) => !READ_ONLY_TOOL_NAMES.has(name)) ||
    [...READ_ONLY_TOOL_NAMES].some((name) => !tools[name])
  ) {
    throw new Error("Design Review tool isolation could not be established.");
  }

  const events: GeneratorEvents = {
    onToolCall: (name) => options.events?.onToolCall?.(name),
    onRetry: (attempt, maxAttempts, error) =>
      options.events?.onRetry?.(attempt, maxAttempts, error),
  };
  const extras = {
    tools,
    executionMode: "chat" as const,
    runtimePlatform,
    conversationId: options.conversationId,
    allowedMcpAliases: new Set<string>(),
    initialSkillContext: null,
    maxIterations: 20,
  };
  const backend: GenerationBackend =
    options.provider.runtime === "local"
      ? createLocalAgentGenerator(
          {
            ...options.provider.config,
            nativeSearch: false,
            conversationId: options.conversationId,
          },
          events,
          initialFiles,
          customTools,
          customToolHandler,
          extras,
        )
      : createOpenAIGenerator(
          { ...options.provider.config, providerToolNames: [] },
          events,
          initialFiles,
          customTools,
          customToolHandler,
          extras,
        );

  backend.syncMessages([]);
  // `setReadOnlyMode(true)` maps the shared generator to Plan Mode, where the
  // chat-only submit_design_review capability is denied. This isolated run is
  // read-only by construction: its schema contains only three read tools plus
  // the completion tool, and file mutations are rejected below.
  backend.setExecutionMode("chat");
  backend.setNativeSearchAllowed?.(false);
  backend.setConversationContextAllowed?.(false);
  backend.setAllowedMcpAliases(new Set());
  backend.setCustomToolSet(customTools);
  backend.setTools(tools);
  backend.setSystemPromptSuffix(
    buildDesignReviewSystemSuffix(options.locale) +
      buildDesignReviewRequirementsContext([
        ...(options.requirementsMessages ?? []),
      ]) +
      buildDesignReviewSemanticContext(options.screenshots) +
      (options.automaticEvidence
        ? buildAutomaticDesignReviewContext(options.automaticEvidence)
        : ""),
  );

  return {
    backend,
    run: async () => {
      const firstResult = await backend.generate(
        DESIGN_REVIEW_REQUEST,
        screenshotAttachments(options.conversationId, options.screenshots),
      );
      if (!sameFiles(initialFiles, backend.getFiles())) {
        backend.setFiles(initialFiles);
        throw new Error(
          "Design Review attempted to change project files; all changes were discarded.",
        );
      }
      if (!acceptedReport) {
        const textReport = parseDesignReviewReportText(firstResult.text);
        if (textReport) acceptReport(textReport);
      }
      if (!acceptedReport && !firstResult.aborted) {
        // The analysis already exists in this isolated conversation. Give a
        // compatible provider one bounded, submit-only protocol repair turn.
        backend.setTools(customTools);
        const repairResult = await backend.generate(
          DESIGN_REVIEW_PROTOCOL_REPAIR_REQUEST,
        );
        if (!sameFiles(initialFiles, backend.getFiles())) {
          backend.setFiles(initialFiles);
          throw new Error(
            "Design Review attempted to change project files; all changes were discarded.",
          );
        }
        if (!acceptedReport) {
          const textReport = parseDesignReviewReportText(repairResult.text);
          if (textReport) acceptReport(textReport);
        }
      }
      if (!acceptedReport) {
        throw new Error(
          `The ${providerRef(options.provider)} model did not submit a structured Design Review report.`,
        );
      }
      return acceptedReport;
    },
  };
}
