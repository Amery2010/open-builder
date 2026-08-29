import type { ToolSet } from "ai";
import { WebAppGenerator } from "../ai/generator";
import type {
  FileChange,
  GenerateResult,
  GenerationBackend,
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
import {
  cancelLocalAgent,
  resolveLocalAgentTool,
  startLocalAgent,
  supportsLocalAgents,
} from "./tauri";
import {
  computeConversationFingerprint,
  formatConversationBootstrap,
} from "./context";
import {
  serializeLocalToolSet,
  validateLocalToolArguments,
} from "./tool-schema";
import type {
  LocalAgentEvent,
  LocalAgentProvider,
  LocalAgentStartRequest,
  LocalToolContent,
  LocalToolResolution,
} from "./types";

const LOCAL_RUNTIME_INSTRUCTIONS = `

## OPEN BUILDER LOCAL CLI RUNTIME
Your working directory is an isolated, empty scratch directory — not the user's project. Anything written there is invisible to the user and deleted when the run ends.
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
  getConversation?: () => Conversation | null;
  saveSession?: (session: LocalAgentSessionRef | undefined) => void;
  maxToolCalls?: number;
}

class LocalRunFailure extends Error {
  constructor(
    message: string,
    readonly hadActivity: boolean,
    readonly canRetryFresh = /\b(resume|resuming)\b|\bno conversation found\b|\b(session|thread)\b.{0,48}\b(invalid|missing|not found|expired|unavailable|does not exist)\b/i.test(
      message,
    ),
  ) {
    super(message);
    this.name = "LocalRunFailure";
  }
}

interface RunOutcome {
  sessionId?: string;
  cliVersion?: string;
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

function conversationBeforeCurrentPrompt(
  conversation: Conversation,
  prompt: string,
): Conversation {
  const messages = [...conversation.messages];
  const last = messages.at(-1);
  if (
    last?.role === "user" &&
    typeof last.content === "string" &&
    last.content === prompt
  ) {
    messages.pop();
  }
  return { ...conversation, messages };
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
    const prompt = this.lastFailureHadActivity
      ? RETRY_CONTINUATION_PROMPT
      : this.lastPrompt ||
        "Retry the most recent unfinished user request using the current Open Builder project state.";
    try {
      const result = await this.runTurn(prompt, [], false);
      this.lastFailureHadActivity = false;
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
  ): Promise<GenerateResult> {
    this.lastPrompt = userMessage;
    this.lastFailureHadActivity = false;
    this.host.appendUserMessage(userMessage, attachments);
    try {
      return await this.runTurn(userMessage, attachments, true);
    } catch (error) {
      if (error instanceof LocalRunFailure) {
        this.lastFailureHadActivity = error.hadActivity;
      }
      throw error;
    }
  }

  private async runTurn(
    prompt: string,
    attachments: ResolvedAttachment[],
    allowResume: boolean,
  ): Promise<GenerateResult> {
    this.abortRequested = false;
    if (!(await supportsLocalAgents())) {
      throw new Error(
        "Local CLI agents are available only in the desktop application.",
      );
    }
    this.planApproved = false;
    this.host.beginExternalRun();
    const conversation = this.conversationSnapshot();
    const baseline = conversationBeforeCurrentPrompt(conversation, prompt);
    const baselineFingerprint = await computeConversationFingerprint(baseline);
    const storedSession = baseline.localAgentSessions?.[this.config.provider];
    const sessionId =
      allowResume &&
      storedSession?.transcriptFingerprint === baselineFingerprint
        ? storedSession.sessionId
        : undefined;
    const bootstrapContext = sessionId
      ? undefined
      : formatConversationBootstrap(baseline);
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
        bootstrapContext,
        attachmentIndex,
        budget,
      });
    } catch (error) {
      if (
        sessionId &&
        error instanceof LocalRunFailure &&
        !error.hadActivity &&
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
      outcome.cliVersion &&
      this.config.saveSession
    ) {
      const current = this.conversationSnapshot();
      const transcriptFingerprint =
        await computeConversationFingerprint(current);
      this.config.saveSession({
        provider: this.config.provider,
        sessionId: outcome.sessionId,
        transcriptFingerprint,
        model: this.config.model || undefined,
        cliVersion: outcome.cliVersion,
        updatedAt: Date.now(),
      });
    }
    return result;
  }

  private async runOnce({
    prompt,
    sessionId,
    bootstrapContext,
    attachmentIndex,
    budget,
  }: {
    prompt: string;
    sessionId?: string;
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
    const toolSpecs = await serializeLocalToolSet(
      tools,
      new Set(["screenshot_to_code"]),
    );
    if (attachmentIndex.size > 0) {
      toolSpecs.push({
        name: "read_attachment",
        description:
          "Read an Open Builder attachment by its opaque id. Returns text, an image, or an embedded PDF resource.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      });
    }
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
    let toolError: Error | null = null;
    let toolQueue = Promise.resolve();
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
    ) => {
      if (this.abortRequested || budget.exhausted || toolError) {
        await cancelLocalAgent(event.runId).catch(() => false);
        return;
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
        const validation = await validateLocalToolArguments(
          tools,
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
      await resolveLocalAgentTool(
        event.runId,
        event.callId,
        toLocalResolution(output),
      );
      if (budgetError) {
        await cancelLocalAgent(event.runId).catch(() => false);
      }
    };

    const outcome = await new Promise<RunOutcome>((resolve, reject) => {
      let settled = false;
      const finish = (done: Extract<LocalAgentEvent, { type: "done" }>) => {
        if (settled) return;
        settled = true;
        void toolQueue.then(() => {
          appendAssistant();
          this.currentRunId = null;
          if (toolError) {
            reject(new LocalRunFailure(toolError.message, hadActivity));
            return;
          }
          if (error) {
            reject(new LocalRunFailure(error.message, hadActivity));
            return;
          }
          resolve({
            sessionId: done.sessionId ?? activeSessionId,
            cliVersion,
            aborted: done.aborted || this.abortRequested,
            text,
          });
        });
      };

      const onEvent = (event: LocalAgentEvent) => {
        switch (event.type) {
          case "session":
            activeSessionId = event.sessionId;
            cliVersion = event.cliVersion;
            break;
          case "textDelta":
            streamedChars += event.delta.length;
            if (streamedChars > MAX_LOCAL_STREAM_CHARS) {
              error = new Error(
                "Local CLI output exceeded the renderer limit.",
              );
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
              error = new Error(
                "Local CLI output exceeded the renderer limit.",
              );
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
            this.currentRunId = event.runId;
            toolQueue = toolQueue
              .then(() => executeTool(event))
              .catch((cause) => {
                toolError =
                  cause instanceof Error ? cause : new Error(String(cause));
                void cancelLocalAgent(event.runId);
              });
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
            console.warn("Local CLI warning:", event.message);
            break;
          case "error":
            error = new Error(event.message);
            break;
          case "done":
            finish(event);
            break;
          case "status":
          case "usage":
            break;
        }
      };

      startLocalAgent(request, onEvent)
        .then((runId) => {
          if (!settled) this.currentRunId = runId;
          if (this.abortRequested || budget.exhausted) {
            void cancelLocalAgent(runId);
          }
        })
        .catch((cause) => {
          if (settled) return;
          settled = true;
          this.currentRunId = null;
          reject(
            new LocalRunFailure(
              cause instanceof Error ? cause.message : String(cause),
              hadActivity,
            ),
          );
        });
    });
    return outcome;
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
              `Local utility generation timed out after ${timeoutMs}ms.`,
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
