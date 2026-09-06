import type { LocalAgentProvider } from "./providers";

export type { LocalAgentProvider } from "./providers";
export type LocalAgentAvailability =
  "notFound" | "unsupported" | "needsSetup" | "ready" | "error";

/** The backend's launch-level readiness. Availability is retained for older
 * persisted responses; callers that decide whether a run may start should use
 * this status after normalizing a probe. */
export type LocalCliInspectionStatus =
  "ready" | "verificationRequired" | "setupRequired" | "unavailable";

export type LocalCliUnavailableReason =
  "notFound" | "unsupported" | "hostUnsupported" | "probeError";

export type LocalCliCatalogAuthority = "authoritative" | "partial";

export type LocalAgentRunScopeKind = "conversation" | "utility";

export interface LocalAgentRunScope {
  kind: LocalAgentRunScopeKind;
  id: string;
}

export interface LocalAgentModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultEffort?: string;
  efforts: string[];
}

export interface LocalAgentPreference {
  model: string;
  effort: string;
}

export type PreferenceDecision =
  | { kind: "keep"; unverified: boolean }
  | { kind: "replace"; preference: LocalAgentPreference };

export interface LocalAgentProbe {
  provider: LocalAgentProvider;
  availability: LocalAgentAvailability;
  /** Added by the Verified Local CLI Run wire. Optional for old desktop builds. */
  status?: LocalCliInspectionStatus;
  reasonCode?: LocalCliUnavailableReason;
  path?: string;
  pathSource?: "override" | "path" | "common";
  version?: string;
  installationFingerprint?: string;
  catalogAuthority?: LocalCliCatalogAuthority;
  checkedAt?: number;
  setupCommand: string;
  models: LocalAgentModel[];
  efforts: string[];
  preferenceDecision: PreferenceDecision;
  capabilities: {
    sessions: boolean;
    reasoning: boolean;
    tools: boolean;
    nativeSearch: boolean;
    /** Optional on older desktop builds and persisted observations. */
    imageGeneration?: boolean;
    /** Optional on older desktop builds and persisted observations. */
    imageEditing?: boolean;
    /** True only when the backend completed a provider capability probe. */
    mediaCapabilitiesVerified?: boolean;
  };
  message?: string;
}

export interface LocalImageReferenceInput {
  id: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** Raw base64 without a data URL prefix. */
  data: string;
}

export interface LocalImageGenerationRequest {
  taskId: string;
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  prompt: string;
  references: LocalImageReferenceInput[];
}

export interface LocalGeneratedImage {
  id: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** Raw base64 without a data URL prefix. */
  data: string;
  size: number;
  sha256: string;
  revisedPrompt?: string;
  fileName?: string;
}

export interface LocalToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP capability hints. These describe a tool; they never grant access. */
  annotations?: LocalToolAnnotations;
  /** Host-side authorization metadata projected to the provider. */
  hostApproval?: LocalToolHostApproval;
}

export interface LocalToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type LocalToolHostApproval = "none" | "session" | "perCall";

export type LocalToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource";
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
    };

export interface LocalToolResolution {
  text: string;
  isError?: boolean;
  structuredContent?: unknown;
  content?: LocalToolContent[];
}

export interface LocalAgentStartRequest {
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  systemPrompt: string;
  prompt: string;
  bootstrapContext?: string;
  sessionId?: string;
  sessionCompatibilityKey?: string;
  scope: LocalAgentRunScope;
  tools: LocalToolSpec[];
  nativeSearch: boolean;
  maxToolCalls: number;
  mode: "chat" | "plan" | "auto_qa" | "subagent";
}

export type LocalAgentEvent =
  | { type: "status"; state: string; message?: string }
  | { type: "session"; sessionId: string; cliVersion: string }
  | {
      type: "prepared";
      compatibilityKey: string;
      installationFingerprint: string;
      cliVersion: string;
      actualModel?: string | null;
      actualEffort?: string | null;
      resumed: boolean;
    }
  | { type: "textDelta"; delta: string }
  | { type: "reasoningDelta"; delta: string }
  | {
      type: "toolRequest";
      runId: string;
      callId: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "nativeTool";
      callId: string;
      name: string;
      phase: "started" | "completed";
      arguments?: unknown;
      result?: unknown;
    }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    }
  | { type: "warning"; message: string }
  | {
      type: "error";
      message: string;
      retryable: boolean;
      failure?: LocalCliFailure;
    }
  | { type: "done"; aborted: boolean; sessionId?: string };

export type LocalCliFailureCode =
  | "executableNotFound"
  | "cliUnsupported"
  | "setupRequired"
  | "selectionRejected"
  | "installationChanged"
  | "credentialRejected"
  | "modelRejected"
  | "runAlreadyActive"
  | "providerApprovalRejected"
  | "spawnFailed"
  | "inputFailed"
  | "handshakeFailed"
  | "sessionUnavailable"
  | "toolBridgeFailed"
  | "isolationViolation"
  | "protocolViolation"
  | "outputLimit"
  | "timeout"
  | "processExit"
  | "cancelled"
  | "consumerGone"
  | "internal";

export type LocalCliFailurePhase =
  | "inspect"
  | "prepare"
  | "spawn"
  | "input"
  | "handshake"
  | "stream"
  | "tool"
  | "shutdown";

export type LocalCliRetryPolicy =
  "none" | "reprobe" | "afterSetup" | "freshSessionSafe" | "manual";

export interface LocalCliFailure {
  code: LocalCliFailureCode;
  phase: LocalCliFailurePhase;
  provider: LocalAgentProvider;
  safeMessage: string;
  diagnosticId: string;
  hadActivity: boolean;
  hadHostSideEffect: boolean;
  retryPolicy: LocalCliRetryPolicy;
}

export interface LocalCliPreparedMetadata {
  compatibilityKey: string;
  installationFingerprint: string;
  cliVersion: string;
  actualModel?: string;
  actualEffort?: string;
  resumed: boolean;
}

export interface LocalCliUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface LocalCliRunStatus {
  state: string;
  message?: string;
}

export interface LocalCliHostToolOutcome {
  resolution: LocalToolResolution;
  /** True only after the Host execution seam was crossed for a side-effecting
   * tool. Validation, policy, budget and authorization denials are false. */
  hadSideEffect: boolean;
}
