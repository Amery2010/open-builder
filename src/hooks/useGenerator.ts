import { useRef, useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ToolSet } from "ai";
import type {
  GenerateResult,
  GenerationBackend,
  GeneratorEvents,
} from "../lib/ai/generator";
import { DEFAULT_TITLE, useConversationStore } from "../store/conversation";
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
  isErrorMessage,
  messagesForConversationContinuation,
  removeErrorMessages,
} from "../lib/ai/conversation-context";
import { PLAN_MODE_SYSTEM_SUFFIX } from "../lib/ai/plan-mode";
import { buildRunSystemPromptSuffix } from "../lib/ai/run-system-prompt";
import { buildCustomSystemPromptSection } from "../lib/ai/custom-system-prompt";
import { appendBufferedAssistantOutput } from "../lib/utils/stream-output";
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
import { createDesignReviewLogEntry } from "../lib/design/review-jobs/logs";
import {
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
  createDesignContractController,
  type DesignBlueprintScopeBindings,
  type DesignChangeMode,
  type DesignContract,
} from "../lib/design/run-contract";
import {
  deriveImpactPages,
  getIncompleteBuildProgress,
  PROJECT_DESIGN_PATH,
  readProjectDesign,
  resolveProjectDesignPreviewTarget,
} from "../lib/design/project-design";
import type { PrototypePreviewTarget } from "../lib/design/preview-runtime";
import { isPrototypeProject } from "../lib/design/prototype-starter";
import {
  collectChangedUiPaths,
  runDesignSystemAdherenceCheck,
} from "../lib/design/adherence";
import {
  buildAutomaticDesignRepairPrompt,
  canEnterAutomaticDesignRepair,
  hasRemainingAutomaticDesignIssues,
  requiredSkillsForContract,
  selectAutomaticDesignRepairScope,
  shouldRequestAutomaticDesignReview,
  shouldRunAutomaticDesignRepair,
  type AutomaticDesignReviewEvidence,
  type AutomaticDesignReviewPhase,
} from "../lib/design/automatic-review";
import { runProjectHealthCheck } from "../lib/tools/project-health";
import { localAgentSupportsNativeSearch } from "../lib/local-agent/providers";
import { createHostProjectPermissionSession } from "../lib/security/project-permission-host";
import {
  publishProjectPermissionAuthority,
  registerProjectPermissionSession,
  useProjectPermissionStore,
} from "../store/project-permission";

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
  return hydrateMessageAttachments(messagesForConversationContinuation(conv));
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
  reusableDesignContract?: DesignContract;
  automaticDesignReviewPhase?: AutomaticDesignReviewPhase;
  automaticDesignOriginalRequest?: string;
  automaticDesignReviewActivityId?: string;
  skipAutomaticDesignReview?: boolean;
  messageOrigin?: NonNullable<Message["metadata"]>["origin"];
  /** Request-scoped preparation that must run after the optimistic message and
   * loading state are visible, but before generator setup and provider I/O. */
  prepareRun?: () => Promise<void>;
}

function designBlueprintBindings(
  files: ProjectFiles,
): DesignBlueprintScopeBindings | undefined {
  const result = readProjectDesign(files);
  if (result.status !== "ready") return undefined;
  const design = result.design;
  return {
    expectedRevision: design.revision,
    knownPageIds: design.pages.map((page) => page.id),
    knownSharedUiIds: design.sharedUiRefs.map((ref) => ref.id),
    knownSharedFilePaths: [
      ...design.layouts.flatMap((layout) => layout.filePaths),
      ...design.sharedUiRefs.flatMap((ref) => ref.filePaths),
    ],
    knownPageFilePaths: Object.fromEntries(
      design.pages.map((page) => [page.id, page.filePaths]),
    ),
  };
}

function designBlueprintRunPolicy(files: ProjectFiles) {
  if (!isPrototypeProject(files)) return {};
  const result = readProjectDesign(files);
  if (result.status === "ready") {
    return { blueprint: designBlueprintBindings(files) };
  }
  if (result.status === "invalid") {
    return { allowProjectDesignRepair: true as const };
  }
  return {};
}

function hasIncompletePrototypeBuild(files: ProjectFiles): boolean {
  if (!isPrototypeProject(files)) return false;
  const result = readProjectDesign(files);
  if (result.status !== "ready") return true;
  const progress = getIncompleteBuildProgress(result.design);
  return (
    progress.status !== "complete" ||
    progress.pageIds.length > 0 ||
    progress.flowIds.length > 0 ||
    progress.phaseIds.length > 0
  );
}

