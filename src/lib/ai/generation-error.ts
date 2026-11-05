import type {
  StructuredGenerationError,
  StructuredGenerationErrorKind,
} from "./generator-types";
import type { Translations } from "../../i18n";
import {
  isLocalCliFailure,
  isLocalCliRuntimeError,
  redactLocalCliMessage,
} from "../local-agent/runtime";
import { LOCAL_AGENT_PROVIDER_CATALOG } from "../local-agent/providers";
import type {
  LocalCliFailure,
  LocalCliFailureCode,
} from "../local-agent/types";

const KIND_PATTERNS: Array<{
  kind: StructuredGenerationErrorKind;
  retryable: boolean;
  pattern: RegExp;
}> = [
  {
    kind: "context_length",
    retryable: true,
    pattern: /context_length_exceeded|context length|maximum context/i,
  },
  {
    kind: "auth",
    retryable: false,
    pattern: /api key|unauthorized|forbidden|invalid key|permission/i,
  },
  {
    kind: "network",
    retryable: true,
    pattern: /network|fetch|timeout|timed out|failed to fetch/i,
  },
  {
    kind: "tool",
    retryable: true,
    pattern: /tool|invalid arguments|schema|tool call/i,
  },
  {
    kind: "runtime_check",
    retryable: true,
    pattern: /automatic qa|runtime check|health check|project_health_check/i,
  },
];

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "Unknown error";
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Unknown error";
}

export function getGenerationErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as { statusCode?: unknown; status?: unknown };
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  return typeof candidate.status === "number" ? candidate.status : undefined;
}

function getExplicitRetryable(err: unknown): boolean | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as { isRetryable?: unknown; retryable?: unknown };
  if (typeof candidate.isRetryable === "boolean") {
    return candidate.isRetryable;
  }
  return typeof candidate.retryable === "boolean"
    ? candidate.retryable
    : undefined;
}

function getLocalCliFailure(err: unknown): LocalCliFailure | undefined {
  if (isLocalCliRuntimeError(err)) return sanitizeLocalCliFailure(err.failure);
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as {
    failure?: unknown;
  };
  if (!candidate.failure || typeof candidate.failure !== "object") {
    return undefined;
  }
  return isLocalCliFailure(candidate.failure)
    ? sanitizeLocalCliFailure(candidate.failure)
    : undefined;
}

function sanitizeLocalCliFailure(failure: LocalCliFailure): LocalCliFailure {
  return {
    ...failure,
    safeMessage: redactLocalCliMessage(failure.safeMessage),
  };
}

function localFailureKind(
  code: LocalCliFailureCode,
): StructuredGenerationErrorKind {
  switch (code) {
    case "credentialRejected":
    case "setupRequired":
      return "auth";
    case "modelRejected":
    case "selectionRejected":
    case "cliUnsupported":
      return "model";
    case "toolBridgeFailed":
    case "toolBudgetExceeded":
    case "providerApprovalRejected":
    case "isolationViolation":
      return "tool";
    case "executableNotFound":
    case "installationChanged":
    case "spawnFailed":
    case "inputFailed":
    case "handshakeFailed":
    case "sessionUnavailable":
    case "timeout":
    case "processExit":
    case "consumerGone":
    case "runAlreadyActive":
    case "protocolViolation":
    case "outputLimit":
    case "internal":
      return "local_cli";
    case "cancelled":
      return "aborted";
    default:
      return "unknown";
  }
}

function localFailureRetryable(failure: LocalCliFailure): boolean {
  if (failure.code === "cancelled") return false;
  if (
    failure.code === "credentialRejected" ||
    failure.code === "setupRequired" ||
    failure.code === "modelRejected" ||
    failure.code === "selectionRejected" ||
    failure.code === "cliUnsupported" ||
    failure.code === "providerApprovalRejected" ||
    failure.code === "installationChanged" ||
    failure.code === "executableNotFound"
  ) {
    return false;
  }
  return failure.retryPolicy !== "none";
}

