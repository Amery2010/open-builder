import type { Message, ProjectFiles } from "../../ai/generator-types";
import type { OpenAIClientConfig } from "../../ai/client";
import type { LocalAgentClientConfig } from "../../local-agent/generator";
import type { AutomaticDesignReviewEvidence } from "../automatic-review";
import type { DesignReviewReport, DesignReviewScreenshot } from "../review";
import type { ResolvedLocale } from "../../../i18n";

export const DESIGN_REVIEW_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type DesignReviewTerminalStatus =
  (typeof DESIGN_REVIEW_TERMINAL_STATUSES)[number];

export type DesignReviewRunStatus =
  | "capturing"
  | "queued"
  | "running"
  | "fixing"
  | "verifying"
  | DesignReviewTerminalStatus;

export type DesignReviewFreshness = "fresh" | "stale";
export type DesignReviewRunKind = "manual" | "automatic";

export type DesignReviewLogEvent =
  | "capture_complete"
  | "queued"
  | "runtime_started"
  | "fixing"
  | "verifying"
  | "retry"
  | "tool_call"
  | "report_received"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "stale";

export interface DesignReviewLogEntry {
  id: string;
  at: number;
  level: "info" | "warning" | "error";
  event: DesignReviewLogEvent;
  message: string;
  toolName?: "list_files" | "read_files" | "search_in_files";
  count?: number;
}

export interface DesignReviewProviderRef {
  runtime: "api" | "local";
  provider: string;
  model: string;
}

/** Persistable Design Review state. Screenshots and project files never belong here. */
export interface DesignReviewRun {
  id: string;
  conversationId: string;
  kind: DesignReviewRunKind;
  phase: "initial" | "verify";
  status: DesignReviewRunStatus;
  freshness: DesignReviewFreshness;
  sourceDigest: string;
  /** Files plus applied Design-system digest, used for stale checks after reload. */
  sourceProjectDigest?: string;
  provider: DesignReviewProviderRef;
  logs: DesignReviewLogEntry[];
  report?: DesignReviewReport;
  error?: string;
  retryOf?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export type DesignReviewBackendConfig =
  | {
      runtime: "api";
      config: OpenAIClientConfig;
    }
  | {
      runtime: "local";
      config: Pick<LocalAgentClientConfig, "provider" | "model" | "effort">;
    };

/** Volatile input retained only until its queued run finishes or is cancelled. */
export interface DesignReviewJobInput {
  conversationId: string;
  kind: DesignReviewRunKind;
  locale: ResolvedLocale;
  phase?: "initial" | "verify";
  sourceDigest: string;
  sourceProjectDigest?: string;
  files: ProjectFiles;
  screenshots: readonly DesignReviewScreenshot[];
  provider: DesignReviewBackendConfig;
  requirementsMessages?: readonly Message[];
  automaticEvidence?: AutomaticDesignReviewEvidence;
  captureErrors?: readonly string[];
  retryOf?: string;
}

export function isDesignReviewTerminalStatus(
  status: DesignReviewRunStatus,
): status is DesignReviewTerminalStatus {
  return DESIGN_REVIEW_TERMINAL_STATUSES.includes(
    status as DesignReviewTerminalStatus,
  );
}

export function isDesignReviewRunActive(run: DesignReviewRun): boolean {
  return !isDesignReviewTerminalStatus(run.status);
}