function bindReviewContractToCurrentBlueprint(
  contract: DesignContract,
  files: ProjectFiles,
  affectedPageIds?: readonly string[],
): DesignContract | null {
  const result = readProjectDesign(files);
  if (result.status !== "ready") {
    return contract.blueprint || contract.blueprint_scope ? null : contract;
  }
  const { blueprint_scope: _legacyScope, ...base } = contract;
  const knownPageIds = new Set(result.design.pages.map((page) => page.id));
  const targetPageIds = (affectedPageIds ?? []).filter((pageId) =>
    knownPageIds.has(pageId),
  );
  return {
    ...base,
    blueprint: {
      revision: result.design.revision,
      target_page_ids:
        targetPageIds.length > 0
          ? targetPageIds
          : result.design.pages.map((page) => page.id),
      shared_scope: {
        file_paths: [
          ...new Set([
            ...result.design.layouts.flatMap((layout) => layout.filePaths),
            ...result.design.sharedUiRefs.flatMap((ref) => ref.filePaths),
          ]),
        ],
        ui_ids: result.design.sharedUiRefs.map((ref) => ref.id),
      },
      batch_phase: "final_review",
    },
  };
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
  const target = resolveProjectDesignPreviewTarget(
    blueprint.design,
    selection.pageId,
    selection.scenarioId,
  );
  if (!target) return "";
  return `
<project_design_workspace>
The current trusted workspace selection is page_id "${target.pageId}" and scenario_id "${target.scenarioId}". For a local or deictic request such as "this page", default target_page_ids to this page only. Add shared_scope entries only when the requested change truly modifies a declared shared layout or shared UI.
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
        ...new Set([page.defaultScenario, ...page.scenarioIds]),
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

const MAX_AUTOMATIC_PROTOTYPE_BATCHES = 3;
const AUTOMATIC_PROTOTYPE_BATCH_PROMPT =
  "Continue the next incomplete prototype batch automatically. Read design-project.json, do not repeat completed pages or flows, load the required Design Skill, submit a contract bound to the current blueprint revision and batch scope, implement one coherent batch, update build progress and revision, run project_health_check, then stop this batch.";

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

function appendAutomaticReviewActivity(
  conversationId: string,
  reviewJobId: string,
  status: DesignReviewSummary["status"],
): void {
  const state = useConversationStore.getState();
  const conversation = state.conversations[conversationId];
  if (!conversation) return;
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
  const generatorConfigRef = useRef<GeneratorConfigSnapshot | null>(null);
  const generatorConstructionEpochRef = useRef(0);
  const permissionBrokerBypassEnabled = useSettingsStore(
    (state) => state.system.permissionBrokerBypassEnabled,
  );
  const previousPermissionBypassRef = useRef(permissionBrokerBypassEnabled);
  const activeId = useConversationStore((s) => s.activeId);
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
  const prevActiveIdRef = useRef(activeId);
  const textBufferRef = useRef("");
  const thinkingBufferRef = useRef("");
  const typewriterTimerRef = useRef<number | null>(null);
  const thinkingTimerRef = useRef<number | null>(null);
  const lastCharTimeRef = useRef(0);
  const lastThinkingTimeRef = useRef(0);
  const runConversationIdRef = useRef<string | null>(null);
  const generationRunEpochRef = useRef(0);
  const forcedSkillsPromptRef = useRef("");
  const customSystemPromptRef = useRef("");
  const requestPromptContextRef = useRef("");
  const baseCustomToolSetRef = useRef<ToolSet>({});
  const providerToolNamesRef = useRef<string[]>([]);
  const mcpRuntimeRef = useRef<McpRuntimeBundle | null>(null);
  const activeToolProfileRef = useRef<ToolProfile>("default");
  const designContractControllerRef = useRef(createDesignContractController());
  const lastAcceptedDesignContractRef = useRef<DesignContract | null>(null);
  const designRunInitialFilesRef = useRef<ProjectFiles>({});
  const reviewContractByRunIdRef = useRef(
    new Map<string, DesignContract | null>(),
  );

  const clearOutputBuffers = useCallback(() => {
    if (typewriterTimerRef.current) {
      cancelAnimationFrame(typewriterTimerRef.current);
      typewriterTimerRef.current = null;
    }
    if (thinkingTimerRef.current) {
      cancelAnimationFrame(thinkingTimerRef.current);
      thinkingTimerRef.current = null;
    }
    textBufferRef.current = "";
    thinkingBufferRef.current = "";
  }, []);

  const isCurrentGeneratorRun = useCallback(
    (runConversationId: string | null) =>
      isGenerationRunCurrent(
        runConversationId,
        useConversationStore.getState().activeId,
        runConversationIdRef.current,
      ),
    [],
  );

  useEffect(
    () => () => {
      generationRunEpochRef.current += 1;
      generatorConstructionEpochRef.current += 1;
      clearOutputBuffers();
      forcedSkillsPromptRef.current = "";
      customSystemPromptRef.current = "";
      requestPromptContextRef.current = "";
      mcpRuntimeRef.current = null;
      activeToolProfileRef.current = "default";
      designContractControllerRef.current.reset({ enabled: false });
      designRunInitialFilesRef.current = {};
      generatorRef.current?.abort();
    },
    [clearOutputBuffers],
  );

  const invalidateGenerator = useCallback(() => {
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
    designContractControllerRef.current.reset({ enabled: false });
    designRunInitialFilesRef.current = {};
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
    if (prevActiveIdRef.current === activeId) return;
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
    designContractControllerRef.current.reset({ enabled: false });
    designRunInitialFilesRef.current = {};
    clearOutputBuffers();
    prevActiveIdRef.current = activeId;
    useInteractiveStore.getState().rejectAllPending("conversation switched");
    useSubagentStore.setState({ progress: {} });
    useDesignReviewStore.getState().reset();
    setIsGenerating(false);
    setIsThinkingStreaming(false);
    setRunState("idle");
  }, [activeId, clearOutputBuffers, setIsGenerating]);

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
        !["capturing", "queued", "running", "fixing", "verifying"].includes(
          status,
        ) ||
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
    ) => {
      const provider = settings.localAgent.provider;
      const preferences = settings.localAgent.preferences[provider];
      const { runLocalUtilityText } =
        await import("../lib/local-agent/generator");
      try {
        return await runLocalUtilityText(
          {
            provider,
            model: preferences.model,
            effort: preferences.effort,
          },
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
  });

  /** Flush all remaining thinking buffer content at once */
  const flushThinkingBuffer = useCallback(() => {
    if (thinkingTimerRef.current) {
      cancelAnimationFrame(thinkingTimerRef.current);
      thinkingTimerRef.current = null;
    }
    if (thinkingBufferRef.current) {
      const remaining = thinkingBufferRef.current;
      thinkingBufferRef.current = "";
      setMessages((prev) =>
        appendBufferedAssistantOutput(prev, { thinking: remaining }),
      );
    }
  }, [setMessages]);

  const flushOutputBuffers = useCallback(() => {
    if (thinkingTimerRef.current) {
      cancelAnimationFrame(thinkingTimerRef.current);
      thinkingTimerRef.current = null;
    }
    if (typewriterTimerRef.current) {
      cancelAnimationFrame(typewriterTimerRef.current);
      typewriterTimerRef.current = null;
    }
    const thinking = thinkingBufferRef.current;
    const text = textBufferRef.current;
    thinkingBufferRef.current = "";
    textBufferRef.current = "";
    if (!thinking && !text) return;
    setMessages((prev) =>
      appendBufferedAssistantOutput(prev, { thinking, text }),
    );
  }, [setMessages]);

  const appendGenerationError = useCallback(
    (
      err: unknown,
      options: { replaceExisting?: boolean } = {},
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
          errorRetryable: classified.retryable,
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

  const getGenerator = useCallback(async () => {
    const isLocalRuntime = settings.runtime === "localCli";
    const localProvider = settings.localAgent.provider;
    const localPreferences = settings.localAgent.preferences[localProvider];
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
        !localAgentSupportsNativeSearch(localProvider)
      ) {
        throw new Error(getT().settings.localCli.builtinSearchBlocked);
      }
      const { supportsLocalAgents } = await import("../lib/local-agent/tauri");
      if (!(await supportsLocalAgents())) {
        throw new Error(getT().settings.localCli.runtimeUnavailableAction);
      }
    }

    const currentActiveId = useConversationStore.getState().activeId;
    if (!currentActiveId) return null;

    // Invalidate on conversation switch, including a store update that arrived
    // before React committed the matching render.
    if (prevActiveIdRef.current !== currentActiveId) {
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
      prevActiveIdRef.current = currentActiveId;
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
      const runtime = await loadGeneratorRuntime();
      const generatorConversationId = currentActiveId;
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
          if (!isCurrentGeneratorRun(generatorConversationId)) return false;
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
            !isCurrentGeneratorRun(generatorConversationId)
          ) {
            throw new DOMException("conversation switched", "AbortError");
          }
          const { setConversationDefaultPreviewView } =
            await import("../lib/design/preview-preference");
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
            !isCurrentGeneratorRun(generatorConversationId)
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
            acceptedDesignContract:
              designContractControllerRef.current.getContract(),
            snapshotLabel: getT().designTokens.snapshotLabel,
            onProjectFilesChanged: (nextFiles) => {
              if (!isCurrentGeneratorRun(generatorConversationId)) {
                throw new DOMException("conversation switched", "AbortError");
              }
              generatorRef.current?.setFiles(nextFiles);
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
        capturePreviewEvidence: async (_name, args, context) => {
          if (
            !context ||
            context.run.conversationId !== generatorConversationId ||
            !isCurrentGeneratorRun(generatorConversationId)
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
          const currentFiles =
            generatorRef.current?.getFiles() ?? conversation.files;
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
              typeof rawTarget.route !== "string" ||
              typeof rawTarget.scenarioId !== "string"
            ) {
              return "Error: prototype preview targets require a valid design-project.json blueprint.";
            }
            const resolved = resolveProjectDesignPreviewTarget(
              blueprint.design,
              rawTarget.pageId,
              rawTarget.scenarioId,
            );
            const page = blueprint.design.pages.find(
              (candidate) => candidate.id === rawTarget.pageId,
            );
            if (
              !resolved ||
              !page ||
              (rawTarget.route !== page.route &&
                rawTarget.route !== resolved.route)
            ) {
              return "Error: preview target page, route, or scenario is not declared by design-project.json.";
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
            signal: context.signal,
          });
        },
        designDiagnostics: async (name, args, context) => {
          if (
            !context ||
            context.run.conversationId !== generatorConversationId ||
            !isCurrentGeneratorRun(generatorConversationId)
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
              files: generatorRef.current?.getFiles() ?? conversation.files,
              beforeFiles: designRunInitialFilesRef.current,
              template: conversation.template,
              previewMode: conversation.previewMode ?? "sandpack",
              designState: conversation.designState,
              contract: designContractControllerRef.current.getContract(),
              history: conversation.messages,
              signal: context.signal,
            },
          );
        },
        onDesignReviewSubmitted: (report) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          useDesignReviewStore.getState().complete(report);
        },
        submitDesignContract: (args, context) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) {
            throw new DOMException("conversation switched", "AbortError");
          }
          const appliedSystem =
            useConversationStore.getState().conversations[
              generatorConversationId
            ]?.designState?.appliedSystem;
          const contract = designContractControllerRef.current.submit(args, {
            expectedSystemId: appliedSystem?.id ?? null,
            skillContext: context.skillContext,
            blueprint: designBlueprintBindings(
              generatorRef.current?.getFiles() ?? {},
            ),
          });
          lastAcceptedDesignContractRef.current = contract;
          const sourceConversation =
            useConversationStore.getState().conversations[
              generatorConversationId
            ];
          if (sourceConversation) {
            void computeDesignReviewSourceDigest({
              files: sourceConversation.files,
              designSystem:
                sourceConversation.designState?.appliedSystem ?? null,
              designContract: contract,
            })
              .then((sourceDigest) => {
                const runs =
                  useDesignReviewStore.getState().runsByConversation[
                    generatorConversationId
                  ] ?? [];
                for (const run of runs) {
                  useDesignReviewStore
                    .getState()
                    .markRunFreshness(run.id, sourceDigest);
                }
              })
              .catch(() => undefined);
          }
          return JSON.stringify({ accepted: true, contract });
        },
        getDesignHealthContext: () => {
          if (activeToolProfileRef.current !== "design") return undefined;
          const current =
            useConversationStore.getState().conversations[
              generatorConversationId
            ];
          return {
            designState: current?.designState,
            contract: designContractControllerRef.current.getContract(),
            beforeFiles: designRunInitialFilesRef.current,
          };
        },
        filesBridge: {
          getFiles: () =>
            isCurrentGeneratorRun(generatorConversationId)
              ? (generatorRef.current?.getFiles() ?? {})
              : {},
          onFilesChanged: (newFiles, changes) => {
            if (!isCurrentGeneratorRun(generatorConversationId)) return;
            generatorRef.current?.setFiles(newFiles);
            setFiles(newFiles);
            const depsChanged = changes.some(
              (c) =>
                c.path === "package.json" || c.path.endsWith("/package.json"),
            );
            if (depsChanged) restartSandpack();
          },
        },
        onProjectDesignUpdated: (nextFiles) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          const currentConversation =
            useConversationStore.getState().conversations[
              generatorConversationId
            ];
          designContractControllerRef.current.reset({
            enabled: true,
            expectedSystemId:
              currentConversation?.designState?.appliedSystem?.id ?? null,
            blueprint: designBlueprintBindings(nextFiles),
          });
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
                {
                  provider: localProvider,
                  model: localPreferences.model,
                  effort: localPreferences.effort,
                  nativeSearch: false,
                  conversationId: options.conversationId,
                },
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

      const generatorEvents = {
        onText: (delta) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          setRunState("streaming");
          setIsThinkingStreaming(false);
          flushThinkingBuffer();
          textBufferRef.current += delta;
          if (!typewriterTimerRef.current) {
            const typeChar = (timestamp: number) => {
              typewriterTimerRef.current = null;
              if (!isCurrentGeneratorRun(generatorConversationId)) {
                textBufferRef.current = "";
                return;
              }
              if (timestamp - lastCharTimeRef.current >= 20) {
                if (textBufferRef.current.length > 0) {
                  const char = textBufferRef.current[0];
                  textBufferRef.current = textBufferRef.current.slice(1);
                  setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant") {
                      return [
                        ...prev.slice(0, -1),
                        {
                          ...last,
                          content:
                            ((typeof last.content === "string"
                              ? last.content
                              : "") || "") + char,
                        },
                      ];
                    }
                    return [...prev, { role: "assistant", content: char }];
                  });
                  lastCharTimeRef.current = timestamp;
                }
              }
              if (textBufferRef.current.length > 0) {
                typewriterTimerRef.current = requestAnimationFrame(typeChar);
              }
            };
            typewriterTimerRef.current = requestAnimationFrame(typeChar);
          }
        },
        onThinking: (delta) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          setRunState("streaming");
          setIsThinkingStreaming(true);
          thinkingBufferRef.current += delta;
          if (!thinkingTimerRef.current) {
            const typeThinking = (timestamp: number) => {
              thinkingTimerRef.current = null;
              if (!isCurrentGeneratorRun(generatorConversationId)) {
                thinkingBufferRef.current = "";
                return;
              }
              if (timestamp - lastThinkingTimeRef.current >= 20) {
                if (thinkingBufferRef.current.length > 0) {
                  const char = thinkingBufferRef.current[0];
                  thinkingBufferRef.current =
                    thinkingBufferRef.current.slice(1);
                  setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant") {
                      return [
                        ...prev.slice(0, -1),
                        { ...last, thinking: (last.thinking || "") + char },
                      ];
                    }
                    return [
                      ...prev,
                      { role: "assistant", content: null, thinking: char },
                    ];
                  });
                  lastThinkingTimeRef.current = timestamp;
                }
              }
              if (thinkingBufferRef.current.length > 0) {
                thinkingTimerRef.current = requestAnimationFrame(typeThinking);
              }
            };
            thinkingTimerRef.current = requestAnimationFrame(typeThinking);
          }
        },
        onToolCall: (name, id) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
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
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
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
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          setFiles(newFiles);
        },
        onTemplateChange: (tmpl, newFiles) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          setTemplate(tmpl);
          setFiles(newFiles);
          restartSandpack();
        },
        onDependenciesChange: (newFiles) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          setFiles(newFiles);
          restartSandpack();
        },
        onComplete: () => {
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          setIsThinkingStreaming(false);
          setRunState("completed");
          flushOutputBuffers();
          if (activeToolProfileRef.current !== "design_review") {
            createSnapshotForCurrentState();
          }
        },
        onError: (error) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
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
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          const normalized = status.state.toLowerCase();
          if (normalized.includes("tool")) {
            setRunState("executingTool");
          } else if (
            normalized.includes("wait") ||
            normalized.includes("input")
          ) {
            setRunState("waitingUser");
          } else if (
            normalized.includes("stream") ||
            normalized.includes("think")
          ) {
            setRunState("streaming");
          } else if (
            normalized.includes("prepare") ||
            normalized.includes("start") ||
            normalized.includes("handshake")
          ) {
            setRunState("preparing");
          }
        },
        onRetry: (attempt, maxAttempts, error) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
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
          if (!isCurrentGeneratorRun(generatorConversationId)) return null;
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
          );
          if (!isCurrentGeneratorRun(generatorConversationId)) return null;
          if (!result) return null;
          return getMessagesForAPI({ ...conv, compressedContext: result });
        },
      } satisfies GeneratorEvents;
      const projectPermissionSession = createHostProjectPermissionSession({
        conversationId: generatorConversationId,
        platform: runtimePlatform,
        runtime: isLocalRuntime ? "local_cli" : "api",
        bypassEnabled: permissionBrokerBypassEnabled,
      });
      let candidate: GenerationBackend | null = null;
      const generatorExtras = {
        conversationId: generatorConversationId,
        tools: initialTools,
        askUserQuestion: (toolCallId, questions) => {
          if (!isCurrentGeneratorRun(generatorConversationId)) {
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
          if (!isCurrentGeneratorRun(generatorConversationId)) {
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
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          const returnMode = useConversationStore
            .getState()
            .returnFromPlan(generatorConversationId);
          const profile: ToolProfile =
            returnMode === "design" ? "design" : "default";
          generatorRef.current?.setReadOnlyMode(false);
          generatorRef.current?.setExecutionMode("chat");
          const mcpRuntime = await runtime.mcpManager.prepareRuntime();
          if (!isCurrentGeneratorRun(generatorConversationId)) return;
          mcpRuntimeRef.current = mcpRuntime;
          generatorRef.current?.setLocalToolAnnotations?.(
            mcpRuntime.annotations,
          );
          const custom = {
            ...baseCustomToolSetRef.current,
            ...mcpRuntime.tools,
          };
          generatorRef.current?.setCustomToolSet(custom);
          generatorRef.current?.setAllowedMcpAliases(
            new Set(mcpRuntime.aliases.keys()),
          );
          generatorRef.current?.setUntrustedReferenceContext(
            mcpRuntime.instructions,
          );
          generatorRef.current?.setSystemPromptSuffix(
            runtime.buildMemoryPromptSection(
              useMemoryStore.getState().getAll(),
            ) + requestPromptContextRef.current,
          );
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
          if (!isCurrentGeneratorRun(generatorConversationId)) {
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
          if (
            context.signal.aborted ||
            !isCurrentGeneratorRun(generatorConversationId)
          ) {
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
                      state.activeId === conversationId &&
                      isCurrentGeneratorRun(conversationId),
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
        authorizeToolCall: (name, args) => {
          if (activeToolProfileRef.current !== "design") return;
          return designContractControllerRef.current.authorizeProjectWrite(
            name,
            args,
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
        | "authorizeToolCall"
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
          {
            provider: localProvider,
            model: localPreferences.model,
            effort: localPreferences.effort,
            nativeSearch: webSearchSettings.engine === "builtin",
            conversationId: generatorConversationId,
            getConversation: () =>
              useConversationStore.getState().conversations[
                generatorConversationId
              ] ?? null,
            saveSession: (session) => {
              if (
                generatorRef.current !== candidate ||
                !isCurrentGeneratorRun(generatorConversationId)
              ) {
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
          },
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
      if (!constructionIsCurrent) {
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
        workspaceMode?: WorkspaceMode;
        profile?: ToolProfile;
        customSystemPromptSnapshot?: string;
      } = {},
    ) => {
      const runtime = await loadGeneratorRuntime();
      const conversationId = generator.getRunContext().conversationId;
      const workspace = getConversationWorkspaceContext(conversationId);
      const promptWorkspaceMode =
        dynamicOptions.workspaceMode ?? workspace.promptWorkspaceMode;
      const mode = dynamicOptions.mode ?? workspace.mode;
      const profile = dynamicOptions.profile ?? workspace.profile;
      const isDesignReview = profile === "design_review";
      activeToolProfileRef.current = profile;
      generator.setNativeSearchAllowed?.(mode !== "auto_qa" && !isDesignReview);
      generator.setConversationContextAllowed?.(!isDesignReview);
      const mcpRuntime = await runtime.mcpManager.prepareRuntime({
        includeMcp:
          mode === "auto_qa" || isDesignReview
            ? false
            : dynamicOptions.includeMcp,
      });
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
      let skillsSuffix = "";
      let forcedSkillsSuffix = "";
      if (
        !isDesignReview &&
        (mode === "chat" || mode === "plan") &&
        runtime.isSkillsAvailable()
      ) {
        const registry = await runtime.getSkillRegistry();
        skillsSuffix = runtime.buildSkillsPromptSection(
          registry.getAutoEnabled(),
        );
        const prepared = await registry.prepareForcedSkills(forcedSkillIds);
        skillContext.activateMany(prepared.map((skill) => skill.entry));
        forcedSkillsSuffix = runtime.buildForcedSkillsPromptSection(prepared);
      } else if (forcedSkillIds.length > 0) {
        throw new Error(
          "Forced skills cannot be loaded because skill storage is unavailable.",
        );
      }
      const designState = conversationId
        ? useConversationStore.getState().conversations[conversationId]
            ?.designState
        : undefined;
      const designSystemContext =
        promptWorkspaceMode === "design"
          ? await loadDesignSystemContext(designState)
          : "";
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
      generator.setSystemPromptSuffix(promptSuffix);
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
        );
      }
    },
    [
      applyDynamicGeneratorState,
      appendGenerationError,
      isCurrentGeneratorRun,
      setMessages,
    ],
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
      const acceptedContract =
        designContractControllerRef.current.getContract() ??
        lastAcceptedDesignContractRef.current;
      const contract = acceptedContract
        ? bindReviewContractToCurrentBlueprint(
            acceptedContract,
            result.files,
            affectedPageIds,
          )
        : null;
      if (
        options.skipAutomaticDesignReview ||
        conversation?.workspaceMode !== "design" ||
        !contract ||
        result.aborted ||
        result.maxIterationsReached
      ) {
        return;
      }
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
          updateAutomaticReviewActivity(runConversationId, requestId, {
            status: "failed",
          });
        });
    },
    [],
  );

  const generate = useCallback(
    async (
      prompt: string,
      attachments?: Attachment[],
      options: GenerateRunOptions = {},
    ) => {
      const runConversationId = useConversationStore.getState().activeId;
      if (!runConversationId) return;
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
      runConversationIdRef.current = runConversationId;
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
        options.messageOrigin
          ? {
              ...(attachmentRefs.length > 0
                ? { attachments: attachmentRefs }
                : {}),
              ...(options.designSelection
                ? { designSelection: options.designSelection }
                : {}),
              ...(options.messageOrigin
                ? { origin: options.messageOrigin }
                : {}),
            }
          : undefined;

      const previousConversation =
        useConversationStore.getState().conversations[runConversationId];
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
      setMessages((prev) => [...removeErrorMessages(prev), currentRequest]);
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
        designContractControllerRef.current.reset({ enabled: false });
        await options.prepareRun?.();
        if (!isCurrentRun()) return;
        const preparedConversation =
          useConversationStore.getState().conversations[runConversationId];
        const preparedWorkspace =
          getConversationWorkspaceContext(runConversationId);
        designRunInitialFilesRef.current = {
          ...(preparedConversation?.files ?? {}),
        };
        designContractControllerRef.current.reset(
          {
            enabled: preparedWorkspace.profile === "design",
            expectedSystemId:
              preparedConversation?.designState?.appliedSystem?.id ?? null,
            expectedChangeModes:
              options.designExpectedChangeModes ??
              (Object.keys(preparedConversation?.files ?? {}).length === 0
                ? (["create"] as const)
                : undefined),
            ...(preparedConversation
              ? designBlueprintRunPolicy(preparedConversation.files)
              : {}),
          },
          options.reusableDesignContract,
        );
        lastAcceptedDesignContractRef.current =
          options.reusableDesignContract ?? null;
        const resolvedAttachments = attachments?.length
          ? await resolveAttachmentsForModel(attachments)
          : [];
        clearAgnesAttachments = registerAgnesRunAttachments(
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
          for (
            let batch = 0;
            batch < MAX_AUTOMATIC_PROTOTYPE_BATCHES &&
            !result.aborted &&
            !result.maxIterationsReached &&
            hasIncompletePrototypeBuild(result.files);
            batch += 1
          ) {
            const currentConversation =
              useConversationStore.getState().conversations[runConversationId];
            designContractControllerRef.current.reset({
              enabled: true,
              expectedSystemId:
                currentConversation?.designState?.appliedSystem?.id ?? null,
              expectedChangeModes: ["create", "extend"],
              ...designBlueprintRunPolicy(result.files),
            });
            result = await generator.generate(AUTOMATIC_PROTOTYPE_BATCH_PROMPT);
          }
          const prototypeBuildIncomplete = hasIncompletePrototypeBuild(
            result.files,
          );
          if (!prototypeBuildIncomplete) {
            scheduleAutomaticDesignReview(
              result,
              runConversationId,
              prompt,
              options,
            );
          }
          if (!options.skipAutoQa && !prototypeBuildIncomplete) {
            await runAutomaticQa(
              generator,
              result,
              runConversationId,
              runEpoch,
            );
          }
        }
      } catch (err: any) {
        if (!isCurrentRun()) return;
        console.error("Error generating:", err);
        if (err?.name !== "AbortError") {
          appendGenerationError(err, { replaceExisting: true });
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
          runConversationIdRef.current = null;
        }
      }
    },
    [
      getGenerator,
      setIsGenerating,
      setMessages,
      applyDynamicGeneratorState,
      runAutomaticQa,
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
    generationRunEpochRef.current += 1;
    setIsThinkingStreaming(false);
    flushOutputBuffers();
    generatorRef.current?.abort();
    generatorRef.current = null;
    generatorConfigRef.current = null;
    forcedSkillsPromptRef.current = "";
    customSystemPromptRef.current = "";
    requestPromptContextRef.current = "";
    runConversationIdRef.current = null;
    useInteractiveStore.getState().rejectAllPending("user stopped");
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
    designContractControllerRef.current.reset({ enabled: false });
    designRunInitialFilesRef.current = {};
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
    if (settings.runtime === "localCli") {
      useConversationStore
        .getState()
        .setLocalAgentSessionForConversation(
          conversationId,
          settings.localAgent.provider,
          undefined,
        );
    }

    setLastError(null);
    setIsThinkingStreaming(false);
    setRunState("idle");
    setIsGenerating(false);
    return draft;
  }, [
    clearOutputBuffers,
    setIsGenerating,
    settings.localAgent.provider,
    settings.runtime,
  ]);

  const retry = useCallback(async () => {
    const runConversationId = useConversationStore.getState().activeId;
    if (!runConversationId) return;
    const customSystemPromptSnapshot =
      useSettingsStore.getState().system.customSystemPrompt;
    runConversationIdRef.current = runConversationId;
    setRunState("preparing");
    setLastError(null);
    setIsThinkingStreaming(false);
    setIsGenerating(true);
    setMessages((prev) => {
      const toolResultIds = new Set(
        prev.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
      );
      return prev.filter((m) => {
        if (isErrorMessage(m)) return false;
        if (m.role === "assistant" && m.tool_calls?.length) {
          return m.tool_calls.every((tc) => toolResultIds.has(tc.id));
        }
        return true;
      });
    });
    let clearAgnesAttachments = () => {};
    try {
      const generator = await getGenerator();
      if (!isCurrentGeneratorRun(runConversationId)) return;
      if (generator) {
        const storeState = useConversationStore.getState();
        const activeConv = runConversationId
          ? storeState.conversations[runConversationId]
          : null;
        if (activeConv) {
          const lastRequest = [...activeConv.messages]
            .reverse()
            .find(
              (message) => message.role === "user" && !message.metadata?.origin,
            );
          const resolvedAttachments = lastRequest?.metadata?.attachments?.length
            ? await resolveAttachmentsForModel(lastRequest.metadata.attachments)
            : [];
          clearAgnesAttachments = registerAgnesRunAttachments(
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
        }
        await applyDynamicGeneratorState(
          generator,
          getLastForcedSkillIds(activeConv?.messages ?? []),
          { customSystemPromptSnapshot },
        );
        if (!isCurrentGeneratorRun(runConversationId)) return;
        await generator.retry();
      }
    } catch (err: any) {
      if (!isCurrentGeneratorRun(runConversationId)) return;
      console.error("Error retrying:", err);
      if (err?.name !== "AbortError") {
        appendGenerationError(err);
      }
    } finally {
      clearAgnesAttachments();
      if (isCurrentGeneratorRun(runConversationId)) {
        setMessages((prev) => filterMemoryMessages(prev));
        setIsGenerating(false);
        setIsThinkingStreaming(false);
        setRunState((state) =>
          state === "error" || state === "aborted" ? state : "idle",
        );
        forcedSkillsPromptRef.current = "";
        customSystemPromptRef.current = "";
        requestPromptContextRef.current = "";
        runConversationIdRef.current = null;
      }
    }
  }, [
    getGenerator,
    setIsGenerating,
    setMessages,
    applyDynamicGeneratorState,
    appendGenerationError,
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
      try {
        // Capture the UI language before any async digest or queue work so a
        // run/retry keeps one consistent report language.
        const locale = getResolvedLocale();
        validateDesignReviewScreenshots(screenshots);
        const contract =
          options?.automaticEvidence?.contract ??
          designContractControllerRef.current.getContract();
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
        const run = options?.retryOf
          ? designReviewJobRunner.retry(options.retryOf, input)
          : designReviewJobRunner.start(input);
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
      if (!conversation) return;

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

      useDesignReviewStore.getState().setAutomaticStage("reviewing");
      const startedRun = await designReview(screenshots, {
        automaticEvidence: enrichedEvidence,
        captureErrors,
      });
      if (!startedRun) return;
      const completedRun = await waitForDesignReviewRun(startedRun.id);
      if (!completedRun) return;
      const report = completedRun.report ?? {
        overview: "Visual review unavailable.",
        findings: [],
      };
      const currentConversation =
        useConversationStore.getState().conversations[evidence.conversationId];
      const currentDigest = currentConversation
        ? await computeDesignReviewSourceDigest({
            files: currentConversation.files,
            designSystem:
              currentConversation.designState?.appliedSystem ?? null,
            designContract: evidence.contract,
          })
        : null;
      const fresh = currentDigest === completedRun.sourceDigest;
      if (currentDigest) {
        useDesignReviewStore
          .getState()
          .markRunFreshness(completedRun.id, currentDigest);
      }
      updateAutomaticReviewActivity(evidence.conversationId, completedRun.id, {
        status: completedRun.status,
        findingCount: completedRun.report?.findings.length ?? 0,
        stale: !fresh,
      });

      if (evidence.phase === "verify") {
        if (
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId
        ) {
          useDesignReviewStore
            .getState()
            .finishAutomatic(
              completedRun.status === "succeeded" &&
                hasRemainingAutomaticDesignIssues(enrichedEvidence, report),
            );
        }
        return;
      }

      const scope = selectAutomaticDesignRepairScope(enrichedEvidence, report);
      if (!shouldRunAutomaticDesignRepair(evidence.phase, scope)) {
        if (
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId
        ) {
          useDesignReviewStore.getState().finishAutomatic(false);
        }
        return;
      }
      const safeToRepair = canEnterAutomaticDesignRepair({
        fresh,
        activeConversation:
          useConversationStore.getState().activeId === evidence.conversationId,
        currentReview:
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId,
        chatIdle: runConversationIdRef.current === null,
        hasNewerUserRequest: hasNewerGenuineUserMessage(
          evidence.conversationId,
          completedRun.id,
        ),
      });
      if (!safeToRepair) {
        if (
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId
        ) {
          useDesignReviewStore.getState().finishAutomatic(false);
        }
        return;
      }

      updateAutomaticReviewActivity(evidence.conversationId, completedRun.id, {
        status: "fixing",
        findingCount: report.findings.length,
      });
      const trackFixingOnRun =
        completedRun.status === "succeeded" &&
        completedRun.report !== undefined;
      if (trackFixingOnRun) {
        useDesignReviewStore
          .getState()
          .updateRunStatus(completedRun.id, "fixing");
      }
      useDesignReviewStore
        .getState()
        .appendRunLog(
          completedRun.id,
          createDesignReviewLogEntry(
            "fixing",
            "Automatic repair entered the foreground write queue.",
            { level: "info" },
          ),
        );
      useDesignReviewStore.getState().setAutomaticStage("fixing");
      await generate(
        buildAutomaticDesignRepairPrompt(enrichedEvidence, scope),
        undefined,
        {
          skipAutoQa: true,
          forcedSkillIds: requiredSkillsForContract(evidence.contract),
          reusableDesignContract: evidence.contract,
          automaticDesignReviewPhase: "verify",
          automaticDesignOriginalRequest: evidence.originalRequest,
          automaticDesignReviewActivityId: completedRun.id,
          messageOrigin: "design_auto_fix",
        },
      );
      if (trackFixingOnRun && completedRun.report) {
        useDesignReviewStore
          .getState()
          .completeRun(completedRun.id, completedRun.report);
      }
      const activity = useConversationStore
        .getState()
        .conversations[evidence.conversationId]?.messages.find(
          (message) => message.metadata?.reviewJobId === completedRun.id,
        );
      if (activity?.metadata?.reviewSummary?.status === "fixing") {
        updateAutomaticReviewActivity(
          evidence.conversationId,
          completedRun.id,
          { status: "interrupted" },
        );
      }
    },
    [designReview, generate],
  );

  const automaticDesignReviewUnavailable = useCallback(
    async (evidence: AutomaticDesignReviewEvidence, message: string) => {
      const state = useConversationStore.getState();
      const conversation = state.conversations[evidence.conversationId];
      if (!conversation) return;
      const scope = selectAutomaticDesignRepairScope(evidence, {
        overview: "Visual review unavailable.",
        findings: [],
      });
      const currentDigest = await computeDesignReviewSourceDigest({
        files: conversation.files,
        designSystem: conversation.designState?.appliedSystem ?? null,
        designContract: evidence.contract,
      });
      const fresh = Boolean(
        evidence.sourceDigest && currentDigest === evidence.sourceDigest,
      );
      const safeToRepair = canEnterAutomaticDesignRepair({
        fresh,
        activeConversation: state.activeId === evidence.conversationId,
        currentReview:
          useDesignReviewStore.getState().automatic?.evidence.requestId ===
          evidence.requestId,
        chatIdle: runConversationIdRef.current === null,
        hasNewerUserRequest: hasNewerGenuineUserMessage(
          evidence.conversationId,
          evidence.requestId,
        ),
      });
      if (
        shouldRunAutomaticDesignRepair(evidence.phase, scope) &&
        safeToRepair
      ) {
        updateAutomaticReviewActivity(
          evidence.conversationId,
          evidence.requestId,
          { status: "fixing" },
        );
        useDesignReviewStore.getState().setAutomaticStage("fixing");
        await generate(
          buildAutomaticDesignRepairPrompt(evidence, scope),
          undefined,
          {
            skipAutoQa: true,
            forcedSkillIds: requiredSkillsForContract(evidence.contract),
            reusableDesignContract: evidence.contract,
            automaticDesignReviewPhase: "verify",
            automaticDesignOriginalRequest: evidence.originalRequest,
            automaticDesignReviewActivityId: evidence.requestId,
            messageOrigin: "design_auto_fix",
          },
        );
        return;
      }
      updateAutomaticReviewActivity(
        evidence.conversationId,
        evidence.requestId,
        { status: "failed", stale: !fresh },
      );
      if (
        useDesignReviewStore.getState().automatic?.evidence.requestId ===
        evidence.requestId
      ) {
        useDesignReviewStore.getState().failAutomatic(message);
      }
    },
    [generate],
  );

  const continueTask = useCallback(async () => {
    const runConversationId = useConversationStore.getState().activeId;
    if (!runConversationId) return;
    const runEpoch = ++generationRunEpochRef.current;
    const isCurrentRun = () =>
      generationRunEpochRef.current === runEpoch &&
      isCurrentGeneratorRun(runConversationId);
    const customSystemPromptSnapshot =
      useSettingsStore.getState().system.customSystemPrompt;
    runConversationIdRef.current = runConversationId;
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
          designRunInitialFilesRef.current = { ...activeConv.files };
          const workspace = getConversationWorkspaceContext(runConversationId);
          designContractControllerRef.current.reset({
            enabled: workspace.profile === "design",
            expectedSystemId: activeConv.designState?.appliedSystem?.id ?? null,
            ...designBlueprintRunPolicy(activeConv.files),
          });
          lastAcceptedDesignContractRef.current = null;
        }
        await applyDynamicGeneratorState(generator, [], {
          customSystemPromptSnapshot,
        });
        if (!isCurrentRun()) return;
        const continuePrompt =
          "Continue from the current design-project.json checkpoint. Do not repeat completed prototype pages, flows, or batches. Complete the next unfinished task and update the blueprint checkpoint.";
        let result = await generator.generate(continuePrompt);
        for (
          let batch = 0;
          batch < MAX_AUTOMATIC_PROTOTYPE_BATCHES &&
          !result.aborted &&
          !result.maxIterationsReached &&
          hasIncompletePrototypeBuild(result.files);
          batch += 1
        ) {
          if (!isCurrentRun()) return;
          const currentConversation =
            useConversationStore.getState().conversations[runConversationId];
          designContractControllerRef.current.reset({
            enabled: true,
            expectedSystemId:
              currentConversation?.designState?.appliedSystem?.id ?? null,
            expectedChangeModes: ["create", "extend"],
            ...designBlueprintRunPolicy(result.files),
          });
          result = await generator.generate(AUTOMATIC_PROTOTYPE_BATCH_PROMPT);
        }
        const incomplete = hasIncompletePrototypeBuild(result.files);
        if (!incomplete) {
          scheduleAutomaticDesignReview(
            result,
            runConversationId,
            continuePrompt,
            {},
          );
          await runAutomaticQa(generator, result, runConversationId, runEpoch);
        }
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
        runConversationIdRef.current = null;
      }
    }
  }, [
    getGenerator,
    setIsGenerating,
    setMessages,
    applyDynamicGeneratorState,
    appendGenerationError,
    isCurrentGeneratorRun,
    runAutomaticQa,
    scheduleAutomaticDesignReview,
  ]);

  return {
    generate,
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
    generateUtilityText,
    getDesignContract: () => designContractControllerRef.current.getContract(),
  };
}