function retryableFromMetadata(
  err: unknown,
  status: number | undefined,
): boolean | undefined {
  if (
    err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  ) {
    return false;
  }
  if (status === 401 || status === 403) return false;

  const explicit = getExplicitRetryable(err);
  if (explicit !== undefined) return explicit;
  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status ?? 0) >= 500
  ) {
    return true;
  }
  if (status !== undefined && status >= 400 && status < 500) return false;
  return undefined;
}

export function classifyGenerationError(
  err: unknown,
): StructuredGenerationError {
  const message = getErrorMessage(err);
  const status = getGenerationErrorStatus(err);
  const metadataRetryable = retryableFromMetadata(err, status);
  const localFailure = getLocalCliFailure(err);

  if (localFailure) {
    return {
      kind: localFailureKind(localFailure.code),
      message: localFailure.safeMessage,
      retryable: localFailureRetryable(localFailure),
      status,
      localCliFailure: localFailure,
    };
  }

  if (
    err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  ) {
    return { kind: "aborted", message, retryable: false, status };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", message, retryable: false, status };
  }
  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  ) {
    return {
      kind: "model",
      message,
      retryable: metadataRetryable ?? true,
      status,
    };
  }

  for (const candidate of KIND_PATTERNS) {
    if (candidate.pattern.test(message)) {
      return {
        kind: candidate.kind,
        message,
        retryable:
          candidate.kind === "auth"
            ? false
            : (metadataRetryable ?? candidate.retryable),
        status,
      };
    }
  }

  return {
    kind: "unknown",
    message,
    retryable: metadataRetryable ?? true,
    status,
  };
}

export function isRetryableGenerationError(err: unknown): boolean {
  return classifyGenerationError(err).retryable;
}

export function formatGenerationErrorMessage(
  error: StructuredGenerationError,
  t: Translations,
): string {
  const label = error.localCliFailure
    ? t.message.generationError.kinds.local_cli
    : t.message.generationError.kinds[error.kind];
  const action = error.localCliFailure
    ? t.message.generationError.actions.local_cli
    : t.message.generationError.actions[error.kind];
  const status = error.status
    ? `\n\n${t.message.generationError.status.replace("{status}", String(error.status))}`
    : "";
  const retryHint = error.retryable
    ? `\n\n${t.message.generationError.retryable}`
    : "";
  let detailMessage = error.localCliFailure
    ? t.message.generationError.localCli.failureCodes[
        error.localCliFailure.code
      ]
    : error.message;
  // Legacy processExit records include different Host-authored summaries.
  // Translate only these exact summaries; provider prose stays hidden.
  if (error.localCliFailure?.code === "processExit") {
    if (
      error.localCliFailure.safeMessage ===
      "The local CLI provider rate limit prevented this request from completing."
    ) {
      detailMessage =
        t.message.generationError.localCli.failureDetails.rateLimited;
    } else if (
      error.localCliFailure.safeMessage ===
      "The local CLI stopped before completing the request. Your changes have been kept. Retry to continue."
    ) {
      detailMessage =
        t.message.generationError.localCli.failureDetails.unexpectedStop;
    }
  }

  const localDetails = error.localCliFailure
    ? [
        `**${t.message.generationError.localCli.provider}:** ${LOCAL_AGENT_PROVIDER_CATALOG[error.localCliFailure.provider]?.displayName ?? error.localCliFailure.provider}`,
        `**${t.message.generationError.localCli.phase}:** ${t.message.generationError.localCli.phases[error.localCliFailure.phase]}`,
        `**${t.message.generationError.localCli.retryPolicy}:** ${t.message.generationError.localCli.retryPolicies[error.localCliFailure.retryPolicy]}`,
        `**${t.message.generationError.localCli.diagnosticId}:** \`${error.localCliFailure.diagnosticId}\``,
      ].join("\n")
    : "";

  const sections = [
    `⚠️ **${label}**`,
    action,
    `${t.message.generationError.detail}\n\n\`${detailMessage}\`${status}${retryHint}`,
  ];
  if (localDetails) sections.push(localDetails);
  return sections.join("\n\n");
}
