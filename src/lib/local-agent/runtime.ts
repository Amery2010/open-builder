import * as tauri from "./tauri";
import type {
  LocalAgentEvent,
  LocalAgentPreference,
  LocalAgentProbe,
  LocalAgentProvider,
  LocalAgentStartRequest,
  LocalCliCatalogAuthority,
  LocalCliFailure,
  LocalCliFailureCode,
  LocalCliFailurePhase,
  LocalCliInspectionStatus,
  LocalCliPreparedMetadata,
  LocalCliRetryPolicy,
  LocalCliUnavailableReason,
  LocalCliUsage,
  LocalCliRunStatus,
  LocalCliHostToolOutcome,
  LocalToolResolution,
} from "./types";
import { isLocalAgentProvider } from "./providers";

const EVENT_TYPE_ALIASES: Record<string, LocalAgentEvent["type"]> = {
  status: "status",
  session: "session",
  prepared: "prepared",
  textDelta: "textDelta",
  text_delta: "textDelta",
  reasoningDelta: "reasoningDelta",
  reasoning_delta: "reasoningDelta",
  toolRequest: "toolRequest",
  tool_request: "toolRequest",
  nativeTool: "nativeTool",
  native_tool: "nativeTool",
  usage: "usage",
  warning: "warning",
  error: "error",
  done: "done",
};

const LOCAL_CLI_FAILURE_CODES: readonly LocalCliFailureCode[] = [
  "executableNotFound",
  "cliUnsupported",
  "setupRequired",
  "selectionRejected",
  "installationChanged",
  "credentialRejected",
  "modelRejected",
  "runAlreadyActive",
  "providerApprovalRejected",
  "spawnFailed",
  "inputFailed",
  "handshakeFailed",
  "sessionUnavailable",
  "toolBridgeFailed",
  "isolationViolation",
  "protocolViolation",
  "outputLimit",
  "timeout",
  "processExit",
  "cancelled",
  "consumerGone",
  "internal",
];

const LOCAL_CLI_FAILURE_PHASES: readonly LocalCliFailurePhase[] = [
  "inspect",
  "prepare",
  "spawn",
  "input",
  "handshake",
  "stream",
  "tool",
  "shutdown",
];

const LOCAL_CLI_RETRY_POLICIES: readonly LocalCliRetryPolicy[] = [
  "none",
  "reprobe",
  "afterSetup",
  "freshSessionSafe",
  "manual",
];

