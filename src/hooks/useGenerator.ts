import { useRef, useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ToolSet } from "ai";
import bundledDesignSkills from "virtual:bundled-design-skills";
import type {
  GenerateResult,
  GenerationBackend,
  GeneratorEvents,
} from "../lib/ai/generator";
import type {
  UserInstructionSource,
  PreparedUserInstruction,
  PreparedUserInstructionBatch,
  ResolvedAttachment,
} from "../lib/ai/generator-types";
import {
  captureConversationIdentity,
  isConversationIdentityCurrent,
  type ConversationIdentity,
} from "../lib/conversation/branches";
import {
  LOCAL_CLI_IDLE_MESSAGE,
  LOCAL_CLI_MESSAGE_OUTPUT_NOTICE,
} from "../lib/local-agent/runtime";
import {
  DEFAULT_TITLE,
  useConversationStore,
  flushConversationPersistence,
} from "../store/conversation";
import type {
  LocalRecoverableRun,
  LocalRecoveryContext,
} from "../lib/local-agent/types";
import { useSettingsStore } from "../store/settings";
import { useInteractiveStore } from "../store/interactive";
import { useSubagentStore } from "../store/subagent";
import { useSandpackStore } from "../store/sandpack";
import { filterMemoryMessages } from "../lib/utils/memory-filter";
import { findWithdrawableUserMessageIndex } from "../lib/utils/merge-messages";
import { createSnapshotForCurrentState } from "../lib/utils/snapshot-helpers";
import type {
  Message,
  Conversation,
  ProjectFiles,
  AISettings,
  WebSearchSettings,
  AssetSearchSettings,
  Attachment,
  GeneratorRunState,
  StructuredGenerationError,
  WorkspaceMode,
  DesignSelectionContext,
} from "../types";
import { useMemoryStore } from "../store/memory";
import { useFileOperations } from "./useFileOperations";
import { useTitleAndCompression } from "./useTitleAndCompression";
import {
  classifyGenerationError,
  formatGenerationErrorMessage,
} from "../lib/ai/generation-error";
import {
  cancelPendingToolCalls,
  findPendingToolCall,
  isGenerationRunCurrent,
  isGeneratorConstructionCurrent,
} from "../lib/ai/run-guard";
import { getT, getResolvedLocale } from "../i18n";
import type { McpRuntimeBundle } from "../lib/mcp/runtime";
import type {
  ExecutionMode,
  RuntimePlatform,
  ToolProfile,
} from "../lib/ai/tools-schema";
import { TOOL_POLICY_VERSION } from "../lib/ai/tool-policy-version";
import { getSkillRegistry } from "../lib/skills/instance";
import {
  hydrateMessageAttachments,
  resolveAttachmentsForModel,
  toAttachmentRef,
} from "../lib/attachments/store";
import { recordPermissionActivity } from "../lib/security/activity-log";
import {
  sanitizeToolExecutionOutputForHistory,
  sanitizeToolResultForHistory,
  serializeToolArgumentsForHistory,
} from "../lib/utils/message-security";
import {
  messagesForConversationContinuation,
  removeErrorMessages,
} from "../lib/ai/conversation-context";
import { PLAN_MODE_SYSTEM_SUFFIX } from "../lib/ai/plan-mode";
import { buildRunSystemPromptSuffix } from "../lib/ai/run-system-prompt";
import { buildCustomSystemPromptSection } from "../lib/ai/custom-system-prompt";
import { appendBufferedAssistantOutput } from "../lib/utils/stream-output";
import { flushPendingSandpackFileChanges } from "../components/code-viewer/sandpack-file-changes";
import {
  createAdaptiveOutputScheduler,
  type AdaptiveOutputScheduler,
} from "../lib/utils/adaptive-output";
import {
  DESIGN_MODE_SYSTEM_SUFFIX,
  loadDesignSystemContext,
} from "../lib/ai/design-mode";
import { formatDesignSelectionForModel } from "../lib/design/selection-context";
import {
  validateDesignReviewScreenshots,
  type DesignReviewCoverageTarget,
  type DesignReviewScreenshot,
} from "../lib/design/review";
import { useDesignReviewStore } from "../store/design-review";
import { useProjectDesignWorkspaceStore } from "../store/project-design-workspace";
import { computeDesignReviewSourceDigest } from "../lib/design/review-jobs/digest";
import {
  isDesignReviewRunActive,
  isDesignReviewTerminalStatus,
  type DesignReviewJobInput,
  type DesignReviewRun,
} from "../lib/design/review-jobs/types";
import { useMcpStore } from "../store/mcp";
import {
  formatAgnesAttachmentManifest,
  registerAgnesRunAttachments,
} from "../lib/mcp/agnes/attachments";
import {
  DESIGN_CHANGE_MODES,
  type DesignChangeMode,
  type DesignContract,
} from "../lib/design/run-contract";
import {
  deriveImpactPages,
  PROJECT_DESIGN_PATH,
  readProjectDesign,
  resolveProjectDesignPreviewTarget,
  resolveProjectDesignPreview,
  resolveProjectDesignPreviewRoute,
} from "../lib/design/project-design";
import {
  prepareDesignRun,
  designRunSkillIds,
  type DesignRun,
} from "../lib/design/design-run";
import type { PrototypePreviewTarget } from "../lib/design/preview-runtime";
import { isPrototypeProject } from "../lib/design/prototype-starter";
import {
  collectChangedUiPaths,
  runDesignSystemAdherenceCheck,
} from "../lib/design/adherence";
import {
  hasRemainingAutomaticDesignIssues,
  shouldRequestAutomaticDesignReview,
  type AutomaticDesignReviewEvidence,
  type AutomaticDesignReviewPhase,
} from "../lib/design/automatic-review";
import { runProjectHealthCheck } from "../lib/tools/project-health";
import {
  localAgentSupportsNativeSearch,
  type LocalAgentProvider,
} from "../lib/local-agent/providers";
import { runStateForLocalCliStatus } from "../lib/local-agent/orchestration";
import type { LocalAgentClientConfig } from "../lib/local-agent/generator";
import { createHostProjectPermissionSession } from "../lib/security/project-permission-host";
import {
  publishProjectPermissionAuthority,
  registerProjectPermissionSession,
  useProjectPermissionStore,
} from "../store/project-permission";

function checkoutKey(conversation: Conversation | undefined): string | null {
  if (!conversation) return null;
  const identity = captureConversationIdentity(conversation);
  return `${identity.conversationId}:${identity.branchId}:${identity.checkoutEpoch}`;
}

interface GeneratorConfigSnapshot {
  runtime: AISettings["runtime"];
  localProvider: AISettings["localAgent"]["provider"];
  localModel: string;
  localEffort: string;
  apiType: AISettings["apiType"];
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  searchEngine: string;
  tavilyKey: string;
  firecrawlKey: string;
  exaKey: string;
  assetEngine: string;
  pixabayKey: string;
  unsplashKey: string;
  toolPolicyVersion: string;
  developerSkillScriptsEnabled: boolean;
  permissionBrokerBypassEnabled: boolean;
}

const EMPTY_DESIGN_REVIEW_RUNS: DesignReviewRun[] = [];
const EMPTY_MESSAGES: Message[] = [];
const pendingAutomaticCaptureIds = new Set<string>();

function buildGeneratorConfigSnapshot(
  ai: AISettings,
  webSearch: WebSearchSettings,
  assetSearch: AssetSearchSettings,
  developerSkillScriptsEnabled: boolean,
  permissionBrokerBypassEnabled: boolean,
): GeneratorConfigSnapshot {
  const localProvider = ai.localAgent.provider;
  const localPreferences = ai.localAgent.preferences[localProvider];
  return {
    runtime: ai.runtime,
    localProvider,
    localModel: localPreferences.model,
    localEffort: localPreferences.effort,
    apiType: ai.apiType,
    apiKey: ai.apiKey,
    apiBaseUrl: ai.apiBaseUrl,
    model: ai.model,
    searchEngine: webSearch.engine,
    tavilyKey: webSearch.tavilyApiKey,
    firecrawlKey: webSearch.firecrawlApiKey,
    exaKey: webSearch.exaApiKey,
    assetEngine: assetSearch.engine,
    pixabayKey: assetSearch.pixabayApiKey,
    unsplashKey: assetSearch.unsplashApiKey,
    toolPolicyVersion: TOOL_POLICY_VERSION,
    developerSkillScriptsEnabled,
    permissionBrokerBypassEnabled,
  };
}

function currentGeneratorConfigSnapshot(): GeneratorConfigSnapshot {
  const state = useSettingsStore.getState();
  return buildGeneratorConfigSnapshot(
    state.ai,
    state.webSearch,
    state.assetSearch,
    state.system.developerSkillScriptsEnabled,
    state.system.permissionBrokerBypassEnabled,
  );
}

function sameGeneratorConfig(
  a: GeneratorConfigSnapshot | null,
  b: GeneratorConfigSnapshot,
): boolean {
  if (!a) return false;
  return (
    a.apiType === b.apiType &&
    a.runtime === b.runtime &&
    a.localProvider === b.localProvider &&
    a.localModel === b.localModel &&
    a.localEffort === b.localEffort &&
    a.apiKey === b.apiKey &&
    a.apiBaseUrl === b.apiBaseUrl &&
    a.model === b.model &&
    a.searchEngine === b.searchEngine &&
    a.tavilyKey === b.tavilyKey &&
    a.firecrawlKey === b.firecrawlKey &&
    a.exaKey === b.exaKey &&
    a.assetEngine === b.assetEngine &&
    a.pixabayKey === b.pixabayKey &&
    a.unsplashKey === b.unsplashKey &&
    a.toolPolicyVersion === b.toolPolicyVersion &&
    a.developerSkillScriptsEnabled === b.developerSkillScriptsEnabled &&
    a.permissionBrokerBypassEnabled === b.permissionBrokerBypassEnabled
  );
}

function getLastForcedSkillIds(messages: readonly Message[]): string[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && !message.metadata?.origin) {
      return message.forcedSkillIds ?? [];
    }
  }
  return [];
}

function getLastDesignExpectedChangeModes(
  messages: readonly Message[],
): DesignChangeMode[] | undefined {
  const allowed = new Set<string>(DESIGN_CHANGE_MODES);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user" || message.metadata?.origin) continue;
    const rawModes = message.metadata?.designExpectedChangeModes;
    const modes = Array.isArray(rawModes)
      ? rawModes.filter(
          (mode): mode is DesignChangeMode =>
            typeof mode === "string" && allowed.has(mode),
        )
      : undefined;
    return modes?.length ? [...new Set(modes)] : undefined;
  }
  return undefined;
}

function isAgnesImageToolAvailable(): boolean {
  const state = useMcpStore.getState();
  return Boolean(
    state.globalEnabled &&
    state.agnes.enabled &&
    state.agnes.apiKey.trim() &&
    state.agnes.tools.generate_image.enabled,
  );
}

function appendAgnesManifestToLastUserMessage(
  messages: Message[],
  manifest: string,
): Message[] {
  if (!manifest) return messages;
  let index = -1;
  for (let candidate = messages.length - 1; candidate >= 0; candidate--) {
    const message = messages[candidate];
    if (message.role === "user" && !message.metadata?.origin) {
      index = candidate;
      break;
    }
  }
  if (index < 0) return messages;
  const message = messages[index];
  const content = Array.isArray(message.content)
    ? [...message.content, { type: "text" as const, text: manifest }]
    : [
        ...(typeof message.content === "string" && message.content
          ? [{ type: "text" as const, text: message.content }]
          : []),
        { type: "text" as const, text: manifest },
      ];
  const next = [...messages];
  next[index] = { ...message, content };
  return next;
}

/** Apply compression and hydrate attachment references only for model input. */
async function getMessagesForAPI(conv: Conversation): Promise<Message[]> {
  return hydrateMessageAttachments(
    cancelPendingToolCalls(messagesForConversationContinuation(conv)),
  );
}

const AUTO_QA_PROMPT =
  "Automatic QA round: call project_health_check with include_console=true. " +
  "Fix issues that break the build or runtime, using the file tools. " +
  "No redesigns, no optional refactors. If only informational issues remain, summarize them and stop.";

interface GenerateRunOptions {
  skipAutoQa?: boolean;
  forcedSkillIds?: string[];
  designSelection?: DesignSelectionContext;
  designExpectedChangeModes?: readonly DesignChangeMode[];
  automaticDesignReviewPhase?: AutomaticDesignReviewPhase;
  automaticDesignOriginalRequest?: string;
  automaticDesignReviewActivityId?: string;
  skipAutomaticDesignReview?: boolean;
  messageOrigin?: NonNullable<Message["metadata"]>["origin"];
  /** Internal currentness binding for a background repair promoted into the
   * foreground. Message/activity updates preserve this source-only token. */
  expectedConversationId?: string;
  expectedProjectSource?: DesignRepairProjectSource;
  /** Request-scoped preparation that must run after the optimistic message and
   * loading state are visible, but before generator setup and provider I/O. */
  prepareRun?: () => Promise<void>;
}

interface DesignRepairProjectSource {
  files: ProjectFiles;
  appliedSystemKey: string;
  workspaceMode: WorkspaceMode;
}

function appliedDesignSystemKey(conversation: Conversation | undefined) {
  const applied = conversation?.designState?.appliedSystem;
  return applied
    ? [applied.id, applied.version, applied.digest ?? ""].join("\u0000")
    : "";
}

function captureDesignRepairProjectSource(
  conversation: Conversation,
): DesignRepairProjectSource {
  return {
    files: conversation.files,
    appliedSystemKey: appliedDesignSystemKey(conversation),
    workspaceMode: conversation.workspaceMode ?? "auto",
  };
}

function isDesignRepairProjectSourceCurrent(
  expected: DesignRepairProjectSource,
  conversation: Conversation | undefined,
): boolean {
  return Boolean(
    conversation &&
    conversation.files === expected.files &&
    appliedDesignSystemKey(conversation) === expected.appliedSystemKey &&
    (conversation.workspaceMode ?? "auto") === expected.workspaceMode,
  );
}

function projectDesignWorkspaceContext(
  conversationId: string | undefined,
  files: ProjectFiles,
): string {
  if (!conversationId) return "";
  if (!isPrototypeProject(files)) return "";
  const selection =
    useProjectDesignWorkspaceStore.getState().selections[conversationId];
  const blueprint = readProjectDesign(files);
  if (!selection || blueprint.status !== "ready") return "";
  if (!blueprint.design.pages.some((page) => page.id === selection.pageId))
    return "";
  return `
<project_design_workspace>
The current trusted workspace selection is page_id "${selection.pageId}" and scenario_id "${selection.scenarioId}". For a local or deictic request such as "this page", default target_page_ids to this page only. Add shared_scope entries only when the requested change truly modifies a declared shared layout or shared UI.
</project_design_workspace>
`;
}

function expectedPrototypeReviewCoverage(
  files: ProjectFiles,
  affectedPageIds?: readonly string[],
): DesignReviewCoverageTarget[] | undefined {
  if (!isPrototypeProject(files)) return undefined;
  const result = readProjectDesign(files);
  if (result.status !== "ready") return undefined;
  const affected = affectedPageIds?.length
    ? new Set(affectedPageIds)
    : undefined;
  const targets = result.design.pages
    .filter((page) => !affected || affected.has(page.id))
    .flatMap((page) => {
      const scenarios = [
        ...new Set([page.defaultScenario ?? "default", ...page.scenarioIds]),
      ];
      return scenarios.flatMap((scenarioId) => {
        const target = resolveProjectDesignPreviewTarget(
          result.design,
          page.id,
          scenarioId,
        );
        return target
          ? (["desktop", "tablet", "mobile"] as const).map((viewport) => ({
              ...target,
              viewport,
            }))
          : [];
      });
    });
  return targets.slice(0, 120);
}

const AUTOMATIC_PROTOTYPE_BATCH_PROMPT =
  "Continue only the explicitly pending tasks for the current user request. Preserve completed work. Update task status and report missing information; do not add tasks just to fill blueprint fields.";

export interface WithdrawnUserDraft {
  content: string;
  attachments: Attachment[];
  forcedSkillIds: string[];
  designSelection?: DesignSelectionContext;
}

function userMessageTextForDraft(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (
        part,
      ): part is Extract<(typeof message.content)[number], { type: "text" }> =>
        part.type === "text" && !part.text.startsWith("[File: "),
    )
    .map((part) => part.text)
    .join("\n");
}

function getConversationWorkspaceContext(conversationId: string | undefined): {
  workspaceMode: WorkspaceMode;
  promptWorkspaceMode: WorkspaceMode;
  mode: ExecutionMode;
  profile: ToolProfile;
} {
  const conversation = conversationId
    ? useConversationStore.getState().conversations[conversationId]
    : undefined;
  const workspaceMode = conversation?.workspaceMode ?? "auto";
  const returnsToDesign =
    workspaceMode === "plan" && conversation?.planReturnMode === "design";
  return {
    workspaceMode,
    promptWorkspaceMode:
      workspaceMode === "design" || returnsToDesign ? "design" : workspaceMode,
    mode: workspaceMode === "plan" ? "plan" : "chat",
    profile:
      workspaceMode === "design" || returnsToDesign ? "design" : "default",
  };
}

type DesignReviewSummary = NonNullable<
  NonNullable<Message["metadata"]>["reviewSummary"]
>;

const reviewBranchIdentities = new Map<string, ConversationIdentity>();
const reviewIdentityKey = (conversationId: string, reviewId: string) =>
  `${conversationId}/${reviewId}`;

function appendAutomaticReviewActivity(
  conversationId: string,
  reviewJobId: string,
  status: DesignReviewSummary["status"],
): void {
  const state = useConversationStore.getState();
  const conversation = state.conversations[conversationId];
  if (!conversation) return;
  reviewBranchIdentities.set(
    reviewIdentityKey(conversationId, reviewJobId),
    captureConversationIdentity(conversation),
  );
  const existing = conversation.messages.some(
    (message) => message.metadata?.reviewJobId === reviewJobId,
  );
  if (existing) {
    updateAutomaticReviewActivity(conversationId, reviewJobId, { status });
    return;
  }
  state.setMessagesForConversation(conversationId, (messages) => [
    ...messages,
    {
      role: "user",
      content: "",
      metadata: {
        origin: "design_review",
        reviewJobId,
        reviewSummary: { status },
      },
    },
  ]);
}

