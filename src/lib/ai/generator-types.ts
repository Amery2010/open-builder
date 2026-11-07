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
  ToolRuntime,
  ToolRunContext,
} from "./tools-schema";
import type { ToolOutputRetention } from "./host-tool-catalog";
import type {
  ProjectPermissionAuthoritySnapshot,
  ProjectPermissionSession,
} from "../security/project-permission-broker";
import type {
  SkillActiveContext,
  SkillActiveContextController,
} from "../skills/active-context";
import type {
  LocalCliFailure,
  LocalAgentProvider,
  LocalCliPreparedMetadata,
  LocalCliRunStatus,
  LocalCliUsage,
  LocalToolAnnotations,
} from "../local-agent/types";

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
  instructionId?: string;
  /** Safe lifecycle telemetry captured from one local CLI run. Provider stderr
   * and other diagnostics are deliberately excluded. */
  localCli?: {
    provider: LocalAgentProvider;
    status?: LocalCliRunStatus;
    usage?: LocalCliUsage;
    warnings?: string[];
  };
  origin?: "auto_qa" | "design_review" | "design_auto_fix";
  attachments?: AttachmentRef[];
  designSelection?: DesignSelectionContext;
  /** Host-owned Design change-mode policy retained so Retry can reconstruct
   * the request boundary without treating a prior contract as new authority. */
  designExpectedChangeModes?: Array<"create" | "extend" | "migrate">;
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
      | "interrupted"
      | "deferred"
      | "superseded"
      | "unavailable";
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
  | {
      /** Persisted reference to an image in the local attachment Blob store. */
      type: "local_image";
      id: string;
      name: string;
      mimeType: string;
      size: number;
    }
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
  /** Run-local Catalog policy. The persistence sanitizer consumes and removes
   * this marker; it is never part of saved Conversation data. */
  retention?: ToolOutputRetention;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  toolCallId: string;
  run: ToolRunContext;
  skillContext: SkillActiveContextController;
}

