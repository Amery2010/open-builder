import type { ToolSet } from "ai";
import { WebAppGenerator } from "../ai/generator";
import type {
  FileChange,
  GenerateResult,
  GenerationBackend,
  GenerationRequestContext,
  GeneratorEvents,
  GeneratorOptions,
  Message,
  ProjectFiles,
  ResolvedAttachment,
  ToolCall,
  ToolExecutionContent,
  ToolExecutionOutput,
} from "../ai/generator-types";
import type { ExecutionMode } from "../ai/tools-schema";
import type { Conversation, LocalAgentSessionRef } from "../../types";
import { resolveAttachmentForModel } from "../attachments/store";
import { formatUntrustedReferenceContext } from "../ai/messages";
import { normalizeToolExecutionOutput } from "../utils/tool-result";
import { PLAN_APPROVED_PREFIX } from "../ai/plan-mode";
import { getT } from "../../i18n";
import { cancelLocalAgent, supportsLocalAgents } from "./tauri";
import {
  isLocalCliRuntimeError,
  localCliRuntime,
  type LocalCliRunResult,
} from "./runtime";
import {
  computeConversationFingerprint,
  formatConversationBootstrap,
} from "./context";
import { createLocalToolAuthoritySnapshot } from "./authority";
import type {
  LocalAgentEvent,
  LocalAgentProvider,
  LocalAgentStartRequest,
  LocalCliFailure,
  LocalCliHostToolOutcome,
  LocalCliPreparedMetadata,
  LocalCliUsage,
  LocalToolAnnotations,
  LocalToolContent,
  LocalToolResolution,
  LocalToolSpec,
} from "./types";
import { localAgentSupportsNativeSearch } from "./providers";

const LOCAL_RUNTIME_INSTRUCTIONS = `

## OPEN BUILDER LOCAL CLI RUNTIME
Your working directory is a stable, app-private blank scratch directory — not the user's project. Anything written there is outside Open Builder's project state and invisible to the user.
The Open Builder host tools are the only authority for project files, preview state, Skills, memory, and approved MCP calls. Never route project work through the native shell, filesystem, hooks, plugins, or external MCP configuration.
Read listed attachments with read_attachment, using the opaque attachment id.
screenshot_to_code is deliberately unavailable here: inspect the attachment yourself and build with the normal project tools.
`;

const PLAN_CONTINUATION_PROMPT =
  "The user approved your plan in Open Builder. Implement it now with the chat-mode tools that just became available. Do not restate the plan or ask for approval again.";

const RETRY_CONTINUATION_PROMPT =
  "Resume the most recent unfinished request, using the canonical Open Builder history and current project state. Do only the remaining work. Do not repeat completed tool calls, native searches, or external side effects.";

const DEFAULT_LOCAL_TOOL_BUDGET = 30;
const MAX_DISPATCH_SUBAGENT_CALLS = 3;
const MAX_LOCAL_STREAM_CHARS = 16 * 1024 * 1024;

export interface LocalAgentClientConfig {
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  nativeSearch: boolean;
  conversationId?: string;
  toolAnnotations?: ReadonlyMap<string, LocalToolAnnotations>;
  getConversation?: () => Conversation | null;
  saveSession?: (session: LocalAgentSessionRef | undefined) => void;
  maxToolCalls?: number;
}

class LocalRunFailure extends Error {
  constructor(
    message: string,
    readonly hadActivity: boolean,
    readonly failure?: LocalCliFailure,
    readonly canRetryFresh = failure?.code === "sessionUnavailable" &&
      failure.retryPolicy === "freshSessionSafe",
  ) {
    super(message);
    this.name = "LocalRunFailure";
  }
}

interface RunOutcome {
  sessionId?: string;
  cliVersion?: string;
  prepared?: LocalCliPreparedMetadata;
  usage?: LocalCliUsage;
  warnings?: string[];
  status?: { state: string; message?: string };
  aborted: boolean;
  text: string;
}

interface LocalTurnBudget {
  readonly maxToolCalls: number;
  toolCalls: number;
  dispatchSubagentCalls: number;
  exhausted: boolean;
}

