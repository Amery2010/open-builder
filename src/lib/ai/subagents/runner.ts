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

  store.init(opts.toolCallId, def.name, checkedTask.task);
  const startedAt = Date.now();

  if (opts.signal.aborted) {
    store.markStatus(opts.toolCallId, "aborted", "Aborted before start");
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
      useSubagentStore.getState().appendText(opts.toolCallId, delta);
    },
    onToolCall: (name, innerId) => {
      useSubagentStore.getState().addToolCall(opts.toolCallId, name, innerId);
    },
    onToolResult: (_name, _args, result, innerId) => {
      useSubagentStore
        .getState()
        .setToolResult(opts.toolCallId, innerId, String(result ?? ""));
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
  const onAbort = () => inner?.abort();
  const maxResultLength = def.maxResultLength ?? 4000;

  try {
    opts.signal.addEventListener("abort", onAbort, { once: true });
    inner = opts.createGenerator
      ? await opts.createGenerator(generatorOptions, events)
      : new WebAppGenerator(generatorOptions, events);
    if (opts.signal.aborted) inner.abort();
    opts.signal.throwIfAborted();
    const innerResult = await inner.generate(checkedTask.task);
    const finalText = (innerResult.text || "").slice(0, maxResultLength);
    const eventsSnapshot = limitSubagentEvents(
      useSubagentStore.getState().progress[opts.toolCallId]?.events ?? [],
    );

    if (innerResult.aborted || opts.signal.aborted) {
      useSubagentStore.getState().markStatus(opts.toolCallId, "aborted");
      const aborted: SubagentToolResult = {
        ok: false,
        subagent: def.name,
        task: checkedTask.task,
        status: "aborted",
        text: finalText,
        events: eventsSnapshot,
        durationMs: Date.now() - startedAt,
        error: "Aborted",
      };
      return { text: JSON.stringify(aborted) };
    }

    const budgetError = innerResult.maxIterationsReached
      ? "The subagent reached its explicitly configured iteration limit before completing."
      : undefined;
    const status = budgetError ? "failed" : "done";
    useSubagentStore
      .getState()
      .markStatus(opts.toolCallId, status, budgetError);
    const result: SubagentToolResult = {
      ok: !budgetError,
      subagent: def.name,
      task: checkedTask.task,
      status,
      text: finalText,
      events: eventsSnapshot,
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
    const eventsSnapshot = limitSubagentEvents(
      useSubagentStore.getState().progress[opts.toolCallId]?.events ?? [],
    );
    const textSnapshot =
      useSubagentStore.getState().progress[opts.toolCallId]?.text ?? "";
    useSubagentStore
      .getState()
      .markStatus(opts.toolCallId, status, isAbort ? undefined : message);
    const failure: SubagentToolResult = {
      ok: false,
      subagent: def.name,
      task: checkedTask.task,
      status,
      text: textSnapshot.slice(0, maxResultLength),
      events: eventsSnapshot,
      durationMs: Date.now() - startedAt,
      error: isAbort
        ? "Aborted"
        : truncateSubagentText(message, SUBAGENT_LIMITS.maxErrorChars),
    };
    return { text: JSON.stringify(failure) };
  } finally {
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