const LOCAL_CLI_UNAVAILABLE_REASONS: readonly LocalCliUnavailableReason[] = [
  "notFound",
  "unsupported",
  "hostUnsupported",
  "probeError",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function valueWithAliases(
  record: Record<string, unknown>,
  camelCase: string,
  snakeCase: string,
): unknown {
  return record[camelCase] ?? record[snakeCase];
}

export function redactLocalCliMessage(message: string): string {
  return message
    .replace(
      /(authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/\bbearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /((?:api[_ -]?key|access[_ -]?token|password|secret|token)\s*)(?:[:=]|\s)\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 600);
}

function diagnosticId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `local-cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function isLocalCliFailure(value: unknown): value is LocalCliFailure {
  if (!isRecord(value)) return false;
  return (
    isOneOf(value.code, LOCAL_CLI_FAILURE_CODES) &&
    isOneOf(value.phase, LOCAL_CLI_FAILURE_PHASES) &&
    isLocalAgentProvider(value.provider) &&
    typeof value.safeMessage === "string" &&
    value.safeMessage.trim().length > 0 &&
    typeof value.diagnosticId === "string" &&
    value.diagnosticId.trim().length > 0 &&
    typeof value.hadActivity === "boolean" &&
    typeof value.hadHostSideEffect === "boolean" &&
    isOneOf(value.retryPolicy, LOCAL_CLI_RETRY_POLICIES)
  );
}

function normalizeFailure(
  value: unknown,
  provider: LocalAgentProvider,
  fallback: {
    message: string;
    retryable?: boolean;
    phase: LocalCliFailurePhase;
    hadActivity: boolean;
    hadHostSideEffect: boolean;
  },
): LocalCliFailure {
  if (isRecord(value)) {
    const code = value.code;
    const phase = value.phase;
    const retryPolicy = valueWithAliases(value, "retryPolicy", "retry_policy");
    const safeMessage = valueWithAliases(value, "safeMessage", "safe_message");
    const id = valueWithAliases(value, "diagnosticId", "diagnostic_id");
    if (
      isOneOf(code, LOCAL_CLI_FAILURE_CODES) &&
      isOneOf(phase, LOCAL_CLI_FAILURE_PHASES) &&
      isOneOf(retryPolicy, LOCAL_CLI_RETRY_POLICIES) &&
      typeof safeMessage === "string"
    ) {
      return {
        code,
        phase,
        provider: isLocalAgentProvider(value.provider)
          ? value.provider
          : provider,
        safeMessage: redactLocalCliMessage(safeMessage),
        diagnosticId: typeof id === "string" ? id : diagnosticId(),
        hadActivity:
          booleanValue(
            valueWithAliases(value, "hadActivity", "had_activity"),
          ) ?? fallback.hadActivity,
        hadHostSideEffect:
          booleanValue(
            valueWithAliases(
              value,
              "hadHostSideEffect",
              "had_host_side_effect",
            ),
          ) ?? fallback.hadHostSideEffect,
        retryPolicy,
      };
    }
  }

  return {
    code: fallbackCode(fallback.phase),
    phase: fallback.phase,
    provider,
    safeMessage: redactLocalCliMessage(
      fallback.message || "The local CLI run failed.",
    ),
    diagnosticId: diagnosticId(),
    hadActivity: fallback.hadActivity,
    hadHostSideEffect: fallback.hadHostSideEffect,
    retryPolicy: fallback.retryable ? "manual" : "none",
  };
}

function fallbackCode(phase: LocalCliFailurePhase): LocalCliFailureCode {
  switch (phase) {
    case "inspect":
      return "internal";
    case "prepare":
      return "selectionRejected";
    case "spawn":
      return "spawnFailed";
    case "input":
      return "inputFailed";
    case "handshake":
      return "handshakeFailed";
    case "tool":
      return "toolBridgeFailed";
    case "shutdown":
      return "processExit";
    case "stream":
      return "processExit";
  }
}

function failureWithActivity(
  failure: LocalCliFailure,
  hadActivity: boolean,
  hadHostSideEffect: boolean,
): LocalCliFailure {
  return {
    ...failure,
    hadActivity: failure.hadActivity || hadActivity,
    hadHostSideEffect: failure.hadHostSideEffect || hadHostSideEffect,
  };
}

function inspectionStatus(probe: LocalAgentProbe): LocalCliInspectionStatus {
  if (
    isOneOf(probe.status, [
      "ready",
      "verificationRequired",
      "setupRequired",
      "unavailable",
    ] as const)
  ) {
    return probe.status;
  }
  switch (probe.availability) {
    case "ready":
      return "ready";
    case "needsSetup":
      return "setupRequired";
    case "notFound":
    case "unsupported":
    case "error":
    default:
      return "unavailable";
  }
}

function inspectionReason(
  probe: LocalAgentProbe,
): LocalCliUnavailableReason | undefined {
  if (isOneOf(probe.reasonCode, LOCAL_CLI_UNAVAILABLE_REASONS)) {
    return probe.reasonCode;
  }
  switch (probe.availability) {
    case "notFound":
      return "notFound";
    case "unsupported":
      return "unsupported";
    case "error":
      return "probeError";
    default:
      return undefined;
  }
}

export interface LocalCliInspection extends LocalAgentProbe {
  status: LocalCliInspectionStatus;
  catalogAuthority: LocalCliCatalogAuthority;
  checkedAt: number;
}

export interface LocalCliInspectInput {
  provider: LocalAgentProvider;
  preference: LocalAgentPreference;
  forceRefresh?: boolean;
}

export interface LocalCliHostToolRequest {
  type: "toolRequest";
  runId: string;
  callId: string;
  name: string;
  arguments: unknown;
}

export interface LocalCliRuntimeHooks {
  onEvent?: (event: LocalAgentEvent) => void;
  executeHostTool?: (
    request: LocalCliHostToolRequest,
    signal: AbortSignal,
  ) => Promise<LocalCliHostToolOutcome>;
}

export interface LocalCliRunResult {
  runId: string;
  aborted: boolean;
  sessionId?: string;
  cliVersion?: string;
  prepared?: LocalCliPreparedMetadata;
  usage?: LocalCliUsage;
  warnings: string[];
  status?: LocalCliRunStatus;
  text: string;
  reasoning: string;
}

export class LocalCliRuntimeError extends Error {
  readonly failure: LocalCliFailure;
  readonly runId?: string;

  constructor(failure: LocalCliFailure, runId?: string, cause?: unknown) {
    super(failure.safeMessage, cause === undefined ? undefined : { cause });
    this.name =
      failure.code === "cancelled" ? "AbortError" : "LocalCliRuntimeError";
    this.failure = failure;
    this.runId = runId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isLocalCliRuntimeError(
  value: unknown,
): value is LocalCliRuntimeError {
  return value instanceof LocalCliRuntimeError;
}

export interface LocalCliRuntimeDependencies {
  supports: () => Promise<boolean>;
  inspect: (
    provider: LocalAgentProvider,
    preference: LocalAgentPreference,
    forceRefresh?: boolean,
  ) => Promise<LocalAgentProbe>;
  start: LocalCliRuntimeStart;
  resolveTool: (
    runId: string,
    callId: string,
    result: LocalToolResolution,
  ) => Promise<void>;
  cancel: (runId: string) => Promise<boolean>;
}

type LocalCliRuntimeStart = (
  request: LocalAgentStartRequest,
  onEvent: (event: LocalAgentEvent) => void,
) => Promise<string>;

const defaultDependencies: LocalCliRuntimeDependencies = {
  supports: () => tauri.supportsLocalAgents(),
  inspect: (provider, preference, forceRefresh) =>
    tauri.probeLocalAgent(provider, preference, forceRefresh),
  start: (request, onEvent) => tauri.startLocalAgent(request, onEvent),
  resolveTool: (runId, callId, result) =>
    tauri.resolveLocalAgentTool(runId, callId, result),
  cancel: (runId) => tauri.cancelLocalAgent(runId),
};

function normalizeEvent(
  value: unknown,
  provider: LocalAgentProvider,
): { kind: "event"; event: LocalAgentEvent } | { kind: "unknown" } {
  if (!isRecord(value)) return { kind: "unknown" };
  const rawType = value.type;
  const type =
    typeof rawType === "string" ? EVENT_TYPE_ALIASES[rawType] : undefined;
  if (!type) {
    return { kind: "unknown" };
  }

  switch (type) {
    case "status": {
      const state = stringValue(value.state);
      if (!state) return { kind: "unknown" };
      return {
        kind: "event",
        event: {
          type,
          state,
          message:
            stringValue(value.message) === undefined
              ? undefined
              : redactLocalCliMessage(stringValue(value.message) as string),
        },
      };
    }
    case "session": {
      const sessionId = stringValue(
        valueWithAliases(value, "sessionId", "session_id"),
      );
      const cliVersion = stringValue(
        valueWithAliases(value, "cliVersion", "cli_version"),
      );
      if (!sessionId || !cliVersion) return { kind: "unknown" };
      return { kind: "event", event: { type, sessionId, cliVersion } };
    }
    case "prepared": {
      const compatibilityKey = stringValue(
        valueWithAliases(value, "compatibilityKey", "compatibility_key"),
      );
      const installationFingerprint = stringValue(
        valueWithAliases(
          value,
          "installationFingerprint",
          "installation_fingerprint",
        ),
      );
      const cliVersion = stringValue(
        valueWithAliases(value, "cliVersion", "cli_version"),
      );
      const resumed = booleanValue(value.resumed);
      if (
        !compatibilityKey ||
        !installationFingerprint ||
        !cliVersion ||
        resumed === undefined
      ) {
        return { kind: "unknown" };
      }
      return {
        kind: "event",
        event: {
          type,
          compatibilityKey,
          installationFingerprint,
          cliVersion,
          actualModel:
            stringValue(
              valueWithAliases(value, "actualModel", "actual_model"),
            ) ?? null,
          actualEffort:
            stringValue(
              valueWithAliases(value, "actualEffort", "actual_effort"),
            ) ?? null,
          resumed,
        },
      };
    }
    case "textDelta":
    case "reasoningDelta": {
      const delta = stringValue(value.delta);
      if (delta === undefined) return { kind: "unknown" };
      return { kind: "event", event: { type, delta } };
    }
    case "toolRequest": {
      const runId = stringValue(valueWithAliases(value, "runId", "run_id"));
      const callId = stringValue(valueWithAliases(value, "callId", "call_id"));
      const name = stringValue(value.name);
      if (!runId || !callId || !name || !("arguments" in value)) {
        return { kind: "unknown" };
      }
      return {
        kind: "event",
        event: { type, runId, callId, name, arguments: value.arguments },
      };
    }
    case "nativeTool": {
      const callId = stringValue(valueWithAliases(value, "callId", "call_id"));
      const name = stringValue(value.name);
      const phase = value.phase;
      if (!callId || !name || (phase !== "started" && phase !== "completed")) {
        return { kind: "unknown" };
      }
      return {
        kind: "event",
        event: {
          type,
          callId,
          name,
          phase,
          arguments: value.arguments,
          result: value.result,
        },
      };
    }
    case "usage":
      return {
        kind: "event",
        event: {
          type,
          inputTokens: numberValue(
            valueWithAliases(value, "inputTokens", "input_tokens"),
          ),
          outputTokens: numberValue(
            valueWithAliases(value, "outputTokens", "output_tokens"),
          ),
          cachedInputTokens: numberValue(
            valueWithAliases(value, "cachedInputTokens", "cached_input_tokens"),
          ),
        },
      };
    case "warning": {
      const message = stringValue(value.message);
      if (!message) return { kind: "unknown" };
      return {
        kind: "event",
        event: { type, message: redactLocalCliMessage(message) },
      };
    }
    case "error": {
      const message = stringValue(value.message) ?? "The local CLI run failed.";
      const retryable = booleanValue(value.retryable) ?? false;
      const typedFailure =
        value.failure === undefined
          ? undefined
          : normalizeFailure(value.failure, provider, {
              message,
              retryable,
              phase: "stream",
              hadActivity: false,
              hadHostSideEffect: false,
            });
      return {
        kind: "event",
        event: {
          type,
          // Provider stderr and legacy error prose never cross the runtime
          // boundary. New backends provide the user-safe failure message in
          // `failure`; old backends receive a stable generic fallback.
          message:
            typedFailure?.safeMessage ?? "The local CLI reported an error.",
          retryable,
          ...(typedFailure ? { failure: typedFailure } : {}),
        },
      };
    }
    case "done": {
      const aborted = booleanValue(value.aborted);
      if (aborted === undefined) return { kind: "unknown" };
      return {
        kind: "event",
        event: {
          type,
          aborted,
          sessionId: stringValue(
            valueWithAliases(value, "sessionId", "session_id"),
          ),
        },
      };
    }
  }
}

function createAbortError(
  provider: LocalAgentProvider,
  runId?: string,
): LocalCliRuntimeError {
  return new LocalCliRuntimeError(
    {
      code: "cancelled",
      phase: "shutdown",
      provider,
      safeMessage: "The local CLI run was cancelled.",
      diagnosticId: diagnosticId(),
      hadActivity: false,
      hadHostSideEffect: false,
      retryPolicy: "none",
    },
    runId,
  );
}

function isAbortError(cause: unknown): boolean {
  return (
    Boolean(cause) &&
    typeof cause === "object" &&
    (cause as { name?: unknown }).name === "AbortError"
  );
}

export class LocalCliRuntime {
  private readonly dependencies: LocalCliRuntimeDependencies;

  constructor(dependencies: Partial<LocalCliRuntimeDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async inspect(input: LocalCliInspectInput): Promise<LocalCliInspection> {
    if (!isLocalAgentProvider(input.provider)) {
      throw new LocalCliRuntimeError({
        code: "selectionRejected",
        phase: "inspect",
        provider: "codex",
        safeMessage: "The selected local CLI provider is invalid.",
        diagnosticId: diagnosticId(),
        hadActivity: false,
        hadHostSideEffect: false,
        retryPolicy: "none",
      });
    }
    try {
      if (!(await this.dependencies.supports())) {
        return {
          provider: input.provider,
          availability: "unsupported",
          status: "unavailable",
          reasonCode: "hostUnsupported",
          setupCommand: "",
          models: [],
          efforts: [],
          preferenceDecision: { kind: "keep", unverified: false },
          capabilities: {
            sessions: false,
            reasoning: false,
            tools: false,
            nativeSearch: false,
          },
          message: "Local CLI agents are unavailable on this host.",
          catalogAuthority: "partial",
          checkedAt: Date.now(),
        };
      }
      const probe = await this.dependencies.inspect(
        input.provider,
        input.preference,
        input.forceRefresh ?? false,
      );
      return {
        ...probe,
        status: inspectionStatus(probe),
        reasonCode: inspectionReason(probe),
        catalogAuthority: probe.catalogAuthority ?? "partial",
        checkedAt: probe.checkedAt ?? Date.now(),
      };
    } catch (cause) {
      throw new LocalCliRuntimeError(
        normalizeFailure(undefined, input.provider, {
          message: "The local CLI capability check failed.",
          phase: "inspect",
          hadActivity: false,
          hadHostSideEffect: false,
        }),
        undefined,
        cause,
      );
    }
  }

  async run(
    request: LocalAgentStartRequest,
    hooks: LocalCliRuntimeHooks = {},
    signal?: AbortSignal,
  ): Promise<LocalCliRunResult> {
    if (signal?.aborted) throw createAbortError(request.provider);

    let runId: string | undefined;
    let settled = false;
    let abortRequested = false;
    let externallyAborted = false;
    let hadActivity = false;
    let hadHostSideEffect = false;
    let text = "";
    let reasoning = "";
    let sessionId: string | undefined;
    let cliVersion: string | undefined;
    let prepared: LocalCliPreparedMetadata | undefined;
    let usage: LocalCliUsage | undefined;
    let status: LocalCliRunStatus | undefined;
    let warnings: string[] = [];
    let failure: LocalCliFailure | undefined;
    let doneEvent: Extract<LocalAgentEvent, { type: "done" }> | undefined;
    let toolQueue = Promise.resolve();
    const resolvedToolCalls = new Set<string>();
    let removeAbortListener: (() => void) | undefined;
    let startResolved = false;
    let resolveRun!: (result: LocalCliRunResult) => void;
    let rejectRun!: (error: unknown) => void;
    const completed = new Promise<LocalCliRunResult>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });

    const resolveCompletedRun = (
      done: Extract<LocalAgentEvent, { type: "done" }>,
    ) => {
      if (settled || !startResolved) return;
      settled = true;
      removeAbortListener?.();
      resolveRun({
        runId: runId ?? "unknown",
        aborted: done.aborted || abortRequested,
        sessionId: done.sessionId ?? sessionId,
        cliVersion,
        prepared,
        usage,
        warnings,
        status,
        text,
        reasoning,
      });
    };

    const rejectWithFailure = (
      nextFailure: LocalCliFailure,
      cause?: unknown,
    ) => {
      if (settled) return;
      settled = true;
      removeAbortListener?.();
      rejectRun(new LocalCliRuntimeError(nextFailure, runId, cause));
    };

    const finish = (done: Extract<LocalAgentEvent, { type: "done" }>) => {
      if ((doneEvent && doneEvent !== done) || settled) return;
      doneEvent = doneEvent ?? done;
      void toolQueue.then(
        () => {
          if (settled || !startResolved) return;
          const finalFailure = failure
            ? failureWithActivity(failure, hadActivity, hadHostSideEffect)
            : undefined;
          if (
            finalFailure &&
            !(
              finalFailure.code === "cancelled" &&
              (done.aborted || abortRequested)
            )
          ) {
            rejectWithFailure(finalFailure);
            return;
          }
          resolveCompletedRun(done);
        },
        (cause) => {
          if (
            startResolved &&
            (externallyAborted || (done.aborted && !failure))
          ) {
            resolveCompletedRun(done);
            return;
          }
          const nextFailure = normalizeFailure(cause, request.provider, {
            message: cause instanceof Error ? cause.message : String(cause),
            phase: "tool",
            retryable: true,
            hadActivity,
            hadHostSideEffect,
          });
          rejectWithFailure(
            failureWithActivity(nextFailure, hadActivity, hadHostSideEffect),
            cause,
          );
        },
      );
    };

    const abort = () => {
      abortRequested = true;
      if (runId) {
        void this.dependencies.cancel(runId).catch(() => undefined);
      }
    };

    const onEvent = (rawEvent: LocalAgentEvent) => {
      if (doneEvent || settled) return;
      const normalized = normalizeEvent(rawEvent, request.provider);
      if (normalized.kind === "unknown") {
        const nextFailure = normalizeFailure(undefined, request.provider, {
          message: "The local CLI returned an unsupported capability event.",
          phase: "stream",
          retryable: false,
          hadActivity,
          hadHostSideEffect,
        });
        failure = {
          ...nextFailure,
          code: "protocolViolation",
          retryPolicy: "none",
        };
        abort();
        return;
      }

      const event = normalized.event;
      try {
        hooks.onEvent?.(event);
      } catch (cause) {
        failure = normalizeFailure(cause, request.provider, {
          message: "The local CLI event consumer failed.",
          phase: "stream",
          retryable: false,
          hadActivity,
          hadHostSideEffect,
        });
        abort();
        if (event.type === "done") finish(event);
        return;
      }

      switch (event.type) {
        case "status":
          status = { state: event.state, message: event.message };
          break;
        case "session":
          sessionId = event.sessionId;
          cliVersion = event.cliVersion;
          hadActivity = true;
          break;
        case "prepared":
          prepared = {
            compatibilityKey: event.compatibilityKey,
            installationFingerprint: event.installationFingerprint,
            cliVersion: event.cliVersion,
            actualModel: event.actualModel ?? undefined,
            actualEffort: event.actualEffort ?? undefined,
            resumed: event.resumed,
          };
          cliVersion = event.cliVersion;
          break;
        case "textDelta":
          text += event.delta;
          hadActivity = true;
          break;
        case "reasoningDelta":
          reasoning += event.delta;
          hadActivity = true;
          break;
        case "toolRequest": {
          runId = runId ?? event.runId;
          hadActivity = true;
          if (resolvedToolCalls.has(event.callId)) break;
          resolvedToolCalls.add(event.callId);
          if (!hooks.executeHostTool) {
            toolQueue = toolQueue.then(async () => {
              const nextFailure = normalizeFailure(
                undefined,
                request.provider,
                {
                  message: "The Open Builder tool bridge is unavailable.",
                  phase: "tool",
                  retryable: false,
                  hadActivity: true,
                  hadHostSideEffect: false,
                },
              );
              failure = {
                ...nextFailure,
                code: "toolBridgeFailed",
                retryPolicy: "none",
              };
              await this.dependencies
                .resolveTool(event.runId, event.callId, {
                  text: failure.safeMessage,
                  isError: true,
                })
                .catch(() => undefined);
              abort();
            });
            break;
          }
          toolQueue = toolQueue.then(async () => {
            if (abortRequested || signal?.aborted) return;
            let resultReady = false;
            try {
              const outcome = await hooks.executeHostTool!(
                {
                  type: "toolRequest",
                  runId: event.runId,
                  callId: event.callId,
                  name: event.name,
                  arguments: event.arguments,
                },
                signal ?? new AbortController().signal,
              );
              resultReady = true;
              hadHostSideEffect ||= outcome.hadSideEffect;
              await this.dependencies.resolveTool(
                event.runId,
                event.callId,
                outcome.resolution,
              );
            } catch (cause) {
              // A Stop request unregisters the backend bridge immediately, so a
              // host tool that finishes afterwards cannot deliver its result.
              // That is the expected aborted outcome, not a bridge failure.
              if (signal?.aborted || isAbortError(cause)) {
                abort();
                return;
              }
              if (abortRequested) return;
              const nextFailure = normalizeFailure(cause, request.provider, {
                message:
                  "The Open Builder tool bridge could not complete the local CLI request.",
                phase: "tool",
                retryable: true,
                hadActivity: true,
                hadHostSideEffect,
              });
              failure = {
                ...nextFailure,
                code: "toolBridgeFailed",
                phase: "tool",
                retryPolicy: "manual",
              };
              if (!resultReady) {
                await this.dependencies
                  .resolveTool(event.runId, event.callId, {
                    text: failure.safeMessage,
                    isError: true,
                  })
                  .catch(() => undefined);
              }
              abort();
              throw new LocalCliRuntimeError(failure, event.runId, cause);
            }
          });
          break;
        }
        case "nativeTool":
          hadActivity = true;
          break;
        case "usage":
          usage = {
            ...usage,
            ...(event.inputTokens !== undefined
              ? { inputTokens: event.inputTokens }
              : {}),
            ...(event.outputTokens !== undefined
              ? { outputTokens: event.outputTokens }
              : {}),
            ...(event.cachedInputTokens !== undefined
              ? { cachedInputTokens: event.cachedInputTokens }
              : {}),
          };
          hadActivity = true;
          break;
        case "warning":
          warnings = [...warnings, event.message];
          break;
        case "error":
          failure = normalizeFailure(event.failure, request.provider, {
            message: event.message,
            retryable: event.retryable,
            phase: event.failure?.phase ?? "stream",
            hadActivity,
            hadHostSideEffect,
          });
          abort();
          break;
        case "done":
          finish(event);
          break;
      }
    };

    if (signal) {
      const listener = () => {
        externallyAborted = true;
        abort();
      };
      signal.addEventListener("abort", listener, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", listener);
    }

    try {
      const started = await this.dependencies.start(request, onEvent);
      if (typeof started !== "string" || !started) {
        rejectWithFailure(
          normalizeFailure(undefined, request.provider, {
            message: "The local CLI did not return a run id.",
            phase: "spawn",
            retryable: true,
            hadActivity,
            hadHostSideEffect,
          }),
        );
      } else {
        runId = started;
        startResolved = true;
        if (abortRequested || signal?.aborted) abort();
        if (doneEvent && !settled) finish(doneEvent);
      }
    } catch (cause) {
      const nextFailure = normalizeFailure(cause, request.provider, {
        message: "The local CLI process could not be started.",
        phase: "spawn",
        retryable: true,
        hadActivity,
        hadHostSideEffect,
      });
      rejectWithFailure(nextFailure, cause);
    }

    return completed;
  }
}

export const localCliRuntime = new LocalCliRuntime();

export function normalizeLocalCliProbe(
  probe: LocalAgentProbe,
): LocalCliInspection {
  return {
    ...probe,
    status: inspectionStatus(probe),
    reasonCode: inspectionReason(probe),
    catalogAuthority: probe.catalogAuthority ?? "partial",
    checkedAt: probe.checkedAt ?? Date.now(),
  };
}