function updateAutomaticReviewActivity(
  conversationId: string,
  currentReviewJobId: string,
  summary: Partial<DesignReviewSummary>,
  nextReviewJobId = currentReviewJobId,
): void {
  const state = useConversationStore.getState();
  const conversation = state.conversations[conversationId];
  const identity = reviewBranchIdentities.get(
    reviewIdentityKey(conversationId, currentReviewJobId),
  );
  if (identity && !isConversationIdentityCurrent(identity, conversation))
    return;
  if (identity && nextReviewJobId !== currentReviewJobId)
    reviewBranchIdentities.set(
      reviewIdentityKey(conversationId, nextReviewJobId),
      identity,
    );
  if (
    !conversation?.messages.some(
      (message) => message.metadata?.reviewJobId === currentReviewJobId,
    )
  ) {
    return;
  }
  state.setMessagesForConversation(conversationId, (messages) =>
    messages.map((message) =>
      message.metadata?.reviewJobId === currentReviewJobId
        ? {
            ...message,
            metadata: {
              ...message.metadata,
              reviewJobId: nextReviewJobId,
              reviewSummary: {
                status:
                  summary.status ??
                  message.metadata.reviewSummary?.status ??
                  "capturing",
                ...message.metadata.reviewSummary,
                ...summary,
              },
            },
          }
        : message,
    ),
  );
}

function hasNewerGenuineUserMessage(
  conversationId: string,
  reviewJobId: string,
): boolean {
  const messages =
    useConversationStore.getState().conversations[conversationId]?.messages ??
    [];
  const activityIndex = messages.findIndex(
    (message) => message.metadata?.reviewJobId === reviewJobId,
  );
  if (activityIndex < 0) return true;
  return messages
    .slice(activityIndex + 1)
    .some((message) => message.role === "user" && !message.metadata?.origin);
}

function waitForDesignReviewRun(
  runId: string,
): Promise<DesignReviewRun | null> {
  const current = Object.values(
    useDesignReviewStore.getState().runsByConversation,
  )
    .flat()
    .find((run) => run.id === runId);
  if (!current || isDesignReviewTerminalStatus(current.status)) {
    return Promise.resolve(current ?? null);
  }
  return new Promise((resolve) => {
    const unsubscribe = useDesignReviewStore.subscribe((state) => {
      const run = Object.values(state.runsByConversation)
        .flat()
        .find((candidate) => candidate.id === runId);
      if (run && !isDesignReviewTerminalStatus(run.status)) return;
      unsubscribe();
      resolve(run ?? null);
    });
  });
}

interface GeneratorRuntime {
  createOpenAIGenerator: typeof import("../lib/ai/client").createOpenAIGenerator;
  buildToolHandlers: typeof import("../lib/tools/handler-factory").buildToolHandlers;
  createSubagentDispatcher: typeof import("../lib/ai/subagents/runner").createSubagentDispatcher;
  runCompress: typeof import("../lib/utils/run-compress").runCompress;
  buildMemoryPromptSection: typeof import("../lib/tools/memory").buildMemoryPromptSection;
  buildSkillsPromptSection: typeof import("../lib/skills/tool-handler").buildSkillsPromptSection;
  buildForcedSkillsPromptSection: typeof import("../lib/skills/tool-handler").buildForcedSkillsPromptSection;
  getSkillRegistry: typeof import("../lib/skills/instance").getSkillRegistry;
  isSkillsAvailable: typeof import("../lib/skills/fs").isSkillsAvailable;
  mcpManager: ReturnType<
    typeof import("../lib/mcp/connection-manager").getMcpConnectionManager
  >;
  buildToolSet: (args: {
    custom: ToolSet;
    planMode: boolean;
    mode?: ExecutionMode;
    runtimePlatform: RuntimePlatform;
    allowedDynamicNames?: ReadonlySet<string>;
    providerOwnedNames?: ReadonlySet<string>;
    profile?: ToolProfile;
  }) => ToolSet;
}

let generatorRuntimePromise: Promise<GeneratorRuntime> | null = null;

function loadGeneratorRuntime(): Promise<GeneratorRuntime> {
  generatorRuntimePromise ??= Promise.all([
    import("../lib/ai/client"),
    import("../lib/ai/tools-schema"),
    import("../lib/tools/memory"),
    import("../lib/tools/handler-factory"),
    import("../lib/ai/subagents/runner"),
    import("../lib/utils/run-compress"),
    import("../lib/skills/tool-handler"),
    import("../lib/skills/fs"),
    import("../lib/mcp/connection-manager"),
  ]).then(
    ([
      client,
      toolsSchema,
      memory,
      handlerFactory,
      subagentRunner,
      runCompressModule,
      skillToolHandler,
      skillFs,
      mcpConnectionManager,
    ]) => {
      const buildToolSet = ({
        custom,
        planMode,
        mode = planMode ? "plan" : "chat",
        runtimePlatform,
        allowedDynamicNames = new Set(),
        providerOwnedNames = new Set(),
        profile = "default",
      }: {
        custom: ToolSet;
        planMode: boolean;
        mode?: ExecutionMode;
        runtimePlatform: RuntimePlatform;
        allowedDynamicNames?: ReadonlySet<string>;
        providerOwnedNames?: ReadonlySet<string>;
        profile?: ToolProfile;
      }): ToolSet =>
        toolsSchema.buildToolSetForRun({
          custom,
          mode,
          platform: runtimePlatform,
          allowedDynamicNames,
          providerOwnedNames,
          profile,
        });

      return {
        createOpenAIGenerator: client.createOpenAIGenerator,
        buildToolHandlers: handlerFactory.buildToolHandlers,
        createSubagentDispatcher: subagentRunner.createSubagentDispatcher,
        runCompress: runCompressModule.runCompress,
        buildMemoryPromptSection: memory.buildMemoryPromptSection,
        buildSkillsPromptSection: skillToolHandler.buildSkillsPromptSection,
        buildForcedSkillsPromptSection:
          skillToolHandler.buildForcedSkillsPromptSection,
        getSkillRegistry,
        isSkillsAvailable: skillFs.isSkillsAvailable,
        mcpManager: mcpConnectionManager.getMcpConnectionManager(),
        buildToolSet,
      };
    },
  );
  return generatorRuntimePromise;
}

interface UseGeneratorOptions {
  settings: AISettings;
  webSearchSettings: WebSearchSettings;
  assetSearchSettings: AssetSearchSettings;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setFiles: Dispatch<SetStateAction<ProjectFiles>>;
  setIsGenerating: Dispatch<SetStateAction<boolean>>;
  setTemplate: Dispatch<SetStateAction<string>>;
  restartSandpack: () => void;
}

function observedLocalCapabilities(provider: LocalAgentProvider) {
  return useSettingsStore.getState().localCliObservationCache.providers[
    provider
  ]?.capabilities;
}

/**
 * Build the local CLI client config from the saved provider preference. The
 * observation cache and image-compression settings are read lazily, so a run
 * sees current values without the lib layer reaching into the store.
 */
function localAgentClientConfig(
  localAgent: AISettings["localAgent"],
  overrides: Pick<LocalAgentClientConfig, "nativeSearch"> &
    Partial<LocalAgentClientConfig>,
): LocalAgentClientConfig {
  const { provider } = localAgent;
  const preferences = localAgent.preferences[provider];
  return {
    provider,
    model: preferences.model,
    effort: preferences.effort,
    getObservedCapabilities: () => observedLocalCapabilities(provider),
    getImageCompression: () => {
      const { imageCompressionEnabled, imageCompressionQuality } =
        useSettingsStore.getState().system;
      return {
        enabled: imageCompressionEnabled,
        quality: imageCompressionQuality,
      };
    },
    ...overrides,
  };
}

/** Explicit Stop may happen before a generator exists. Retire that cancelled
 * journal only after Native confirms cleanup and the existing UI state saves. */
async function retireStoppedLocalRun(
  native: typeof import("../lib/local-agent/tauri"),
  runId: string,
): Promise<void> {
  await native.cancelLocalAgent(runId);
  await flushConversationPersistence();
  const remaining = (await native.listRecoverableLocalAgents()).find(
    (run) => run.runId === runId,
  );
  if (!remaining) return;
  if (!remaining.terminal)
    throw new Error(getT().settings.localCli.recoveryUnavailable);
  const terminal = await native.attachLocalAgent(runId, () => {});
  await native.acknowledgeLocalAgentTerminal(runId, terminal.lease);
}