interface AttachmentIndexEntry extends ResolvedAttachment {}

function contentData(value: string): { mimeType?: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  return match ? { mimeType: match[1], data: match[2] } : { data: value };
}

function attachmentOutput(
  attachment: AttachmentIndexEntry,
): ToolExecutionOutput {
  if (attachment.type === "image") {
    const parsed = contentData(attachment.content);
    return normalizeToolExecutionOutput({
      text: `Image attachment: ${attachment.name}`,
      content: [
        {
          type: "image",
          data: parsed.data,
          mimeType: parsed.mimeType ?? attachment.mimeType,
        },
      ],
    });
  }
  if (attachment.mimeType === "application/pdf") {
    const parsed = contentData(attachment.content);
    return normalizeToolExecutionOutput({
      text: `PDF attachment: ${attachment.name}`,
      content: [
        {
          type: "resource",
          uri: `attachment://${attachment.id}`,
          mimeType: attachment.mimeType,
          blob: parsed.data,
        },
      ],
    });
  }
  return normalizeToolExecutionOutput({
    text: attachment.content,
    content: [{ type: "text", text: attachment.content }],
  });
}

function toLocalContent(content: ToolExecutionContent): LocalToolContent {
  switch (content.type) {
    case "text":
    case "image":
    case "audio":
    case "resource":
    case "resource_link":
      return content;
    case "placeholder":
      return {
        type: "text",
        text: `[${content.label}: ${content.reason}]`,
      };
  }
}

function toLocalResolution(output: ToolExecutionOutput): LocalToolResolution {
  return {
    text: output.text,
    isError: output.isError,
    structuredContent: output.structuredContent,
    content: output.content?.map(toLocalContent),
  };
}

async function collectAttachmentIndex(
  messages: readonly Message[],
  current: readonly ResolvedAttachment[],
): Promise<Map<string, AttachmentIndexEntry>> {
  const index = new Map(
    current.map((attachment) => [attachment.id, attachment]),
  );
  const seen = new Set(index.keys());
  const historical = messages
    .flatMap((message) => message.metadata?.attachments ?? [])
    .filter((attachment) => {
      if (seen.has(attachment.id)) return false;
      seen.add(attachment.id);
      return true;
    });

  await Promise.all(
    historical.map(async (attachment) => {
      try {
        index.set(attachment.id, await resolveAttachmentForModel(attachment));
      } catch {
        // Missing attachment data is intentionally unavailable to this run.
      }
    }),
  );
  return index;
}

function createTurnBudget(maxToolCalls?: number): LocalTurnBudget {
  const requested = maxToolCalls ?? DEFAULT_LOCAL_TOOL_BUDGET;
  return {
    maxToolCalls: Number.isFinite(requested)
      ? Math.max(1, Math.floor(requested))
      : DEFAULT_LOCAL_TOOL_BUDGET,
    toolCalls: 0,
    dispatchSubagentCalls: 0,
    exhausted: false,
  };
}

function consumeToolBudget(
  budget: LocalTurnBudget,
  name: string,
): string | null {
  if (
    name === "dispatch_subagent" &&
    budget.dispatchSubagentCalls >= MAX_DISPATCH_SUBAGENT_CALLS
  ) {
    budget.exhausted = true;
    return `Error: local turn subagent dispatch limit reached (max ${MAX_DISPATCH_SUBAGENT_CALLS}).`;
  }
  if (budget.toolCalls >= budget.maxToolCalls) {
    budget.exhausted = true;
    return `Error: local turn tool-call budget reached (max ${budget.maxToolCalls}).`;
  }

  budget.toolCalls += 1;
  if (name === "dispatch_subagent") budget.dispatchSubagentCalls += 1;
  if (budget.toolCalls >= budget.maxToolCalls) budget.exhausted = true;
  return null;
}

