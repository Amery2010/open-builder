import type { ToolResultPart, ToolSet } from "ai";
import type {
  AskUserQuestion,
  AskUserAnswers,
  PlanDecision,
} from "../../types/api";
import type { ApiType } from "./provider";
import type {
  ExecutionMode,
  RuntimePlatform,
  ToolRunContext,
} from "./tools-schema";
import type {
  SkillActiveContext,
  SkillActiveContextController,
} from "../skills/active-context";

export type {
  AskUserQuestion,
  AskUserAnswerItem,
  AskUserAnswers,
  PlanDecision,
} from "../../types/api";

/** Project files: path -> content */
export type ProjectFiles = Record<string, string>;

/** OpenAI multimodal content block */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | {
      type: "file";
      file: { data: string; mediaType: string; filename: string };
    };

export interface AttachmentRef {
  id: string;
  type: "file" | "image";
  name: string;
  mimeType: string;
  size: number;
}

export interface ResolvedAttachment extends AttachmentRef {
  content: string;
}

export interface MessageMetadata {
  origin?: "auto_qa" | "design_review" | "design_auto_fix";
  attachments?: AttachmentRef[];
  designSelection?: DesignSelectionContext;
  /** UI-only reference for an automatic Design Review activity block. */
  reviewJobId?: string;
  /** Compact fallback retained after the detailed review job is pruned. */
  reviewSummary?: {
    status:
      | "capturing"
      | "queued"
      | "running"
      | "fixing"
      | "verifying"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "interrupted";
    findingCount?: number;
    stale?: boolean;
  };
}

export interface DesignSelectionContext {
  protocolVersion: 1;
  elementId: string;
  idSource?: "explicit" | "runtime";
  anchorElementId?: string;
  sourceLocator?: {
    path: Array<{ tagName: string; nthOfType: number }>;
  };
  label: string;
  tagName: string;
  text?: string;
  aria?: Partial<
    Record<
      | "label"
      | "labelledby"
      | "describedby"
      | "pressed"
      | "expanded"
      | "selected"
      | "current",
      string
    >
  >;
  route: string;
  attributes?: Partial<
    Record<"role" | "type" | "name" | "placeholder", string>
  >;
}

/** Rich, persistable tool-result blocks. MCP is the first consumer, but the
 * shape intentionally lives at the generator boundary so built-in tools can
 * adopt it without introducing a second execution pipeline. */
export type ToolExecutionContent =
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
    }
  | { type: "placeholder"; label: string; reason: string };

export interface McpToolExecutionIdentity {
  kind: "mcp";
  serverId: string;
  serverName: string;
  toolName: string;
  toolTitle?: string;
  alias: string;
}

/** Unified output returned by custom tools. `text` is the deterministic
 * fallback and remains the compatibility surface for existing providers. */
export interface ToolExecutionOutput {
  text: string;
  isError?: boolean;
  structuredContent?: unknown;
  content?: ToolExecutionContent[];
  source?: McpToolExecutionIdentity;
  /** AI SDK representation used when the active provider accepts rich tool
   * results. It is derived locally and is safe to recreate after hydration. */
  modelOutput?: ToolResultPart["output"];
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  toolCallId: string;
  run: ToolRunContext;
  skillContext: SkillActiveContextController;
}

/** Internal message format */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  thinking?: string;
  /** Marks an assistant message that was synthesized locally to report an error
   *  (e.g. network failure). Consumers use this flag to render retry affordances
   *  and filter the message out of subsequent requests. */
  isError?: boolean;
  /** Structured error metadata for locally synthesized assistant errors. */
  errorKind?: StructuredGenerationErrorKind;
  errorRetryable?: boolean;
  errorStatus?: number;
  /** Skills explicitly attached to this user request. Persisted so retry can
   *  rebuild the same mandatory system context. */
  forcedSkillIds?: string[];
  /** Rich result snapshot for tool messages. `content` remains a plain-text
   * compatibility fallback for old conversations and providers. */
  toolOutput?: ToolExecutionOutput;
  metadata?: MessageMetadata;
}

/** Tool call (OpenAI function calling format) */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Tool definition (legacy OpenAI function calling format, kept for compatibility) */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
}

/** File change record */
export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
}

/** Final return value of generate() */
export interface GenerateResult {
  files: ProjectFiles;
  messages: Message[];
  text: string;
  aborted: boolean;
  maxIterationsReached: boolean;
}

export type GeneratorRunState =
  | "idle"
  | "preparing"
  | "streaming"
  | "executingTool"
  | "waitingUser"
  | "awaitingPlanApproval"
  | "autoQa"
  | "completed"
  | "error"
  | "aborted";

export type StructuredGenerationErrorKind =
  | "auth"
  | "network"
  | "model"
  | "tool"
  | "context_length"
  | "aborted"
  | "runtime_check"
  | "unknown";

export interface StructuredGenerationError {
  kind: StructuredGenerationErrorKind;
  message: string;
  status?: number;
  retryable: boolean;
}

export interface InitializedProjectPreparation {
  files: ProjectFiles;
  changes?: FileChange[];
  /** Compact trusted note appended to the init_project tool result. */
  resultNote?: string;
  /** Runs only after the prepared file tree passes validation and is committed. */
  onCommitted?: () => void;
}

export interface InitializedProjectContext {
  conversationId?: string;
  template: string;
  signal: AbortSignal;
}

export interface GeneratorEvent {
  state: GeneratorRunState;
  at: number;
  toolName?: string;
  error?: StructuredGenerationError;
}

