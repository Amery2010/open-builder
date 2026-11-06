import { CANCELLED_TOOL_OUTPUT_KIND } from "../run-guard";
import { sanitizeToolExecutionOutputForHistory } from "../../utils/message-security";
import type { ToolSet } from "ai";
import { WebAppGenerator } from "../generator";
import type {
  DispatchSubagentResult,
  GeneratorEvents,
  GenerationBackend,
  GeneratorOptions,
  ProjectFiles,
} from "../generator-types";
import type { LocalToolAnnotations } from "../../local-agent/types";
import { BUILTIN_TOOLS, BUILTIN_WRITE_TOOL_NAMES } from "../tools-schema";
import type { ApiType } from "../provider";
import { useSubagentStore } from "../../../store/subagent";
import { filterToolSet } from "../../tools/tool-set-utils";
import type { SkillActiveContext } from "../../skills/active-context";
import { SUBAGENT_BUILTIN_TOOL_NAMES, getSubagentByName } from "./registry";
import type { SubagentDefinition, SubagentToolResult } from "./types";
import {
  SUBAGENT_LIMITS,
  limitSubagentEvents,
  normalizeSubagentTask,
  truncateSubagentText,
} from "./limits";

export interface ParentApiConfig {
  apiType: ApiType;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

export interface RunSubagentOpts {
  name: string;
  task: string;
  files: ProjectFiles;
  signal: AbortSignal;
  toolCallId: string;
  conversationId?: string;
  parentApiConfig: ParentApiConfig;
  parentCustomToolSet: ToolSet;
  parentCombinedToolHandler: NonNullable<GeneratorOptions["customToolHandler"]>;
  parentCustomSystemPrompt: string;
  parentForcedSkillsPrompt: string;
  parentSkillContext: SkillActiveContext | null;
  additionalToolNames: ReadonlySet<string>;
  additionalToolAnnotations?: ReadonlyMap<string, LocalToolAnnotations>;
  createGenerator?: (
    options: GeneratorOptions,
    events: GeneratorEvents,
  ) => GenerationBackend | Promise<GenerationBackend>;
}

export interface CreateDispatcherOpts {
  getApiConfig: () => ParentApiConfig;
  getCustomToolSet: () => ToolSet;
  getCombinedToolHandler: () => NonNullable<
    GeneratorOptions["customToolHandler"]
  >;
  getCustomSystemPrompt: () => string;
  getForcedSkillsPrompt: () => string;
  getSkillContextSnapshot?: () => SkillActiveContext | null;
  /** Explicitly approved read-only external tools (currently MCP). */
  getAdditionalToolNames?: () => ReadonlySet<string>;
  getAdditionalToolAnnotations?: () => ReadonlyMap<
    string,
    LocalToolAnnotations
  >;
  createGenerator?: RunSubagentOpts["createGenerator"];
}

export function buildSubagentSystemPrompt(
  basePrompt: string,
  customSystemPrompt: string,
  mandatorySkillsPrompt: string,
): string {
  return basePrompt + customSystemPrompt + mandatorySkillsPrompt;
}

type WritePolicy = "readonly" | "fullWrite";

function effectiveSubagentWhitelist(
  def: SubagentDefinition,
  policy: WritePolicy,
  additionalToolNames: ReadonlySet<string> = new Set(),
): Set<string> {
  const whitelist = new Set(def.toolWhitelist);
  if (policy === "readonly") {
    for (const name of BUILTIN_WRITE_TOOL_NAMES) whitelist.delete(name);
  }
  for (const name of additionalToolNames) whitelist.add(name);
  return whitelist;
}

function buildSubagentToolSet(
  whitelist: ReadonlySet<string>,
  parentCustomToolSet: ToolSet,
): ToolSet {
  const builtins = filterToolSet(
    BUILTIN_TOOLS,
    (name) => SUBAGENT_BUILTIN_TOOL_NAMES.has(name) && whitelist.has(name),
  );
  const customs = filterToolSet(parentCustomToolSet, (name) =>
    whitelist.has(name),
  );
  return { ...builtins, ...customs };
}

function wrapHandlerWithWhitelist(
  parentHandler: NonNullable<GeneratorOptions["customToolHandler"]>,
  whitelist: ReadonlySet<string>,
): NonNullable<GeneratorOptions["customToolHandler"]> {
  return async (name, args, context) => {
    if (!whitelist.has(name)) {
      return `Error: tool "${name}" is not available to this subagent. Available: ${[...whitelist].join(", ")}.`;
    }
    return parentHandler(name, args, context);
  };
}

function resolveApiConfig(
  parent: ParentApiConfig,
  override: SubagentDefinition["modelOverride"],
): ParentApiConfig {
  if (!override) return parent;
  return {
    apiType: override.apiType ?? parent.apiType,
    apiBaseUrl: override.apiBaseUrl ?? parent.apiBaseUrl,
    apiKey: override.apiKey ?? parent.apiKey,
    model: override.model ?? parent.model,
  };
}

export async function runSubagent(
  opts: RunSubagentOpts,
): Promise<DispatchSubagentResult> {
  const def = getSubagentByName(opts.name);
  const store = useSubagentStore.getState();
  const checkedTask = normalizeSubagentTask(opts.task);

  if (!def) {
    const failure: SubagentToolResult = {
      ok: false,
      subagent: opts.name,
      task: checkedTask.ok
        ? checkedTask.task
        : truncateSubagentText(opts.task, SUBAGENT_LIMITS.maxTaskChars),
      status: "failed",
      text: "",
      events: [],
      durationMs: 0,
      error: `Unknown subagent "${opts.name}". Pick one of the listed names.`,
    };
    return { text: JSON.stringify(failure) };
  }

  if (!checkedTask.ok) {
    const failure: SubagentToolResult = {
      ok: false,
      subagent: def.name,
      task: "",
      status: "failed",
      text: "",
      events: [],
      durationMs: 0,
      error: checkedTask.error,
    };
    return { text: JSON.stringify(failure) };
  }

  const runId = store.init(opts.toolCallId, def.name, checkedTask.task);
  const startedAt = Date.now();

  let settled = false;
  let pendingUpdates: Array<{ kind: "text" | "thinking"; text: string }> = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const currentProgress = () => {
    const progress = useSubagentStore.getState().progress[opts.toolCallId];
    return progress?.runId === runId ? progress : undefined;
  };
  const eventsSnapshot = () =>
    limitSubagentEvents(currentProgress()?.events ?? []);
  const isCurrentRun = () => {
    return !settled && currentProgress()?.status === "running";
  };
  const flushPending = () => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!isCurrentRun()) {
      pendingUpdates = [];
      return;
    }
    const updates = pendingUpdates;
    pendingUpdates = [];
    for (const update of updates) {
      if (update.kind === "text") {
        useSubagentStore
          .getState()
          .appendText(opts.toolCallId, update.text, runId);
      } else {
        useSubagentStore
          .getState()
          .appendThinking(opts.toolCallId, update.text, runId);
      }
    }
  };
  const scheduleFlush = () => {
    if (flushTimer || settled) return;
    flushTimer = setTimeout(flushPending, 16);
  };
  const settleLiveProgress = () => {
    flushPending();
    settled = true;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  if (opts.signal.aborted) {
    settleLiveProgress();
    store.markStatus(opts.toolCallId, "aborted", "Aborted before start", runId);
    const aborted: SubagentToolResult = {
      ok: false,
      subagent: def.name,
      task: checkedTask.task,
      status: "aborted",
      text: "",
      events: [],
      durationMs: 0,
      error: "Aborted before start",
    };
    return { text: JSON.stringify(aborted) };
  }

  const policy: WritePolicy = def.writePolicy ?? "readonly";
  const whitelist = effectiveSubagentWhitelist(
    def,
    policy,
    opts.additionalToolNames,
  );
  const toolSet = buildSubagentToolSet(whitelist, opts.parentCustomToolSet);
  const wrappedHandler = wrapHandlerWithWhitelist(
    opts.parentCombinedToolHandler,
    whitelist,
  );
  const apiConfig = resolveApiConfig(opts.parentApiConfig, def.modelOverride);

  const effectiveSystemPrompt = buildSubagentSystemPrompt(
    def.systemPrompt,
    opts.parentCustomSystemPrompt,
    opts.parentForcedSkillsPrompt,
  );

  const events: GeneratorEvents = {
    onText: (delta) => {
      if (!isCurrentRun()) return;
      const last = pendingUpdates.at(-1);
      if (last?.kind === "text") last.text += delta;
      else pendingUpdates.push({ kind: "text", text: delta });
      scheduleFlush();
    },
    onThinking: (delta) => {
      if (!isCurrentRun()) return;
      const last = pendingUpdates.at(-1);
      if (last?.kind === "thinking") last.text += delta;
      else pendingUpdates.push({ kind: "thinking", text: delta });
      scheduleFlush();
    },
    onToolCall: (name, innerId) => {
      if (!isCurrentRun()) return;
      flushPending();
      useSubagentStore
        .getState()
        .addToolCall(opts.toolCallId, name, innerId, runId);
    },
    onRetry: (attempt, maxAttempts, error) => {
      if (!isCurrentRun()) return;
      flushPending();
      useSubagentStore
        .getState()
        .recordRetry(
          opts.toolCallId,
          attempt,
          maxAttempts,
          error.message,
          runId,
        );
    },
    onLocalCliStatus: (status) => {
      if (!isCurrentRun()) return;
      flushPending();
      useSubagentStore
        .getState()
        .recordActivity(
          opts.toolCallId,
          "status",
          status.message || status.state,
          undefined,
          runId,
        );
    },
    onLocalCliWarning: (message) => {
      if (!isCurrentRun()) return;
      flushPending();
      useSubagentStore
        .getState()
        .recordActivity(opts.toolCallId, "warning", message, undefined, runId);
    },
    onToolResult: (name, args, result, innerId, output) => {
      if (!isCurrentRun()) return;
      flushPending();
      const safeOutput = sanitizeToolExecutionOutputForHistory(
        name,
        args,
        output ?? { text: String(result ?? "") },
      );
      useSubagentStore
        .getState()
        .addToolCall(opts.toolCallId, name, innerId, runId);
      useSubagentStore
        .getState()
        .setToolResult(
          opts.toolCallId,
          innerId,
          safeOutput?.text ?? "",
          safeOutput,
          output?.structuredContent &&
            typeof output.structuredContent === "object" &&
            "kind" in output.structuredContent &&
            output.structuredContent.kind === CANCELLED_TOOL_OUTPUT_KIND
            ? "aborted"
            : undefined,
          runId,
        );
    },
    onError: () => {
      // Caught by outer try/catch.
    },
  };

  const generatorOptions: GeneratorOptions = {
    conversationId: opts.conversationId,
    apiType: apiConfig.apiType,
    apiBaseUrl: apiConfig.apiBaseUrl,
    apiKey: apiConfig.apiKey,
    model: apiConfig.model,
    systemPrompt: effectiveSystemPrompt,
    initialFiles: opts.files,
    maxIterations: def.maxIterations,
    stream: true,
    tools: toolSet,
    customTools: {},
    customToolHandler: wrappedHandler,
    executionMode: "subagent",
    allowedMcpAliases: opts.additionalToolNames,
    localToolAnnotations: opts.additionalToolAnnotations,
    initialSkillContext: opts.parentSkillContext,
    // Subagents do not get user interaction or plan-mode tools.
    thinking: false,
  };

  let inner: GenerationBackend | undefined;
  const onAbort = () => {
    settleLiveProgress();
    useSubagentStore
      .getState()
      .markStatus(opts.toolCallId, "aborted", undefined, runId);
    inner?.abort();
  };
  const maxResultLength = def.maxResultLength ?? 4000;

  try {
    opts.signal.addEventListener("abort", onAbort, { once: true });
    inner = opts.createGenerator
      ? await opts.createGenerator(generatorOptions, events)
      : new WebAppGenerator(generatorOptions, events);
    if (opts.signal.aborted) inner.abort();
    opts.signal.throwIfAborted();
    const innerResult = await inner.generate(checkedTask.task);
    flushPending();
    const receivedText = opts.signal.aborted
      ? (currentProgress()?.text ?? "")
      : innerResult.text || "";
    useSubagentStore
      .getState()
      .setFinalText(opts.toolCallId, receivedText, runId);
    const finalText = receivedText.slice(0, maxResultLength);

    if (innerResult.aborted || opts.signal.aborted) {
      settleLiveProgress();
      useSubagentStore
        .getState()
        .markStatus(opts.toolCallId, "aborted", undefined, runId);
      const aborted: SubagentToolResult = {
        ok: false,
        subagent: def.name,
        task: checkedTask.task,
        status: "aborted",
        text: finalText,
        events: eventsSnapshot(),
        durationMs: Date.now() - startedAt,
        error: "Aborted",
      };
      return { text: JSON.stringify(aborted) };
    }

    const budgetError = innerResult.maxIterationsReached
      ? "The subagent reached its explicitly configured iteration limit before completing."
      : undefined;
    const status = budgetError ? "failed" : "done";
    settleLiveProgress();
    useSubagentStore
      .getState()
      .markStatus(opts.toolCallId, status, budgetError, runId);
    const result: SubagentToolResult = {
      ok: !budgetError,
      subagent: def.name,
      task: checkedTask.task,
      status,
      text: finalText,
      events: eventsSnapshot(),
      durationMs: Date.now() - startedAt,
      ...(budgetError ? { error: budgetError } : {}),
    };
    return {
      text: JSON.stringify(result),
      // Only propagate files for write-capable subagents. Readonly subagents'
      // inner files cannot diverge from the parent's, so skip the work.
      files: policy === "fullWrite" ? inner.getFiles() : undefined,
    };
  } catch (err) {
    const isAbort =
      (err as { name?: string })?.name === "AbortError" || opts.signal.aborted;
    const status = isAbort ? "aborted" : "failed";
    const message =
      (err as { message?: string })?.message ?? "Unknown subagent error";
    settleLiveProgress();
    const textSnapshot = currentProgress()?.text ?? "";
    useSubagentStore
      .getState()
      .markStatus(
        opts.toolCallId,
        status,
        isAbort ? undefined : message,
        runId,
      );
    const failure: SubagentToolResult = {
      ok: false,
      subagent: def.name,
      task: checkedTask.task,
      status,
      text: textSnapshot.slice(0, maxResultLength),
      events: eventsSnapshot(),
      durationMs: Date.now() - startedAt,
      error: isAbort
        ? "Aborted"
        : truncateSubagentText(message, SUBAGENT_LIMITS.maxErrorChars),
    };
    return { text: JSON.stringify(failure) };
  } finally {
    settleLiveProgress();
    opts.signal.removeEventListener("abort", onAbort);
  }
}

export function createSubagentDispatcher(
  opts: CreateDispatcherOpts,
): NonNullable<GeneratorOptions["dispatchSubagent"]> {
  return (name, task, files, signal, toolCallId, conversationId) =>
    runSubagent({
      name,
      task,
      files,
      signal,
      toolCallId,
      conversationId,
      parentApiConfig: opts.getApiConfig(),
      parentCustomToolSet: opts.getCustomToolSet(),
      parentCombinedToolHandler: opts.getCombinedToolHandler(),
      parentCustomSystemPrompt: opts.getCustomSystemPrompt(),
      parentForcedSkillsPrompt: opts.getForcedSkillsPrompt(),
      parentSkillContext: opts.getSkillContextSnapshot?.() ?? null,
      additionalToolNames: opts.getAdditionalToolNames?.() ?? new Set(),
      additionalToolAnnotations: opts.getAdditionalToolAnnotations?.(),
      createGenerator: opts.createGenerator,
    });
}
