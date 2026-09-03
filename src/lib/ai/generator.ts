// ============================================================================
//  generator.ts
//  AI Tool Call engine — drives an in-memory web-app build through the AI SDK.
//  Files live as Record<path, content>; no Node dependencies, runs in browser.
// ============================================================================

import { streamText, generateText } from "ai";
import type { ToolSet } from "ai";
import { getProviderModel, buildProviderOptions } from "./provider";
import type { ApiType } from "./provider";
import {
  messagesToModelMessages,
  untrustedReferenceToModelMessages,
} from "./messages";
import {
  BUILTIN_TOOLS,
  TOOL_POLICY_VERSION,
  getToolCapability,
  isWriteToolName,
  READONLY_TOOL_NAMES,
  type ExecutionMode,
  type RuntimePlatform,
  type ToolRunContext,
} from "./tools-schema";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt";
import { buildProjectGuidelinesSection } from "./project-guidelines";
import { PLAN_APPROVED_PREFIX, PLAN_REJECTED_PREFIX } from "./plan-mode";
import { dispatchFsTool } from "../tools/fs-tools";
import {
  createAskUserAnswersToolOutput,
  normalizeToolExecutionOutput,
  normalizeToolResultForModel,
} from "../utils/tool-result";
import {
  buildProjectFilesPromptListing,
  validateProjectFiles,
} from "../utils/project-files";
import {
  pickSensitiveProjectFiles,
  projectFilesForModel,
} from "../utils/project-file-policy";
import { normalizeSubagentTask } from "./subagents/limits";
import {
  ALWAYS_ALLOWED_TOOL_NAMES,
  createSkillActiveContext,
} from "../skills/active-context";
import type { SkillActiveContextController } from "../skills/active-context";
import { recordPermissionActivity } from "../security/activity-log";
import { isRetryableGenerationError } from "./generation-error";
import { attachmentPartsForModel } from "../attachments/model-context";
import type {
  Message,
  ToolCall,
  ContentPart,
  ProjectFiles,
  FileChange,
  GenerateResult,
  GeneratorOptions,
  GeneratorEvents,
  AskUserQuestion,
  ToolExecutionOutput,
  ResolvedAttachment,
  GenerationBackend,
  AgentToolExecutor,
} from "./generator-types";

// Re-export everything so callers can keep importing types from this module.
export type {
  AskUserQuestion,
  AskUserAnswerItem,
  AskUserAnswers,
  PlanDecision,
  ProjectFiles,
  ContentPart,
  Message,
  ToolCall,
  ToolDefinition,
  FileChange,
  GenerateResult,
  GeneratorOptions,
  GeneratorEvents,
  ToolExecutionContent,
  ToolExecutionContext,
  ToolExecutionOutput,
  McpToolExecutionIdentity,
  GenerationBackend,
  AgentToolExecutor,
  InitializedProjectContext,
  InitializedProjectPreparation,
} from "./generator-types";

function toolExecutionHasSideEffect(name: string): boolean {
  if (name === "dispatch_subagent") return true;
  const capability = getToolCapability(name);
  if (capability) {
    return capability.effects.some(
      (effect) =>
        effect === "write_project" ||
        effect === "write_runtime" ||
        effect === "process",
    );
  }
  // Unknown tools are dynamic capabilities. Treat them conservatively until
  // the local authority snapshot supplies an explicit read-only annotation.
  return !READONLY_TOOL_NAMES.has(name);
}

export class WebAppGenerator implements GenerationBackend, AgentToolExecutor {
  // ── internal state ──
  private files: ProjectFiles;
  private messages: Message[];
  private events: GeneratorEvents;
  private ctrl: AbortController | null = null;

  // ── config (read-only) ──
  private readonly apiType: ApiType;
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;
  private readonly useStream: boolean;
  private tools: ToolSet;
  private customToolSet: ToolSet;
  private readonly customToolHandler?: GeneratorOptions["customToolHandler"];
  private readonly authorizeToolCall?: GeneratorOptions["authorizeToolCall"];
  private readonly useThinking: boolean;
  private readonly thinkingBudget: number;
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private readonly providerToolNames: Set<string>;
  private readonly askUserQuestion?: GeneratorOptions["askUserQuestion"];
  private readonly requestPlanApproval?: GeneratorOptions["requestPlanApproval"];
  private readonly onPlanApproved?: GeneratorOptions["onPlanApproved"];
  private readonly dispatchSubagent?: GeneratorOptions["dispatchSubagent"];
  private readonly prepareInitializedProject?: GeneratorOptions["prepareInitializedProject"];
  private readonly conversationId?: string;
  private systemPromptSuffix: string = "";
  private untrustedReferenceContext: string = "";
  private readOnlyMode = false;
  private executionMode: ExecutionMode;
  private readonly runtimePlatform: RuntimePlatform;
  private allowedMcpAliases: ReadonlySet<string>;
  private readonly skillContext: SkillActiveContextController;
  private runId: string;