export class LocalAgentGenerator implements GenerationBackend {
  private readonly host: WebAppGenerator;
  private readonly config: LocalAgentClientConfig;
  private readonly events: GeneratorEvents;
  private currentRunId: string | null = null;
  private abortRequested = false;
  private planApproved = false;
  private nativeSearchAllowed = true;
  private conversationContextAllowed = true;
  private lastPrompt = "";
  private lastFailureHadActivity = false;
  private lastBaseline: Conversation | null = null;
  private activeSignal: AbortSignal | null = null;
  private readonly utilityScopeId: string;
  private localToolAnnotations: ReadonlyMap<string, LocalToolAnnotations>;

  private conversationSnapshot(): Conversation {
    return (
      (this.conversationContextAllowed
        ? this.config.getConversation?.()
        : null) ?? {
        id: this.config.conversationId ?? "local-agent-ephemeral",
        title: "Local agent",
        messages: this.host.getMessages(),
        files: this.host.getFiles(),
        template: "vite-react-ts",
        isProjectInitialized: Object.keys(this.host.getFiles()).length > 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    );
  }

  constructor(
    host: WebAppGenerator,
    config: LocalAgentClientConfig,
    events: GeneratorEvents,
  ) {
    this.host = host;
    this.config = config;
    this.events = events;
    this.localToolAnnotations = new Map(config.toolAnnotations ?? []);
    this.utilityScopeId =
      globalThis.crypto?.randomUUID?.() ??
      `utility-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  getFiles(): ProjectFiles {
    return this.host.getFiles();
  }

  setFiles(files: ProjectFiles): void {
    this.host.setFiles(files);
  }

  getMessages(): Message[] {
    return this.host.getMessages();
  }

  resetMessages(): void {
    this.host.resetMessages();
  }

  syncMessages(messages: Message[]): void {
    this.host.syncMessages(messages);
  }

  setSystemPromptSuffix(suffix: string): void {
    this.host.setSystemPromptSuffix(suffix);
  }

  setUntrustedReferenceContext(reference: string): void {
    this.host.setUntrustedReferenceContext(reference);
  }

  setTools(tools: ToolSet): void {
    this.host.setTools(tools);
  }

  setReadOnlyMode(readOnly: boolean): void {
    this.host.setReadOnlyMode(readOnly);
  }

  setExecutionMode(mode: ExecutionMode): void {
    this.host.setExecutionMode(mode);
  }

  setNativeSearchAllowed(allowed: boolean): void {
    this.nativeSearchAllowed = allowed;
  }

  setConversationContextAllowed(allowed: boolean): void {
    this.conversationContextAllowed = allowed;
  }

  setAllowedMcpAliases(aliases: ReadonlySet<string>): void {
    this.host.setAllowedMcpAliases(aliases);
  }

  setLocalToolAnnotations(
    annotations: ReadonlyMap<string, LocalToolAnnotations>,
  ): void {
    this.localToolAnnotations = new Map(annotations);
  }

  getSkillContext() {
    return this.host.getSkillContext();
  }

  getRunContext() {
    return this.host.getRunContext();
  }

  getCustomToolSet(): ToolSet {
    return this.host.getCustomToolSet();
  }

  setCustomToolSet(tools: ToolSet): void {
    this.host.setCustomToolSet(tools);
  }

  abort(): void {
    this.abortRequested = true;
    this.host.abort();
    if (this.currentRunId) {
      void cancelLocalAgent(this.currentRunId);
    }
  }

  async retry(): Promise<GenerateResult> {
    this.assertSearchCompatibility();
    const failureHadActivity = this.lastFailureHadActivity;
    const prompt = failureHadActivity
      ? RETRY_CONTINUATION_PROMPT
      : this.lastPrompt ||
        "Retry the most recent unfinished user request using the current Open Builder project state.";
    try {
      const result = await this.runTurn(
        prompt,
        [],
        false,
        failureHadActivity ? undefined : (this.lastBaseline ?? undefined),
      );
      this.lastFailureHadActivity = false;
      this.lastBaseline = null;
      return result;
    } catch (error) {
      if (error instanceof LocalRunFailure) {
        this.lastFailureHadActivity ||= error.hadActivity;
      }
      throw error;
    }
  }

  async generate(
    userMessage: string,
    attachments: ResolvedAttachment[] = [],
    context?: GenerationRequestContext,
  ): Promise<GenerateResult> {
    this.assertSearchCompatibility();
    this.lastPrompt = userMessage;
    this.lastFailureHadActivity = false;
    const conversation = this.conversationSnapshot();
    const currentMessageIndex = context?.currentMessageIndex;
    if (
      currentMessageIndex !== undefined &&
      (!Number.isInteger(currentMessageIndex) ||
        currentMessageIndex < 0 ||
        currentMessageIndex > conversation.messages.length)
    ) {
      throw new Error("The current conversation message index is invalid.");
    }
    // The UI optimistically persists the current request before invoking the
    // backend. Use its canonical index to exclude it from bootstrap/resume
    // history, independent of prompt transformations and attachments.
    const baseline =
      currentMessageIndex === undefined
        ? conversation
        : {
            ...conversation,
            messages: conversation.messages.slice(0, currentMessageIndex),
          };
    this.lastBaseline = baseline;
    this.host.appendUserMessage(userMessage, attachments);
    try {
      return await this.runTurn(userMessage, attachments, true, baseline);
    } catch (error) {
      if (error instanceof LocalRunFailure) {
        this.lastFailureHadActivity = error.hadActivity;
      }
      throw error;
    }
  }

  private assertSearchCompatibility(): void {
    const mode = this.host.getRunContext().mode;
    if (
      !localAgentSupportsNativeSearch(this.config.provider) &&
      this.config.nativeSearch &&
      this.nativeSearchAllowed &&
      (mode === "chat" || mode === "plan")
    ) {
      throw new Error(getT().settings.localCli.builtinSearchBlocked);
    }
  }

  private async runTurn(
    prompt: string,
    attachments: ResolvedAttachment[],
    allowResume: boolean,
    baselineOverride?: Conversation,
  ): Promise<GenerateResult> {
    this.abortRequested = false;
    if (!(await supportsLocalAgents())) {
      throw new Error(getT().settings.localCli.runtimeUnavailable);
    }
    this.planApproved = false;
    this.activeSignal = this.host.beginExternalRun();
    const initialMode = this.host.getRunContext().mode;
    const persistentConversationRun =
      initialMode === "chat" || initialMode === "plan";
    const conversation = baselineOverride ?? this.conversationSnapshot();
    const baseline = baselineOverride ?? conversation;
    const baselineFingerprint = await computeConversationFingerprint(baseline);
    const storedSession = baseline.localAgentSessions?.[this.config.provider];
    const sessionId =
      allowResume &&
      persistentConversationRun &&
      Boolean(storedSession?.compatibilityKey) &&
      storedSession?.transcriptFingerprint === baselineFingerprint
        ? storedSession.sessionId
        : undefined;
    // The backend discards bootstrap context when the compatibility key proves
    // a valid resume. Sending it for every request keeps the wire complete and
    // lets a fresh run recover without rebuilding the request object.
    const bootstrapContext = formatConversationBootstrap(baseline);
    const attachmentIndex = await collectAttachmentIndex(
      this.host.getMessages(),
      attachments,
    );
    const budget = createTurnBudget(this.config.maxToolCalls);

    let outcome: RunOutcome;
    try {
      outcome = await this.runOnce({
        prompt,
        sessionId,
        sessionCompatibilityKey: sessionId
          ? storedSession?.compatibilityKey
          : undefined,
        bootstrapContext,
        attachmentIndex,
        budget,
      });
    } catch (error) {
      if (
        sessionId &&
        error instanceof LocalRunFailure &&
        !error.hadActivity &&
        !error.failure?.hadHostSideEffect &&
        error.canRetryFresh &&
        !this.abortRequested
      ) {
        this.config.saveSession?.(undefined);
        outcome = await this.runOnce({
          prompt,
          bootstrapContext: formatConversationBootstrap(baseline),
          attachmentIndex,
          budget,
        });
      } else {
        this.events.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }
    }

    let fullText = outcome.text;
    if (this.planApproved && !outcome.aborted && !budget.exhausted) {
      this.planApproved = false;
      const continuation = await this.runOnce({
        prompt: PLAN_CONTINUATION_PROMPT,
        sessionId: outcome.sessionId,
        sessionCompatibilityKey: outcome.prepared?.compatibilityKey,
        bootstrapContext,
        attachmentIndex,
        budget,
      });
      outcome = continuation;
      fullText += continuation.text;
    }

    const result: GenerateResult = {
      files: this.host.getFiles(),
      messages: this.host.getMessages(),
      text: fullText,
      aborted: outcome.aborted && !budget.exhausted,
      maxIterationsReached: budget.exhausted,
    };
    this.events.onComplete?.(result);

    if (
      !outcome.aborted &&
      !budget.exhausted &&
      outcome.sessionId &&
      outcome.prepared?.compatibilityKey &&
      outcome.prepared.installationFingerprint &&
      this.config.saveSession &&
      persistentConversationRun
    ) {
      const current = this.conversationSnapshot();
      const transcriptFingerprint =
        await computeConversationFingerprint(current);
      this.config.saveSession({
        provider: this.config.provider,
        sessionId: outcome.sessionId,
        transcriptFingerprint,
        model: this.config.model || undefined,
        compatibilityKey: outcome.prepared?.compatibilityKey,
        installationFingerprint: outcome.prepared?.installationFingerprint,
        actualModel: outcome.prepared?.actualModel,
        actualEffort: outcome.prepared?.actualEffort,
        cliVersion:
          outcome.prepared?.cliVersion ?? outcome.cliVersion ?? "unknown",
        updatedAt: Date.now(),
      });
    }
    return result;
  }

  private async runOnce({
    prompt,
    sessionId,
    sessionCompatibilityKey,
    bootstrapContext,
    attachmentIndex,
    budget,
  }: {
    prompt: string;
    sessionId?: string;
    sessionCompatibilityKey?: string;
    bootstrapContext?: string;
    attachmentIndex: Map<string, AttachmentIndexEntry>;
    budget: LocalTurnBudget;
  }): Promise<RunOutcome> {
    const tools = this.host.getTools();
    const runContext = this.host.getRunContext();
    const nativeSearch =
      this.config.nativeSearch &&
      this.nativeSearchAllowed &&
      (runContext.mode === "chat" || runContext.mode === "plan");
    const attachmentSpecs: LocalToolSpec[] = [];
    if (attachmentIndex.size > 0) {
      attachmentSpecs.push({
        name: "read_attachment",
        description:
          "Read an Open Builder attachment by its opaque id. Returns text, an image, or an embedded PDF resource.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        hostApproval: "none",
      });
    }
    const authority = await createLocalToolAuthoritySnapshot({
      tools,
      mode: runContext.mode,
      platform: runContext.platform,
      allowedMcpAliases: runContext.allowedMcpAliases,
      annotations: this.localToolAnnotations,
      extraSpecs: attachmentSpecs,
    });
    const toolSpecs = [...authority.specs];
    const attachmentListing = [...attachmentIndex.values()]
      .map(
        (attachment) =>
          `${attachment.id}: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`,
      )
      .join("\n");
    const promptWithAttachments = attachmentListing
      ? `${prompt}\n\n[Available attachments]\n${attachmentListing}`
      : prompt;
    const untrustedReference = formatUntrustedReferenceContext(
      this.host.getUntrustedReferenceContext(),
    );
    const request: LocalAgentStartRequest = {
      provider: this.config.provider,
      model: this.config.model || undefined,
      effort: this.config.effort || undefined,
      systemPrompt: `${this.host.getSystemContent()}${LOCAL_RUNTIME_INSTRUCTIONS}`,
      prompt: untrustedReference
        ? `${untrustedReference}\n\n[Current user request]\n${promptWithAttachments}`
        : promptWithAttachments,
      bootstrapContext,
      sessionId,
      sessionCompatibilityKey,
      scope:
        runContext.mode === "subagent" || runContext.mode === "auto_qa"
          ? { kind: "utility", id: this.utilityScopeId }
          : {
              kind: "conversation",
              id:
                this.config.conversationId ??
                runContext.conversationId ??
                "local-agent-ephemeral",
            },
      tools: toolSpecs,
      nativeSearch,
      maxToolCalls: Math.max(1, budget.maxToolCalls - budget.toolCalls),
      mode: runContext.mode,
    };

    let text = "";
    let assistantText = "";
    let assistantThinking = "";
    let cliVersion: string | undefined;
    let activeSessionId = sessionId;
    let hadActivity = false;
    let error: Error | null = null;
    let streamedChars = 0;
    const nativeStarted = new Set<string>();
    const nativeRejected = new Set<string>();

    const appendAssistant = (toolCall?: ToolCall) => {
      if (!assistantText && !assistantThinking && !toolCall) return;
      this.host.appendMessage({
        role: "assistant",
        content: assistantText || null,
        thinking: assistantThinking || undefined,
        tool_calls: toolCall ? [toolCall] : undefined,
      });
      assistantText = "";
      assistantThinking = "";
    };

    const executeTool = async (
      event: Extract<LocalAgentEvent, { type: "toolRequest" }>,
    ): Promise<LocalCliHostToolOutcome> => {
      if (!authority.has(event.name)) {
        const output = normalizeToolExecutionOutput({
          text: `Error: tool "${event.name}" is not authorized for this local CLI run.`,
          isError: true,
        });
        this.events.onToolResult?.(
          event.name,
          event.arguments,
          output.text,
          event.callId,
          output,
        );
        return { resolution: toLocalResolution(output), hadSideEffect: false };
      }
      if (this.abortRequested || budget.exhausted) {
        await cancelLocalAgent(event.runId).catch(() => false);
        return {
          resolution: {
            text: "Error: the local CLI run is stopping.",
            isError: true,
          },
          hadSideEffect: false,
        };
      }
      hadActivity = true;
      const toolCall: ToolCall = {
        id: event.callId,
        type: "function",
        function: {
          name: event.name,
          arguments: JSON.stringify(event.arguments ?? {}),
        },
      };
      appendAssistant(toolCall);
      this.events.onToolCall?.(event.name, event.callId);

      let output: ToolExecutionOutput;
      let changes: FileChange[] = [];
      let hadSideEffect = false;
      const budgetError = consumeToolBudget(budget, event.name);
      if (budgetError) {
        output = normalizeToolExecutionOutput({
          text: budgetError,
          isError: true,
        });
        this.events.onToolResult?.(
          event.name,
          event.arguments,
          output.text,
          event.callId,
          output,
        );
      } else if (event.name === "read_attachment") {
        const id =
          event.arguments && typeof event.arguments === "object"
            ? (event.arguments as { id?: unknown }).id
            : undefined;
        const attachment =
          typeof id === "string" ? attachmentIndex.get(id) : undefined;
        output = attachment
          ? attachmentOutput(attachment)
          : normalizeToolExecutionOutput({
              text: "Error: attachment is unavailable for this run.",
              isError: true,
            });
        this.events.onToolResult?.(
          event.name,
          event.arguments,
          output.text,
          event.callId,
          output,
        );
      } else {
        const validation = await authority.validate(
          event.name,
          event.arguments,
        );
        if (!validation.success) {
          output = normalizeToolExecutionOutput({
            text: `Error: invalid arguments for "${event.name}": ${validation.error.message}`,
            isError: true,
          });
          this.events.onToolResult?.(
            event.name,
            event.arguments,
            output.text,
            event.callId,
            output,
          );
        } else {
          const executed = await this.host.executeToolCall({
            ...toolCall,
            function: {
              ...toolCall.function,
              arguments: JSON.stringify(validation.value),
            },
          });
          output = executed.result;
          changes = executed.changes;
          hadSideEffect =
            executed.hadSideEffect && !authority.isReadOnly(event.name);
          if (
            event.name === "exit_plan_mode" &&
            output.text.startsWith(PLAN_APPROVED_PREFIX)
          ) {
            this.planApproved = true;
            this.host.setReadOnlyMode(false);
            this.host.setExecutionMode("chat");
          }
        }
      }
      this.host.appendMessage({
        role: "tool",
        tool_call_id: event.callId,
        content: output.text,
        toolOutput: output,
      });
      if (changes.length > 0) {
        this.events.onFileChange?.(this.host.getFiles(), changes);
      }
      if (budgetError) {
        await cancelLocalAgent(event.runId).catch(() => false);
      }
      return {
        resolution: toLocalResolution(output),
        hadSideEffect,
      };
    };

    const onEvent = (event: LocalAgentEvent) => {
      switch (event.type) {
        case "session":
          activeSessionId = event.sessionId;
          cliVersion = event.cliVersion;
          break;
        case "prepared":
          cliVersion = event.cliVersion;
          break;
        case "textDelta":
          streamedChars += event.delta.length;
          if (streamedChars > MAX_LOCAL_STREAM_CHARS) {
            error = new Error(getT().settings.localCli.outputLimit);
            this.abortRequested = true;
            this.host.abort();
            if (this.currentRunId) void cancelLocalAgent(this.currentRunId);
            break;
          }
          hadActivity = true;
          text += event.delta;
          assistantText += event.delta;
          this.events.onText?.(event.delta);
          break;
        case "reasoningDelta":
          streamedChars += event.delta.length;
          if (streamedChars > MAX_LOCAL_STREAM_CHARS) {
            error = new Error(getT().settings.localCli.outputLimit);
            this.abortRequested = true;
            this.host.abort();
            if (this.currentRunId) void cancelLocalAgent(this.currentRunId);
            break;
          }
          hadActivity = true;
          assistantThinking += event.delta;
          this.events.onThinking?.(event.delta);
          break;
        case "toolRequest":
          // LocalCliRuntime serializes tool execution and resolves each call
          // exactly once. The generator retains the host-authority side effects
          // in executeTool, but no longer owns the transport queue.
          this.currentRunId = event.runId;
          break;
        case "nativeTool": {
          hadActivity = true;
          if (event.phase === "started") {
            const budgetError = consumeToolBudget(budget, event.name);
            if (budgetError) {
              nativeRejected.add(event.callId);
              if (this.currentRunId) {
                void cancelLocalAgent(this.currentRunId);
              }
              break;
            }
            nativeStarted.add(event.callId);
            this.events.onToolCall?.(event.name, event.callId);
          } else {
            if (nativeRejected.delete(event.callId)) break;
            if (!nativeStarted.has(event.callId)) {
              const budgetError = consumeToolBudget(budget, event.name);
              if (budgetError) {
                if (this.currentRunId) {
                  void cancelLocalAgent(this.currentRunId);
                }
                break;
              }
              this.events.onToolCall?.(event.name, event.callId);
            }
            nativeStarted.delete(event.callId);
            const resultText = event.result
              ? JSON.stringify(event.result)
              : "Native CLI search completed.";
            this.events.onToolResult?.(
              event.name,
              event.arguments ?? {},
              resultText,
              event.callId,
              normalizeToolExecutionOutput(resultText),
            );
          }
          break;
        }
        case "warning":
          this.events.onLocalCliWarning?.(event.message);
          break;
        case "error":
          break;
        case "done":
          break;
        case "status":
          this.events.onLocalCliStatus?.({
            state: event.state,
            message: event.message,
          });
          break;
        case "usage":
          this.events.onLocalCliUsage?.({
            ...(event.inputTokens !== undefined
              ? { inputTokens: event.inputTokens }
              : {}),
            ...(event.outputTokens !== undefined
              ? { outputTokens: event.outputTokens }
              : {}),
            ...(event.cachedInputTokens !== undefined
              ? { cachedInputTokens: event.cachedInputTokens }
              : {}),
          });
          break;
      }
    };

    let runtimeResult: LocalCliRunResult;
    try {
      runtimeResult = await localCliRuntime.run(
        request,
        {
          onEvent,
          executeHostTool: async (event) => executeTool(event),
        },
        this.activeSignal ?? undefined,
      );
    } catch (cause) {
      this.currentRunId = null;
      if (isLocalCliRuntimeError(cause)) {
        const failure = cause.failure;
        throw new LocalRunFailure(
          failure.safeMessage,
          failure.hadActivity || hadActivity,
          failure,
        );
      }
      throw new LocalRunFailure(
        cause instanceof Error ? cause.message : String(cause),
        hadActivity,
      );
    }

    appendAssistant();
    this.attachLocalCliTelemetry(runtimeResult);
    this.currentRunId = null;
    const rendererError = error as Error | null;
    if (rendererError) {
      throw new LocalRunFailure(rendererError.message, hadActivity);
    }
    return {
      sessionId: runtimeResult.sessionId ?? activeSessionId,
      cliVersion: runtimeResult.cliVersion ?? cliVersion,
      prepared: runtimeResult.prepared,
      usage: runtimeResult.usage,
      warnings: runtimeResult.warnings,
      status: runtimeResult.status,
      aborted: runtimeResult.aborted || this.abortRequested,
      text,
    };
  }

  private attachLocalCliTelemetry(result: LocalCliRunResult): void {
    if (!result.status && !result.usage && result.warnings.length === 0) {
      return;
    }
    const messages = this.host.getMessages();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      messages[index] = {
        ...message,
        metadata: {
          ...message.metadata,
          localCli: {
            provider: this.config.provider,
            ...(result.status ? { status: result.status } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.warnings.length > 0
              ? { warnings: [...result.warnings] }
              : {}),
          },
        },
      };
      this.host.syncMessages(messages);
      return;
    }
  }
}

export function createLocalAgentGenerator(
  config: LocalAgentClientConfig,
  events: GeneratorEvents = {},
  initialFiles?: ProjectFiles,
  customTools?: ToolSet,
  customToolHandler?: GeneratorOptions["customToolHandler"],
  extras?: Pick<
    GeneratorOptions,
    | "tools"
    | "localToolAnnotations"
    | "askUserQuestion"
    | "requestPlanApproval"
    | "onPlanApproved"
    | "dispatchSubagent"
    | "executionMode"
    | "runtimePlatform"
    | "conversationId"
    | "allowedMcpAliases"
    | "initialSkillContext"
    | "systemPrompt"
    | "maxIterations"
    | "prepareInitializedProject"
    | "authorizeToolCall"
  >,
): LocalAgentGenerator {
  const host = new WebAppGenerator(
    {
      apiBaseUrl: "http://127.0.0.1.invalid",
      apiKey: "local-cli-runtime",
      model: config.model || `${config.provider}-cli`,
      stream: true,
      conversationId: config.conversationId ?? extras?.conversationId,
      initialFiles,
      customTools,
      customToolHandler,
      ...(extras ?? {}),
    },
    events,
  );
  return new LocalAgentGenerator(
    host,
    {
      ...config,
      toolAnnotations: extras?.localToolAnnotations ?? config.toolAnnotations,
      maxToolCalls: extras?.maxIterations ?? config.maxToolCalls,
    },
    events,
  );
}

export async function runLocalUtilityText(
  config: Pick<LocalAgentClientConfig, "provider" | "model" | "effort">,
  instructions: string,
  prompt: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
  let text = "";
  const generator = createLocalAgentGenerator(
    { ...config, nativeSearch: false },
    { onText: (delta) => (text += delta) },
    {},
    {},
    undefined,
    {
      tools: {},
      executionMode: "subagent",
      runtimePlatform: "desktop",
      systemPrompt: instructions,
    },
  );
  const generation = generator.generate(prompt);
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const guards: Promise<never>[] = [];
    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      guards.push(
        new Promise<never>((_resolve, reject) => {
          timeoutId = globalThis.setTimeout(() => {
            generator.abort();
            const error = new Error(
              getT().settings.localCli.utilityTimeout.replace(
                "{timeoutMs}",
                String(timeoutMs),
              ),
            );
            error.name = "TimeoutError";
            reject(error);
          }, timeoutMs);
        }),
      );
    }
    if (signal) {
      guards.push(
        new Promise<never>((_resolve, reject) => {
          abortHandler = () => {
            generator.abort();
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError"),
            );
          };
          signal.addEventListener("abort", abortHandler, { once: true });
        }),
      );
    }
    await Promise.race([generation, ...guards]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
  return text.trim();
}