/** Internal message format */
export interface Message {
  /** Persisted UI identity; not part of provider message payloads. */
  id?: string;
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
  /** Structured local CLI diagnostics. Raw provider stderr is never stored. */
  localCliFailure?: LocalCliFailure;
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
  | "local_cli"
  | "context_length"
  | "aborted"
  | "runtime_check"
  | "unknown";

export interface StructuredGenerationError {
  kind: StructuredGenerationErrorKind;
  message: string;
  status?: number;
  retryable: boolean;
  localCliFailure?: LocalCliFailure;
}

export interface InitializedProjectPreparation {
  files: ProjectFiles;
  changes?: FileChange[];
  /** Compact trusted note appended to the init_project tool result. */
  resultNote?: string;
  /** Rechecks external Conversation/Design authority immediately before the
   * prepared files become authoritative. Must not mutate state. */
  validateBeforeCommit?: () => void;
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
export interface PreparedUserInstruction {
  id: string;
  message: Message;
  attachments: ResolvedAttachment[];
  modelPrompt?: string;
  skillPrompt?: string;
}

export interface PreparedUserInstructionBatch {
  instructions: PreparedUserInstruction[];
  /** Synchronous ownership check and canonical-history commit. */
  commit(): boolean;
  fail(reason: "failed" | "uncertain"): void;
}

export interface UserInstructionSource {
  prepare(
    backend: GenerationBackend,
    signal: AbortSignal,
  ): Promise<PreparedUserInstructionBatch | null>;
}

export interface GeneratorOptions {
  /** Prepare source and Host recovery metadata in one validated mutation. */
  prepareProjectCommit?: (
    before: ProjectFiles,
    proposed: ProjectFiles,
    operationId: string,
  ) => ProjectFiles;
  /** Host-owned write scope for an isolated developer subagent. */
  subagentWritePaths?: readonly string[];
  getCurrentProjectFiles?: () => ProjectFiles;
  /** Synchronous compare-and-set into canonical Conversation files. */
  commitDelegatedProjectFiles?: (
    expected: ProjectFiles,
    next: ProjectFiles,
  ) => boolean;
  userInstructions?: UserInstructionSource;
  /** Conversation that owns this generator and its permission activity. */
  conversationId?: string;
  apiType?: ApiType;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  initialFiles?: ProjectFiles;
  /** Optional caller-selected limit; normal runs have no iteration limit. */
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
  /** Host-owned destructive ProjectFiles authority shared by API and Local CLI
   * adapters. Omit for isolated utility runs that cannot mutate ProjectFiles. */
  projectPermissionSession?: ProjectPermissionSession;
  onProjectPermissionAuthorityChange?: (
    authority: ProjectPermissionAuthoritySnapshot,
  ) => void;
  onProjectPermissionRequestFinished?: (callId: string, error?: string) => void;
  executionMode?: ExecutionMode;
  runtimePlatform?: RuntimePlatform;
  /** Execution transport. Desktop is a platform and does not imply that a
   * provider CLI owns the run. */
  toolRuntime?: ToolRuntime;
  allowedMcpAliases?: ReadonlySet<string>;
  /** Provider-facing annotations for dynamic local tools. */
  localToolAnnotations?: ReadonlyMap<string, LocalToolAnnotations>;
  initialSkillContext?: SkillActiveContext | null;
  thinking?: boolean;
  thinkingBudget?: number;
  /** Additional retries for failed API requests (default 2, 3 attempts total). */
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
    writePaths?: readonly string[],
    authorizeWrite?: (name: string, args: unknown) => Promise<void>,
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

/** Run-local edits are merged by the parent; only text is persisted. */
export interface DispatchSubagentResult {
  text: string;
  edits?: import("./subagents/delegated-edits").DelegatedEdit[];
  /** Settles live progress only after the parent accepts or rejects the edits. */
  complete?: (error?: string) => string;
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
  onLocalCliPrepared?: (
    provider: LocalAgentProvider,
    metadata: LocalCliPreparedMetadata,
  ) => void;
  onLocalCliStatus?: (status: LocalCliRunStatus) => void;
  onLocalCliWarning?: (message: string) => void;
  onLocalCliUsage?: (usage: LocalCliUsage) => void;
}

/** Per-request orchestration facts that are known before the UI appends the
 * optimistic user message. Runtime backends may ignore fields they do not
 * need. */
export interface GenerationRequestContext {
  /** Index of the current user message in the canonical conversation. Local
   * runtimes use it to exclude that message from bootstrap/resume history. */
  currentMessageIndex?: number;
}

/** Runtime-independent generation surface consumed by the React orchestrator. */
export interface GenerationBackend {
  recover?(
    run: import("../local-agent/types").LocalRecoverableRun,
  ): Promise<GenerateResult>;
  acknowledgeRecovery?(): Promise<void>;
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
  /** Reopen the immutable Host Tool Run after a manual grant revocation. */
  rotateProjectPermissionAuthority?(): void;
  /** Restrict provider-native search for isolated utility profiles whose
   * shared execution mode is still chat. */
  setNativeSearchAllowed?(allowed: boolean): void;
  /** Prevent an isolated utility profile from bootstrapping or resuming the
   * normal conversation when it supplies its own bounded context. */
  setConversationContextAllowed?(allowed: boolean): void;
  /** Set the MCP annotations used by the local Host Tool Authority snapshot. */
  setLocalToolAnnotations?(
    annotations: ReadonlyMap<string, LocalToolAnnotations>,
  ): void;
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
    context?: GenerationRequestContext,
  ): Promise<GenerateResult>;
}

/** Shared authoritative tool boundary used by API and local CLI runtimes. */
export interface AgentToolExecutor {
  executeToolCall(toolCall: ToolCall): Promise<{
    result: ToolExecutionOutput;
    changes: FileChange[];
    hadSideEffect: boolean;
  }>;
}