  constructor(options: GeneratorOptions, events: GeneratorEvents = {}) {
    this.apiType = options.apiType ?? "openai-compatible";
    this.apiBaseUrl = options.apiBaseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxIterations = options.maxIterations ?? 30;
    this.useStream = options.stream ?? true;
    this.customToolSet = options.customTools ?? {};
    this.tools = options.tools
      ? options.tools
      : { ...BUILTIN_TOOLS, ...this.customToolSet };
    this.customToolHandler = options.customToolHandler;
    this.authorizeToolCall = options.authorizeToolCall;
    this.useThinking = options.thinking ?? true;
    this.thinkingBudget = options.thinkingBudget ?? 10000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelay = options.retryDelay ?? 1000;
    this.providerToolNames = new Set(options.providerToolNames ?? []);
    this.askUserQuestion = options.askUserQuestion;
    this.requestPlanApproval = options.requestPlanApproval;
    this.onPlanApproved = options.onPlanApproved;
    this.dispatchSubagent = options.dispatchSubagent;
    this.prepareInitializedProject = options.prepareInitializedProject;
    this.conversationId = options.conversationId;
    this.executionMode = options.executionMode ?? "chat";
    this.runtimePlatform = options.runtimePlatform ?? "web";
    this.allowedMcpAliases = new Set(options.allowedMcpAliases ?? []);
    this.skillContext = createSkillActiveContext(
      options.initialSkillContext ?? null,
    );
    this.runId = this.createRunId();

    this.files = { ...(options.initialFiles ?? {}) };
    this.messages = [];
    this.events = events;
  }

  // ═══════════════════════════ public API ═════════════════════════════════

  getFiles(): ProjectFiles {
    return { ...this.files };
  }