export function useGenerator({
  settings,
  webSearchSettings,
  assetSearchSettings,
  setMessages,
  setFiles,
  setIsGenerating,
  setTemplate,
  restartSandpack,
}: UseGeneratorOptions) {
  const generatorRef = useRef<GenerationBackend | null>(null);
  const [runState, setRunState] = useState<GeneratorRunState>("idle");
  const [lastError, setLastError] = useState<StructuredGenerationError | null>(
    null,
  );
  const [isThinkingStreaming, setIsThinkingStreaming] = useState(false);
  const [runtimeWaitMessage, setRuntimeWaitMessage] = useState<string | null>(
    null,
  );
  const generatorConfigRef = useRef<GeneratorConfigSnapshot | null>(null);
  const generatorConstructionEpochRef = useRef(0);
  const permissionBrokerBypassEnabled = useSettingsStore(
    (state) => state.system.permissionBrokerBypassEnabled,
  );
  const previousPermissionBypassRef = useRef(permissionBrokerBypassEnabled);
  const activeId = useConversationStore((s) => s.activeId);
  const conversationHydrated = useConversationStore((s) => s._hasHydrated);
  const recoveryCheckedRef = useRef<string | null>(null);
  const recoveryCheckingRef = useRef(false);
  const recoveryAttemptRef = useRef(0);
  const recoveryStopEpochRef = useRef(0);
  const recoveringRunRef = useRef<LocalRecoverableRun | null>(null);
  const recoveryInstructionMessagesRef = useRef(new Map<string, Message>());
  const recoveryToolOutputsRef = useRef(
    new Map<string, import("../lib/ai/generator-types").ToolExecutionOutput>(),
  );
  const activeCheckoutKey = useConversationStore((state) =>
    checkoutKey(
      state.activeId ? state.conversations[state.activeId] : undefined,
    ),
  );
  const activeReviewFiles = useConversationStore((state) =>
    state.activeId ? state.conversations[state.activeId]?.files : undefined,
  );
  const activeReviewDesignSystem = useConversationStore((state) =>
    state.activeId
      ? state.conversations[state.activeId]?.designState?.appliedSystem
      : undefined,
  );
  const activeReviewMessages = useConversationStore((state) =>
    state.activeId
      ? (state.conversations[state.activeId]?.messages ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
  );
  const activeDesignReviewRuns = useDesignReviewStore((state) =>
    activeId
      ? (state.runsByConversation[activeId] ?? EMPTY_DESIGN_REVIEW_RUNS)
      : EMPTY_DESIGN_REVIEW_RUNS,
  );
  const designReviewRunsHydrated = useDesignReviewStore(
    (state) => state._hasHydratedRuns,
  );
  const prevActiveIdRef = useRef(activeCheckoutKey);
  const outputSchedulerRef = useRef<AdaptiveOutputScheduler | null>(null);
  const runConversationIdRef = useRef<string | null>(null);
  const runIdentityRef = useRef<ConversationIdentity | null>(null);
  const generationRunEpochRef = useRef(0);
  const forcedSkillsPromptRef = useRef("");
  const forcedSkillIdsRef = useRef<string[]>([]);
  const systemPromptSuffixRef = useRef("");
  const foregroundForcedSkillIdsRef = useRef<string[]>([]);
  const foregroundCustomPromptRef = useRef("");
  const runAttachmentsRef = useRef<{
    epoch: number;
    conversationId: string;
    attachments: Map<string, ResolvedAttachment>;
    clear: () => void;
  } | null>(null);
  const logicalRunIdRef = useRef<string | null>(null);
  const instructionSequenceRef = useRef(0);
  const customSystemPromptRef = useRef("");
  const requestPromptContextRef = useRef("");
  const baseCustomToolSetRef = useRef<ToolSet>({});
  const providerToolNamesRef = useRef<string[]>([]);
  const mcpRuntimeRef = useRef<McpRuntimeBundle | null>(null);
  const activeToolProfileRef = useRef<ToolProfile>("default");
  const designRunRef = useRef<DesignRun | null>(null);
  const designRunInitialFilesRef = useRef<ProjectFiles>({});
  const designRunExpectedChangeModesRef = useRef<
    readonly DesignChangeMode[] | undefined
  >(undefined);
  const reviewContractByRunIdRef = useRef(
    new Map<string, DesignContract | null>(),
  );

  const configureDesignRun = useCallback(
    (
      conversation: Conversation | undefined,
      options: {
        expectedChangeModes?: readonly DesignChangeMode[];
        profile?: ToolProfile;
        resume?: boolean;
      } = {},
    ) => {
      const files = conversation?.files ?? {};
      const workspace = getConversationWorkspaceContext(conversation?.id);
      const expectedChangeModes =
        options.expectedChangeModes ??
        (Object.keys(files).length === 0 ? (["create"] as const) : undefined);
      designRunInitialFilesRef.current = { ...files };
      designRunExpectedChangeModesRef.current = expectedChangeModes
        ? [...expectedChangeModes]
        : undefined;
      const request = [...(conversation?.messages ?? [])]
        .reverse()
        .find(
          (message) => message.role === "user" && !message.metadata?.origin,
        );
      const goal = typeof request?.content === "string" ? request.content : "";
      const selection = conversation
        ? useProjectDesignWorkspaceStore.getState().selections[conversation.id]
        : undefined;
      const blueprint = readProjectDesign(files);
      const pointPage =
        request?.metadata?.designSelection && blueprint.status === "ready"
          ? resolveProjectDesignPreviewRoute(
              blueprint.design,
              request.metadata.designSelection.route,
            )?.pageId
          : undefined;
      designRunRef.current =
        (options.profile ?? workspace.profile) === "design"
          ? prepareDesignRun({
              requestId: logicalRunIdRef.current ?? crypto.randomUUID(),
              goal,
              files,
              systemId: conversation?.designState?.appliedSystem?.id ?? null,
              changeMode: expectedChangeModes?.[0],
              pageIds: pointPage
                ? [pointPage]
                : selection?.explicit
                  ? [selection.pageId]
                  : undefined,
              resume: options.resume,
            })
          : null;
    },
    [],
  );

  const clearOutputBuffers = useCallback(() => {
    outputSchedulerRef.current?.clear();
  }, []);

  const isCurrentGeneratorRun = useCallback(
    (runConversationId: string | null) =>
      isGenerationRunCurrent(
        runConversationId,
        useConversationStore.getState().activeId,
        runConversationIdRef.current,
      ) &&
      !!runIdentityRef.current &&
      isConversationIdentityCurrent(
        runIdentityRef.current,
        runConversationId
          ? useConversationStore.getState().conversations[runConversationId]
          : undefined,
      ),
    [],
  );

  useEffect(
    () => () => {
      if (runConversationIdRef.current)
        useConversationStore
          .getState()
          .cancelUserInstructions(runConversationIdRef.current);
      runAttachmentsRef.current?.clear();
      runAttachmentsRef.current = null;
      generationRunEpochRef.current += 1;
      generatorConstructionEpochRef.current += 1;
      clearOutputBuffers();
      forcedSkillsPromptRef.current = "";
      customSystemPromptRef.current = "";
      requestPromptContextRef.current = "";
      mcpRuntimeRef.current = null;
      activeToolProfileRef.current = "default";
      designRunRef.current = null;
      designRunInitialFilesRef.current = {};
      designRunExpectedChangeModesRef.current = undefined;
      generatorRef.current?.abort();
    },
    [clearOutputBuffers],
  );

  const invalidateGenerator = useCallback(() => {
    if (runConversationIdRef.current)
      useConversationStore
        .getState()
        .cancelUserInstructions(runConversationIdRef.current);
    runAttachmentsRef.current?.clear();
    runAttachmentsRef.current = null;
    generationRunEpochRef.current += 1;
    generatorConstructionEpochRef.current += 1;
    generatorRef.current?.abort();
    generatorRef.current = null;
    generatorConfigRef.current = null;
    runConversationIdRef.current = null;
    forcedSkillsPromptRef.current = "";
    customSystemPromptRef.current = "";
    requestPromptContextRef.current = "";
    baseCustomToolSetRef.current = {};
    providerToolNamesRef.current = [];
    mcpRuntimeRef.current = null;
    activeToolProfileRef.current = "default";
    designRunRef.current = null;
    designRunInitialFilesRef.current = {};
    designRunExpectedChangeModesRef.current = undefined;
    clearOutputBuffers();
    setIsThinkingStreaming(false);
    useInteractiveStore.getState().rejectAllPending("project reset");
    useSubagentStore.setState({ progress: {} });
    useDesignReviewStore.getState().reset();
  }, [clearOutputBuffers]);

  useEffect(() => {
    if (previousPermissionBypassRef.current === permissionBrokerBypassEnabled) {
      return;
    }
    previousPermissionBypassRef.current = permissionBrokerBypassEnabled;
    if (runConversationIdRef.current)
      useConversationStore
        .getState()
        .cancelUserInstructions(runConversationIdRef.current);
    runAttachmentsRef.current?.clear();
    runAttachmentsRef.current = null;
    generationRunEpochRef.current += 1;
    generatorConstructionEpochRef.current += 1;
    generatorRef.current?.abort();
    generatorRef.current = null;
    generatorConfigRef.current = null;
    useProjectPermissionStore
      .getState()
      .cancelPending("permission setting changed");
  }, [permissionBrokerBypassEnabled]);

  useEffect(() => {
    if (prevActiveIdRef.current === activeCheckoutKey) return;
    if (runConversationIdRef.current) {
      useConversationStore
        .getState()
        .setMessagesForConversation(runConversationIdRef.current, (messages) =>
          cancelPendingToolCalls(messages, "conversation-switched"),
        );
    }
    if (runConversationIdRef.current)
      useConversationStore
        .getState()
        .cancelUserInstructions(runConversationIdRef.current);
    runAttachmentsRef.current?.clear();
    runAttachmentsRef.current = null;
    generationRunEpochRef.current += 1;
    generatorConstructionEpochRef.current += 1;
    generatorRef.current?.abort();
    generatorRef.current = null;
    generatorConfigRef.current = null;
    runConversationIdRef.current = null;
    forcedSkillsPromptRef.current = "";
    customSystemPromptRef.current = "";
    requestPromptContextRef.current = "";
    baseCustomToolSetRef.current = {};
    providerToolNamesRef.current = [];
    mcpRuntimeRef.current = null;
    activeToolProfileRef.current = "default";
    designRunRef.current = null;
    designRunInitialFilesRef.current = {};
    designRunExpectedChangeModesRef.current = undefined;
    clearOutputBuffers();
    prevActiveIdRef.current = activeCheckoutKey;
    useInteractiveStore.getState().rejectAllPending("conversation switched");
    useProjectPermissionStore
      .getState()
      .cancelPending("conversation branch switched");
    useSubagentStore.setState({ progress: {} });
    useDesignReviewStore.getState().reset();
    setIsGenerating(false);
    setIsThinkingStreaming(false);
    setRuntimeWaitMessage(null);
    setRunState("idle");
  }, [activeId, activeCheckoutKey, clearOutputBuffers, setIsGenerating]);

  useEffect(() => {
    if (!activeId || !activeReviewFiles) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const runs =
        useDesignReviewStore.getState().runsByConversation[activeId] ?? [];
      void computeDesignReviewSourceDigest({
        files: activeReviewFiles,
        designSystem: activeReviewDesignSystem ?? null,
        designContract: null,
      })
        .then((sourceProjectDigest) =>
          Promise.all(
            runs.map(async (run) => {
              let stale = run.sourceProjectDigest
                ? run.sourceProjectDigest !== sourceProjectDigest
                : run.freshness === "stale";
              if (reviewContractByRunIdRef.current.has(run.id)) {
                const contract =
                  reviewContractByRunIdRef.current.get(run.id) ?? null;
                const sourceDigest = await computeDesignReviewSourceDigest({
                  files: activeReviewFiles,
                  designSystem: activeReviewDesignSystem ?? null,
                  designContract: contract,
                });
                if (cancelled) return;
                stale = run.sourceDigest !== sourceDigest;
                useDesignReviewStore
                  .getState()
                  .markRunFreshness(run.id, sourceDigest);
              } else if (run.sourceProjectDigest) {
                if (cancelled) return;
                useDesignReviewStore
                  .getState()
                  .markRunProjectFreshness(run.id, sourceProjectDigest);
              }
              if (run.kind === "automatic") {
                updateAutomaticReviewActivity(activeId, run.id, { stale });
              }
            }),
          ),
        )
        .catch(() => undefined);
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeId, activeReviewDesignSystem, activeReviewFiles]);

  useEffect(() => {
    if (!activeId) return;
    for (const run of activeDesignReviewRuns) {
      if (
        run.kind !== "automatic" ||
        !isDesignReviewTerminalStatus(run.status)
      ) {
        continue;
      }
      const activityStatus = useConversationStore
        .getState()
        .conversations[activeId]?.messages.find(
          (message) => message.metadata?.reviewJobId === run.id,
        )?.metadata?.reviewSummary?.status;
      if (
        run.status === "succeeded" &&
        (activityStatus === "fixing" || activityStatus === "verifying")
      ) {
        continue;
      }
      updateAutomaticReviewActivity(activeId, run.id, {
        status: run.status,
        findingCount: run.report?.findings.length ?? 0,
        stale: run.freshness === "stale",
      });
    }
  }, [activeDesignReviewRuns, activeId]);

  useEffect(() => {
    if (!activeId || !designReviewRunsHydrated) return;
    const persistedIds = new Set(activeDesignReviewRuns.map((run) => run.id));
    const activeCaptureId =
      useDesignReviewStore.getState().automatic?.evidence.requestId;
    for (const message of activeReviewMessages) {
      const reviewJobId = message.metadata?.reviewJobId;
      const status = message.metadata?.reviewSummary?.status;
      if (
        !reviewJobId ||
        !status ||
        ![
          "capturing",
          "queued",
          "running",
          "fixing",
          "verifying",
          "deferred",
        ].includes(status) ||
        persistedIds.has(reviewJobId) ||
        activeCaptureId === reviewJobId ||
        pendingAutomaticCaptureIds.has(reviewJobId)
      ) {
        continue;
      }
      updateAutomaticReviewActivity(activeId, reviewJobId, {
        status: "interrupted",
      });
    }
  }, [
    activeDesignReviewRuns,
    activeId,
    activeReviewMessages,
    designReviewRunsHydrated,
  ]);

  const { updateFiles, deleteFile, renameFile, moveFile } = useFileOperations({
    setFiles,
    generatorRef,
  });

  const resolveEffectiveConfig = useCallback(async () => {
    return {
      apiType: settings.apiType,
      apiBaseUrl: settings.apiBaseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
    };
  }, [settings]);

  const generateLocalUtilityText = useCallback(
    async (
      instructions: string,
      prompt: string,
      options?: { timeoutMs?: number; signal?: AbortSignal },
      purpose?: "title",
    ) => {
      const { runLocalUtilityText, runLocalTitleText } =
        await import("../lib/local-agent/generator");
      try {
        const runText =
          purpose === "title" ? runLocalTitleText : runLocalUtilityText;
        return await runText(
          localAgentClientConfig(settings.localAgent, { nativeSearch: false }),
          instructions,
          prompt,
          {
            ...options,
            onPrepared: (preparedProvider, metadata) => {
              useSettingsStore
                .getState()
                .mergeLocalCliPreparedMetadata(preparedProvider, metadata);
            },
          },
        );
      } catch (error) {
        const failure = classifyGenerationError(error).localCliFailure;
        if (failure) {
          useSettingsStore.getState().mergeLocalCliFailure(failure);
        }
        throw error;
      }
    },
    [settings.localAgent],
  );

  const generateLocalTitleText = useCallback(
    (
      instructions: string,
      prompt: string,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ) => generateLocalUtilityText(instructions, prompt, options, "title"),
    [generateLocalUtilityText],
  );

  const generateUtilityText = useCallback(
    async (
      instructions: string,
      prompt: string,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ) => {
      if (settings.runtime === "localCli") {
        return generateLocalUtilityText(instructions, prompt, options);
      }
      const [{ generateText }, { getProviderModel }] = await Promise.all([
        import("ai"),
        import("../lib/ai/provider"),
      ]);
      const result = await generateText({
        model: getProviderModel(await resolveEffectiveConfig()),
        instructions,
        prompt,
        maxRetries: 0,
        abortSignal: options?.signal,
        timeout: options?.timeoutMs,
      });
      return result.text.trim();
    },
    [generateLocalUtilityText, resolveEffectiveConfig, settings.runtime],
  );

  const { triggerSmartTitle, compressContext } = useTitleAndCompression({
    resolveConfig: resolveEffectiveConfig,
    setIsGenerating,
    setMessages,
    generateTextOverride:
      settings.runtime === "localCli" ? generateLocalUtilityText : undefined,
    generateTitleOverride:
      settings.runtime === "localCli" ? generateLocalTitleText : undefined,
  });

  const flushThinkingBuffer = useCallback(() => {
    outputSchedulerRef.current?.flush("thinking");
  }, []);

  const flushOutputBuffers = useCallback(() => {
    outputSchedulerRef.current?.flush();
  }, []);

  const appendGenerationError = useCallback(
    (
      err: unknown,
      options: { replaceExisting?: boolean; retryable?: boolean } = {},
    ): StructuredGenerationError => {
      flushOutputBuffers();
      setIsThinkingStreaming(false);
      const classified = classifyGenerationError(err);
      if (classified.localCliFailure) {
        useSettingsStore
          .getState()
          .mergeLocalCliFailure(classified.localCliFailure);
      }
      setLastError(classified);
      setRunState(classified.kind === "aborted" ? "aborted" : "error");
      setMessages((prev) => [
        ...(options.replaceExisting ? removeErrorMessages(prev) : prev),
        {
          role: "assistant",
          content: formatGenerationErrorMessage(classified, getT()),
          isError: true,
          errorKind: classified.kind,
          errorRetryable: options.retryable ?? classified.retryable,
          ...(classified.status !== undefined
            ? { errorStatus: classified.status }
            : {}),
          ...(classified.localCliFailure
            ? { localCliFailure: classified.localCliFailure }
            : {}),
        },
      ]);
      return classified;
    },
    [flushOutputBuffers, setMessages],
  );

  const registerRunAttachments = useCallback(
    (
      conversationId: string,
      attachments: ResolvedAttachment[],
    ): (() => void) => {
      const registration = {
        epoch: generationRunEpochRef.current,
        conversationId,
        attachments: new Map(
          attachments.map((attachment) => [attachment.id, attachment]),
        ),
        clear: registerAgnesRunAttachments(conversationId, attachments),
      };
      runAttachmentsRef.current = registration;
      return () => {
        registration.clear();
        if (runAttachmentsRef.current === registration)
          runAttachmentsRef.current = null;
      };
    },
    [],
  );

  const enqueueInstruction = useCallback(
    async (
      prompt: string,
      attachments: Attachment[] = [],
      options: GenerateRunOptions = {},
    ): Promise<boolean> => {
      const conversationId = runConversationIdRef.current;
      const runId = logicalRunIdRef.current;
      const epoch = generationRunEpochRef.current;
      if (
        !conversationId ||
        !runId ||
        !isCurrentGeneratorRun(conversationId) ||
        (!prompt.trim() &&
          attachments.length === 0 &&
          !options.forcedSkillIds?.length)
      )
        return false;
      try {
        // Validate before accepting ownership of the draft; the queue retains only references.
        if (attachments.length) await resolveAttachmentsForModel(attachments);
        if (options.forcedSkillIds?.length) {
          const runtime = await loadGeneratorRuntime();
          if (!runtime.isSkillsAvailable()) return false;
          const registry = await runtime.getSkillRegistry();
          await registry.prepareForcedSkills(options.forcedSkillIds);
        }
      } catch {
        return false;
      }
      if (
        epoch !== generationRunEpochRef.current ||
        runId !== logicalRunIdRef.current ||
        !isCurrentGeneratorRun(conversationId)
      )
        return false;
      flushOutputBuffers();
      const afterMessageIndex =
        useConversationStore.getState().conversations[conversationId]?.messages
          .length ?? 0;
      useConversationStore
        .getState()
        .setPendingUserInstructions(conversationId, (items) => [
          ...items,
          {
            id: crypto.randomUUID(),
            conversationId,
            runId,
            sequence: ++instructionSequenceRef.current,
            afterMessageIndex,
            content:
              prompt.trim() ||
              (options.forcedSkillIds?.length
                ? getT().chat.instructions.applySkills
                : ""),
            attachments: attachments.map(toAttachmentRef),
            forcedSkillIds: [...new Set(options.forcedSkillIds ?? [])],
            status: "queued",
          },
        ]);
      return true;
    },
    [flushOutputBuffers, isCurrentGeneratorRun],
  );

  const prepareUserInstructions = useCallback<UserInstructionSource["prepare"]>(
    async (backend, signal) => {
      const conversationId = runConversationIdRef.current;
      const runId = logicalRunIdRef.current;
      const epoch = generationRunEpochRef.current;
      const current = () =>
        !signal.aborted &&
        generatorRef.current === backend &&
        generationRunEpochRef.current === epoch &&
        logicalRunIdRef.current === runId &&
        isCurrentGeneratorRun(conversationId);
      if (
        !conversationId ||
        !runId ||
        !current() ||
        activeToolProfileRef.current === "design_review" ||
        (backend.getRunContext().mode !== "chat" &&
          backend.getRunContext().mode !== "plan")
      )
        return null;
      const store = useConversationStore.getState();
      const queued = (
        store.conversations[conversationId]?.pendingUserInstructions ?? []
      )
        .filter((item) => item.runId === runId && item.status === "queued")
        .sort((a, b) => a.sequence - b.sequence);
      if (!queued.length) return null;
      const instructions: PreparedUserInstruction[] = [];
      for (const item of queued) {
        try {
          const attachments = await resolveAttachmentsForModel(
            item.attachments,
          );
          let skillPrompt = "";
          if (item.forcedSkillIds.length) {
            const runtime = await loadGeneratorRuntime();
            if (!runtime.isSkillsAvailable())
              throw new Error("Skill storage unavailable");
            const registry = await runtime.getSkillRegistry();
            const ids = [
              ...new Set([
                ...forcedSkillIdsRef.current,
                ...item.forcedSkillIds,
              ]),
            ];
            const prepared = await registry.prepareForcedSkills(ids);
            if (!current()) return null;
            backend
              .getSkillContext()
              .activateMany(prepared.map((skill) => skill.entry));
            skillPrompt = runtime.buildForcedSkillsPromptSection(prepared);
            const previous = forcedSkillsPromptRef.current;
            systemPromptSuffixRef.current = previous
              ? systemPromptSuffixRef.current.replace(previous, skillPrompt)
              : systemPromptSuffixRef.current + skillPrompt;
            requestPromptContextRef.current = previous
              ? requestPromptContextRef.current.replace(previous, skillPrompt)
              : requestPromptContextRef.current + skillPrompt;
            foregroundForcedSkillIdsRef.current = ids;
            forcedSkillIdsRef.current = ids;
            forcedSkillsPromptRef.current = skillPrompt;
            backend.setSystemPromptSuffix(systemPromptSuffixRef.current);
          }
          if (!current()) return null;
          instructions.push({
            id: item.id,
            attachments,
            skillPrompt,
            message: {
              role: "user",
              content:
                item.content ||
                (item.forcedSkillIds.length
                  ? getT().chat.instructions.applySkills
                  : ""),
              forcedSkillIds: [...foregroundForcedSkillIdsRef.current],
              metadata: {
                instructionId: item.id,
                ...(item.attachments.length
                  ? { attachments: item.attachments }
                  : {}),
              },
            },
          });
        } catch {
          if (!current()) return null;
          store.setPendingUserInstructions(conversationId, (items) =>
            items.map((entry) =>
              entry.id === item.id && entry.status === "queued"
                ? { ...entry, status: "failed" }
                : entry,
            ),
          );
        }
      }
      if (!instructions.length || !current()) return null;
      const registration = runAttachmentsRef.current;
      if (
        registration?.epoch === epoch &&
        registration.conversationId === conversationId
      ) {
        for (const instruction of instructions) {
          for (const attachment of instruction.attachments)
            registration.attachments.set(attachment.id, attachment);
          if (isAgnesImageToolAvailable()) {
            const manifest = formatAgnesAttachmentManifest(
              instruction.attachments,
            );
            if (manifest)
              instruction.modelPrompt = `${String(instruction.message.content ?? "")}\n\n${manifest}`;
          }
        }
        registration.clear();
        registration.clear = registerAgnesRunAttachments(conversationId, [
          ...registration.attachments.values(),
        ]);
      }
      const ids = new Set(instructions.map((item) => item.id));
      store.setPendingUserInstructions(conversationId, (items) =>
        items.map((item) =>
          ids.has(item.id) && item.status === "queued"
            ? { ...item, status: "delivering" }
            : item,
        ),
      );
      return {
        instructions,
        commit() {
          if (!current()) return false;
          flushOutputBuffers();
          return store.commitUserInstructions(
            conversationId,
            runId,
            [...ids],
            instructions.map((item) => item.message),
          );
        },
        fail(reason) {
          if (!current()) return;
          store.setPendingUserInstructions(conversationId, (items) =>
            items.map((item) =>
              ids.has(item.id) && item.status === "delivering"
                ? { ...item, status: reason }
                : item,
            ),
          );
        },
      } satisfies PreparedUserInstructionBatch;
    },
    [flushOutputBuffers, isCurrentGeneratorRun],
  );

  const getGenerator = useCallback(async () => {
    const requestedRunEpoch = generationRunEpochRef.current;
    const isLocalRuntime = settings.runtime === "localCli";
    const localProvider = settings.localAgent.provider;
    const currentApiType = settings.apiType;
    const currentApiKey = settings.apiKey;
    const currentApiBaseUrl = settings.apiBaseUrl;
    const currentModel = settings.model;

    if (
      !isLocalRuntime &&
      (!settings.apiKey || !settings.apiBaseUrl || !settings.model)
    )
      return null;
    if (isLocalRuntime) {
      if (
        webSearchSettings.engine === "builtin" &&
        !localAgentSupportsNativeSearch(
          localProvider,
          observedLocalCapabilities(localProvider),
        )
      ) {
        throw new Error(getT().settings.localCli.builtinSearchBlocked);
      }
      const { supportsLocalAgents } = await import("../lib/local-agent/tauri");
      if (!(await supportsLocalAgents())) {
        throw new Error(getT().settings.localCli.runtimeUnavailableAction);
      }
    }

    if (requestedRunEpoch !== generationRunEpochRef.current) return null;
    const currentActiveId = useConversationStore.getState().activeId;
    if (!currentActiveId || !isCurrentGeneratorRun(currentActiveId))
      return null;
    const currentConversation =
      useConversationStore.getState().conversations[currentActiveId];
    const currentCheckoutKey = checkoutKey(currentConversation);

    // Invalidate on conversation switch, including a store update that arrived
    // before React committed the matching render.
    if (prevActiveIdRef.current !== currentCheckoutKey) {
      generatorConstructionEpochRef.current += 1;
      generatorRef.current?.abort();
      generatorRef.current = null;
      generatorConfigRef.current = null;
      runConversationIdRef.current = null;
      baseCustomToolSetRef.current = {};
      providerToolNamesRef.current = [];
      mcpRuntimeRef.current = null;
      activeToolProfileRef.current = "default";
      clearOutputBuffers();
      setIsThinkingStreaming(false);
      prevActiveIdRef.current = currentCheckoutKey;
      useInteractiveStore.getState().rejectAllPending("conversation switched");
      useSubagentStore.setState({ progress: {} });
    }

    const nextConfig = buildGeneratorConfigSnapshot(
      settings,
      webSearchSettings,
      assetSearchSettings,
      useSettingsStore.getState().system.developerSkillScriptsEnabled,
      useSettingsStore.getState().system.permissionBrokerBypassEnabled,
    );

    if (
      generatorRef.current &&
      !sameGeneratorConfig(generatorConfigRef.current, nextConfig)
    ) {
      generatorConstructionEpochRef.current += 1;
      generatorRef.current.abort();
      generatorRef.current = null;
      generatorConfigRef.current = null;
      baseCustomToolSetRef.current = {};
      providerToolNamesRef.current = [];
      mcpRuntimeRef.current = null;
      activeToolProfileRef.current = "default";
    }

    if (!generatorRef.current) {
      const constructionEpoch = ++generatorConstructionEpochRef.current;
      const constructionRunEpoch = requestedRunEpoch;
      const runtime = await loadGeneratorRuntime();
      const generatorConversationId = currentActiveId;
      const candidateIdentity =
        captureConversationIdentity(currentConversation);
      let candidate: GenerationBackend | null = null;
      const isCurrentCandidate = () =>
        candidate !== null &&
        generatorRef.current === candidate &&
        isCurrentGeneratorRun(generatorConversationId) &&
        isConversationIdentityCurrent(
          candidateIdentity,
          useConversationStore.getState().conversations[
            generatorConversationId
          ],
        );

      const isBuiltinSearch =
        !isLocalRuntime && webSearchSettings.engine === "builtin";
      const webConfigured =
        webSearchSettings.engine !== "builtin" &&
        useSettingsStore.getState().isWebSearchConfigured();
      const assetConfigured = useSettingsStore
        .getState()
        .isAssetSearchConfigured();

      const {
        customToolSet,
        combinedToolHandler,
        providerToolNames,
        runtimePlatform,
      } = await runtime.buildToolHandlers({
        features: {
          builtinSearch: isBuiltinSearch,
          webSearch: webConfigured,
          assetSearch: assetConfigured,
          localAgent: isLocalRuntime,
        },
        effectiveWebSearchSettings: webSearchSettings,
        effectiveAssetSearchSettings: assetSearchSettings,
        apiConfig: {
          apiType: currentApiType,
          apiBaseUrl: currentApiBaseUrl,
          apiKey: currentApiKey,
          model: currentModel,
        },
        getConsoleLogs: () => useSandpackStore.getState().consoleLogs,
        memoryDeps: {
          getAll: () => useMemoryStore.getState().getAll(),
          processBatch: (ops) => useMemoryStore.getState().processBatch(ops),
        },
        developerSkillScriptsEnabled:
          useSettingsStore.getState().system.developerSkillScriptsEnabled,
        requestRegistryOriginApproval: async (origin, context) => {
          if (!isCurrentCandidate()) return false;
          const translations = getT();
          recordPermissionActivity({
            conversationId: context.run.conversationId,
            tool: "install_component",
            source: "registry",
            mode: context.run.mode,
            platform: context.run.platform,
            decision: "requested",
            target: origin,
          });
          const answers = await useInteractiveStore.getState().askQuestion({
            toolCallId: context.toolCallId,
            presentation: "approval",
            questions: [
              {
                header: translations.approvals.registryHeader,
                question: translations.approvals.registryQuestion.replace(
                  "{origin}",
                  origin,
                ),
                multiSelect: false,
                options: [
                  {
                    label: translations.approvals.approveOnce,
                    description: translations.approvals.approveOnceDesc,
                  },
                  {
                    label: translations.approvals.deny,
                    description: translations.approvals.denyDesc,
                  },
                ],
              },
            ],
          });
          if (!isCurrentCandidate() || context.signal.aborted) return false;
          const approved = answers.answers[0]?.selected.includes(
            translations.approvals.approveOnce,
          );
          recordPermissionActivity({
            conversationId: context.run.conversationId,
            tool: "install_component",
            source: "registry",
            mode: context.run.mode,
            platform: context.run.platform,
            decision: approved ? "allowed" : "denied",
            target: origin,
            reason: approved ? undefined : "user denied custom registry origin",
          });
          return approved;
        },
        setDefaultPreviewView: async (_name, args, context) => {
          if (
            !context ||
            context.run.conversationId !== generatorConversationId ||
            !isCurrentCandidate()
          ) {
            throw new DOMException("conversation switched", "AbortError");
          }
          const { setConversationDefaultPreviewView } =
            await import("../lib/design/preview-preference");
          if (!isCurrentCandidate() || context.signal.aborted)
            throw new DOMException("run stopped", "AbortError");
          const result = setConversationDefaultPreviewView({
            conversationId: generatorConversationId,
            view: (args as { view?: unknown })?.view,
          });
          return {
            text: JSON.stringify(result),
            structuredContent: result,
            isError: !result.ok,
          };
        },
        updateDesignTokens: async (_name, args, context) => {
          if (
            !context ||
            context.run.conversationId !== generatorConversationId ||
            !isCurrentCandidate()
          ) {
            throw new DOMException("conversation switched", "AbortError");
          }
          const { mutateConversationDesignTokens } =
            await import("../lib/design/token-mutation-host");
          const result = await mutateConversationDesignTokens({
            conversationId: generatorConversationId,
            changes:
              (
                args as {
                  changes?: import("../lib/design/token-mutation").DesignTokenChange[];
                }
              ).changes ?? [],
            principal: "model",
            designRunContext: designRunRef.current?.context(
              generatorRef.current?.getFiles(),
            ),
            snapshotLabel: getT().designTokens.snapshotLabel,
            prepareProjectFiles: (before, proposed) =>
              designRunRef.current?.prepareCommit(
                before,
                proposed,
                context.toolCallId,
              ) ?? proposed,
            onProjectFilesChanged: (nextFiles) => {
              if (!isCurrentCandidate()) {
                throw new DOMException("conversation switched", "AbortError");
              }
              candidate?.setFiles(nextFiles);
            },
          });
          const summary = result.ok
            ? {
                ok: true as const,
                status: result.status,
                conversationId: result.conversationId,
                revision: result.revision,
                snapshotId: result.snapshotId,
                changedTokens: result.changedTokens,
              }
            : result;
          return {
            text: JSON.stringify(summary),
            structuredContent: summary,
            isError: !result.ok,
          };
        },
        capturePreviewSequence: async (_name, args, context) => {
          if (
            !context ||
            context.run.conversationId !== generatorConversationId ||
            !isCurrentCandidate()
          ) {
            throw new DOMException("conversation switched", "AbortError");
          }
          const conversation =
            useConversationStore.getState().conversations[
              generatorConversationId
            ];
          if (!conversation)
            throw new DOMException("conversation switched", "AbortError");
          const { capturePreviewSequence, createPreviewSequenceToolOutput } =
            await import("../lib/design/preview-sequence");
          const { computePreviewGeneration } =
            await import("../lib/design/preview-runtime");
          const expectedGeneration = await computePreviewGeneration({
            files: conversation.files,
            template: conversation.template,
            previewMode: conversation.previewMode ?? "sandpack",
          });
          if (!isCurrentCandidate())
            throw new DOMException("run stopped", "AbortError");
          return createPreviewSequenceToolOutput(
            await capturePreviewSequence({
              conversationId: generatorConversationId,
              atMs: (args as { atMs?: number[] }).atMs,
              scope: (
                args as {
                  scope?: import("../lib/design/preview-runtime").PreviewCaptureScope;
                }
              ).scope,
              expectedGeneration,
              signal: context.signal,
            }),
          );
        },
        capturePreviewEvidence: async (_name, args, context) => {
          if (
            !context ||
            context.run.conversationId !== generatorConversationId ||
            !isCurrentCandidate()
          ) {
            throw new DOMException("conversation switched", "AbortError");
          }
          const conversation =
            useConversationStore.getState().conversations[
              generatorConversationId
            ];
          if (!conversation) {
            throw new DOMException("conversation switched", "AbortError");
          }
          const { capturePreviewEvidence } =
            await import("../lib/design/preview-evidence");
          const currentFiles = candidate?.getFiles() ?? conversation.files;
          const rawTarget = (
            args as {
              target?: {
                pageId?: unknown;
                route?: unknown;
                scenarioId?: unknown;
              };
            }
          ).target;
          let target: PrototypePreviewTarget | undefined;
          if (rawTarget !== undefined) {
            const blueprint = readProjectDesign(currentFiles);
            if (
              blueprint.status !== "ready" ||
              typeof rawTarget.pageId !== "string" ||
              (rawTarget.scenarioId !== undefined &&
                typeof rawTarget.scenarioId !== "string")
            ) {
              return "Error: prototype preview targets require a valid design-project.json blueprint.";
            }
            const resolution = resolveProjectDesignPreview(
              blueprint.design,
              rawTarget.pageId,
              rawTarget.scenarioId as string | undefined,
            );
            if (resolution.status !== "ready")
              return {
                text: JSON.stringify(resolution),
                isError: true,
                structuredContent: resolution,
              };
            const resolved = resolution.target;
            if (rawTarget.route !== undefined) {
              const page = blueprint.design.pages.find(
                (page) => page.id === rawTarget.pageId,
              );
              if (
                rawTarget.route !== page?.route &&
                rawTarget.route !== resolved.route
              )
                return "Error: legacy route does not match the resolved page target.";
            }
            target = resolved;
          }
          return capturePreviewEvidence({
            conversationId: generatorConversationId,
            files: currentFiles,
            template: conversation.template,
            previewMode: conversation.previewMode ?? "sandpack",
            viewports:
              (args as { viewports?: import("../types").PreviewView[] })
                .viewports ?? [],
            target,
            scope: (
              args as {
                scope?: import("../lib/design/preview-runtime").PreviewCaptureScope;
              }
            ).scope,
            signal: context.signal,
          });
        },
        designDiagnostics: async (name, args, context) => {
          if (
            !context ||
            context.run.conversationId !== generatorConversationId ||
            !isCurrentCandidate()
          ) {
            throw new DOMException("conversation switched", "AbortError");
          }
          const conversation =
            useConversationStore.getState().conversations[
              generatorConversationId
            ];
          if (!conversation) {
            throw new DOMException("conversation switched", "AbortError");
          }
          const { executeDesignDiagnostic } =
            await import("../lib/design/diagnostics");
          return executeDesignDiagnostic(
            name as import("../lib/design/diagnostics").DesignDiagnosticToolName,
            args,
            {
              conversationId: generatorConversationId,
              files: candidate?.getFiles() ?? conversation.files,
              beforeFiles: designRunInitialFilesRef.current,
              template: conversation.template,
              previewMode: conversation.previewMode ?? "sandpack",
              designState: conversation.designState,
              contract:
                designRunRef.current?.context(
                  generatorRef.current?.getFiles(),
                ) ?? null,
              history: conversation.messages,
              signal: context.signal,
            },
          );
        },
        onDesignReviewSubmitted: (report) => {
          if (!isCurrentCandidate()) return;
          useDesignReviewStore.getState().complete(report);
        },
        getDesignHealthContext: () => {
          if (activeToolProfileRef.current !== "design") return undefined;
          const current =
            useConversationStore.getState().conversations[
              generatorConversationId
            ];
          return {
            designState: current?.designState,
            contract:
              designRunRef.current?.context(generatorRef.current?.getFiles()) ??
              null,
            beforeFiles: designRunInitialFilesRef.current,
          };
        },
        filesBridge: {
          getFiles: () =>
            isCurrentCandidate() ? (candidate?.getFiles() ?? {}) : {},
          onFilesChanged: (newFiles, changes) => {
            if (!isCurrentCandidate())
              throw new DOMException("conversation switched", "AbortError");
            if (designRunRef.current) {
              newFiles = designRunRef.current.prepareCommit(
                candidate?.getFiles() ?? {},
                newFiles,
                crypto.randomUUID(),
              );
            }
            candidate?.setFiles(newFiles);
            setFiles(newFiles);
            const depsChanged = changes.some(
              (c) =>
                c.path === "package.json" || c.path.endsWith("/package.json"),
            );
            if (depsChanged) restartSandpack();
          },
        },
        onProjectDesignUpdated: (nextFiles) => {
          if (isCurrentCandidate()) designRunRef.current?.context(nextFiles);
        },
      });

      const combinedToolHandlerWithMcp: typeof combinedToolHandler = async (
        name,
        args,
        context,
      ) => {
        const mcpRuntime = mcpRuntimeRef.current;
        if (mcpRuntime?.aliases.has(name)) {
          return mcpRuntime.handler(name, args, context);
        }
        return combinedToolHandler(name, args, context);
      };

      const dispatchSubagent = runtime.createSubagentDispatcher({
        getApiConfig: () => ({
          apiType: currentApiType,
          apiBaseUrl: currentApiBaseUrl,
          apiKey: currentApiKey,
          model: currentModel,
        }),
        getCustomToolSet: () =>
          generatorRef.current?.getCustomToolSet() ?? customToolSet,
        getCombinedToolHandler: () => combinedToolHandlerWithMcp,
        getCustomSystemPrompt: () => customSystemPromptRef.current,
        getForcedSkillsPrompt: () => forcedSkillsPromptRef.current,
        getSkillContextSnapshot: () =>
          generatorRef.current?.getSkillContext().snapshot() ?? null,
        getAdditionalToolNames: () =>
          mcpRuntimeRef.current?.subagentToolNames ?? new Set(),
        getAdditionalToolAnnotations: () =>
          mcpRuntimeRef.current?.annotations ?? new Map(),
        createGenerator: isLocalRuntime
          ? async (options, events) => {
              const { createLocalAgentGenerator } =
                await import("../lib/local-agent/generator");
              return createLocalAgentGenerator(
                localAgentClientConfig(settings.localAgent, {
                  nativeSearch: false,
                  conversationId: options.conversationId,
                }),
                events,
                options.initialFiles,
                options.customTools,
                options.customToolHandler,
                {
                  conversationId: options.conversationId,
                  tools: options.tools,
                  executionMode: options.executionMode,
                  runtimePlatform: options.runtimePlatform,
                  allowedMcpAliases: options.allowedMcpAliases,
                  localToolAnnotations: options.localToolAnnotations,
                  initialSkillContext: options.initialSkillContext,
                  subagentWritePaths: options.subagentWritePaths,
                  authorizeToolCall: options.authorizeToolCall,
                  systemPrompt: options.systemPrompt,
                  maxIterations: options.maxIterations,
                },
              );
            }
          : undefined,
      });

      const initialWorkspace = getConversationWorkspaceContext(
        generatorConversationId,
      );
      const initialTools = runtime.buildToolSet({
        custom: customToolSet,
        planMode: initialWorkspace.mode === "plan",
        mode: initialWorkspace.mode,
        profile: initialWorkspace.profile,
        runtimePlatform,
        providerOwnedNames: new Set(providerToolNames),
      });

      const initialFiles =
        (generatorConversationId &&
          useConversationStore.getState().conversations[generatorConversationId]
            ?.files) ||
        {};

      outputSchedulerRef.current?.clear();
      outputSchedulerRef.current = createAdaptiveOutputScheduler({
        isCurrent: isCurrentCandidate,
        append: (output) =>
          setMessages((previous) =>
            appendBufferedAssistantOutput(previous, output),
          ),
      });
      const generatorEvents = {
        onText: (delta) => {
          if (!isCurrentCandidate()) return;
          setRuntimeWaitMessage(null);
          setRunState("streaming");
          setIsThinkingStreaming(false);
          flushThinkingBuffer();
          outputSchedulerRef.current?.push("text", delta);
        },
        onThinking: (delta) => {
          if (!isCurrentCandidate()) return;
          setRuntimeWaitMessage(null);
          setRunState("streaming");
          setIsThinkingStreaming(true);
          outputSchedulerRef.current?.push("thinking", delta);
        },
        onToolCall: (name, id) => {
          if (!isCurrentCandidate()) return;
          setRuntimeWaitMessage(null);
          setIsThinkingStreaming(false);
          setRunState(
            name === "ask_user_question"
              ? "waitingUser"
              : name === "exit_plan_mode"
                ? "awaitingPlanApproval"
                : "executingTool",
          );
          flushOutputBuffers();

          const actualId =
            id || `call_${Math.random().toString(36).substring(2, 11)}`;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            const newToolCall = {
              id: actualId,
              type: "function" as const,
              function: { name, arguments: "" },
            };
            if (last?.role === "assistant") {
              if (last.tool_calls?.some((tc) => tc.id === actualId))
                return prev;
              return [
                ...prev.slice(0, -1),
                {
                  ...last,
                  tool_calls: [...(last.tool_calls || []), newToolCall],
                },
              ];
            }
            return [
              ...prev,
              {
                role: "assistant" as const,
                content: null,
                tool_calls: [newToolCall],
              },
            ];
          });
        },
        onToolResult: (_name, _args, result, _toolCallId, output) => {
          if (!isCurrentCandidate()) return;
          const persistedArguments = serializeToolArgumentsForHistory(
            _name,
            _args,
          );
          const persistedResult = sanitizeToolResultForHistory(
            _name,
            _args,
            result,
          );
          const persistedOutput = sanitizeToolExecutionOutputForHistory(
            _name,
            _args,
            output,
          );
          setMessages((prev) => {
            const msgs = [...prev];
            const target = findPendingToolCall(msgs, _toolCallId);
            if (target) {
              const { messageIndex, toolCallIndex } = target;
              const toolCall = msgs[messageIndex].tool_calls![toolCallIndex];
              const updatedToolCalls = [...msgs[messageIndex].tool_calls!];
              updatedToolCalls[toolCallIndex] = {
                ...toolCall,
                function: {
                  ...toolCall.function,
                  arguments: persistedArguments,
                },
              };
              msgs[messageIndex] = {
                ...msgs[messageIndex],
                tool_calls: updatedToolCalls,
              };
              return [
                ...msgs,
                {
                  role: "tool",
                  content: persistedResult,
                  tool_call_id: toolCall.id,
                  ...(persistedOutput ? { toolOutput: persistedOutput } : {}),
                },
              ];
            }
            console.warn("Couldn't find matching tool call for result:", _name);
            return prev;
          });
        },
        onFileChange: (newFiles) => {
          if (!isCurrentCandidate()) return;
          setFiles(newFiles);
        },
        onTemplateChange: (tmpl, newFiles) => {
          if (!isCurrentCandidate()) return;
          setTemplate(tmpl);
          setFiles(newFiles);
          restartSandpack();
        },
        onDependenciesChange: (newFiles) => {
          if (!isCurrentCandidate()) return;
          setFiles(newFiles);
          restartSandpack();
        },
        onComplete: (result) => {
          if (!isCurrentCandidate()) return;
          const pending =
            useConversationStore.getState().conversations[
              generatorConversationId
            ]?.pendingUserInstructions ?? [];
          if (
            pending.some(
              (item) =>
                item.runId === logicalRunIdRef.current &&
                (item.status === "queued" || item.status === "delivering"),
            )
          ) {
            flushOutputBuffers();
            setRuntimeWaitMessage(null);
            setRunState("preparing");
            return;
          }
          setIsThinkingStreaming(false);
          setRunState(
            result.aborted || result.maxIterationsReached
              ? "idle"
              : "completed",
          );
          flushOutputBuffers();
          if (result.maxIterationsReached) {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: getT().message.toolBudgetReached },
            ]);
          }
          if (activeToolProfileRef.current !== "design_review") {
            createSnapshotForCurrentState();
          }
        },
        onError: (error) => {
          if (!isCurrentCandidate()) return;
          flushOutputBuffers();
          setIsThinkingStreaming(false);
          setLastError(classifyGenerationError(error));
          setRunState("error");
          console.error("Generation error:", error);
        },
        onLocalCliPrepared: (provider, metadata) => {
          useSettingsStore
            .getState()
            .mergeLocalCliPreparedMetadata(provider, metadata);
        },
        onLocalCliStatus: (status) => {
          if (!isCurrentCandidate()) return;
          const fallbackNotice = getT().subagent.messageOutputNotice;
          setRuntimeWaitMessage((previous) =>
            status.message === LOCAL_CLI_IDLE_MESSAGE
              ? getT().subagent.waitingForResponse
              : status.message === LOCAL_CLI_MESSAGE_OUTPUT_NOTICE
                ? fallbackNotice
                : previous === fallbackNotice
                  ? previous
                  : null,
          );
          setRunState(runStateForLocalCliStatus(status.state));
        },
        onRetry: (attempt, maxAttempts, error) => {
          if (!isCurrentCandidate()) return;
          setIsThinkingStreaming(false);
          clearOutputBuffers();
          console.warn(
            `Retrying API request (${attempt}/${maxAttempts}):`,
            error.message,
          );
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              return prev.slice(0, -1);
            }
            return prev;
          });
        },
        onCompact: async () => {
          const compactEpoch = generationRunEpochRef.current;
          if (!isCurrentCandidate()) return null;
          const s = useConversationStore.getState();
          const conv = generatorConversationId
            ? s.conversations[generatorConversationId]
            : null;
          if (!conv) return null;

          const result = await runtime.runCompress(
            {
              apiType: settings.apiType,
              apiBaseUrl: settings.apiBaseUrl,
              apiKey: settings.apiKey,
              model: settings.model,
            },
            conv,
            isLocalRuntime ? generateLocalUtilityText : undefined,
            () =>
              isCurrentCandidate() &&
              compactEpoch === generationRunEpochRef.current,
          );
          if (!isCurrentCandidate()) return null;
          if (!result || compactEpoch !== generationRunEpochRef.current)
            return null;
          return getMessagesForAPI({ ...conv, compressedContext: result });
        },
      } satisfies GeneratorEvents;
      const projectPermissionSession = createHostProjectPermissionSession({
        conversationId: generatorConversationId,
        platform: runtimePlatform,
        runtime: isLocalRuntime ? "local_cli" : "api",
        bypassEnabled: permissionBrokerBypassEnabled,
      });
      const generatorExtras = {
        getCurrentProjectFiles: () => {
          flushPendingSandpackFileChanges(generatorConversationId);
          return (
            useConversationStore.getState().conversations[
              generatorConversationId
            ]?.files ?? {}
          );
        },
        commitDelegatedProjectFiles: (expected, next) => {
          flushPendingSandpackFileChanges(generatorConversationId);
          const state = useConversationStore.getState();
          if (
            !isCurrentCandidate() ||
            state.conversations[generatorConversationId]?.files !== expected
          )
            return false;
          state.setFilesForConversation(generatorConversationId, next);
          const committed =
            useConversationStore.getState().conversations[
              generatorConversationId
            ]?.files;
          return (
            !!committed &&
            Object.keys(committed).length === Object.keys(next).length &&
            Object.entries(next).every(
              ([path, content]) => committed[path] === content,
            )
          );
        },
        userInstructions: { prepare: prepareUserInstructions },
        conversationId: generatorConversationId,
        tools: initialTools,
        askUserQuestion: (toolCallId, questions) => {
          if (!isCurrentCandidate()) {
            return Promise.reject(
              new DOMException("conversation switched", "AbortError"),
            );
          }
          return useInteractiveStore.getState().askQuestion({
            toolCallId,
            questions,
          });
        },
        requestPlanApproval: (toolCallId, plan) => {
          if (!isCurrentCandidate()) {
            return Promise.reject(
              new DOMException("conversation switched", "AbortError"),
            );
          }
          return useInteractiveStore.getState().askPlanApproval({
            toolCallId,
            plan,
          });
        },
        onPlanApproved: async () => {
          const approvalEpoch = generationRunEpochRef.current;
          if (!isCurrentCandidate()) return;
          const returnMode = useConversationStore
            .getState()
            .returnFromPlan(generatorConversationId);
          const profile: ToolProfile =
            returnMode === "design" ? "design" : "default";
          // Bind the approved continuation to the same profile used to build
          // its replacement tool set, even if the workspace selector changes
          // while MCP preparation is in flight.
          activeToolProfileRef.current = profile;
          candidate?.setReadOnlyMode(false);
          candidate?.setExecutionMode("chat");
          const mcpRuntime = await runtime.mcpManager.prepareRuntime();
          if (
            !isCurrentCandidate() ||
            approvalEpoch !== generationRunEpochRef.current
          )
            return;
          mcpRuntimeRef.current = mcpRuntime;
          candidate?.setLocalToolAnnotations?.(mcpRuntime.annotations);
          const custom = {
            ...baseCustomToolSetRef.current,
            ...mcpRuntime.tools,
          };
          candidate?.setCustomToolSet(custom);
          candidate?.setAllowedMcpAliases(new Set(mcpRuntime.aliases.keys()));
          candidate?.setUntrustedReferenceContext(mcpRuntime.instructions);
          systemPromptSuffixRef.current =
            runtime.buildMemoryPromptSection(
              useMemoryStore.getState().getAll(),
            ) + requestPromptContextRef.current;
          candidate?.setSystemPromptSuffix(systemPromptSuffixRef.current);
          return runtime.buildToolSet({
            custom,
            planMode: false,
            mode: "chat",
            profile,
            runtimePlatform,
            allowedDynamicNames: new Set(mcpRuntime.aliases.keys()),
            providerOwnedNames: new Set(providerToolNames),
          });
        },
        dispatchSubagent: async (...args) => {
          if (!isCurrentCandidate()) {
            throw new DOMException("conversation switched", "AbortError");
          }
          return dispatchSubagent(...args);
        },
        prepareInitializedProject: async (initializedFiles, context) => {
          if (
            activeToolProfileRef.current !== "design" ||
            !generatorConversationId
          ) {
            return;
          }
          if (context.signal.aborted || !isCurrentCandidate()) {
            throw new DOMException("conversation switched", "AbortError");
          }
          const selectedAtStart =
            useConversationStore.getState().conversations[
              generatorConversationId
            ]?.designState?.selectedSystem;
          if (!selectedAtStart || selectedAtStart.source === "legacy") return;

          const { prepareInitializedDesignSystem } =
            await import("../lib/design-systems/application");
          const prepared = await prepareInitializedDesignSystem(
            {
              conversationId: generatorConversationId,
              initializedFiles,
              expectedReference: selectedAtStart,
              requireSelected: true,
              signal: context.signal,
            },
            {
              conversation: {
                read: (conversationId) => {
                  const state = useConversationStore.getState();
                  const conversation = state.conversations[conversationId];
                  if (!conversation) return undefined;
                  return {
                    conversationId,
                    revision: conversation,
                    isCurrent:
                      state.activeId === conversationId && isCurrentCandidate(),
                    files: conversation.files,
                    designState: conversation.designState,
                  };
                },
              },
            },
          );

          return {
            files: prepared.files,
            changes: [...prepared.changes],
            resultNote: prepared.resultNote,
            validateBeforeCommit: () => {
              const state = useConversationStore.getState();
              const current = state.conversations[generatorConversationId];
              if (
                state.activeId !== generatorConversationId ||
                current !== prepared.expectedRevision
              ) {
                throw new DOMException("conversation switched", "AbortError");
              }
            },
            onCommitted: () => {
              const state = useConversationStore.getState();
              state.setDesignStateForConversation(
                generatorConversationId,
                prepared.designState,
              );
            },
          };
        },
        authorizeToolCall: (name, args, context) => {
          const currentRun = candidate?.getRunContext();
          if (
            context.signal.aborted ||
            generatorRef.current !== candidate ||
            !isCurrentCandidate() ||
            !currentRun ||
            currentRun.runId !== context.run.runId
          ) {
            return `Tool "${name}" belongs to a generation run that is no longer current.`;
          }
          // Authorization follows the profile used to compile this run's
          // immutable tool authority. A workspace selector change cannot
          // loosen an already-running Design request.
          if (activeToolProfileRef.current !== "design") return;
          return designRunRef.current?.authorize(
            name,
            args,
            candidate?.getFiles() ?? {},
          );
        },
        prepareProjectCommit: (before, proposed, operationId) => {
          if (!isCurrentCandidate())
            throw new DOMException("conversation switched", "AbortError");
          return (
            designRunRef.current?.prepareCommit(
              before,
              proposed,
              operationId,
            ) ?? proposed
          );
        },
        projectPermissionSession,
        onProjectPermissionAuthorityChange: () =>
          publishProjectPermissionAuthority(
            generatorConversationId,
            projectPermissionSession,
          ),
        onProjectPermissionRequestFinished: (callId, error) =>
          useProjectPermissionStore.getState().finishRequest(callId, error),
        runtimePlatform,
      } satisfies Pick<
        import("../lib/ai/generator").GeneratorOptions,
        | "conversationId"
        | "tools"
        | "askUserQuestion"
        | "requestPlanApproval"
        | "onPlanApproved"
        | "dispatchSubagent"
        | "prepareInitializedProject"
        | "prepareProjectCommit"
        | "authorizeToolCall"
        | "userInstructions"
        | "getCurrentProjectFiles"
        | "commitDelegatedProjectFiles"
        | "projectPermissionSession"
        | "onProjectPermissionAuthorityChange"
        | "onProjectPermissionRequestFinished"
        | "runtimePlatform"
      >;

      if (isLocalRuntime) {
        if (!generatorConversationId) {
          throw new Error("The active conversation is unavailable.");
        }
        const { createLocalAgentGenerator } =
          await import("../lib/local-agent/generator");
        candidate = createLocalAgentGenerator(
          localAgentClientConfig(settings.localAgent, {
            nativeSearch:
              recoveringRunRef.current?.request.nativeSearch ??
              webSearchSettings.engine === "builtin",
            ...(recoveringRunRef.current
              ? {
                  model: recoveringRunRef.current.request.model,
                  effort: recoveringRunRef.current.request.effort,
                }
              : {}),
            conversationId: generatorConversationId,
            getConversation: () =>
              useConversationStore.getState().conversations[
                generatorConversationId
              ] ?? null,
            getRecoveryAppState: () => ({
              logicalRunId: logicalRunIdRef.current,
              profile: activeToolProfileRef.current,
              mode: candidate?.getRunContext().mode ?? "chat",
              forcedSkillIds: foregroundForcedSkillIdsRef.current,
              customSystemPrompt: customSystemPromptRef.current,
              expectedChangeModes: designRunExpectedChangeModesRef.current,
              designContract:
                designRunRef.current?.context(
                  generatorRef.current?.getFiles(),
                ) ?? null,
              uiBaselineIds:
                useConversationStore
                  .getState()
                  .conversations[generatorConversationId]?.messages.map(
                    (message) => message.id,
                  ) ?? [],
            }),
            flushRecoveryState: async () => {
              flushOutputBuffers();
              await flushConversationPersistence();
            },
            restoreRecoveryContext: async (context: LocalRecoveryContext) => {
              if (!isCurrentCandidate() || !candidate)
                throw new DOMException("Recovery superseded", "AbortError");
              const conversation =
                useConversationStore.getState().conversations[
                  generatorConversationId
                ];
              const ids = context.app.uiBaselineIds;
              if (
                !Array.isArray(ids) ||
                !isConversationIdentityCurrent(
                  context.identity,
                  conversation,
                ) ||
                ids.some((id, index) => conversation.messages[index]?.id !== id)
              ) {
                throw new Error(getT().settings.localCli.recoveryIncompatible);
              }
              const registry = await getSkillRegistry();
              const skills = await registry.prepareForcedSkills(
                context.skillIds,
              );
              if (
                skills.some((skill) => {
                  const original = context.skillContext?.skills.find(
                    (entry) => entry.skillId === skill.entry.id,
                  );
                  return (
                    !original ||
                    JSON.stringify([...original.allowedTools].sort()) !==
                      JSON.stringify(
                        [...(skill.entry.allowedTools ?? [])].sort(),
                      )
                  );
                })
              )
                throw new Error(getT().settings.localCli.recoveryIncompatible);
              if (!isCurrentCandidate())
                throw new DOMException("Recovery superseded", "AbortError");
              candidate.getSkillContext().clear();
              candidate
                .getSkillContext()
                .activateMany(skills.map((skill) => skill.entry));
              configureDesignRun(conversation, {
                profile: context.app.profile as ToolProfile,
                expectedChangeModes: context.app.expectedChangeModes as
                  DesignChangeMode[] | undefined,
                resume: true,
              });
              recoveryToolOutputsRef.current = new Map(
                conversation.messages
                  .filter(
                    (message) =>
                      message.role === "tool" &&
                      message.tool_call_id &&
                      message.toolOutput,
                  )
                  .map((message) => [
                    message.tool_call_id!,
                    message.toolOutput!,
                  ]),
              );
              recoveryInstructionMessagesRef.current = new Map([
                ...conversation.messages
                  .filter((message) => message.metadata?.instructionId)
                  .map(
                    (message) =>
                      [message.metadata!.instructionId!, message] as const,
                  ),
                ...(conversation.pendingUserInstructions ?? []).map(
                  (item) =>
                    [
                      item.id,
                      {
                        role: "user" as const,
                        content:
                          item.content ||
                          (item.forcedSkillIds.length
                            ? getT().chat.instructions.applySkills
                            : ""),
                        forcedSkillIds: context.app.forcedSkillIds as
                          string[] | undefined,
                        metadata: {
                          instructionId: item.id,
                          ...(item.attachments.length
                            ? { attachments: item.attachments }
                            : {}),
                        },
                      },
                    ] as const,
                ),
              ]);
              clearOutputBuffers();
              setMessages((messages) => messages.slice(0, ids.length));
            },
            getRecoveredToolOutput: (callId) =>
              recoveryToolOutputsRef.current.get(callId),
            restoreUserInstructions: (ids) => {
              if (!isCurrentCandidate())
                throw new DOMException("Recovery superseded", "AbortError");
              const messages = ids.map((id) =>
                recoveryInstructionMessagesRef.current.get(id),
              );
              if (messages.some((message) => !message))
                throw new Error(getT().settings.localCli.recoveryIncompatible);
              const restored = messages as Message[];
              setMessages((previous) => [
                ...previous,
                ...restored.filter(
                  (message) =>
                    !previous.some(
                      (existing) =>
                        existing.metadata?.instructionId ===
                        message.metadata?.instructionId,
                    ),
                ),
              ]);
              useConversationStore
                .getState()
                .setPendingUserInstructions(
                  generatorConversationId,
                  (pending) => pending.filter((item) => !ids.includes(item.id)),
                );
              return restored as import("../lib/ai/generator-types").Message[];
            },
            saveSession: (session) => {
              if (generatorRef.current !== candidate || !isCurrentCandidate()) {
                return;
              }
              useConversationStore
                .getState()
                .setLocalAgentSessionForConversation(
                  generatorConversationId,
                  localProvider,
                  session,
                );
            },
          }),
          generatorEvents,
          initialFiles,
          customToolSet,
          combinedToolHandlerWithMcp,
          generatorExtras,
        );
      } else {
        candidate = runtime.createOpenAIGenerator(
          {
            apiType: currentApiType,
            apiKey: currentApiKey,
            apiBaseUrl: currentApiBaseUrl,
            model: currentModel,
            stream: true,
            providerToolNames,
          },
          generatorEvents,
          initialFiles,
          customToolSet,
          combinedToolHandlerWithMcp,
          generatorExtras,
        );
      }

      const constructionIsCurrent = isGeneratorConstructionCurrent(
        constructionEpoch,
        generatorConstructionEpochRef.current,
        generatorConversationId,
        useConversationStore.getState().activeId,
        runConversationIdRef.current,
        sameGeneratorConfig(nextConfig, currentGeneratorConfigSnapshot()),
      );
      if (
        !constructionIsCurrent ||
        !isConversationIdentityCurrent(
          candidateIdentity,
          useConversationStore.getState().conversations[
            generatorConversationId
          ],
        ) ||
        constructionRunEpoch !== generationRunEpochRef.current
      ) {
        candidate.abort();
        return null;
      }

      baseCustomToolSetRef.current = customToolSet;
      providerToolNamesRef.current = [...providerToolNames];
      registerProjectPermissionSession(
        generatorConversationId,
        projectPermissionSession,
        () => candidate?.rotateProjectPermissionAuthority?.(),
      );
      generatorRef.current = candidate;
      generatorConfigRef.current = nextConfig;
    }

    return generatorRef.current;
  }, [
    prepareUserInstructions,
    settings,
    webSearchSettings,
    assetSearchSettings,
    permissionBrokerBypassEnabled,
    activeId,
    setMessages,
    setFiles,
    setTemplate,
    restartSandpack,
    clearOutputBuffers,
    flushThinkingBuffer,
    flushOutputBuffers,
    generateLocalUtilityText,
  ]);

  // Apply state that can change between generations: tool policy and the
  // request-scoped memory, Skill, custom-prompt, and Plan context.
  const applyDynamicGeneratorState = useCallback(
    async (
      generator: GenerationBackend,
      forcedSkillIds: readonly string[] = [],
      dynamicOptions: {
        includeMcp?: boolean;
        mode?: ExecutionMode;
        promptWorkspaceMode?: WorkspaceMode;
        profile?: ToolProfile;
        customSystemPromptSnapshot?: string;
        isCurrent?: () => boolean;
      } = {},
    ) => {
      const assertCurrent = () => {
        if (dynamicOptions.isCurrent && !dynamicOptions.isCurrent()) {
          throw new DOMException(
            "generation setup was superseded",
            "AbortError",
          );
        }
      };
      assertCurrent();
      const conversationId = generator.getRunContext().conversationId;
      const workspace = getConversationWorkspaceContext(conversationId);
      const promptWorkspaceMode =
        dynamicOptions.promptWorkspaceMode ?? workspace.promptWorkspaceMode;
      const mode = dynamicOptions.mode ?? workspace.mode;
      const profile = dynamicOptions.profile ?? workspace.profile;
      const isDesignReview = profile === "design_review";
      // Publish the run profile before the first async boundary. If a stopped
      // run later resumes setup, it cannot overwrite the profile selected by a
      // newer foreground run using the same generator instance.
      activeToolProfileRef.current = profile;
      const runtime = await loadGeneratorRuntime();
      assertCurrent();
      generator.setNativeSearchAllowed?.(mode !== "auto_qa" && !isDesignReview);
      generator.setConversationContextAllowed?.(!isDesignReview);
      const mcpRuntime = await runtime.mcpManager.prepareRuntime({
        includeMcp:
          mode === "auto_qa" || isDesignReview
            ? false
            : dynamicOptions.includeMcp,
      });
      assertCurrent();
      mcpRuntimeRef.current =
        dynamicOptions.includeMcp === false || isDesignReview
          ? null
          : mcpRuntime;
      generator.setLocalToolAnnotations?.(
        isDesignReview ? new Map() : mcpRuntime.annotations,
      );
      const customToolSet = {
        ...baseCustomToolSetRef.current,
        ...mcpRuntime.tools,
      };
      generator.setCustomToolSet(customToolSet);
      generator.setExecutionMode(mode);
      generator.setAllowedMcpAliases(
        isDesignReview
          ? new Set()
          : mode === "chat"
            ? new Set(mcpRuntime.aliases.keys())
            : mode === "plan"
              ? mcpRuntime.planModeToolNames
              : new Set(),
      );
      generator.setTools(
        runtime.buildToolSet({
          custom: customToolSet,
          planMode: mode === "plan",
          mode,
          runtimePlatform: generator.getRunContext().platform,
          allowedDynamicNames:
            mode === "chat"
              ? new Set(mcpRuntime.aliases.keys())
              : mode === "plan"
                ? mcpRuntime.planModeToolNames
                : new Set(),
          profile,
          providerOwnedNames: new Set(providerToolNamesRef.current),
        }),
      );
      if (mcpRuntime.warnings.length > 0) {
        console.warn("Some MCP servers are unavailable:", mcpRuntime.warnings);
      }
      const memorySuffix =
        mode === "chat" && !isDesignReview
          ? runtime.buildMemoryPromptSection(useMemoryStore.getState().getAll())
          : "";
      const customSystemPromptSnapshot =
        dynamicOptions.customSystemPromptSnapshot ??
        useSettingsStore.getState().system.customSystemPrompt;
      const skillContext = generator.getSkillContext();
      skillContext.clear();
      const automaticSkillIds =
        profile === "design"
          ? designRunSkillIds(designRunRef.current?.context().surface_mode)
          : [];
      let skillsSuffix = "";
      let forcedSkillsSuffix = "";
      if (
        !isDesignReview &&
        (mode === "chat" || mode === "plan") &&
        runtime.isSkillsAvailable()
      ) {
        const registry = await runtime.getSkillRegistry();
        assertCurrent();
        skillsSuffix = runtime.buildSkillsPromptSection(
          registry.getAutoEnabled(),
        );
        const explicit = await registry.prepareForcedSkills(forcedSkillIds);
        const prepared = explicit.filter(
          (skill) =>
            skill.entry.source !== "builtin" ||
            !automaticSkillIds.some((id) => id === skill.entry.id),
        );
        assertCurrent();
        skillContext.activateMany(prepared.map((skill) => skill.entry));
        forcedSkillsSuffix = runtime.buildForcedSkillsPromptSection(prepared);
      } else if (forcedSkillIds.length > 0) {
        throw new Error(
          "Forced skills cannot be loaded because skill storage is unavailable.",
        );
      }
      if (automaticSkillIds.length) {
        for (const id of automaticSkillIds) {
          const content = bundledDesignSkills[id];
          if (content) {
            forcedSkillsSuffix += `\n<host_design_skill id="${id}">\n${content}\n</host_design_skill>\n`;
            skillContext.activate({
              id,
              name: id,
              source: "builtin",
              version: "bundled",
              description: "",
              installedAt: 0,
              autoEnabled: true,
            });
          }
        }
      }
      const designState = conversationId
        ? useConversationStore.getState().conversations[conversationId]
            ?.designState
        : undefined;
      const designSystemContext =
        promptWorkspaceMode === "design"
          ? await loadDesignSystemContext(designState)
          : "";
      assertCurrent();
      const projectDesignContext =
        promptWorkspaceMode === "design" && conversationId
          ? projectDesignWorkspaceContext(
              conversationId,
              useConversationStore.getState().conversations[conversationId]
                ?.files ?? {},
            )
          : "";
      const promptSuffix = buildRunSystemPromptSuffix({
        mode,
        memory: memorySuffix,
        autoSkills: skillsSuffix,
        mandatorySkills: forcedSkillsSuffix,
        customSystemPrompt: customSystemPromptSnapshot,
        planMode: PLAN_MODE_SYSTEM_SUFFIX,
        workspaceMode: promptWorkspaceMode,
        designMode: DESIGN_MODE_SYSTEM_SUFFIX,
        designSystem: designSystemContext + projectDesignContext,
      });
      const customSystemPromptSuffix =
        mode === "chat" || mode === "plan"
          ? buildCustomSystemPromptSection(customSystemPromptSnapshot)
          : "";
      if (mode === "chat" || mode === "plan") {
        foregroundForcedSkillIdsRef.current = [...forcedSkillIds];
        foregroundCustomPromptRef.current = customSystemPromptSnapshot;
      }
      forcedSkillIdsRef.current = [...forcedSkillIds];
      forcedSkillsPromptRef.current = forcedSkillsSuffix;
      customSystemPromptRef.current = customSystemPromptSuffix;
      // Keep the exact request-start snapshot for an approved Plan's next
      // provider iteration, even if settings change while approval is pending.
      requestPromptContextRef.current =
        skillsSuffix +
        customSystemPromptSuffix +
        forcedSkillsSuffix +
        (promptWorkspaceMode === "design"
          ? DESIGN_MODE_SYSTEM_SUFFIX +
            designSystemContext +
            projectDesignContext
          : "");
      generator.setUntrustedReferenceContext(
        mode === "auto_qa" || isDesignReview ? "" : mcpRuntime.instructions,
      );
      systemPromptSuffixRef.current = promptSuffix;
      generator.setSystemPromptSuffix(promptSuffix);
      assertCurrent();
    },
    [],
  );

  const runAutomaticQa = useCallback(
    async (
      generator: GenerationBackend,
      result: GenerateResult | null,
      runConversationId: string,
      runEpoch: number,
    ) => {
      const isCurrentRun = () =>
        generationRunEpochRef.current === runEpoch &&
        isCurrentGeneratorRun(runConversationId);
      if (!isCurrentRun()) return;
      const system = useSettingsStore.getState().system;
      const conversation = runConversationId
        ? useConversationStore.getState().conversations[runConversationId]
        : undefined;
      if (
        !system.autoQaEnabled ||
        conversation?.workspaceMode === "plan" ||
        conversation?.workspaceMode === "design"
      )
        return;
      if (!result || result.aborted || result.maxIterationsReached) return;
      if (Object.keys(generator.getFiles()).length === 0) return;

      await applyDynamicGeneratorState(generator, [], {
        includeMcp: false,
        mode: "auto_qa",
        isCurrent: isCurrentRun,
      });
      if (!isCurrentRun()) return;
      setRunState("autoQa");
      useInteractiveStore.getState().rejectAllPending("automatic QA started");
      const currentMessageIndex = filterMemoryMessages(
        useConversationStore.getState().conversations[runConversationId]
          ?.messages ?? [],
      ).length;
      setMessages((prev) => [
        ...filterMemoryMessages(prev),
        {
          role: "user",
          content: AUTO_QA_PROMPT,
          metadata: { origin: "auto_qa" },
        },
      ]);
      try {
        await generator.generate(AUTO_QA_PROMPT, undefined, {
          currentMessageIndex,
        });
      } catch (err: any) {
        if (err?.name === "AbortError") throw err;
        if (!isCurrentRun()) return;
        console.error("Automatic QA failed:", err);
        appendGenerationError(
          new Error(`Automatic QA failed: ${err?.message || "Unknown error"}`),
          { retryable: false },
        );
        return false;
      }
      return true;
    },
    [
      applyDynamicGeneratorState,
      appendGenerationError,
      isCurrentGeneratorRun,
      setMessages,
    ],
  );

  const settleUserInstructions = useCallback(
    async (
      generator: GenerationBackend,
      initialResult: GenerateResult,
      conversationId: string,
      epoch: number,
      autoQa: boolean,
    ): Promise<GenerateResult> => {
      const current = () =>
        epoch === generationRunEpochRef.current &&
        generatorRef.current === generator &&
        isCurrentGeneratorRun(conversationId);
      const pending = () =>
        (
          useConversationStore.getState().conversations[conversationId]
            ?.pendingUserInstructions ?? []
        ).filter(
          (item) =>
            item.runId === logicalRunIdRef.current && item.status === "queued",
        );
      let result = initialResult;
      while (current() && !result.aborted && !result.maxIterationsReached) {
        const before = pending();
        if (before.length) {
          const workspace = getConversationWorkspaceContext(conversationId);
          if (generator.getRunContext().mode !== workspace.mode) {
            await applyDynamicGeneratorState(
              generator,
              foregroundForcedSkillIdsRef.current,
              {
                customSystemPromptSnapshot: foregroundCustomPromptRef.current,
                mode: workspace.mode,
                profile: workspace.profile,
                promptWorkspaceMode: workspace.promptWorkspaceMode,
                isCurrent: current,
              },
            );
          }
          if (!current()) return result;
          result = await generator.generate(
            "Continue the current task with the queued user updates. Preserve completed work.",
          );
          if (!current()) return result;
          // A backend that cannot consume the batch must not spin or silently replay it.
          const remaining = new Set(pending().map((item) => item.id));
          if (before.some((item) => remaining.has(item.id))) {
            const ids = new Set(before.map((item) => item.id));
            useConversationStore
              .getState()
              .setPendingUserInstructions(conversationId, (items) =>
                items.map((item) =>
                  ids.has(item.id) && item.status === "queued"
                    ? { ...item, status: "failed" }
                    : item,
                ),
              );
            return result;
          }
        }
        if (autoQa) {
          const success = await runAutomaticQa(
            generator,
            result,
            conversationId,
            epoch,
          );
          if (success === false) return result;
        }
        if (!pending().length) return result;
      }
      return result;
    },
    [applyDynamicGeneratorState, isCurrentGeneratorRun, runAutomaticQa],
  );

  const scheduleAutomaticDesignReview = useCallback(
    (
      result: GenerateResult,
      runConversationId: string,
      prompt: string,
      options: GenerateRunOptions,
    ) => {
      const conversation =
        useConversationStore.getState().conversations[runConversationId];
      const beforeFiles = designRunInitialFilesRef.current;
      const changedUiPaths = collectChangedUiPaths(beforeFiles, result.files);
      const reviewedProjectDesign = isPrototypeProject(result.files)
        ? readProjectDesign(result.files)
        : ({ status: "missing", path: PROJECT_DESIGN_PATH } as const);
      const affectedPageIds =
        reviewedProjectDesign.status === "ready"
          ? deriveImpactPages(reviewedProjectDesign.design, changedUiPaths)
          : [];
      const contract = designRunRef.current?.context(result.files) ?? null;
      if (
        options.skipAutomaticDesignReview ||
        conversation?.workspaceMode !== "design" ||
        !contract ||
        result.aborted ||
        result.maxIterationsReached
      ) {
        return;
      }
      const reviewIdentity = captureConversationIdentity(conversation);
      const reviewIsCurrent = () =>
        isConversationIdentityCurrent(
          reviewIdentity,
          useConversationStore.getState().conversations[runConversationId],
        );
      const phase = options.automaticDesignReviewPhase ?? "initial";
      if (!shouldRequestAutomaticDesignReview(changedUiPaths, phase)) return;

      const designReport = runDesignSystemAdherenceCheck({
        files: result.files,
        beforeFiles,
        changedPaths: changedUiPaths,
        designState: conversation.designState,
        contract,
      });
      const healthReport = runProjectHealthCheck(
        result.files,
        useSandpackStore.getState().consoleLogs,
        {
          includeConsole: true,
          design: {
            beforeFiles,
            changedPaths: changedUiPaths,
            designState: conversation.designState,
            contract,
          },
        },
      );
      const applied = conversation.designState?.appliedSystem;
      const requestId =
        options.automaticDesignReviewActivityId ?? crypto.randomUUID();
      pendingAutomaticCaptureIds.add(requestId);
      appendAutomaticReviewActivity(
        runConversationId,
        requestId,
        phase === "verify" ? "verifying" : "capturing",
      );
      void computeDesignReviewSourceDigest({
        files: result.files,
        designSystem: applied ?? null,
        designContract: contract,
      })
        .then((sourceDigest) => {
          if (!reviewIsCurrent()) {
            pendingAutomaticCaptureIds.delete(requestId);
            return;
          }
          if (hasNewerGenuineUserMessage(runConversationId, requestId)) {
            pendingAutomaticCaptureIds.delete(requestId);
            updateAutomaticReviewActivity(runConversationId, requestId, {
              status: "interrupted",
            });
            return;
          }
          const store = useDesignReviewStore.getState();
          const previous = store.automatic?.evidence;
          if (previous && previous.requestId !== requestId) {
            updateAutomaticReviewActivity(
              previous.conversationId,
              previous.requestId,
              { status: "interrupted" },
            );
          }
          store.requestAutomaticCapture({
            requestId,
            conversationId: runConversationId,
            sourceDigest,
            phase,
            originalRequest: options.automaticDesignOriginalRequest ?? prompt,
            contract,
            blueprintRevision:
              reviewedProjectDesign.status === "ready"
                ? reviewedProjectDesign.design.revision
                : undefined,
            affectedPageIds:
              affectedPageIds.length > 0
                ? [...affectedPageIds]
                : reviewedProjectDesign.status === "ready"
                  ? reviewedProjectDesign.design.pages.map((page) => page.id)
                  : undefined,
            appliedSystem: applied
              ? {
                  id: applied.id,
                  name: applied.name,
                  version: applied.version,
                  digest: applied.digest,
                }
              : null,
            designReport,
            healthReport,
          });
          pendingAutomaticCaptureIds.delete(requestId);
        })
        .catch(() => {
          pendingAutomaticCaptureIds.delete(requestId);
          if (!reviewIsCurrent()) return;
          updateAutomaticReviewActivity(runConversationId, requestId, {
            status: "failed",
          });
        });
    },
    [],
  );

  const recoveryHandlersRef = useRef({
    getGenerator,
    applyDynamicGeneratorState,
    configureDesignRun,
    appendGenerationError,
    clearOutputBuffers,
    flushOutputBuffers,
    isCurrentGeneratorRun,
    setIsGenerating,
  });
  recoveryHandlersRef.current = {
    getGenerator,
    applyDynamicGeneratorState,
    configureDesignRun,
    appendGenerationError,
    clearOutputBuffers,
    flushOutputBuffers,
    isCurrentGeneratorRun,
    setIsGenerating,
  };

  // A new page reconciles native ownership before it accepts another prompt.
  // No unload callback is required: the next page atomically takes the lease.
  useEffect(() => {
    if (
      !conversationHydrated ||
      !activeId ||
      settings.runtime !== "localCli" ||
      typeof window === "undefined" ||
      !("__TAURI_INTERNALS__" in window)
    )
      return;
    if (
      recoveryCheckedRef.current === activeCheckoutKey ||
      recoveryCheckingRef.current ||
      runConversationIdRef.current
    )
      return;
    const {
      getGenerator,
      applyDynamicGeneratorState,
      configureDesignRun,
      appendGenerationError,
      flushOutputBuffers,
      isCurrentGeneratorRun,
      setIsGenerating,
    } = recoveryHandlersRef.current;
    const attempt = ++recoveryAttemptRef.current;
    recoveryCheckedRef.current = activeCheckoutKey;
    recoveryCheckingRef.current = true;
    const expectedKey = activeCheckoutKey;
    const originalEpoch = generationRunEpochRef.current;
    const originalStopEpoch = recoveryStopEpochRef.current;
    let cancelled = false;
    setIsGenerating(true);
    setRunState("preparing");
    setRuntimeWaitMessage(getT().settings.localCli.recoveryChecking);
    void (async () => {
      const native = await import("../lib/local-agent/tauri");
      const runs = await native.listRecoverableLocalAgents();
      // Effect replacement (including StrictMode) is not a Stop. A stale
      // discovery must never cancel a run that the next effect now owns.
      if (cancelled) return;
      if (recoveryStopEpochRef.current !== originalStopEpoch) {
        await Promise.all(
          runs
            .filter((run) => run.request.scope.id === activeId)
            .map((run) => retireStoppedLocalRun(native, run.runId)),
        );
        return;
      }
      if (generationRunEpochRef.current !== originalEpoch) return;
      const store = useConversationStore.getState();
      const conversation = store.activeId
        ? store.conversations[store.activeId]
        : undefined;
      if (!conversation || checkoutKey(conversation) !== expectedKey) return;
      // A changed checkout must never inherit the previous branch's writes.
      const matching: LocalRecoverableRun[] = [];
      let incompatible = false;
      for (const run of runs) {
        if (
          run.request.scope.kind !== "conversation" ||
          run.request.scope.id !== conversation.id
        )
          continue;
        const same =
          run.context?.version === 1 &&
          isConversationIdentityCurrent(run.context.identity, conversation) &&
          run.request.provider === settings.localAgent.provider;
        if (same) {
          matching.push(run);
          continue;
        }
        // Retired journals from another branch are never replayed into this one.
        if (!run.terminal) await native.cancelLocalAgent(run.runId);
        // Keep unprojected terminal evidence for its original branch. It must
        // neither overwrite the selected checkout nor block a new explicit run.
        incompatible ||= !run.terminal;
      }
      const active = matching.filter((run) => !run.terminal);
      const run = active[0] ?? matching.at(-1);
      if (!run) {
        if (incompatible)
          appendGenerationError(
            new Error(getT().settings.localCli.recoveryIncompatible),
            { replaceExisting: true },
          );
        return;
      }
      if (generationRunEpochRef.current !== originalEpoch || cancelled) {
        await native.cancelLocalAgent(run.runId);
        return;
      }
      const identity = captureConversationIdentity(conversation);
      const epoch = ++generationRunEpochRef.current;
      runConversationIdRef.current = conversation.id;
      runIdentityRef.current = identity;
      prevActiveIdRef.current = expectedKey;
      logicalRunIdRef.current =
        typeof run.context.app.logicalRunId === "string"
          ? run.context.app.logicalRunId
          : crypto.randomUUID();
      recoveringRunRef.current = run;
      setRuntimeWaitMessage(getT().settings.localCli.recoveryConnecting);
      const current = () =>
        !cancelled &&
        generationRunEpochRef.current === epoch &&
        isCurrentGeneratorRun(conversation.id);
      let recoveryBackend: GenerationBackend | null = null;
      try {
        const generator = await getGenerator();
        recoveryBackend = generator;
        if (!current()) return;
        if (!generator?.recover)
          throw new Error(getT().settings.localCli.recoveryUnavailable);
        const profile = run.context.app.profile as ToolProfile;
        const mode = run.request.mode === "plan" ? "plan" : "chat";
        await applyDynamicGeneratorState(generator, run.context.skillIds, {
          mode,
          profile,
          customSystemPromptSnapshot:
            typeof run.context.app.customSystemPrompt === "string"
              ? run.context.app.customSystemPrompt
              : "",
          isCurrent: current,
        });
        if (!current()) return;
        configureDesignRun(conversation, {
          profile,
          expectedChangeModes: run.context.app.expectedChangeModes as
            DesignChangeMode[] | undefined,
          resume: true,
        });
        await generator.recover(run);
      } catch (error) {
        if (current()) {
          await native.cancelLocalAgent(run.runId);
          if (!(error instanceof Error && error.name === "AbortError"))
            appendGenerationError(error, { replaceExisting: true });
          await generatorRef.current?.acknowledgeRecovery?.();
        }
      } finally {
        if (!current() && !run.terminal)
          await native.cancelLocalAgent(run.runId);
        // Stop clears generatorRef immediately. Retain this backend long enough
        // to ACK only its observed terminal after the cancelled UI state saves.
        await recoveryBackend?.acknowledgeRecovery?.();
        if (recoveryStopEpochRef.current !== originalStopEpoch)
          await retireStoppedLocalRun(native, run.runId);
        recoveringRunRef.current = null;
        if (current()) {
          flushOutputBuffers();
          runConversationIdRef.current = null;
          setIsThinkingStreaming(false);
        }
      }
    })()
      .catch((error) => {
        if (!cancelled) {
          recoveryCheckedRef.current = null;
          appendGenerationError(
            new Error(
              error instanceof Error &&
                error.message === getT().settings.localCli.recoveryIncompatible
                ? error.message
                : getT().settings.localCli.recoveryUnavailable,
            ),
            { replaceExisting: true },
          );
        }
      })
      .finally(() => {
        if (recoveryAttemptRef.current !== attempt) return;
        recoveryCheckingRef.current = false;
        if (!cancelled) {
          setIsGenerating(false);
          setRuntimeWaitMessage(null);
          setRunState((state) =>
            state === "error" || state === "aborted" ? state : "idle",
          );
        }
      });
    return () => {
      cancelled = true;
      if (recoveryAttemptRef.current === attempt) {
        recoveryAttemptRef.current += 1;
        recoveryCheckingRef.current = false;
        recoveryCheckedRef.current = null;
      }
    };
  }, [
    conversationHydrated,
    activeId,
    activeCheckoutKey,
    settings.runtime,
    settings.localAgent.provider,
  ]);

  const continueDesignTasks = useCallback(
    async (
      generator: GenerationBackend,
      initial: GenerateResult,
      current: () => boolean,
    ) => {
      let result = initial;
      let before = designRunInitialFilesRef.current;
      while (current() && designRunRef.current) {
        const decision = designRunRef.current.finishPass(
          before,
          result.files,
          result,
        );
        if (decision.status !== "continue") {
          if (
            decision.status === "needs-information" &&
            decision.taskIds.length
          ) {
            setMessages((previous) => [
              ...previous,
              {
                role: "assistant",
                content: getT().message.designTasksPending.replace(
                  "{tasks}",
                  decision.taskIds.join(", "),
                ),
              },
            ]);
          }
          break;
        }
        before = result.files;
        result = await generator.generate(
          `${AUTOMATIC_PROTOTYPE_BATCH_PROMPT} Pending task IDs: ${decision.taskIds.join(", ")}.`,
        );
      }
      return result;
    },
    [setMessages],
  );

  const generate = useCallback(
    async (
      prompt: string,
      attachments?: Attachment[],
      options: GenerateRunOptions = {},
    ) => {
      if (runConversationIdRef.current !== null || recoveryCheckingRef.current)
        return;
      if (
        settings.runtime === "localCli" &&
        typeof window !== "undefined" &&
        "__TAURI_INTERNALS__" in window &&
        recoveryCheckedRef.current !==
          checkoutKey(
            useConversationStore.getState().conversations[
              useConversationStore.getState().activeId ?? ""
            ],
          )
      )
        return;
      const beforeRun = useConversationStore.getState();
      if (beforeRun.activeId)
        beforeRun.ensureWritableBranch(beforeRun.activeId);
      const runStartState = useConversationStore.getState();
      const runConversationId = runStartState.activeId;
      if (!runConversationId) return;
      const runStartConversation =
        runStartState.conversations[runConversationId];
      const runWorkspace = getConversationWorkspaceContext(runConversationId);
      if (
        (options.expectedConversationId !== undefined &&
          options.expectedConversationId !== runConversationId) ||
        (options.expectedProjectSource !== undefined &&
          !isDesignRepairProjectSourceCurrent(
            options.expectedProjectSource,
            runStartConversation,
          )) ||
        (options.messageOrigin === "design_auto_fix" &&
          runWorkspace.profile !== "design")
      ) {
        const activityId = options.automaticDesignReviewActivityId;
        if (activityId) {
          updateAutomaticReviewActivity(
            options.expectedConversationId ?? runConversationId,
            activityId,
            {
              status: "superseded",
              stale: true,
            },
          );
        }
        const automatic = useDesignReviewStore.getState().automatic;
        if (
          automatic?.evidence.conversationId ===
          (options.expectedConversationId ?? runConversationId)
        ) {
          useDesignReviewStore.getState().finishAutomatic("superseded");
        }
        return;
      }
      if (options.messageOrigin !== "design_auto_fix") {
        const reviewStore = useDesignReviewStore.getState();
        const pendingAutomatic = reviewStore.automatic?.evidence;
        if (pendingAutomatic) {
          updateAutomaticReviewActivity(
            pendingAutomatic.conversationId,
            pendingAutomatic.requestId,
            { status: "interrupted" },
          );
        }
        reviewStore.reset();
      }
      const runEpoch = ++generationRunEpochRef.current;
      const customSystemPromptSnapshot =
        useSettingsStore.getState().system.customSystemPrompt;
      logicalRunIdRef.current = crypto.randomUUID();
      runConversationIdRef.current = runConversationId;
      const runConversation =
        useConversationStore.getState().conversations[runConversationId];
      if (prevActiveIdRef.current !== checkoutKey(runConversation)) {
        generatorConstructionEpochRef.current += 1;
        generatorRef.current?.abort();
        generatorRef.current = null;
        generatorConfigRef.current = null;
        clearOutputBuffers();
        prevActiveIdRef.current = checkoutKey(runConversation);
      }
      runIdentityRef.current = captureConversationIdentity(runConversation);
      recoveryCheckedRef.current = checkoutKey(runConversation);
      setRuntimeWaitMessage(null);
      setRunState("preparing");
      setLastError(null);
      setIsThinkingStreaming(false);
      setIsGenerating(true);

      const content = prompt;
      const modelPrompt = formatDesignSelectionForModel(
        prompt,
        options.designSelection,
      );
      const attachmentRefs = attachments?.map(toAttachmentRef) ?? [];
      const messageMetadata =
        attachmentRefs.length > 0 ||
        options.designSelection ||
        options.designExpectedChangeModes?.length ||
        options.messageOrigin
          ? {
              ...(attachmentRefs.length > 0
                ? { attachments: attachmentRefs }
                : {}),
              ...(options.designSelection
                ? { designSelection: options.designSelection }
                : {}),
              ...(options.designExpectedChangeModes?.length
                ? {
                    designExpectedChangeModes: [
                      ...new Set(options.designExpectedChangeModes),
                    ],
                  }
                : {}),
              ...(options.messageOrigin
                ? { origin: options.messageOrigin }
                : {}),
            }
          : undefined;

      const previousConversation = runStartConversation
        ? {
            ...runStartConversation,
            messages: cancelPendingToolCalls(runStartConversation.messages),
          }
        : undefined;
      const currentMessageIndex = removeErrorMessages(
        previousConversation?.messages ?? [],
      ).length;
      const currentRequest: Message = {
        role: "user",
        content,
        forcedSkillIds: options.forcedSkillIds,
        ...(messageMetadata ? { metadata: messageMetadata } : {}),
      };
      const titleRequest =
        previousConversation?.messages.find(
          (message) => message.role === "user" && !message.metadata?.origin,
        ) ?? currentRequest;
      const shouldGenerateTitle = previousConversation?.title === DEFAULT_TITLE;
      const isCurrentRun = () =>
        generationRunEpochRef.current === runEpoch &&
        isCurrentGeneratorRun(runConversationId);

      useInteractiveStore.getState().rejectAllPending("new generation started");
      setMessages((prev) => [
        ...cancelPendingToolCalls(removeErrorMessages(prev)),
        currentRequest,
      ]);
      if (shouldGenerateTitle) {
        void triggerSmartTitle({
          conversationId: runConversationId,
          firstRequest: titleRequest,
          config: {
            apiType: settings.apiType,
            apiBaseUrl: settings.apiBaseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
          },
        });
      }

      let clearAgnesAttachments = () => {};
      try {
        designRunRef.current = null;
        await options.prepareRun?.();
        if (!isCurrentRun()) return;
        if (options.designExpectedChangeModes?.length) {
          const expectedChangeModes = [
            ...new Set(options.designExpectedChangeModes),
          ];
          useConversationStore
            .getState()
            .setMessagesForConversation(runConversationId, (messages) =>
              messages.map((message, index) =>
                index === currentMessageIndex &&
                message.role === "user" &&
                !message.metadata?.origin
                  ? {
                      ...message,
                      metadata: {
                        ...message.metadata,
                        designExpectedChangeModes: expectedChangeModes,
                      },
                    }
                  : message,
              ),
            );
        }
        const preparedConversation =
          useConversationStore.getState().conversations[runConversationId];
        configureDesignRun(preparedConversation, {
          expectedChangeModes: options.designExpectedChangeModes,
          profile: runWorkspace.profile,
        });
        const resolvedAttachments = attachments?.length
          ? await resolveAttachmentsForModel(attachments)
          : [];
        clearAgnesAttachments = registerRunAttachments(
          runConversationId,
          resolvedAttachments,
        );
        const agnesManifest = isAgnesImageToolAvailable()
          ? formatAgnesAttachmentManifest(resolvedAttachments)
          : "";
        if (!isCurrentRun()) return;
        const generator = await getGenerator();
        if (!isCurrentRun()) return;
        if (generator) {
          if (preparedConversation) {
            generator.setFiles(preparedConversation.files);
          }
          if (previousConversation) {
            generator.syncMessages(
              await getMessagesForAPI(previousConversation),
            );
          }
          if (!isCurrentRun()) return;
          await applyDynamicGeneratorState(
            generator,
            options.forcedSkillIds ?? [],
            {
              customSystemPromptSnapshot,
              promptWorkspaceMode: runWorkspace.promptWorkspaceMode,
              mode: runWorkspace.mode,
              profile: runWorkspace.profile,
              isCurrent: isCurrentRun,
            },
          );
        }
        if (!isCurrentRun()) return;
        if (generator) {
          let result = await generator.generate(
            agnesManifest ? `${modelPrompt}\n\n${agnesManifest}` : modelPrompt,
            resolvedAttachments.length ? resolvedAttachments : undefined,
            { currentMessageIndex },
          );
          result = await continueDesignTasks(generator, result, isCurrentRun);
          result = await settleUserInstructions(
            generator,
            result,
            runConversationId,
            runEpoch,
            !options.skipAutoQa,
          );
          if (!isCurrentRun()) return;
          scheduleAutomaticDesignReview(
            result,
            runConversationId,
            modelPrompt,
            options,
          );
        }
      } catch (err: any) {
        if (!isCurrentRun()) return;
        console.error("Error generating:", err);
        if (err?.name !== "AbortError") {
          appendGenerationError(err, {
            replaceExisting: true,
            ...(options.messageOrigin ? { retryable: false } : {}),
          });
          await generatorRef.current?.acknowledgeRecovery?.();
        }
      } finally {
        clearAgnesAttachments();
        if (isCurrentRun()) {
          setMessages((prev) => filterMemoryMessages(prev));
          setIsGenerating(false);
          setIsThinkingStreaming(false);
          setRunState((state) =>
            state === "error" || state === "aborted" ? state : "idle",
          );
          forcedSkillsPromptRef.current = "";
          customSystemPromptRef.current = "";
          requestPromptContextRef.current = "";
          useConversationStore
            .getState()
            .cancelUserInstructions(runConversationId);
          runConversationIdRef.current = null;
        }
      }
    },
    [
      getGenerator,
      registerRunAttachments,
      setIsGenerating,
      setMessages,
      applyDynamicGeneratorState,
      settleUserInstructions,
      continueDesignTasks,
      scheduleAutomaticDesignReview,
      appendGenerationError,
      isCurrentGeneratorRun,
      settings.apiType,
      settings.apiBaseUrl,
      settings.apiKey,
      settings.model,
      triggerSmartTitle,
    ],
  );

  const stop = useCallback(() => {
    recoveryStopEpochRef.current += 1;
    const discovered = recoveringRunRef.current;
    if (discovered)
      void import("../lib/local-agent/tauri")
        .then((native) => native.cancelLocalAgent(discovered.runId))
        .catch((error) =>
          console.error("Local CLI recovery stop failed:", error),
        );
    const stoppedConversationId = runConversationIdRef.current;
    if (stoppedConversationId)
      useConversationStore
        .getState()
        .cancelUserInstructions(stoppedConversationId);
    runAttachmentsRef.current?.clear();
    runAttachmentsRef.current = null;
    generationRunEpochRef.current += 1;
    generatorConstructionEpochRef.current += 1;
    setIsThinkingStreaming(false);
    flushOutputBuffers();
    if (stoppedConversationId)
      useConversationStore
        .getState()
        .setMessagesForConversation(stoppedConversationId, (messages) =>
          cancelPendingToolCalls(messages, "user-stopped"),
        );
    generatorRef.current?.abort();
    generatorRef.current = null;
    generatorConfigRef.current = null;
    forcedSkillsPromptRef.current = "";
    customSystemPromptRef.current = "";
    requestPromptContextRef.current = "";
    runConversationIdRef.current = null;
    activeToolProfileRef.current = "default";
    designRunRef.current = null;
    designRunInitialFilesRef.current = {};
    designRunExpectedChangeModesRef.current = undefined;
    useInteractiveStore.getState().rejectAllPending("user stopped");
    setRuntimeWaitMessage(null);
    setRunState("aborted");
    setIsGenerating(false);
    createSnapshotForCurrentState();
    useDesignReviewStore.getState().reset();
  }, [flushOutputBuffers, setIsGenerating]);

  const withdrawLastUserMessage = useCallback((): WithdrawnUserDraft | null => {
    const state = useConversationStore.getState();
    const conversationId = state.activeId;
    const conversation = conversationId
      ? state.conversations[conversationId]
      : undefined;
    const withdrawableIndex = conversation
      ? findWithdrawableUserMessageIndex(conversation.messages)
      : null;
    const lastMessage =
      withdrawableIndex === null
        ? undefined
        : conversation?.messages[withdrawableIndex];
    if (
      !conversationId ||
      !conversation ||
      lastMessage?.role !== "user" ||
      lastMessage.metadata?.origin
    ) {
      return null;
    }

    if (runConversationIdRef.current)
      useConversationStore
        .getState()
        .cancelUserInstructions(runConversationIdRef.current);
    runAttachmentsRef.current?.clear();
    runAttachmentsRef.current = null;
    generationRunEpochRef.current += 1;
    generatorConstructionEpochRef.current += 1;
    generatorRef.current?.abort();
    generatorRef.current = null;
    generatorConfigRef.current = null;
    runConversationIdRef.current = null;
    forcedSkillsPromptRef.current = "";
    customSystemPromptRef.current = "";
    requestPromptContextRef.current = "";
    baseCustomToolSetRef.current = {};
    providerToolNamesRef.current = [];
    mcpRuntimeRef.current = null;
    activeToolProfileRef.current = "default";
    designRunRef.current = null;
    designRunInitialFilesRef.current = {};
    designRunExpectedChangeModesRef.current = undefined;
    clearOutputBuffers();
    useInteractiveStore.getState().rejectAllPending("user message withdrawn");
    useSubagentStore.setState({ progress: {} });

    const removed = useConversationStore
      .getState()
      .withdrawLastUserMessage(conversationId);
    if (!removed) return null;
    const draft: WithdrawnUserDraft = {
      content: userMessageTextForDraft(removed),
      attachments: (removed.metadata?.attachments ?? []).map((attachment) => ({
        ...attachment,
      })),
      forcedSkillIds: [...(removed.forcedSkillIds ?? [])],
      ...(removed.metadata?.designSelection
        ? { designSelection: { ...removed.metadata.designSelection } }
        : {}),
    };
    const retainedMessages =
      useConversationStore.getState().conversations[conversationId]?.messages ??
      [];
    if (
      !retainedMessages.some(
        (message) => message.role === "user" && !message.metadata?.origin,
      )
    ) {
      useConversationStore
        .getState()
        .renameConversation(conversationId, DEFAULT_TITLE);
    }
    // Every provider's session fingerprint is tied to the transcript that
    // just changed, so none of them may resume.
    useConversationStore.getState().clearLocalAgentSessions(conversationId);

    setLastError(null);
    setIsThinkingStreaming(false);
    setRuntimeWaitMessage(null);
    setRunState("idle");
    setIsGenerating(false);
    return draft;
  }, [clearOutputBuffers, setIsGenerating]);

  const retry = useCallback(async () => {
    if (runConversationIdRef.current !== null || recoveryCheckingRef.current)
      return;
    if (
      settings.runtime === "localCli" &&
      typeof window !== "undefined" &&
      "__TAURI_INTERNALS__" in window &&
      recoveryCheckedRef.current !==
        checkoutKey(
          useConversationStore.getState().conversations[
            useConversationStore.getState().activeId ?? ""
          ],
        )
    )
      return;
    const beforeRetry = useConversationStore.getState();
    if (beforeRetry.activeId)
      beforeRetry.ensureWritableBranch(beforeRetry.activeId);
    const retryStartState = useConversationStore.getState();
    const runConversationId = retryStartState.activeId;
    if (!runConversationId) return;
    const retryConversation = retryStartState.conversations[runConversationId];
    const retryWorkspace = getConversationWorkspaceContext(runConversationId);
    const lastRunRequest = [...(retryConversation?.messages ?? [])]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          message.metadata?.origin !== "design_review",
      );
    if (lastRunRequest?.metadata?.origin) {
      appendGenerationError(new Error(getT().chat.automaticRetryUnavailable), {
        replaceExisting: true,
        retryable: false,
      });
      return;
    }
    const customSystemPromptSnapshot =
      useSettingsStore.getState().system.customSystemPrompt;
    logicalRunIdRef.current = crypto.randomUUID();
    runConversationIdRef.current = runConversationId;
    const runConversation =
      useConversationStore.getState().conversations[runConversationId];
    if (prevActiveIdRef.current !== checkoutKey(runConversation)) {
      generatorConstructionEpochRef.current += 1;
      generatorRef.current?.abort();
      generatorRef.current = null;
      generatorConfigRef.current = null;
      clearOutputBuffers();
      prevActiveIdRef.current = checkoutKey(runConversation);
    }
    runIdentityRef.current = captureConversationIdentity(runConversation);
    recoveryCheckedRef.current = checkoutKey(runConversation);
    const runEpoch = ++generationRunEpochRef.current;
    const isCurrentRun = () =>
      generationRunEpochRef.current === runEpoch &&
      isCurrentGeneratorRun(runConversationId);
    setRuntimeWaitMessage(null);
    setRunState("preparing");
    setLastError(null);
    setIsThinkingStreaming(false);
    setIsGenerating(true);
    setMessages((prev) => cancelPendingToolCalls(removeErrorMessages(prev)));
    let clearAgnesAttachments = () => {};
    try {
      const generator = await getGenerator();
      if (!isCurrentRun()) return;
      if (generator) {
        const storeState = useConversationStore.getState();
        const activeConv = runConversationId
          ? storeState.conversations[runConversationId]
          : null;
        if (!activeConv) return;
        generator.setFiles(activeConv.files);
        configureDesignRun(activeConv, {
          expectedChangeModes: getLastDesignExpectedChangeModes(
            activeConv.messages,
          ),
          profile: retryWorkspace.profile,
        });
        const lastRequest = [...activeConv.messages]
          .reverse()
          .find(
            (message) => message.role === "user" && !message.metadata?.origin,
          );
        const resolvedAttachments = lastRequest?.metadata?.attachments?.length
          ? await resolveAttachmentsForModel(lastRequest.metadata.attachments)
          : [];
        if (!isCurrentRun()) return;
        clearAgnesAttachments = registerRunAttachments(
          runConversationId,
          resolvedAttachments,
        );
        const manifest = isAgnesImageToolAvailable()
          ? formatAgnesAttachmentManifest(resolvedAttachments)
          : "";
        generator.syncMessages(
          appendAgnesManifestToLastUserMessage(
            await getMessagesForAPI(activeConv),
            manifest,
          ),
        );
        await applyDynamicGeneratorState(
          generator,
          getLastForcedSkillIds(activeConv.messages),
          {
            customSystemPromptSnapshot,
            promptWorkspaceMode: retryWorkspace.promptWorkspaceMode,
            mode: retryWorkspace.mode,
            profile: retryWorkspace.profile,
            isCurrent: isCurrentRun,
          },
        );
        if (!isCurrentRun()) return;
        const result = await generator.retry();
        await settleUserInstructions(
          generator,
          result,
          runConversationId,
          runEpoch,
          false,
        );
      }
    } catch (err: any) {
      if (!isCurrentRun()) return;
      console.error("Error retrying:", err);
      if (err?.name !== "AbortError") {
        appendGenerationError(err);
      }
    } finally {
      clearAgnesAttachments();
      if (isCurrentRun()) {
        setMessages((prev) => filterMemoryMessages(prev));
        setIsGenerating(false);
        setIsThinkingStreaming(false);
        setRunState((state) =>
          state === "error" || state === "aborted" ? state : "idle",
        );
        forcedSkillsPromptRef.current = "";
        customSystemPromptRef.current = "";
        requestPromptContextRef.current = "";
        useConversationStore
          .getState()
          .cancelUserInstructions(runConversationId);
        runConversationIdRef.current = null;
      }
    }
  }, [
    getGenerator,
    registerRunAttachments,
    settleUserInstructions,
    setIsGenerating,
    setMessages,
    applyDynamicGeneratorState,
    appendGenerationError,
    configureDesignRun,
    isCurrentGeneratorRun,
  ]);

  const review = useCallback(async () => {
    await generate(
      "Please review all project files for security vulnerabilities. Use list_files and read_files to examine the code. Report any security issues found with severity and location, or confirm no issues were detected. If issues are found, ask if I should fix them automatically.",
      undefined,
      { skipAutoQa: true },
    );
  }, [generate]);

  const healthCheck = useCallback(async () => {
    await generate(
      "Run project_health_check with include_console=true. Summarize the health report by severity, explain the highest-impact issues first, and fix obvious project-breaking errors if they are safe to fix.",
      undefined,
      { skipAutoQa: true },
    );
  }, [generate]);

  const designReview = useCallback(
    async (
      screenshots: readonly DesignReviewScreenshot[],
      options?: {
        automaticEvidence?: AutomaticDesignReviewEvidence;
        captureErrors?: readonly string[];
        retryOf?: string;
      },
    ) => {
      const runConversationId =
        options?.automaticEvidence?.conversationId ??
        useConversationStore.getState().activeId;
      const conversation = runConversationId
        ? useConversationStore.getState().conversations[runConversationId]
        : undefined;
      if (!runConversationId || !conversation) {
        useDesignReviewStore.getState().fail("No active Design project.");
        return null;
      }
      if (conversation.workspaceMode !== "design") {
        useDesignReviewStore
          .getState()
          .fail("Design Review is available only in Design mode.");
        return null;
      }
      const reviewIdentity = captureConversationIdentity(conversation);
      const reviewIsCurrent = () =>
        isConversationIdentityCurrent(
          reviewIdentity,
          useConversationStore.getState().conversations[runConversationId],
        );
      try {
        // Capture the UI language before any async digest or queue work so a
        // run/retry keeps one consistent report language.
        const locale = getResolvedLocale();
        validateDesignReviewScreenshots(screenshots);
        const contract =
          options?.automaticEvidence?.contract ??
          designRunRef.current?.context(generatorRef.current?.getFiles()) ??
          null;
        const files = { ...conversation.files };
        const reviewedBlueprint = readProjectDesign(files);
        const [sourceDigest, sourceProjectDigest] = await Promise.all([
          computeDesignReviewSourceDigest({
            files,
            designSystem: conversation.designState?.appliedSystem ?? null,
            designContract: contract,
          }),
          computeDesignReviewSourceDigest({
            files,
            designSystem: conversation.designState?.appliedSystem ?? null,
            designContract: null,
          }),
        ]);
        if (!reviewIsCurrent()) return null;
        const provider: DesignReviewJobInput["provider"] =
          settings.runtime === "localCli"
            ? {
                runtime: "local",
                config: {
                  provider: settings.localAgent.provider,
                  model:
                    settings.localAgent.preferences[
                      settings.localAgent.provider
                    ].model,
                  effort:
                    settings.localAgent.preferences[
                      settings.localAgent.provider
                    ].effort,
                },
              }
            : {
                runtime: "api",
                config: {
                  apiType: settings.apiType,
                  apiBaseUrl: settings.apiBaseUrl,
                  apiKey: settings.apiKey,
                  model: settings.model,
                },
              };
        const input: DesignReviewJobInput = {
          conversationId: runConversationId,
          kind: options?.automaticEvidence ? "automatic" : "manual",
          locale,
          phase: options?.automaticEvidence?.phase ?? "initial",
          sourceDigest,
          sourceProjectDigest,
          blueprintRevision:
            reviewedBlueprint.status === "ready"
              ? reviewedBlueprint.design.revision
              : undefined,
          files,
          screenshots,
          expectedCoverage: expectedPrototypeReviewCoverage(
            files,
            options?.automaticEvidence?.affectedPageIds,
          ),
          provider,
          requirementsMessages: [...conversation.messages],
          automaticEvidence: options?.automaticEvidence,
          captureErrors:
            options?.captureErrors ??
            useDesignReviewStore.getState().captureErrors,
        };
        const { designReviewJobRunner } =
          await import("../lib/design/review-jobs/runner");
        if (!reviewIsCurrent()) return null;
        const run = options?.retryOf
          ? designReviewJobRunner.retry(options.retryOf, input)
          : designReviewJobRunner.start(input);
        reviewBranchIdentities.set(
          reviewIdentityKey(runConversationId, run.id),
          reviewIdentity,
        );
        reviewContractByRunIdRef.current.set(run.id, contract);
        useDesignReviewStore.getState().selectRun(runConversationId, run.id);
        if (options?.automaticEvidence) {
          updateAutomaticReviewActivity(
            runConversationId,
            options.automaticEvidence.requestId,
            {
              status:
                options.automaticEvidence.phase === "verify"
                  ? "verifying"
                  : "queued",
            },
            run.id,
          );
        }
        return run;
      } catch (error) {
        if (!reviewIsCurrent()) return null;
        const message = error instanceof Error ? error.message : String(error);
        useDesignReviewStore.getState().fail(message);
        if (options?.automaticEvidence) {
          updateAutomaticReviewActivity(
            runConversationId,
            options.automaticEvidence.requestId,
            { status: "failed" },
          );
        }
        return null;
      }
    },
    [
      settings.apiBaseUrl,
      settings.apiKey,
      settings.apiType,
      settings.localAgent.preferences,
      settings.localAgent.provider,
      settings.model,
      settings.runtime,
    ],
  );

  const automaticDesignReview = useCallback(
    async (
      screenshots: readonly DesignReviewScreenshot[],
      evidence: AutomaticDesignReviewEvidence,
      captureErrors: readonly string[] = [],
    ) => {
      const conversation =
        useConversationStore.getState().conversations[evidence.conversationId];
      if (!conversation) {
        updateAutomaticReviewActivity(
          evidence.conversationId,
          evidence.requestId,
          { status: "superseded", stale: true },
        );
        if (
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId
        ) {
          useDesignReviewStore.getState().finishAutomatic("superseded");
        }
        return;
      }

      const reviewIdentity = captureConversationIdentity(conversation);
      const reviewIsCurrent = () =>
        isConversationIdentityCurrent(
          reviewIdentity,
          useConversationStore.getState().conversations[
            evidence.conversationId
          ],
        );
      const runtimeSnapshots = screenshots.flatMap((screenshot) =>
        screenshot.semanticSnapshot ? [screenshot.semanticSnapshot] : [],
      );
      const runtimeReport = runDesignSystemAdherenceCheck({
        files: conversation.files,
        beforeFiles: conversation.files,
        changedPaths: [],
        designState: conversation.designState,
        contract: evidence.contract,
        runtimeSnapshots,
      });
      const issueKey = (issue: {
        code: string;
        path?: string;
        viewport?: string;
        message: string;
      }) =>
        [
          issue.code,
          issue.path ?? "",
          issue.viewport ?? "",
          issue.message,
        ].join("\u0000");
      const mergedIssues = [...evidence.designReport.issues];
      const knownIssues = new Set(mergedIssues.map(issueKey));
      for (const issue of runtimeReport.issues) {
        const key = issueKey(issue);
        if (!knownIssues.has(key)) {
          knownIssues.add(key);
          mergedIssues.push(issue);
        }
      }
      const errors = mergedIssues.filter(
        (issue) => issue.severity === "error",
      ).length;
      const enrichedEvidence: AutomaticDesignReviewEvidence = {
        ...evidence,
        captureErrors: [...captureErrors],
        designReport: {
          ...runtimeReport,
          ok: errors === 0 && mergedIssues.length === 0,
          issues: mergedIssues,
          changedUiPaths: evidence.designReport.changedUiPaths,
          summary: {
            errors,
            warnings: mergedIssues.length - errors,
            totalIssues: mergedIssues.length,
          },
        },
      };

      const activeRun = (
        useDesignReviewStore.getState().runsByConversation[
          evidence.conversationId
        ] ?? []
      ).find(isDesignReviewRunActive);
      if (activeRun) {
        if (
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId
        ) {
          useDesignReviewStore.getState().setAutomaticStage("deferred");
        }
        updateAutomaticReviewActivity(
          evidence.conversationId,
          evidence.requestId,
          { status: "deferred" },
        );
        await waitForDesignReviewRun(activeRun.id);
        if (!reviewIsCurrent()) return;
        const resumedConversation =
          useConversationStore.getState().conversations[
            evidence.conversationId
          ];
        const resumedProjectSource = resumedConversation
          ? captureDesignRepairProjectSource(resumedConversation)
          : null;
        const resumedDigest = resumedConversation
          ? await computeDesignReviewSourceDigest({
              files: resumedConversation.files,
              designSystem:
                resumedConversation.designState?.appliedSystem ?? null,
              designContract: evidence.contract,
            })
          : null;
        if (!reviewIsCurrent()) return;
        const resumedState = useConversationStore.getState();
        const currentAutomatic =
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId;
        const resumedProjectIsCurrent =
          resumedProjectSource !== null &&
          isDesignRepairProjectSourceCurrent(
            resumedProjectSource,
            resumedState.conversations[evidence.conversationId],
          );
        if (
          !currentAutomatic ||
          !evidence.sourceDigest ||
          resumedDigest !== evidence.sourceDigest ||
          !resumedProjectIsCurrent ||
          resumedConversation?.workspaceMode !== "design" ||
          hasNewerGenuineUserMessage(
            evidence.conversationId,
            evidence.requestId,
          )
        ) {
          updateAutomaticReviewActivity(
            evidence.conversationId,
            evidence.requestId,
            {
              status: "superseded",
              stale: resumedDigest !== evidence.sourceDigest,
            },
          );
          if (currentAutomatic) {
            useDesignReviewStore.getState().finishAutomatic("superseded");
          }
          return;
        }
        updateAutomaticReviewActivity(
          evidence.conversationId,
          evidence.requestId,
          { status: "queued" },
        );
      }

      useDesignReviewStore.getState().setAutomaticStage("reviewing");
      const startedRun = await designReview(screenshots, {
        automaticEvidence: enrichedEvidence,
        captureErrors,
      });
      if (!reviewIsCurrent()) return;
      if (!startedRun) {
        if (
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId
        ) {
          useDesignReviewStore
            .getState()
            .failAutomatic(
              useDesignReviewStore.getState().error ??
                "Automatic Design Review could not start.",
            );
        }
        return;
      }
      const completedRun = await waitForDesignReviewRun(startedRun.id);
      if (!reviewIsCurrent()) return;
      if (!completedRun) {
        if (
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId
        ) {
          useDesignReviewStore
            .getState()
            .failAutomatic("Automatic Design Review result is unavailable.");
        }
        return;
      }
      const currentConversation =
        useConversationStore.getState().conversations[evidence.conversationId];
      const currentProjectSource = currentConversation
        ? captureDesignRepairProjectSource(currentConversation)
        : null;
      const currentDigest = currentConversation
        ? await computeDesignReviewSourceDigest({
            files: currentConversation.files,
            designSystem:
              currentConversation.designState?.appliedSystem ?? null,
            designContract: evidence.contract,
          })
        : null;
      if (!reviewIsCurrent()) return;
      const postDigestState = useConversationStore.getState();
      const currentProject =
        currentProjectSource !== null &&
        isDesignRepairProjectSourceCurrent(
          currentProjectSource,
          postDigestState.conversations[evidence.conversationId],
        );
      const fresh =
        currentProject && currentDigest === completedRun.sourceDigest;
      if (currentDigest || !currentProject) {
        useDesignReviewStore
          .getState()
          .markRunFreshness(
            completedRun.id,
            currentProject ? (currentDigest ?? "") : "",
          );
      }
      updateAutomaticReviewActivity(evidence.conversationId, completedRun.id, {
        status: completedRun.status,
        findingCount: completedRun.report?.findings.length ?? 0,
        stale: !fresh,
      });
      if (completedRun.status !== "succeeded" || !completedRun.report) {
        if (
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId
        ) {
          useDesignReviewStore
            .getState()
            .failAutomatic(
              completedRun.error ??
                "Automatic Design Review did not produce a report.",
            );
        }
        return;
      }
      const report = completedRun.report;
      if (!fresh) {
        updateAutomaticReviewActivity(
          evidence.conversationId,
          completedRun.id,
          { status: "superseded", stale: true },
        );
        if (
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId
        ) {
          useDesignReviewStore.getState().finishAutomatic("superseded");
        }
        return;
      }

      if (
        useDesignReviewStore.getState().automatic?.evidence.requestId ===
        evidence.requestId
      ) {
        useDesignReviewStore
          .getState()
          .finishAutomatic(
            hasRemainingAutomaticDesignIssues(enrichedEvidence, report)
              ? "findings"
              : "clean",
          );
      }
    },
    [designReview],
  );

  const automaticDesignReviewUnavailable = useCallback(
    async (evidence: AutomaticDesignReviewEvidence, message: string) => {
      updateAutomaticReviewActivity(
        evidence.conversationId,
        evidence.requestId,
        { status: "failed" },
      );
      if (
        useDesignReviewStore.getState().automatic?.evidence.requestId ===
        evidence.requestId
      ) {
        useDesignReviewStore.getState().failAutomatic(message);
      }
    },
    [],
  );

  const continueTask = useCallback(async () => {
    if (runConversationIdRef.current !== null || recoveryCheckingRef.current)
      return;
    if (
      settings.runtime === "localCli" &&
      typeof window !== "undefined" &&
      "__TAURI_INTERNALS__" in window &&
      recoveryCheckedRef.current !==
        checkoutKey(
          useConversationStore.getState().conversations[
            useConversationStore.getState().activeId ?? ""
          ],
        )
    )
      return;
    const beforeContinue = useConversationStore.getState();
    if (beforeContinue.activeId)
      beforeContinue.ensureWritableBranch(beforeContinue.activeId);
    const continueStartState = useConversationStore.getState();
    const runConversationId = continueStartState.activeId;
    if (!runConversationId) return;
    const continueWorkspace =
      getConversationWorkspaceContext(runConversationId);
    const runEpoch = ++generationRunEpochRef.current;
    const isCurrentRun = () =>
      generationRunEpochRef.current === runEpoch &&
      isCurrentGeneratorRun(runConversationId);
    const customSystemPromptSnapshot =
      useSettingsStore.getState().system.customSystemPrompt;
    logicalRunIdRef.current = crypto.randomUUID();
    runConversationIdRef.current = runConversationId;
    const runConversation =
      useConversationStore.getState().conversations[runConversationId];
    if (prevActiveIdRef.current !== checkoutKey(runConversation)) {
      generatorConstructionEpochRef.current += 1;
      generatorRef.current?.abort();
      generatorRef.current = null;
      generatorConfigRef.current = null;
      clearOutputBuffers();
      prevActiveIdRef.current = checkoutKey(runConversation);
    }
    runIdentityRef.current = captureConversationIdentity(runConversation);
    recoveryCheckedRef.current = checkoutKey(runConversation);
    setRuntimeWaitMessage(null);
    setRunState("preparing");
    setLastError(null);
    setIsThinkingStreaming(false);
    setIsGenerating(true);
    try {
      const generator = await getGenerator();
      if (!isCurrentRun()) return;
      if (generator) {
        const storeState = useConversationStore.getState();
        const activeConv = runConversationId
          ? storeState.conversations[runConversationId]
          : null;
        if (activeConv) {
          generator.syncMessages(await getMessagesForAPI(activeConv));
          generator.setFiles(activeConv.files);
          configureDesignRun(activeConv, {
            resume: true,
            profile: continueWorkspace.profile,
          });
        }
        await applyDynamicGeneratorState(
          generator,
          getLastForcedSkillIds(activeConv?.messages ?? []),
          {
            customSystemPromptSnapshot,
            promptWorkspaceMode: continueWorkspace.promptWorkspaceMode,
            mode: continueWorkspace.mode,
            profile: continueWorkspace.profile,
            isCurrent: isCurrentRun,
          },
        );
        if (!isCurrentRun()) return;
        const continuePrompt =
          "Continue from the current design-project.json checkpoint. Do not repeat completed prototype pages, flows, or batches. Complete the next unfinished task and update the blueprint checkpoint.";
        let result = await generator.generate(continuePrompt);
        result = await continueDesignTasks(generator, result, isCurrentRun);
        result = await settleUserInstructions(
          generator,
          result,
          runConversationId,
          runEpoch,
          true,
        );
        if (!isCurrentRun()) return;
        scheduleAutomaticDesignReview(
          result,
          runConversationId,
          continuePrompt,
          {},
        );
      }
    } catch (err: any) {
      if (!isCurrentRun()) return;
      console.error("Error continuing:", err);
      if (err?.name !== "AbortError") {
        appendGenerationError(err);
      }
    } finally {
      if (isCurrentRun()) {
        setMessages((prev) => filterMemoryMessages(prev));
        setIsGenerating(false);
        setIsThinkingStreaming(false);
        setRunState((state) =>
          state === "error" || state === "aborted" ? state : "idle",
        );
        forcedSkillsPromptRef.current = "";
        customSystemPromptRef.current = "";
        requestPromptContextRef.current = "";
        useConversationStore
          .getState()
          .cancelUserInstructions(runConversationId);
        runConversationIdRef.current = null;
      }
    }
  }, [
    getGenerator,
    configureDesignRun,
    setIsGenerating,
    setMessages,
    applyDynamicGeneratorState,
    appendGenerationError,
    isCurrentGeneratorRun,
    settleUserInstructions,
    continueDesignTasks,
    scheduleAutomaticDesignReview,
  ]);

  return {
    generate,
    enqueueInstruction,
    stop,
    withdrawLastUserMessage,
    retry,
    continueTask,
    updateFiles,
    deleteFile,
    renameFile,
    moveFile,
    compressContext,
    review,
    healthCheck,
    designReview,
    automaticDesignReview,
    automaticDesignReviewUnavailable,
    invalidateGenerator,
    runState,
    lastError,
    isThinkingStreaming,
    runtimeWaitMessage,
    generateUtilityText,
    getDesignContract: () =>
      designRunRef.current?.context(generatorRef.current?.getFiles()) ?? null,
  };
}
