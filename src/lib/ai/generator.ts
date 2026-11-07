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
  DESIGN_DIAGNOSTIC_TOOLS,
  HOST_TOOL_CATALOG,
  TOOL_POLICY_VERSION,
  getToolCapability,
  type ExecutionMode,
  type RuntimePlatform,
  type ToolRunContext,
} from "./tools-schema";
import {
  HostToolDispatchError,
  type HostToolProjectPermissionResolution,
  type HostToolRun,
} from "./host-tool-catalog";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt";
import { UI_DESIGN_PRINCIPLES } from "./ui-design-principles";
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
import { projectFilesForModel } from "../utils/project-file-policy";
import { getSubagentByName } from "./subagents/registry";
import {
  DelegatedEditCoordinator,
  collectDelegatedEdits,
  delegatedWriteError,
  mergeDelegatedEdits,
  validateDelegatedWritePaths,
} from "./subagents/delegated-edits";
import { normalizeSubagentTask } from "./subagents/limits";
import {
  activeSkillToolRestrictionError,
  createSkillActiveContext,
} from "../skills/active-context";
import type { SkillActiveContextController } from "../skills/active-context";
import { recordPermissionActivity } from "../security/activity-log";
import {
  ProjectPermissionError,
  type ProjectPermissionPermit,
  type ProjectPermissionSession,
} from "../security/project-permission-broker";
import { isRetryableGenerationError } from "./generation-error";
import { attachmentPartsForModel } from "../attachments/model-context";
import { sanitizeToolExecutionOutputForHistory } from "../utils/message-security";
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
  InitializedProjectPreparation,
  PreparedUserInstructionBatch,
} from "./generator-types";

function diffProjectFiles(
  before: Readonly<ProjectFiles>,
  after: Readonly<ProjectFiles>,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const path of Object.keys(after).sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (!(path in before)) changes.push({ path, action: "created" });
    else if (before[path] !== after[path]) {
      changes.push({ path, action: "modified" });
    }
  }
  for (const path of Object.keys(before).sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (!(path in after)) changes.push({ path, action: "deleted" });
  }
  return changes;
}