  setFiles(files: ProjectFiles): void {
    this.files = { ...files };
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  appendMessage(message: Message): void {
    this.messages.push(message);
  }

  getTools(): ToolSet {
    return this.tools;
  }

  getSystemContent(): string {
    return this.buildSystemContent();
  }

  getUntrustedReferenceContext(): string {
    return this.untrustedReferenceContext;
  }

  resetMessages(): void {
    this.messages = [];
  }

  syncMessages(messages: Message[]): void {
    this.messages = [...messages];
  }

  setSystemPromptSuffix(suffix: string): void {
    this.systemPromptSuffix = suffix;
  }

  setUntrustedReferenceContext(reference: string): void {
    this.untrustedReferenceContext = reference;
  }

  /** Replace the tool set used on subsequent iterations.
   *  Used to switch between plan-mode (no write tools) and full tool set after plan approval.
   *  The provided set is used as-is — the caller is responsible for including any builtins it wants. */
  setTools(tools: ToolSet): void {
    this.tools = tools;
  }

  setReadOnlyMode(readOnly: boolean): void {
    this.readOnlyMode = readOnly;
    if (this.executionMode !== "subagent" && this.executionMode !== "auto_qa") {
      this.executionMode = readOnly ? "plan" : "chat";
    }
  }

  setExecutionMode(mode: ExecutionMode): void {
    this.executionMode = mode;
    this.readOnlyMode = mode === "plan" || mode === "subagent";
  }

  setAllowedMcpAliases(aliases: ReadonlySet<string>): void {
    this.allowedMcpAliases = new Set(aliases);
  }

  getSkillContext(): SkillActiveContextController {
    return this.skillContext;
  }

  getRunContext(): ToolRunContext {
    const activeSkillIds = new Set(
      this.skillContext.snapshot()?.skills.map((skill) => skill.skillId) ?? [],
    );
    return Object.freeze({
      runId: this.runId,
      conversationId: this.conversationId,
      mode: this.executionMode,
      platform: this.runtimePlatform,
      allowedMcpAliases: new Set(this.allowedMcpAliases),
      activeSkillIds,
      approvedSkillScriptHashes: new Set<string>(),
      policyVersion: TOOL_POLICY_VERSION,
    });
  }

  getCustomToolSet(): ToolSet {
    return this.customToolSet;
  }

  setCustomToolSet(tools: ToolSet): void {
    this.customToolSet = tools;
  }

  abort(): void {
    this.ctrl?.abort();
    this.ctrl = null;
  }

  beginExternalRun(): AbortSignal {
    this.ctrl?.abort();
    this.runId = this.createRunId();
    this.ctrl = new AbortController();
    return this.ctrl.signal;
  }

  appendUserMessage(
    userMessage: string,
    attachments?: ResolvedAttachment[],
  ): void {
    if (attachments && attachments.length > 0) {
      const parts: ContentPart[] = [];
      if (userMessage) parts.push({ type: "text", text: userMessage });
      for (const att of attachments) {
        parts.push(...attachmentPartsForModel(att));
      }
      this.messages.push({ role: "user", content: parts });
      return;
    }
    this.messages.push({ role: "user", content: userMessage });
  }

  executeToolCall(toolCall: ToolCall): Promise<{
    result: ToolExecutionOutput;
    changes: FileChange[];
    hadSideEffect: boolean;
  }> {
    return this.executeTool(toolCall);
  }

  /** Retry the loop without adding a new user message (user message is already in history). */
  async retry(): Promise<GenerateResult> {
    this.runId = this.createRunId();
    return this._runGenerateLoop();
  }

  async generate(
    userMessage: string,
    attachments?: ResolvedAttachment[],
  ): Promise<GenerateResult> {
    this.runId = this.createRunId();
    this.appendUserMessage(userMessage, attachments);

    return this._runGenerateLoop();
  }

  // ═══════════════════════════ internals ══════════════════════════════════

  private createRunId(): string {
    return (
      globalThis.crypto?.randomUUID?.() ??
      `run-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  }

  private async _runGenerateLoop(): Promise<GenerateResult> {
    let fullText = "";
    let aborted = false;
    let maxReached = false;

    try {
      for (let iter = 0; iter < this.maxIterations; iter++) {
        // Authorization transitions (notably Plan approval) can change the
        // trusted suffix and untrusted reference context between iterations.
        const systemContent = this.buildSystemContent();
        const isLastIter = iter === this.maxIterations - 1;
        const instructions = isLastIter
          ? systemContent +
            `\n\nFinal iteration — the tool call budget of ${this.maxIterations} is exhausted. ` +
            `Call no further tools. Summarize what you accomplished and what remains, ` +
            `then stop so the user can resume in a follow-up message.`
          : systemContent;

        const assistantMsg = await this.requestWithRetry(
          this.messages,
          instructions,
        );

        this.messages.push(assistantMsg);
        if (assistantMsg.content) {
          fullText += assistantMsg.content;
        }

        if (!assistantMsg.tool_calls?.length) {
          break;
        }

        // Plan approval is an exclusive authorization barrier. A provider must
        // observe the approval result and start a fresh iteration before it can
        // use the expanded Chat schema. Never execute sibling calls that were
        // composed while the run was still authorized only for Plan Mode.
        const exitPlanCall = assistantMsg.tool_calls.find(
          (toolCall) =>
            this.executionMode === "plan" &&
            toolCall.function.name === "exit_plan_mode" &&
            !this.providerToolNames.has(toolCall.function.name),
        );
        if (exitPlanCall) {
          const barrierContext = this.getRunContext();
          const { result, changes } = await this.executeTool(exitPlanCall);
          this.messages.push({
            role: "tool",
            tool_call_id: exitPlanCall.id,
            content: result.text,
            toolOutput: result,
          });
          if (changes.length > 0) {
            this.events.onFileChange?.(this.getFiles(), changes);
          }

          for (const siblingCall of assistantMsg.tool_calls) {
            if (
              siblingCall === exitPlanCall ||
              this.providerToolNames.has(siblingCall.function.name)
            ) {
              continue;
            }
            const output = normalizeToolExecutionOutput({
              text:
                `Error: tool "${siblingCall.function.name}" was discarded ` +
                "because exit_plan_mode must be the only tool call in its response. " +
                "Reissue it in a fresh provider iteration after plan approval.",
              isError: true,
            });
            let siblingArgs: unknown = null;
            try {
              siblingArgs = JSON.parse(siblingCall.function.arguments);
            } catch {
              // Keep malformed arguments inert while still completing the tool call.
            }
            this.messages.push({
              role: "tool",
              tool_call_id: siblingCall.id,
              content: output.text,
              toolOutput: output,
            });
            recordPermissionActivity({
              conversationId: barrierContext.conversationId,
              tool: siblingCall.function.name,
              source: barrierContext.allowedMcpAliases.has(
                siblingCall.function.name,
              )
                ? "mcp"
                : (getToolCapability(siblingCall.function.name)?.source ??
                  "unknown"),
              mode: barrierContext.mode,
              platform: barrierContext.platform,
              decision: "denied",
              reason: "exit_plan_mode exclusive authorization barrier",
            });
            this.events.onToolResult?.(
              siblingCall.function.name,
              siblingArgs,
              output.text,
              siblingCall.id,
              output,
            );
          }

          if (iter === this.maxIterations - 1) {
            maxReached = true;
          }
          continue;
        }

        // Split dispatch_subagent calls out — they run in parallel after the
        // regular sequential calls finish. Read-only subagents share file
        // snapshots, so parallel execution is safe.
        const regularCalls: ToolCall[] = [];
        const dispatchCalls: ToolCall[] = [];
        for (const tc of assistantMsg.tool_calls) {
          if (tc.function.name === "dispatch_subagent") {
            dispatchCalls.push(tc);
          } else {
            regularCalls.push(tc);
          }
        }

        for (const toolCall of regularCalls) {
          if (this.providerToolNames.has(toolCall.function.name)) {
            continue;
          }

          const { result, changes } = await this.executeTool(toolCall);

          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result.text,
            toolOutput: result,
          });

          if (changes.length > 0) {
            this.events.onFileChange?.(this.getFiles(), changes);
          }
        }

        if (dispatchCalls.length > 0) {
          const MAX_PARALLEL = 3;
          const accepted = dispatchCalls.slice(0, MAX_PARALLEL);
          const rejected = dispatchCalls.slice(MAX_PARALLEL);

          const results = await Promise.all(
            accepted.map((tc) => this.executeTool(tc)),
          );

          for (let i = 0; i < accepted.length; i++) {
            this.messages.push({
              role: "tool",
              tool_call_id: accepted[i].id,
              content: results[i].result.text,
              toolOutput: results[i].result,
            });
          }

          for (const tc of rejected) {
            const msg = `Too many parallel subagent dispatches in one turn (limit: ${MAX_PARALLEL}). Reissue this call in the next turn.`;
            this.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: msg,
            });
            this.events.onToolResult?.(tc.function.name, {}, msg, tc.id);
          }
        }

        if (iter === this.maxIterations - 1) {
          maxReached = true;
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        aborted = true;
      } else {
        this.events.onError?.(err);
        throw err;
      }
    }

    const result: GenerateResult = {
      files: this.getFiles(),
      messages: this.getMessages(),
      text: fullText,
      aborted,
      maxIterationsReached: maxReached,
    };

    this.events.onComplete?.(result);
    return result;
  }

  private isRetryableError(err: any): boolean {
    return isRetryableGenerationError(err);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      this.ctrl?.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  private async requestWithRetry(
    messages: Message[],
    instructions: string,
  ): Promise<Message> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestAI(messages, instructions);
      } catch (err: any) {
        if (!this.isRetryableError(err) || attempt >= this.maxRetries)
          throw err;
        this.events.onRetry?.(attempt + 1, this.maxRetries, err);
        const delay =
          this.retryDelay * Math.pow(2, attempt) + Math.random() * 500;
        await this.sleep(delay);
      }
    }
  }

  private buildSystemContent(): string {
    const listing = buildProjectFilesPromptListing(
      projectFilesForModel(this.files),
    );
    const guidelines = buildProjectGuidelinesSection(this.files);
    return this.systemPrompt + listing + guidelines + this.systemPromptSuffix;
  }

  private async requestAI(
    messages: Message[],
    instructions: string,
  ): Promise<Message> {
    this.ctrl = new AbortController();

    const coreMessages = [
      ...untrustedReferenceToModelMessages(this.untrustedReferenceContext),
      ...messagesToModelMessages(messages, this.apiType),
    ];
    const model = getProviderModel({
      apiType: this.apiType,
      apiBaseUrl: this.apiBaseUrl,
      apiKey: this.apiKey,
      model: this.model,
    });

    const providerOptions = this.useThinking
      ? buildProviderOptions(this.apiType, this.thinkingBudget)
      : undefined;

    if (this.useStream) {
      return this.requestStreamAI(
        model,
        coreMessages,
        instructions,
        providerOptions,
      );
    } else {
      return this.requestGenerateAI(
        model,
        coreMessages,
        instructions,
        providerOptions,
      );
    }
  }

  private async requestStreamAI(
    model: ReturnType<typeof getProviderModel>,
    coreMessages: ReturnType<typeof messagesToModelMessages>,
    instructions: string,
    providerOptions?: ReturnType<typeof buildProviderOptions>,
  ): Promise<Message> {
    const result = streamText({
      model,
      instructions,
      messages: coreMessages,
      tools: this.tools,
      maxRetries: 0,
      abortSignal: this.ctrl!.signal,
      providerOptions: providerOptions as any,
    });

    let contentAccum = "";
    let thinkingAccum = "";
    const toolCallsAccum: ToolCall[] = [];

    const normalizeStreamError = (error: unknown, fallback: string): Error => {
      if (error instanceof Error) return error;
      if (typeof error === "string" && error.trim()) {
        return new Error(error);
      }
      if (error && typeof error === "object") {
        const source = error as {
          message?: unknown;
          name?: unknown;
          statusCode?: unknown;
          status?: unknown;
          isRetryable?: unknown;
          retryable?: unknown;
          cause?: unknown;
        };
        const normalized = new Error(
          typeof source.message === "string" && source.message.trim()
            ? source.message
            : fallback,
          { cause: source.cause },
        ) as Error & {
          statusCode?: number;
          status?: number;
          isRetryable?: boolean;
          retryable?: boolean;
        };
        if (typeof source.name === "string" && source.name) {
          normalized.name = source.name;
        }
        if (typeof source.statusCode === "number") {
          normalized.statusCode = source.statusCode;
        }
        if (typeof source.status === "number")
          normalized.status = source.status;
        if (typeof source.isRetryable === "boolean") {
          normalized.isRetryable = source.isRetryable;
        }
        if (typeof source.retryable === "boolean") {
          normalized.retryable = source.retryable;
        }
        return normalized;
      }
      return new Error(fallback);
    };

    for await (const part of result.stream) {
      switch (part.type) {
        case "text-delta":
          contentAccum += part.text;
          this.events.onText?.(part.text);
          break;

        case "reasoning-delta":
          thinkingAccum += part.text;
          this.events.onThinking?.(part.text);
          break;

        case "tool-input-start":
          if (!this.providerToolNames.has(part.toolName)) {
            this.events.onToolCall?.(part.toolName, part.id);
          }
          break;

        case "tool-call":
          if (!this.providerToolNames.has(part.toolName)) {
            toolCallsAccum.push({
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input),
              },
            });
          }
          break;

        case "error":
          throw normalizeStreamError(part.error, "The model stream failed.");

        case "tool-error":
          throw normalizeStreamError(
            part.error,
            `Tool "${part.toolName}" failed while streaming.`,
          );

        case "abort":
          throw new DOMException(part.reason ?? "Aborted", "AbortError");

        case "finish-step":
        case "finish":
          if (part.finishReason === "error") {
            throw Object.assign(
              new Error("The model stream ended with an error."),
              { isRetryable: true },
            );
          }
          break;
      }
    }

    return {
      role: "assistant",
      content: contentAccum || null,
      tool_calls: toolCallsAccum.length > 0 ? toolCallsAccum : undefined,
      thinking: thinkingAccum || undefined,
    };
  }

  private async requestGenerateAI(
    model: ReturnType<typeof getProviderModel>,
    coreMessages: ReturnType<typeof messagesToModelMessages>,
    instructions: string,
    providerOptions?: ReturnType<typeof buildProviderOptions>,
  ): Promise<Message> {
    const result = await generateText({
      model,
      instructions,
      messages: coreMessages,
      tools: this.tools,
      maxRetries: 0,
      abortSignal: this.ctrl!.signal,
      providerOptions: providerOptions as any,
    });

    if (result.text) {
      this.events.onText?.(result.text);
    }

    const reasoning = (result as any).reasoning;
    if (reasoning) {
      this.events.onThinking?.(reasoning);
    }

    const toolCalls: ToolCall[] = (result.toolCalls || []).map((tc) => ({
      id: tc.toolCallId,
      type: "function",
      function: {
        name: tc.toolName,
        arguments: JSON.stringify(tc.input),
      },
    }));

    for (const tc of toolCalls) {
      this.events.onToolCall?.(tc.function.name, tc.id);
    }

    return {
      role: "assistant",
      content: result.text || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      thinking: reasoning || undefined,
    };
  }

  private async executeTool(toolCall: ToolCall): Promise<{
    result: ToolExecutionOutput;
    changes: FileChange[];
    hadSideEffect: boolean;
  }> {
    const name = toolCall.function.name;
    const logDecision = (
      decision: "allowed" | "denied" | "requested",
      reason?: string,
    ) => {
      recordPermissionActivity({
        conversationId: this.conversationId,
        tool: name,
        source: this.allowedMcpAliases.has(name)
          ? "mcp"
          : (getToolCapability(name)?.source ?? "unknown"),
        mode: this.executionMode,
        platform: this.runtimePlatform,
        decision,
        reason,
      });
    };

    let args: any;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      const errMsg = `Error: failed to parse arguments for "${name}"`;
      const output = normalizeToolExecutionOutput({
        text: errMsg,
        isError: true,
      });
      this.events.onToolResult?.(name, null, output.text, toolCall.id, output);
      return { result: output, changes: [], hadSideEffect: false };
    }

    if (!Object.prototype.hasOwnProperty.call(this.tools, name)) {
      const errMsg =
        `Error: tool "${name}" is not authorized for the current ` +
        `${this.executionMode} run.`;
      const output = normalizeToolExecutionOutput({
        text: errMsg,
        isError: true,
      });
      logDecision("denied", "tool is absent from the current run allowlist");
      this.events.onToolResult?.(name, args, output.text, toolCall.id, output);
      return { result: output, changes: [], hadSideEffect: false };
    }

    const capability = getToolCapability(name);
    const isAuthorizedMcpAlias =
      this.executionMode !== "auto_qa" && this.allowedMcpAliases.has(name);
    if (
      (!capability && !isAuthorizedMcpAlias) ||
      (capability &&
        (!capability.modes.includes(this.executionMode) ||
          !capability.platforms.includes(this.runtimePlatform)))
    ) {
      const errMsg =
        `Error: tool "${name}" is not permitted by policy for ` +
        `${this.executionMode} on ${this.runtimePlatform}.`;
      const output = normalizeToolExecutionOutput({
        text: errMsg,
        isError: true,
      });
      logDecision("denied", "tool capability policy rejected execution");
      this.events.onToolResult?.(name, args, output.text, toolCall.id, output);
      return { result: output, changes: [], hadSideEffect: false };
    }

    const activeCtx = this.skillContext.get();
    if (this.readOnlyMode && isWriteToolName(name)) {
      const errMsg =
        `Error: tool "${name}" is not available while Plan Mode is active. ` +
        "Submit or revise the plan first; write tools are enabled only after approval.";
      const output = normalizeToolExecutionOutput({
        text: errMsg,
        isError: true,
      });
      logDecision("denied", "write tool blocked by Plan Mode");
      this.events.onToolResult?.(name, args, output.text, toolCall.id, output);
      return { result: output, changes: [], hadSideEffect: false };
    }

    if (this.authorizeToolCall) {
      const denial = await this.authorizeToolCall(name, args, {
        signal: this.ctrl?.signal ?? new AbortController().signal,
        toolCallId: toolCall.id,
        run: this.getRunContext(),
        skillContext: this.skillContext,
      });
      if (denial) {
        const output = normalizeToolExecutionOutput({
          text: `Error: ${denial}`,
          isError: true,
        });
        logDecision("denied", denial);
        this.events.onToolResult?.(
          name,
          args,
          output.text,
          toolCall.id,
          output,
        );
        return { result: output, changes: [], hadSideEffect: false };
      }
    }

    if (
      activeCtx?.restrictTools &&
      !ALWAYS_ALLOWED_TOOL_NAMES.has(name) &&
      !activeCtx.allowedTools.includes(name)
    ) {
      const activeNames = activeCtx.skills
        .map((skill) => `"${skill.skillName}"`)
        .join(", ");
      const errMsg =
        `Tool "${name}" is not in the active skills ${activeNames} ` +
        `allowed-tools. Available now: ${activeCtx.allowedTools.join(", ")}. ` +
        `Work within these tools, or call read_skill on a different skill, or wait for the next user message to clear the restriction.`;
      const output = normalizeToolExecutionOutput({
        text: errMsg,
        isError: true,
      });
      logDecision("denied", "active Skill allowed-tools restriction");
      this.events.onToolResult?.(name, args, output.text, toolCall.id, output);
      return { result: output, changes: [], hadSideEffect: false };
    }

    if (!isAuthorizedMcpAlias) {
      logDecision(
        getToolCapability(name)?.approval === "per_call"
          ? "requested"
          : "allowed",
      );
    }

    // File-system tools go through the shared dispatcher.
    const fsOutcome = await dispatchFsTool(name, args, this.files);
    if (fsOutcome) {
      let nextFiles = fsOutcome.newFiles;
      let changes = fsOutcome.changes;
      let resultText = fsOutcome.result;
      let onPreparedProjectCommitted: (() => void) | undefined;
      if (
        name === "init_project" &&
        nextFiles &&
        this.prepareInitializedProject
      ) {
        try {
          const prepared = await this.prepareInitializedProject(nextFiles, {
            conversationId: this.conversationId,
            template: String(args.template ?? ""),
            signal: this.ctrl?.signal ?? new AbortController().signal,
          });
          if (prepared) {
            nextFiles = prepared.files;
            changes = [...changes, ...(prepared.changes ?? [])];
            if (prepared.resultNote) {
              resultText = `${resultText}; ${prepared.resultNote}`;
            }
            onPreparedProjectCommitted = prepared.onCommitted;
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            throw error;
          }
          const errMsg = `Error: ${error instanceof Error ? error.message : String(error)}`;
          const output = normalizeToolExecutionOutput({
            text: errMsg,
            isError: true,
          });
          this.events.onToolResult?.(
            name,
            args,
            output.text,
            toolCall.id,
            output,
          );
          return { result: output, changes: [], hadSideEffect: false };
        }
      }
      if (nextFiles) {
        const validation = validateProjectFiles(nextFiles);
        if (!validation.ok) {
          const errMsg = `Error: ${validation.error}`;
          const output = normalizeToolExecutionOutput({
            text: errMsg,
            isError: true,
          });
          this.events.onToolResult?.(
            name,
            args,
            output.text,
            toolCall.id,
            output,
          );
          return { result: output, changes: [], hadSideEffect: false };
        }
        this.files = nextFiles;
        onPreparedProjectCommitted?.();
      }
      if (fsOutcome.templateChange) {
        this.events.onTemplateChange?.(
          fsOutcome.templateChange.template,
          this.getFiles(),
        );
      }
      if (fsOutcome.dependenciesChanged) {
        this.events.onDependenciesChange?.(this.getFiles());
      }
      const normalized = normalizeToolResultForModel(resultText);
      const output = normalizeToolExecutionOutput(normalized.result);
      this.events.onToolResult?.(name, args, output.text, toolCall.id, output);
      return {
        result: output,
        changes,
        hadSideEffect: toolExecutionHasSideEffect(name),
      };
    }

    let result: string | ToolExecutionOutput;

    switch (name) {
      case "compact_context": {
        const currentAssistant = this.messages.at(-1);
        const compacted = await this.events.onCompact?.();
        if (compacted) {
          this.messages = [...compacted];
          if (currentAssistant?.role === "assistant") {
            this.messages.push(currentAssistant);
          }
        }
        result = compacted
          ? "OK — context compressed successfully."
          : "Context compression skipped (not enough messages).";
        break;
      }

      case "ask_user_question": {
        if (!this.askUserQuestion) {
          result =
            "ask_user_question is not available in this session — fall back to making a reasonable assumption and proceed.";
          break;
        }
        try {
          const answers = await this.askUserQuestion(
            toolCall.id,
            args.questions as AskUserQuestion[],
          );
          result = createAskUserAnswersToolOutput(answers);
        } catch (err: any) {
          if (err?.name === "AbortError") throw err;
          result = `User question was cancelled: ${err?.message ?? "unknown"}`;
        }
        break;
      }

      case "dispatch_subagent": {
        if (!this.dispatchSubagent) {
          result =
            "dispatch_subagent is not available in this session — handle the task yourself.";
          break;
        }
        const subagentName =
          typeof args?.subagent === "string" ? args.subagent : "";
        const subagentTask = typeof args?.task === "string" ? args.task : "";
        const checkedTask = normalizeSubagentTask(subagentTask);
        if (!subagentName) {
          result =
            'Error: dispatch_subagent requires both "subagent" (name) and "task" (string) arguments.';
          break;
        }
        if (!checkedTask.ok) {
          result = `Error: ${checkedTask.error}`;
          break;
        }
        try {
          const dispatched = await this.dispatchSubagent(
            subagentName,
            checkedTask.task,
            projectFilesForModel(this.files),
            this.ctrl!.signal,
            toolCall.id,
            this.conversationId,
          );
          result = dispatched.text;
          // A fullWrite subagent returns its inner file tree; reconcile by
          // diffing against the parent's current state and emitting an
          // onFileChange event with the resolved changes.
          if (dispatched.files) {
            const beforeFiles = this.files;
            const afterFiles = {
              ...dispatched.files,
              // A subagent only sees the redacted projection. Preserve the
              // original secret-bearing files instead of writing that
              // projection back into the canonical project tree.
              ...pickSensitiveProjectFiles(beforeFiles),
            };
            const validation = validateProjectFiles(afterFiles);
            if (!validation.ok) {
              result = `Error: subagent returned an invalid project: ${validation.error}`;
              break;
            }
            const changes: FileChange[] = [];
            for (const path of Object.keys(afterFiles)) {
              if (!(path in beforeFiles)) {
                changes.push({ path, action: "created" });
              } else if (beforeFiles[path] !== afterFiles[path]) {
                changes.push({ path, action: "modified" });
              }
            }
            for (const path of Object.keys(beforeFiles)) {
              if (!(path in afterFiles)) {
                changes.push({ path, action: "deleted" });
              }
            }
            this.files = { ...afterFiles };
            if (changes.length > 0) {
              this.events.onFileChange?.(this.getFiles(), changes);
            }
          }
        } catch (err) {
          if ((err as { name?: string })?.name === "AbortError") throw err;
          const message =
            (err as { message?: string })?.message ?? "Unknown error";
          result = `Error dispatching subagent "${subagentName}": ${message}`;
        }
        break;
      }

      case "exit_plan_mode": {
        if (!this.requestPlanApproval) {
          result =
            "exit_plan_mode is not available in this session. Just present the plan in your reply.";
          break;
        }
        try {
          const decision = await this.requestPlanApproval(
            toolCall.id,
            args.plan as string,
          );
          if (decision.approved) {
            const newTools = await this.onPlanApproved?.();
            if (newTools) {
              this.tools = newTools;
            }
            // Approval changes the capability boundary. Rotate the run identity
            // so expanded tools can only execute in the next provider iteration.
            this.runId = this.createRunId();
            result = `${PLAN_APPROVED_PREFIX} by the user. Plan mode is now exited — proceed to implement the plan using the available write tools.`;
          } else {
            result = decision.feedback
              ? `${PLAN_REJECTED_PREFIX} by the user.\nUser feedback: ${decision.feedback}\nRevise the plan based on this feedback and call exit_plan_mode again.`
              : `${PLAN_REJECTED_PREFIX} by the user. Ask what to change and revise before calling exit_plan_mode again.`;
          }
        } catch (err: any) {
          if (err?.name === "AbortError") throw err;
          result = `Plan approval was cancelled: ${err?.message ?? "unknown"}`;
        }
        break;
      }

      default:
        if (this.customToolHandler) {
          try {
            result = await this.customToolHandler(name, args, {
              signal: this.ctrl!.signal,
              toolCallId: toolCall.id,
              run: this.getRunContext(),
              skillContext: this.skillContext,
            });
          } catch (err: any) {
            result = `Error in custom tool "${name}": ${err.message}`;
          }
        } else {
          result = `Error: unknown tool "${name}"`;
        }
    }

    const output = normalizeToolExecutionOutput(result);
    this.events.onToolResult?.(name, args, output.text, toolCall.id, output);
    return {
      result: output,
      changes: [],
      hadSideEffect: toolExecutionHasSideEffect(name),
    };
  }
}