/** Constructor options */
export interface GeneratorOptions {
  /** Conversation that owns this generator and its permission activity. */
  conversationId?: string;
  apiType?: ApiType;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  initialFiles?: ProjectFiles;
  maxIterations?: number;
  stream?: boolean;
  customTools?: ToolSet;
  /** Full tool set — when provided, used as-is without merging with BUILTIN_TOOLS.
   *  Caller decides which built-ins to include (useful for plan-mode filtering). */
  tools?: ToolSet;
  customToolHandler?: (
    name: string,
    args: unknown,
    context?: ToolExecutionContext,
  ) => string | ToolExecutionOutput | Promise<string | ToolExecutionOutput>;
  /** Optional run-local policy hook evaluated after the immutable capability
   * allowlist but before a tool can execute. Returning text denies the call. */
  authorizeToolCall?: (
    name: string,
    args: unknown,
    context: ToolExecutionContext,
  ) => string | void | Promise<string | void>;
  executionMode?: ExecutionMode;
  runtimePlatform?: RuntimePlatform;
  allowedMcpAliases?: ReadonlySet<string>;
  initialSkillContext?: SkillActiveContext | null;
  thinking?: boolean;
  thinkingBudget?: number;
  /** Max auto-retry attempts for failed API requests (default 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default 1000) */
  retryDelay?: number;
  /** Names of provider-managed tools (executed server-side, not locally) */
  providerToolNames?: string[];
  askUserQuestion?: (
    toolCallId: string,
    questions: AskUserQuestion[],
  ) => Promise<AskUserAnswers>;
  requestPlanApproval?: (
    toolCallId: string,
    plan: string,
  ) => Promise<PlanDecision>;
  /** Called once the user approves a plan via exit_plan_mode. If a new ToolSet is returned,
   *  the generator swaps to it on the next iteration (so write tools become available). */
  onPlanApproved?: () => ToolSet | void | Promise<ToolSet | void>;
  /** Run a subagent delegation request. Returns the serialized SubagentToolResult JSON
   *  that will be fed back to the parent agent as a normal tool result.
   *  Multiple calls in one turn may be invoked in parallel — implementations must be safe
   *  for concurrent execution against the same parent state. */
  dispatchSubagent?: (
    name: string,
    task: string,
    files: ProjectFiles,
    signal: AbortSignal,
    toolCallId: string,
    conversationId?: string,
  ) => Promise<DispatchSubagentResult>;
  /** Run-scoped, trusted transformation applied after init_project creates a
   * template and before that file tree becomes authoritative. */
  prepareInitializedProject?: (
    files: ProjectFiles,
    context: InitializedProjectContext,
  ) =>
    | InitializedProjectPreparation
    | void
    | Promise<InitializedProjectPreparation | void>;
}

/** Result of a subagent dispatch.
 *  `text` is the JSON-serialized SubagentToolResult that flows back into the
 *  parent's tool_result message. `files` is set only when the subagent was
 *  allowed to modify files; the parent generator overwrites its current file
 *  tree with it. */
export interface DispatchSubagentResult {
  text: string;
  files?: ProjectFiles;
}

/** Event callbacks */
export interface GeneratorEvents {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolCall?: (name: string, toolCallId: string) => void;
  onToolResult?: (
    name: string,
    args: unknown,
    result: string,
    toolCallId: string,
    output?: ToolExecutionOutput,
  ) => void;
  onFileChange?: (files: ProjectFiles, changes: FileChange[]) => void;
  onTemplateChange?: (template: string, files: ProjectFiles) => void;
  onDependenciesChange?: (files: ProjectFiles) => void;
  onComplete?: (result: GenerateResult) => void;
  onError?: (error: Error) => void;
  onRetry?: (attempt: number, maxAttempts: number, error: Error) => void;
  onCompact?: () => Promise<Message[] | null>;
}

/** Runtime-independent generation surface consumed by the React orchestrator. */
export interface GenerationBackend {
  getFiles(): ProjectFiles;
  setFiles(files: ProjectFiles): void;
  getMessages(): Message[];
  resetMessages(): void;
  syncMessages(messages: Message[]): void;
  setSystemPromptSuffix(suffix: string): void;
  setUntrustedReferenceContext(reference: string): void;
  setTools(tools: ToolSet): void;
  setReadOnlyMode(readOnly: boolean): void;
  setExecutionMode(mode: ExecutionMode): void;
  /** Restrict provider-native search for isolated utility profiles whose
   * shared execution mode is still chat. */
  setNativeSearchAllowed?(allowed: boolean): void;
  /** Prevent an isolated utility profile from bootstrapping or resuming the
   * normal conversation when it supplies its own bounded context. */
  setConversationContextAllowed?(allowed: boolean): void;
  setAllowedMcpAliases(aliases: ReadonlySet<string>): void;
  getSkillContext(): SkillActiveContextController;
  getRunContext(): ToolRunContext;
  getCustomToolSet(): ToolSet;
  setCustomToolSet(tools: ToolSet): void;
  abort(): void;
  retry(): Promise<GenerateResult>;
  generate(
    userMessage: string,
    attachments?: ResolvedAttachment[],
  ): Promise<GenerateResult>;
}

/** Shared authoritative tool boundary used by API and local CLI runtimes. */
export interface AgentToolExecutor {
  executeToolCall(
    toolCall: ToolCall,
  ): Promise<{ result: ToolExecutionOutput; changes: FileChange[] }>;
}