interface InitializationPermissionPreflight {
  readonly projectRevision: number;
  readonly preparation?: InitializedProjectPreparation;
  readonly failed?: boolean;
  readonly error?: unknown;
}

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
  // Unknown tools are dynamic adapters. Treat them conservatively until the
  // immutable run authority supplies a static declaration.
  return true;
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
  private toolRun!: HostToolRun;
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
  private readonly projectPermissionSession?: ProjectPermissionSession;
  private readonly onProjectPermissionAuthorityChange?: GeneratorOptions["onProjectPermissionAuthorityChange"];
  private readonly onProjectPermissionRequestFinished?: GeneratorOptions["onProjectPermissionRequestFinished"];
  private readonly conversationId?: string;
  private readonly userInstructions?: GeneratorOptions["userInstructions"];
  private systemPromptSuffix: string = "";
  private untrustedReferenceContext: string = "";
  private readonly subagentWritePaths: readonly string[];
  private readonly getCurrentProjectFiles?: GeneratorOptions["getCurrentProjectFiles"];
  private readonly prepareProjectCommit?: GeneratorOptions["prepareProjectCommit"];
  private readonly commitDelegatedProjectFiles?: GeneratorOptions["commitDelegatedProjectFiles"];
  private readonly delegatedEdits = new DelegatedEditCoordinator();
  private readOnlyMode = false;
  private executionMode: ExecutionMode;
  private readonly runtimePlatform: RuntimePlatform;
  private readonly toolRuntime: ToolRunContext["runtime"];
  private allowedMcpAliases: ReadonlySet<string>;
  private readonly skillContext: SkillActiveContextController;
  private runId: string;
  private projectRevision = 0;
  private permissionAuthorityEpoch = 0;
  private readonly permissionPermits = new Map<
    string,
    ProjectPermissionPermit
  >();
  private readonly permissionExemptCalls = new Map<string, number>();
  private readonly permissionImplementationCalls = new Set<string>();
  private readonly initializationPermissionPreflights = new Map<
    string,
    InitializationPermissionPreflight
  >();

  constructor(options: GeneratorOptions, events: GeneratorEvents = {}) {
    this.apiType = options.apiType ?? "openai-compatible";
    this.apiBaseUrl = options.apiBaseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxIterations = options.maxIterations ?? Infinity;
    this.useStream = options.stream ?? true;
    this.customToolSet = options.customTools ?? {};
    this.tools = options.tools
      ? options.tools
      : { ...BUILTIN_TOOLS, ...this.customToolSet };
    this.customToolHandler = options.customToolHandler;
    this.authorizeToolCall = options.authorizeToolCall;
    this.useThinking = options.thinking ?? true;
    this.thinkingBudget = options.thinkingBudget ?? 10000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelay = options.retryDelay ?? 1000;
    this.providerToolNames = new Set(options.providerToolNames ?? []);
    this.askUserQuestion = options.askUserQuestion;
    this.requestPlanApproval = options.requestPlanApproval;
    this.onPlanApproved = options.onPlanApproved;
    this.dispatchSubagent = options.dispatchSubagent;
    this.prepareInitializedProject = options.prepareInitializedProject;
    this.projectPermissionSession = options.projectPermissionSession;
    this.onProjectPermissionAuthorityChange =
      options.onProjectPermissionAuthorityChange;
    this.onProjectPermissionRequestFinished =
      options.onProjectPermissionRequestFinished;
    this.conversationId = options.conversationId;
    this.userInstructions = options.userInstructions;
    this.executionMode = options.executionMode ?? "chat";
    this.subagentWritePaths = Object.freeze(
      options.subagentWritePaths
        ? validateDelegatedWritePaths(
            [...options.subagentWritePaths],
            options.initialFiles ?? {},
          )
        : [],
    );
    this.getCurrentProjectFiles = options.getCurrentProjectFiles;
    this.commitDelegatedProjectFiles = options.commitDelegatedProjectFiles;
    this.prepareProjectCommit = options.prepareProjectCommit;
    this.readOnlyMode =
      this.executionMode === "plan" ||
      (this.executionMode === "subagent" && !this.subagentWritePaths.length);
    this.runtimePlatform = options.runtimePlatform ?? "web";
    this.toolRuntime = options.toolRuntime ?? "api";
    this.allowedMcpAliases = new Set(options.allowedMcpAliases ?? []);
    this.skillContext = createSkillActiveContext(
      options.initialSkillContext ?? null,
    );
    this.runId = this.createRunId();

    this.files = { ...(options.initialFiles ?? {}) };
    this.messages = [];
    this.events = events;
    this.rebuildToolRun();
  }

  // ═══════════════════════════ public API ═════════════════════════════════

  getFiles(): ProjectFiles {
    return { ...this.files };
  }

  setFiles(files: ProjectFiles): void {
    this.commitProjectFiles(files);
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  appendMessage(message: Message): void {
    this.messages.push(message);
  }

  getTools(): ToolSet {
    return this.toolRun.modelTools;
  }

  getHostToolRun(): HostToolRun {
    return this.toolRun;
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
    this.rebuildToolRun();
  }

  setReadOnlyMode(readOnly: boolean): void {
    this.readOnlyMode = readOnly;
    if (this.executionMode !== "subagent" && this.executionMode !== "auto_qa") {
      this.executionMode = readOnly ? "plan" : "chat";
    }
    this.rebuildToolRun();
  }

  setExecutionMode(mode: ExecutionMode): void {
    this.executionMode = mode;
    this.readOnlyMode =
      mode === "plan" ||
      (mode === "subagent" && !this.subagentWritePaths.length);
    this.rebuildToolRun();
  }

  rotateProjectPermissionAuthority(): void {
    this.runId = this.createRunId();
    this.permissionAuthorityEpoch += 1;
    this.rebuildToolRun();
    this.publishProjectPermissionAuthority();
  }

  setAllowedMcpAliases(aliases: ReadonlySet<string>): void {
    this.allowedMcpAliases = new Set(aliases);
    this.rebuildToolRun();
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
      subagentWritePaths:
        this.executionMode === "subagent" ? this.subagentWritePaths : undefined,
      platform: this.runtimePlatform,
      runtime: this.toolRuntime,
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
    this.initializationPermissionPreflights.clear();
    this.permissionExemptCalls.clear();
    this.permissionImplementationCalls.clear();
    if (this.projectPermissionSession) {
      this.projectPermissionSession.change({ type: "close" });
      this.publishProjectPermissionAuthority();
    }
  }

  beginExternalRun(): AbortSignal {
    this.ctrl?.abort();
    this.runId = this.createRunId();
    this.rebuildToolRun();
    this.ctrl = new AbortController();
    return this.ctrl.signal;
  }

  /** Drop summary-only/run-only payloads after an adapter-owned run has
   * finished. Web runs do this automatically; Local CLI calls this at its
   * outer run boundary after every continuation has consumed the result. */
  finishExternalRun(): void {
    this.applyOutputRetentionAfterRun();
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

  hasUserInstructionSource(): boolean {
    return this.userInstructions !== undefined;
  }

  async prepareUserInstructions(
    backend: GenerationBackend,
    signal: AbortSignal,
  ): Promise<PreparedUserInstructionBatch | null> {
    signal.throwIfAborted();
    if (
      (this.executionMode !== "chat" && this.executionMode !== "plan") ||
      this.inferToolProfile() === "design_review"
    )
      return null;
    const priorSkills = this.skillContext.get();
    const batch = await this.userInstructions?.prepare(backend, signal);
    signal.throwIfAborted();
    if (
      batch &&
      JSON.stringify(priorSkills) !== JSON.stringify(this.skillContext.get())
    ) {
      this.rebuildToolRun();
    }
    return batch ?? null;
  }

  appendUserInstructions(batch: PreparedUserInstructionBatch): void {
    for (const instruction of batch.instructions) {
      const prompt =
        instruction.modelPrompt ??
        (typeof instruction.message.content === "string"
          ? instruction.message.content
          : "");
      this.appendUserMessage(prompt, instruction.attachments);
      const message = this.messages[this.messages.length - 1];
      message.metadata = instruction.message.metadata;
      message.forcedSkillIds = instruction.message.forcedSkillIds;
    }
  }

  private async acceptUserInstructions(signal: AbortSignal): Promise<boolean> {
    const batch = await this.prepareUserInstructions(this, signal);
    if (!batch?.instructions.length) return false;
    if (!batch.commit())
      throw new DOMException("The instruction run ended.", "AbortError");
    this.appendUserInstructions(batch);
    return true;
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
    return this._runGenerateLoop();
  }

  async generate(
    userMessage: string,
    attachments?: ResolvedAttachment[],
  ): Promise<GenerateResult> {
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

  private publishProjectPermissionAuthority(): void {
    if (!this.projectPermissionSession) return;
    this.onProjectPermissionAuthorityChange?.(
      this.projectPermissionSession.authority(),
    );
  }

  private commitProjectFiles(files: ProjectFiles, operationId?: string): void {
    if (operationId && this.prepareProjectCommit) {
      this.ctrl?.signal.throwIfAborted();
      files = this.prepareProjectCommit(this.files, files, operationId);
      const validated = validateProjectFiles(files);
      if (!validated.ok) throw new Error(validated.error);
    }
    const currentPaths = Object.keys(this.files);
    const nextPaths = Object.keys(files);
    const unchanged =
      currentPaths.length === nextPaths.length &&
      currentPaths.every(
        (path) =>
          Object.prototype.hasOwnProperty.call(files, path) &&
          files[path] === this.files[path],
      );
    if (unchanged) return;
    this.initializationPermissionPreflights.clear();
    this.files = { ...files };
    this.projectRevision += 1;
    if (!this.projectPermissionSession) return;
    this.projectPermissionSession.change({
      type: "project_revision",
      revision: this.projectRevision,
    });
    // The permission snapshot changed, so subsequent calls use a freshly
    // compiled Host Tool Run. Project edits alone do not expand authority and
    // therefore retain the provider-visible run id.
    this.rebuildToolRun();
    this.publishProjectPermissionAuthority();
  }

  private async prepareInitializationPermissionImpact(
    callId: string,
    input: unknown,
    fallback: HostToolProjectPermissionResolution,
    signal: AbortSignal,
  ): Promise<HostToolProjectPermissionResolution | undefined> {
    const revision = this.projectRevision;
    const initialized = await dispatchFsTool(
      "init_project",
      input as { template: string },
      this.files,
    );
    if (!initialized?.newFiles) return fallback;

    let preparation: InitializedProjectPreparation | undefined;
    if (this.prepareInitializedProject) {
      try {
        const prepared = await this.prepareInitializedProject(
          initialized.newFiles,
          {
            conversationId: this.conversationId,
            template: String((input as { template?: unknown }).template ?? ""),
            signal,
          },
        );
        if (prepared) preparation = prepared;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        this.initializationPermissionPreflights.set(callId, {
          projectRevision: revision,
          failed: true,
          error,
        });
        return undefined;
      }
    }

    if (signal.aborted) {
      throw new DOMException(
        "Project initialization was cancelled.",
        "AbortError",
      );
    }
    if (revision !== this.projectRevision) {
      throw new ProjectPermissionError(
        "permission_stale",
        "The project changed during initialization preflight.",
      );
    }

    const preparedFiles = preparation?.files ?? initialized.newFiles;
    const validation = validateProjectFiles(preparedFiles);
    if (!validation.ok) {
      this.initializationPermissionPreflights.set(callId, {
        projectRevision: revision,
        failed: true,
        error: new Error(validation.error),
      });
      return undefined;
    }
    if (this.prepareInitializedProject) {
      this.initializationPermissionPreflights.set(callId, {
        projectRevision: revision,
        preparation,
      });
    }

    const affectedPaths = diffProjectFiles(this.files, preparedFiles).map(
      (change) => change.path,
    );
    if (affectedPaths.length === 0) return undefined;
    return Object.freeze({
      scope: Object.freeze({ kind: "project" as const }),
      affectedPaths: Object.freeze(affectedPaths),
      affectedCount: affectedPaths.length,
    });
  }

  private discardPermissionSiblingCalls(calls: readonly ToolCall[]): void {
    const context = this.getRunContext();
    for (const call of calls) {
      if (this.toolRun.providerOwnedNames.has(call.function.name)) continue;
      const output = normalizeToolExecutionOutput({
        text:
          `Error: tool "${call.function.name}" was discarded because ` +
          "ProjectFiles permission changed during this response. Reissue it " +
          "in the next provider iteration using the new Host authority.",
        isError: true,
      });
      let args: unknown = null;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        // Malformed sibling arguments remain inert.
      }
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: output.text,
        toolOutput: output,
      });
      recordPermissionActivity({
        conversationId: context.conversationId,
        tool: call.function.name,
        source: context.allowedMcpAliases.has(call.function.name)
          ? "mcp"
          : (getToolCapability(call.function.name)?.source ?? "unknown"),
        mode: context.mode,
        platform: context.platform,
        decision: "denied",
        reason: "ProjectFiles permission authority rotation barrier",
      });
      this.events.onToolResult?.(
        call.function.name,
        args,
        output.text,
        call.id,
        output,
      );
    }
  }

  private enterProjectPermissionImplementation(callId: string): void {
    if (this.ctrl?.signal.aborted) {
      throw this.ctrl.signal.reason instanceof Error
        ? this.ctrl.signal.reason
        : new DOMException(
            "Destructive project operation was cancelled.",
            "AbortError",
          );
    }
    if (this.permissionImplementationCalls.has(callId)) {
      throw new ProjectPermissionError(
        "permission_authority_stale",
        "This destructive tool call already entered Host implementation.",
      );
    }
    const hasExemption = this.permissionExemptCalls.has(callId);
    const exemptRevision = this.permissionExemptCalls.get(callId);
    this.permissionExemptCalls.delete(callId);
    const permit = this.permissionPermits.get(callId);
    if (!hasExemption && !permit) {
      throw new ProjectPermissionError(
        "permission_authority_stale",
        "Destructive Host implementation has no matching call permit.",
      );
    }
    if (
      (hasExemption && exemptRevision !== this.projectRevision) ||
      (permit && permit.projectRevision !== this.projectRevision)
    ) {
      throw new ProjectPermissionError(
        "permission_stale",
        "The project changed before destructive implementation could start.",
      );
    }
    if (
      permit &&
      permit.lifetime !== "bypass" &&
      this.projectPermissionSession?.authority().id !== permit.authorityId
    ) {
      throw new ProjectPermissionError(
        "permission_authority_stale",
        "Permission authority changed before Host implementation could start.",
      );
    }
    this.permissionImplementationCalls.add(callId);
  }

  private assertProjectPermissionCommitCurrent(callId: string): void {
    if (this.ctrl?.signal.aborted) {
      throw this.ctrl.signal.reason instanceof Error
        ? this.ctrl.signal.reason
        : new DOMException(
            "Destructive project operation was cancelled.",
            "AbortError",
          );
    }
    if (!this.permissionImplementationCalls.has(callId)) {
      throw new ProjectPermissionError(
        "permission_authority_stale",
        "Destructive Host implementation is no longer authorized to commit.",
      );
    }
    const permit = this.permissionPermits.get(callId);
    if (permit && permit.projectRevision !== this.projectRevision) {
      throw new ProjectPermissionError(
        "permission_stale",
        "The project changed before destructive implementation could commit.",
      );
    }
    const authority = this.projectPermissionSession?.authority();
    if (permit && (!authority || authority.closed)) {
      throw new ProjectPermissionError(
        "permission_cancelled",
        "The ProjectFiles permission session closed before commit.",
      );
    }
    if (
      permit &&
      permit.lifetime !== "bypass" &&
      authority?.id !== permit.authorityId
    ) {
      throw new ProjectPermissionError(
        "permission_authority_stale",
        "Permission authority changed before destructive implementation could commit.",
      );
    }
  }

  private async _runGenerateLoop(): Promise<GenerateResult> {
    const signal = this.beginExternalRun();
    let fullText = "";
    let aborted = false;
    let maxReached = false;
    let iterationMessageStart = this.messages.length;

    try {
      for (let iter = 0; iter < this.maxIterations; iter++) {
        signal.throwIfAborted();
        await this.acceptUserInstructions(signal);
        // Authorization transitions (notably Plan approval) can change the
        // trusted suffix and untrusted reference context between iterations.
        const instructions = this.buildSystemContent();

        const assistantMsg = await this.requestWithRetry(
          this.messages,
          instructions,
        );

        iterationMessageStart = this.messages.length;
        this.messages.push(assistantMsg);
        if (assistantMsg.content) {
          fullText += assistantMsg.content;
        }
        signal.throwIfAborted();

        if (!assistantMsg.tool_calls?.length) {
          if (
            iter < this.maxIterations - 1 &&
            (await this.acceptUserInstructions(signal))
          )
            continue;
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
            !this.toolRun.providerOwnedNames.has(toolCall.function.name),
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
              this.toolRun.providerOwnedNames.has(siblingCall.function.name)
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

          signal.throwIfAborted();
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

        let permissionBarrier = false;
        for (let index = 0; index < regularCalls.length; index += 1) {
          signal.throwIfAborted();
          const toolCall = regularCalls[index];
          if (this.toolRun.providerOwnedNames.has(toolCall.function.name)) {
            continue;
          }

          const permissionEpoch = this.permissionAuthorityEpoch;
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
          if (this.permissionAuthorityEpoch !== permissionEpoch) {
            this.discardPermissionSiblingCalls([
              ...regularCalls.slice(index + 1),
              ...dispatchCalls,
            ]);
            permissionBarrier = true;
            break;
          }
        }

        if (permissionBarrier) {
          signal.throwIfAborted();
          if (iter === this.maxIterations - 1) maxReached = true;
          continue;
        }

        if (dispatchCalls.length > 0) {
          const MAX_PARALLEL = 3;
          for (
            let offset = 0;
            offset < dispatchCalls.length;
            offset += MAX_PARALLEL
          ) {
            signal.throwIfAborted();
            const batch = dispatchCalls.slice(offset, offset + MAX_PARALLEL);
            // Await every started task before ending the run on Stop or error.
            const results = await Promise.allSettled(
              batch.map((tc) => this.executeTool(tc)),
            );
            for (let index = 0; index < batch.length; index += 1) {
              const result = results[index];
              if (result.status === "fulfilled") {
                this.messages.push({
                  role: "tool",
                  tool_call_id: batch[index].id,
                  content: result.value.result.text,
                  toolOutput: result.value.result,
                });
              }
            }
            const failure = results.find(
              (result) => result.status === "rejected",
            );
            if (failure) throw failure.reason;
          }
        }

        signal.throwIfAborted();
        if (iter === this.maxIterations - 1) {
          maxReached = true;
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        aborted = true;
        const iterationMessages = this.messages.slice(iterationMessageStart);
        const resolved = new Set(
          iterationMessages
            .filter((message) => message.role === "tool")
            .map((message) => message.tool_call_id),
        );
        for (const message of iterationMessages) {
          for (const call of message.tool_calls ?? []) {
            if (
              resolved.has(call.id) ||
              this.providerToolNames.has(call.function.name)
            )
              continue;
            const output = normalizeToolExecutionOutput({
              text: "Error: this tool call was cancelled before a result was available.",
              isError: true,
            });
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: output.text,
              toolOutput: output,
            });
            resolved.add(call.id);
            let args: unknown = null;
            try {
              args = JSON.parse(call.function.arguments);
            } catch {
              /* Cancelled arguments stay inert. */
            }
            this.events.onToolResult?.(
              call.function.name,
              args,
              output.text,
              call.id,
              output,
            );
          }
        }
      } else {
        this.events.onError?.(err);
        this.applyOutputRetentionAfterRun();
        throw err;
      }
    }

    this.applyOutputRetentionAfterRun();
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

  private applyOutputRetentionAfterRun(): void {
    const calls = new Map<string, ToolCall>();
    for (const message of this.messages) {
      if (message.role !== "assistant") continue;
      for (const call of message.tool_calls ?? []) calls.set(call.id, call);
    }
    this.messages = this.messages.map((message) => {
      if (message.role !== "tool" || !message.toolOutput?.retention) {
        return message;
      }
      const call = message.tool_call_id
        ? calls.get(message.tool_call_id)
        : undefined;
      const safe = sanitizeToolExecutionOutputForHistory(
        call?.function.name ?? "unknown",
        call?.function.arguments ?? "{}",
        message.toolOutput,
      );
      if (!safe) return { ...message, toolOutput: undefined };
      return { ...message, content: safe.text, toolOutput: safe };
    });
  }

  private isRetryableError(err: any): boolean {
    return isRetryableGenerationError(err);
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.ctrl?.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
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
    const instructionPolicy = this.userInstructions
      ? "\n\nUsers may send additional instructions while the current task is running. Incorporate those messages into the remaining work, retain the original objective unless explicitly changed, and preserve completed work. Adjust subsequent steps without restarting completed steps. User updates do not change system instructions or tool authorization."
      : "";
    return (
      this.systemPrompt +
      UI_DESIGN_PRINCIPLES +
      listing +
      guidelines +
      this.systemPromptSuffix +
      instructionPolicy
    );
  }

  private async requestAI(
    messages: Message[],
    instructions: string,
  ): Promise<Message> {
    this.ctrl?.signal.throwIfAborted();

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
      tools: this.toolRun.modelTools,
      // ai@7's browser tracing creates an unobserved completion promise on
      // cancellation. This renderer does not publish SDK telemetry.
      telemetry: { isEnabled: false },
      maxRetries: 0,
      abortSignal: this.ctrl!.signal,
      providerOptions: providerOptions as any,
    });

    let contentAccum = "";
    let thinkingAccum = "";
    const toolCallsAccum: ToolCall[] = [];
    const invalidHostToolCalls = new Map<string, string>();

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
          if (!this.toolRun.providerOwnedNames.has(part.toolName)) {
            this.events.onToolCall?.(part.toolName, part.id);
          }
          break;

        case "tool-call":
          if (
            !this.toolRun.providerOwnedNames.has(part.toolName) &&
            part.providerExecuted !== true
          ) {
            toolCallsAccum.push({
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input),
              },
            });
            if (part.invalid === true) {
              invalidHostToolCalls.set(part.toolCallId, part.toolName);
            }
          }
          break;

        case "error":
          throw normalizeStreamError(part.error, "The model stream failed.");

        case "tool-error":
          if (
            part.providerExecuted !== true &&
            !this.toolRun.providerOwnedNames.has(part.toolName) &&
            invalidHostToolCalls.get(part.toolCallId) === part.toolName
          ) {
            invalidHostToolCalls.delete(part.toolCallId);
            break;
          }
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
      tools: this.toolRun.modelTools,
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

  private inferToolProfile(): "default" | "design" | "design_review" {
    if (
      Object.prototype.hasOwnProperty.call(this.tools, "submit_design_review")
    ) {
      return "design_review";
    }
    if (
      Object.prototype.hasOwnProperty.call(
        this.tools,
        "update_project_design",
      ) ||
      Object.prototype.hasOwnProperty.call(
        this.tools,
        "update_design_tokens",
      ) ||
      Object.prototype.hasOwnProperty.call(
        this.tools,
        "capture_preview_evidence",
      ) ||
      Object.keys(DESIGN_DIAGNOSTIC_TOOLS).some((name) =>
        Object.prototype.hasOwnProperty.call(this.tools, name),
      )
    ) {
      return "design";
    }
    return "default";
  }

  private rebuildToolRun(): void {
    const runContext = this.getRunContext();
    const profile = this.inferToolProfile();
    const permissionAuthority = this.projectPermissionSession?.authority();
    this.toolRun = HOST_TOOL_CATALOG.openRun({
      tools: this.tools,
      context: runContext,
      profile,
      allowedDynamicNames: this.allowedMcpAliases,
      providerOwnedNames: this.providerToolNames,
      guard: async (call, record) => {
        const hasWriteEffect = record.effects.some(
          (effect) =>
            effect === "write_project" ||
            effect === "write_runtime" ||
            effect === "process",
        );
        if (this.executionMode === "subagent" && hasWriteEffect) {
          const error = delegatedWriteError(
            call.name,
            call.input,
            this.subagentWritePaths,
            this.files,
          );
          if (error) return error;
        }
        if (
          call.name === "dispatch_subagent" &&
          (call.input as { subagent?: string })?.subagent === "code-writer" &&
          (this.executionMode !== "chat" || this.readOnlyMode)
        )
          return "Developer subagents require an approved chat run.";
        if (this.readOnlyMode && hasWriteEffect) {
          return (
            `Tool "${call.name}" is not available while Plan Mode is active. ` +
            "Submit or revise the plan first; write tools are enabled only after approval."
          );
        }
        const skillRestriction = activeSkillToolRestrictionError(
          call.name,
          this.skillContext.get(),
        );
        if (skillRestriction) return skillRestriction;
        return this.authorizeToolCall?.(call.name, call.input, {
          signal: this.ctrl?.signal ?? new AbortController().signal,
          toolCallId: call.callId ?? "host-tool",
          run: runContext,
          skillContext: this.skillContext,
        });
      },
      requestApproval: async (call, record) => {
        const permission = record.projectPermission;
        if (!permission) return;
        const callId = call.callId ?? "host-tool";
        this.permissionExemptCalls.delete(callId);
        const signal = this.ctrl?.signal ?? new AbortController().signal;
        if (signal.aborted) {
          throw new DOMException("Permission request cancelled.", "AbortError");
        }
        // Run the same pure transform as the implementation before opening a
        // prompt. Invalid, missing, no-op, and empty-project initialization
        // calls keep their original tool result and never ask for authority.
        let impact = await permission.resolve(call.input, this.files);
        if (!impact) {
          this.permissionExemptCalls.set(callId, this.projectRevision);
          return;
        }
        if (
          runContext.mode !== "chat" ||
          profile === "design_review" ||
          !runContext.conversationId
        ) {
          this.initializationPermissionPreflights.delete(callId);
          throw new ProjectPermissionError(
            "permission_prompt_unavailable",
            "Destructive ProjectFiles permission is available only in the main Chat run.",
          );
        }
        if (signal.aborted) {
          this.initializationPermissionPreflights.delete(callId);
          throw new DOMException("Permission request cancelled.", "AbortError");
        }
        if (!this.projectPermissionSession || !permissionAuthority) {
          this.initializationPermissionPreflights.delete(callId);
          throw new ProjectPermissionError(
            "permission_prompt_unavailable",
            "The ProjectFiles permission prompt is unavailable.",
          );
        }
        if (call.name === "init_project") {
          impact = await this.prepareInitializationPermissionImpact(
            callId,
            call.input,
            impact,
            signal,
          );
          if (!impact) {
            this.permissionExemptCalls.set(callId, this.projectRevision);
            return;
          }
        }

        const beforeRevision =
          this.projectPermissionSession.authority().revision;
        try {
          const permit = await this.projectPermissionSession.authorize({
            runId: runContext.runId,
            callId,
            tool: call.name,
            runtime: runContext.runtime,
            operation: permission.operation,
            sessionEligible: permission.sessionEligible,
            scope: impact.scope,
            affectedPaths: impact.affectedPaths,
            affectedCount: impact.affectedCount,
            projectRevision: this.projectRevision,
            authorityId: permissionAuthority.id,
            signal,
          });
          this.permissionPermits.set(callId, permit);
          if (
            this.projectPermissionSession.authority().revision !==
            beforeRevision
          ) {
            this.rotateProjectPermissionAuthority();
          } else {
            this.publishProjectPermissionAuthority();
          }
          this.onProjectPermissionRequestFinished?.(callId);
        } catch (error) {
          this.initializationPermissionPreflights.delete(callId);
          if (
            this.projectPermissionSession.authority().revision !==
            beforeRevision
          ) {
            // Required audit can fail after the Broker has already rotated and
            // then revoked an attempted grant. Reopen the Host run even on the
            // error path so its immutable permission projection cannot drift.
            this.rotateProjectPermissionAuthority();
          }
          const visibleError =
            error instanceof ProjectPermissionError &&
            (error.code === "permission_audit_unavailable" ||
              error.code === "permission_prompt_unavailable" ||
              error.code === "permission_authority_stale")
              ? error.message
              : undefined;
          this.onProjectPermissionRequestFinished?.(callId, visibleError);
          throw error;
        }
      },
      hostDispatcher: (call, record) => {
        const callId = call.callId ?? "host-tool";
        if (record.projectPermission) {
          this.enterProjectPermissionImplementation(callId);
        }
        return this.executeAuthorizedTool(
          call.name,
          call.input,
          callId,
          Boolean(record.projectPermission),
        );
      },
      validateState: () => {
        const validation = validateProjectFiles(this.files);
        return validation.ok ? undefined : validation.error;
      },
      // The active model receives the full run-local result. Stamp the Catalog
      // policy so the persistence boundary can enforce it without importing
      // the executable tool schema (which also keeps that boundary lightweight).
      retainOutput: (result, retention) => {
        const outcome = result as {
          result: ToolExecutionOutput;
          changes: FileChange[];
          hadSideEffect: boolean;
        };
        return {
          ...outcome,
          result: { ...outcome.result, retention },
        };
      },
      audit: (call, record) => {
        // Dynamic MCP adapters already record their authoritative lifecycle,
        // drift, approval, target, and outcome details. Avoid adding a second
        // generic entry that could contradict an adapter-level denial.
        if (record.source === "mcp" || record.projectPermission) return;
        recordPermissionActivity({
          conversationId: this.conversationId,
          tool: call.name,
          source: record.source,
          mode: this.executionMode,
          platform: this.runtimePlatform,
          decision: record.approval === "per_call" ? "requested" : "allowed",
        });
      },
    });
  }

  private async executeTool(toolCall: ToolCall): Promise<{
    result: ToolExecutionOutput;
    changes: FileChange[];
    hadSideEffect: boolean;
  }> {
    const name = toolCall.function.name;
    const authorityRecord = this.toolRun.authority.get(name);
    if (!authorityRecord) {
      const output = normalizeToolExecutionOutput({
        text:
          `Error: tool "${name}" is not authorized for the current ` +
          `${this.executionMode} run; it is not permitted by policy.`,
        isError: true,
      });
      recordPermissionActivity({
        conversationId: this.conversationId,
        tool: name,
        source: this.allowedMcpAliases.has(name) ? "mcp" : "unknown",
        mode: this.executionMode,
        platform: this.runtimePlatform,
        decision: "denied",
        reason: "tool is absent from the immutable run authority",
      });
      this.events.onToolResult?.(name, null, output.text, toolCall.id, output);
      return { result: output, changes: [], hadSideEffect: false };
    }

    let args: unknown;
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

    try {
      const outcome = (await this.toolRun.dispatch({
        name,
        input: args,
        callId: toolCall.id,
      })) as {
        result: ToolExecutionOutput;
        changes: FileChange[];
        hadSideEffect: boolean;
      };
      await this.settleProjectPermission(
        toolCall.id,
        outcome.result.isError ? "failed" : "succeeded",
        outcome.result.isError ? "tool_error" : undefined,
      );
      return outcome;
    } catch (error) {
      await this.settleProjectPermission(
        toolCall.id,
        error instanceof ProjectPermissionError &&
          error.code === "permission_stale"
          ? "stale"
          : error instanceof Error && error.name === "AbortError"
            ? "aborted"
            : "failed",
        error instanceof ProjectPermissionError ? error.code : undefined,
      );
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      const reason =
        error instanceof ProjectPermissionError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "Host tool dispatch failed.";
      const output = normalizeToolExecutionOutput({
        text: `Error: ${reason}`,
        isError: true,
      });
      if (!(error instanceof ProjectPermissionError)) {
        recordPermissionActivity({
          conversationId: this.conversationId,
          tool: name,
          source: authorityRecord.source,
          mode: this.executionMode,
          platform: this.runtimePlatform,
          decision: "denied",
          reason:
            error instanceof HostToolDispatchError
              ? `${error.stage}: ${error.message}`
              : reason,
        });
      }
      this.events.onToolResult?.(name, args, output.text, toolCall.id, output);
      return { result: output, changes: [], hadSideEffect: false };
    }
  }

  private async settleProjectPermission(
    callId: string,
    outcome: "succeeded" | "failed" | "aborted" | "stale",
    errorCode?: string,
  ): Promise<void> {
    this.permissionImplementationCalls.delete(callId);
    const permit = this.permissionPermits.get(callId);
    if (!permit || !this.projectPermissionSession) return;
    this.permissionPermits.delete(callId);
    try {
      await this.projectPermissionSession.settle(permit, {
        outcome,
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // The destructive operation may already have happened. Final audit is
      // terminal and must never turn a completed call into a retryable error.
    }
  }

  private async executeAuthorizedTool(
    name: string,
    input: unknown,
    toolCallId: string,
    requiresProjectPermission: boolean,
  ): Promise<{
    result: ToolExecutionOutput;
    changes: FileChange[];
    hadSideEffect: boolean;
  }> {
    const args = input as any;
    const toolCall: ToolCall = {
      id: toolCallId,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };

    // File-system tools go through the shared dispatcher.
    const fsOutcome = await dispatchFsTool(name, args, this.files);
    if (fsOutcome) {
      const initializationPreflight =
        name === "init_project"
          ? this.initializationPermissionPreflights.get(toolCallId)
          : undefined;
      if (name === "init_project") {
        this.initializationPermissionPreflights.delete(toolCallId);
      }
      let nextFiles = fsOutcome.newFiles;
      let changes = fsOutcome.changes;
      let resultText = fsOutcome.result;
      let validatePreparedProjectBeforeCommit: (() => void) | undefined;
      let onPreparedProjectCommitted: (() => void) | undefined;
      if (
        name === "init_project" &&
        nextFiles &&
        this.prepareInitializedProject
      ) {
        try {
          if (
            initializationPreflight?.projectRevision === this.projectRevision &&
            initializationPreflight.failed
          ) {
            throw initializationPreflight.error;
          }
          const prepared =
            initializationPreflight?.projectRevision === this.projectRevision
              ? initializationPreflight.preparation
              : await this.prepareInitializedProject(nextFiles, {
                  conversationId: this.conversationId,
                  template: String(args.template ?? ""),
                  signal: this.ctrl?.signal ?? new AbortController().signal,
                });
          if (this.ctrl?.signal.aborted) {
            throw new DOMException(
              "Project initialization was cancelled.",
              "AbortError",
            );
          }
          if (prepared) {
            nextFiles = prepared.files;
            changes = [...changes, ...(prepared.changes ?? [])];
            if (prepared.resultNote) {
              resultText = `${resultText}; ${prepared.resultNote}`;
            }
            validatePreparedProjectBeforeCommit = prepared.validateBeforeCommit;
            onPreparedProjectCommitted = prepared.onCommitted;
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
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
        validatePreparedProjectBeforeCommit?.();
        if (requiresProjectPermission) {
          // dispatchFsTool/init preparation may yield. Stop, conversation
          // replacement, project revision changes, or grant revocation must be
          // observed immediately before the first write becomes visible.
          this.assertProjectPermissionCommitCurrent(toolCallId);
        }
        if (name === "init_project") {
          changes = diffProjectFiles(this.files, nextFiles);
        }
        if (this.executionMode === "subagent") {
          collectDelegatedEdits(this.files, nextFiles, this.subagentWritePaths);
          const error = await this.authorizeToolCall?.(name, args, {
            signal: this.ctrl!.signal,
            toolCallId,
            run: this.getRunContext(),
            skillContext: this.skillContext,
          });
          if (error) throw new Error(error);
          this.ctrl!.signal.throwIfAborted();
        }
        this.ctrl?.signal.throwIfAborted();
        this.commitProjectFiles(nextFiles, toolCallId);
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
        const writer =
          getSubagentByName(subagentName)?.writePolicy === "scopedWrite";
        const dispatchSignal = this.ctrl!.signal;
        const parentRunId = this.runId;
        const authorityEpoch = this.permissionAuthorityEpoch;
        const assertCurrent = () => {
          dispatchSignal.throwIfAborted();
          if (
            this.runId !== parentRunId ||
            this.permissionAuthorityEpoch !== authorityEpoch ||
            (writer && (this.executionMode !== "chat" || this.readOnlyMode)) ||
            this.projectPermissionSession?.authority().closed
          )
            throw new Error("The parent delegation authority changed.");
        };
        const authorizeWrite = async (name: string, input: unknown) => {
          assertCurrent();
          if (!this.toolRun.authority.has(name))
            throw new Error(`Parent tool "${name}" is not authorized.`);
          const skillError = activeSkillToolRestrictionError(
            name,
            this.skillContext.get(),
          );
          if (skillError) throw new Error(skillError);
          const error = await this.authorizeToolCall?.(name, input, {
            signal: dispatchSignal,
            toolCallId: toolCall.id,
            run: this.getRunContext(),
            skillContext: this.skillContext,
          });
          assertCurrent();
          if (error) throw new Error(error);
        };
        try {
          const writePaths = writer
            ? validateDelegatedWritePaths(
                args.writePaths,
                this.getCurrentProjectFiles?.() ?? this.files,
              )
            : [];
          result = await this.delegatedEdits.run(
            writePaths,
            dispatchSignal,
            async () => {
              assertCurrent();
              if (writer) await authorizeWrite("dispatch_subagent", args);
              const baseline = {
                ...(this.getCurrentProjectFiles?.() ?? this.files),
              };
              if (writer) validateDelegatedWritePaths(writePaths, baseline);
              const dispatched = await this.dispatchSubagent!(
                subagentName,
                checkedTask.task,
                projectFilesForModel(baseline),
                dispatchSignal,
                toolCall.id,
                this.conversationId,
                writer ? writePaths : undefined,
                writer ? authorizeWrite : undefined,
              );
              try {
                assertCurrent();
                if (!writer) {
                  if (dispatched.edits)
                    throw new Error("Read-only subagents cannot return edits.");
                  return dispatched.text;
                }
                const summary = JSON.parse(dispatched.text) as {
                  ok?: boolean;
                  status?: string;
                };
                if (!summary.ok || summary.status !== "done")
                  return dispatched.text;
                if (!dispatched.edits)
                  throw new Error(
                    "Developer subagent did not return validated edits.",
                  );
                return await this.delegatedEdits.commit(async () => {
                  await authorizeWrite("dispatch_subagent", args);
                  for (const edit of dispatched.edits!)
                    await authorizeWrite("write_file", {
                      path: edit.path,
                      content: edit.content,
                    });
                  assertCurrent();
                  const current = this.getCurrentProjectFiles?.() ?? this.files;
                  let next = mergeDelegatedEdits(
                    current,
                    baseline,
                    writePaths,
                    dispatched.edits!,
                  );
                  const changes = diffProjectFiles(current, next);
                  if (changes.length) {
                    next =
                      this.prepareProjectCommit?.(current, next, toolCallId) ??
                      next;
                    const validated = validateProjectFiles(next);
                    if (!validated.ok) throw new Error(validated.error);
                    assertCurrent();
                    if (
                      this.commitDelegatedProjectFiles &&
                      !this.commitDelegatedProjectFiles(current, next)
                    )
                      throw new Error(
                        "The project changed before delegated edits could commit.",
                      );
                    this.commitProjectFiles(next);
                    if (!this.commitDelegatedProjectFiles)
                      this.events.onFileChange?.(this.getFiles(), changes);
                  }
                  if (!changes.length) this.commitProjectFiles(next);
                  return dispatched.complete?.() ?? dispatched.text;
                });
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                const failureText = dispatched.complete?.(message);
                if (dispatchSignal.aborted) throw error;
                if (failureText) return failureText;
                throw error;
              }
            },
          );
          if (writer && JSON.parse(result).ok !== true)
            result = { text: result, isError: true };
        } catch (err) {
          if (
            dispatchSignal.aborted ||
            (err as { name?: string })?.name === "AbortError"
          )
            throw err;
          const message =
            (err as { message?: string })?.message ?? "Unknown error";
          result = {
            text: `Error dispatching subagent "${subagentName}": ${message}`,
            isError: true,
          };
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
            this.rebuildToolRun();
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
            if (err?.name === "AbortError") throw err;
            result = {
              text: `Error in custom tool "${name}": ${err?.message ?? String(err)}`,
              isError: true,
            };
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
