// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ToolSet } from "ai";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../store/conversation";
import { useInteractiveStore } from "../store/interactive";
import { useSettingsStore } from "../store/settings";
import { createSkillActiveContext } from "../lib/skills/active-context";
import type { SkillEntry } from "../lib/skills/types";
import type {
  GenerateResult,
  GenerationBackend,
  GeneratorEvents,
  GeneratorOptions,
  Message,
  ProjectFiles,
  ResolvedAttachment,
  ToolExecutionContext,
} from "../lib/ai/generator-types";
import type { GenerationRequestContext } from "../lib/ai/generator-types";
import type {
  ExecutionMode,
  RuntimePlatform,
  ToolRunContext,
} from "../lib/ai/tools-schema";
import type {
  DesignChangeMode,
  DesignContract,
} from "../lib/design/run-contract";
import { useGenerator } from "./useGenerator";

const runtimeMocks = vi.hoisted(() => ({
  buildForcedSkillsPromptSection: vi.fn(),
  buildMemoryPromptSection: vi.fn(),
  buildSkillsPromptSection: vi.fn(),
  buildToolHandlers: vi.fn(),
  buildToolSetForRun: vi.fn(),
  createOpenAIGenerator: vi.fn(),
  createSubagentDispatcher: vi.fn(),
  generateSmartTitle: vi.fn(),
  getSkillRegistry: vi.fn(),
  isSkillsAvailable: vi.fn(),
  prepareRuntime: vi.fn(),
  runCompress: vi.fn(),
}));

vi.mock("../lib/ai/client", () => ({
  createOpenAIGenerator: runtimeMocks.createOpenAIGenerator,
}));
vi.mock("../lib/ai/tools-schema", () => ({
  buildToolSetForRun: runtimeMocks.buildToolSetForRun,
}));
vi.mock("../lib/tools/handler-factory", () => ({
  buildToolHandlers: runtimeMocks.buildToolHandlers,
}));
vi.mock("../lib/ai/subagents/runner", () => ({
  createSubagentDispatcher: runtimeMocks.createSubagentDispatcher,
}));
vi.mock("../lib/utils/run-compress", () => ({
  runCompress: runtimeMocks.runCompress,
}));
vi.mock("../lib/utils/smart-title", () => ({
  generateSmartTitle: runtimeMocks.generateSmartTitle,
}));
vi.mock("../lib/tools/memory", () => ({
  buildMemoryPromptSection: runtimeMocks.buildMemoryPromptSection,
}));
vi.mock("../lib/skills/tool-handler", () => ({
  buildForcedSkillsPromptSection: runtimeMocks.buildForcedSkillsPromptSection,
  buildSkillsPromptSection: runtimeMocks.buildSkillsPromptSection,
}));
vi.mock("../lib/skills/fs", () => ({
  isSkillsAvailable: runtimeMocks.isSkillsAvailable,
}));
vi.mock("../lib/skills/instance", () => ({
  getSkillRegistry: runtimeMocks.getSkillRegistry,
}));
vi.mock("../lib/mcp/connection-manager", () => ({
  getMcpConnectionManager: () => ({
    prepareRuntime: runtimeMocks.prepareRuntime,
  }),
}));

const EMPTY_MCP_RUNTIME = {
  aliases: new Map<string, string>(),
  annotations: new Map(),
  instructions: "",
  planModeToolNames: new Set<string>(),
  subagentToolNames: new Set<string>(),
  tools: {},
  warnings: [],
};

const ART_DIRECT_SKILL: SkillEntry = {
  id: "art-direct-web",
  name: "Art Direct Web",
  description: "Design a web interface.",
  version: "1.0.0",
  autoEnabled: false,
  source: "builtin",
  installedAt: 0,
};

const records: BackendRecord[] = [];
let seedContractForNextGeneration: DesignContract | undefined;
let retryGateForNextBackend: Deferred<GenerateResult> | undefined;

const TEST_API_SETTINGS = {
  apiKey: "test-key",
  apiBaseUrl: "https://api.example.test",
  model: "test-model",
};

type GeneratorExtras = Pick<
  GeneratorOptions,
  "conversationId" | "authorizeToolCall"
>;

type RetryAction = (backend: FakeBackend) => Promise<GenerateResult>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface BackendRecord {
  backend: FakeBackend;
  config: unknown;
  events: GeneratorEvents | undefined;
  extras: GeneratorExtras;
  initialFiles: ProjectFiles;
  customToolHandler: GeneratorOptions["customToolHandler"] | undefined;
}

function resultFor(backend: FakeBackend): GenerateResult {
  return {
    files: { ...backend.getFiles() },
    messages: backend.getMessages(),
    text: "",
    aborted: false,
    maxIterationsReached: false,
  };
}

class FakeBackend implements GenerationBackend {
  private files: ProjectFiles;
  private messages: Message[] = [];
  private customTools: ToolSet = {};
  private readonly skillContext = createSkillActiveContext();
  private readonly conversationId: string | undefined;
  private mode: ExecutionMode = "chat";
  private allowedMcpAliases = new Set<string>();

  retryAction: RetryAction = async (backend) => resultFor(backend);
  retryCalls = 0;
  setFilesCalls: ProjectFiles[] = [];
  seedSubmission: unknown;
  systemPromptSuffix = "";

  constructor(
    initialFiles: ProjectFiles,
    conversationId: string | undefined,
    readonly customToolHandler: GeneratorOptions["customToolHandler"],
  ) {
    this.files = { ...initialFiles };
    this.conversationId = conversationId;
  }

  getFiles(): ProjectFiles {
    return this.files;
  }

  setFiles(files: ProjectFiles): void {
    this.files = { ...files };
    this.setFilesCalls.push({ ...files });
  }

  getMessages(): Message[] {
    return this.messages;
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

  setUntrustedReferenceContext(_reference: string): void {}

  setTools(_tools: ToolSet): void {}

  setReadOnlyMode(_readOnly: boolean): void {}

  setExecutionMode(mode: ExecutionMode): void {
    this.mode = mode;
  }

  setAllowedMcpAliases(aliases: ReadonlySet<string>): void {
    this.allowedMcpAliases = new Set(aliases);
  }

  getSkillContext() {
    return this.skillContext;
  }

  getRunContext(): ToolRunContext {
    return {
      runId: "test-run",
      conversationId: this.conversationId,
      mode: this.mode,
      platform: "web",
      runtime: "api",
      allowedMcpAliases: this.allowedMcpAliases,
      activeSkillIds: new Set(),
      approvedSkillScriptHashes: new Set(),
      policyVersion: "test",
    };
  }

  getCustomToolSet(): ToolSet {
    return this.customTools;
  }

  setCustomToolSet(tools: ToolSet): void {
    this.customTools = tools;
  }

  abort(): void {}

  async retry(): Promise<GenerateResult> {
    this.retryCalls += 1;
    return this.retryAction(this);
  }

  async generate(
    _userMessage: string,
    _attachments?: ResolvedAttachment[],
    _context?: GenerationRequestContext,
  ): Promise<GenerateResult> {
    if (seedContractForNextGeneration) {
      const contract = seedContractForNextGeneration;
      seedContractForNextGeneration = undefined;
      this.skillContext.activate(ART_DIRECT_SKILL);
      this.seedSubmission = await this.customToolHandler?.(
        "submit_design_contract",
        contract,
        toolContextFor(this),
      );
      if (
        typeof this.seedSubmission === "string" &&
        this.seedSubmission.startsWith("Error")
      ) {
        throw new Error(this.seedSubmission);
      }
    }
    return resultFor(this);
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function toolContextFor(backend: FakeBackend): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    toolCallId: "test-tool-call",
    run: backend.getRunContext(),
    skillContext: backend.getSkillContext(),
  };
}

function contractFor(changeMode: DesignChangeMode): DesignContract {
  return {
    surface_mode: "read",
    change_mode: changeMode,
    target: "Current interface",
    audience: "Test users",
    primary_goal: "Make the requested change",
    concept: "Clear and focused",
    system_id: null,
    translation: {
      foundations: "Semantic roles",
      composition: "Clear hierarchy",
      components: "Shared controls",
    },
    preserve: ["Existing behavior"],
    acceptance: ["The change is testable"],
  };
}

function configureRuntimeMocks(): void {
  runtimeMocks.buildForcedSkillsPromptSection.mockReturnValue("");
  runtimeMocks.buildMemoryPromptSection.mockReturnValue("");
  runtimeMocks.buildSkillsPromptSection.mockReturnValue("");
  runtimeMocks.buildToolSetForRun.mockReturnValue({});
  runtimeMocks.createSubagentDispatcher.mockReturnValue(vi.fn());
  runtimeMocks.generateSmartTitle.mockResolvedValue(null);
  runtimeMocks.getSkillRegistry.mockResolvedValue({
    getAutoEnabled: () => [],
    prepareForcedSkills: async () => [],
  });
  runtimeMocks.isSkillsAvailable.mockReturnValue(false);
  runtimeMocks.prepareRuntime.mockResolvedValue(EMPTY_MCP_RUNTIME);
  runtimeMocks.runCompress.mockResolvedValue(null);
  runtimeMocks.buildToolHandlers.mockImplementation(async (args) => ({
    customToolSet: {},
    providerToolNames: [],
    runtimePlatform: "web" as RuntimePlatform,
    combinedToolHandler: async (
      name: string,
      handlerArgs: unknown,
      context?: ToolExecutionContext,
    ) => {
      if (name === "submit_design_contract" && args.submitDesignContract) {
        return args.submitDesignContract(handlerArgs, context!);
      }
      return `Error: unknown tool "${name}"`;
    },
  }));
  runtimeMocks.createOpenAIGenerator.mockImplementation(
    (
      config: unknown,
      events: GeneratorEvents | undefined,
      initialFiles: ProjectFiles | undefined,
      _customTools: ToolSet | undefined,
      customToolHandler: GeneratorOptions["customToolHandler"] | undefined,
      extras: GeneratorExtras,
    ) => {
      const backend = new FakeBackend(
        initialFiles ?? {},
        extras.conversationId,
        customToolHandler,
      );
      const retryGate = retryGateForNextBackend;
      retryGateForNextBackend = undefined;
      if (retryGate) backend.retryAction = () => retryGate.promise;
      records.push({
        backend,
        config,
        events,
        extras,
        initialFiles: { ...(initialFiles ?? {}) },
        customToolHandler,
      });
      return backend;
    },
  );
}

function renderGenerator() {
  const settingsState = useSettingsStore.getState();
  const settings = {
    ...settingsState.ai,
    runtime: "api" as const,
    ...TEST_API_SETTINGS,
  };
  return renderHook(() => {
    const [isGenerating, setIsGenerating] = useState(false);
    return {
      isGenerating,
      ...useGenerator({
        settings,
        webSearchSettings: settingsState.webSearch,
        assetSearchSettings: settingsState.assetSearch,
        setMessages: useConversationStore.getState().setMessages,
        setFiles: useConversationStore.getState().setFiles,
        setIsGenerating,
        setTemplate: useConversationStore.getState().setTemplate,
        restartSandpack: vi.fn(),
      }),
    };
  });
}

describe("useGenerator retry Design policy", () => {
  beforeEach(() => {
    Object.values(runtimeMocks).forEach((mock) => mock.mockReset());
    records.length = 0;
    seedContractForNextGeneration = undefined;
    retryGateForNextBackend = undefined;
    configureRuntimeMocks();
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: true,
    });
    useSettingsStore.setState((state) => ({
      ai: {
        ...state.ai,
        runtime: "api",
        ...TEST_API_SETTINGS,
      },
    }));
    useInteractiveStore.setState({ pending: [] });
  });

  it("rebuilds Design retry policy from current files and persisted migrate mode", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "export const App = () => 'before';" });
    const hook = renderGenerator();
    seedContractForNextGeneration = contractFor("migrate");

    await act(async () => {
      await hook.result.current.generate("Build the interface", undefined, {
        designExpectedChangeModes: ["migrate"],
        skipAutomaticDesignReview: true,
      });
    });

    const request =
      useConversationStore.getState().conversations[conversationId].messages[0];
    expect(request.metadata?.designExpectedChangeModes).toEqual(["migrate"]);
    expect(records).toHaveLength(1);
    expect(records[0].backend.seedSubmission).toBe('{"accepted":true}');

    const currentFiles = {
      "src/App.tsx": "export const App = () => 'current';",
      "src/theme.css": ":root { --accent: rebeccapurple; }",
    };
    useConversationStore.getState().setFiles(currentFiles);

    const record = records[0];
    let beforeContract: string | void | undefined = undefined;
    let rejectedCreate: unknown;
    let afterContract: string | void | undefined = undefined;
    record.backend.retryAction = async (backend) => {
      // The selector remains interactive during a run. Changing it must not
      // relax the Design authority that was compiled for this retry.
      useConversationStore.getState().setWorkspaceMode("auto");
      beforeContract = await record.extras.authorizeToolCall?.(
        "write_file",
        { path: "src/App.tsx", content: "changed" },
        toolContextFor(backend),
      );
      backend.getSkillContext().activate(ART_DIRECT_SKILL);
      try {
        rejectedCreate = await record.customToolHandler?.(
          "submit_design_contract",
          contractFor("create"),
          toolContextFor(backend),
        );
      } catch (error) {
        rejectedCreate = error instanceof Error ? error.message : String(error);
      }
      const accepted = await record.customToolHandler?.(
        "submit_design_contract",
        contractFor("migrate"),
        toolContextFor(backend),
      );
      expect(accepted).toBe('{"accepted":true}');
      afterContract = await record.extras.authorizeToolCall?.(
        "write_file",
        { path: "src/App.tsx", content: "changed" },
        toolContextFor(backend),
      );
      return resultFor(backend);
    };

    await act(async () => {
      await hook.result.current.retry();
    });

    expect(record.backend.setFilesCalls.at(-1)).toEqual(currentFiles);
    expect(
      useConversationStore.getState().conversations[conversationId]
        .workspaceMode,
    ).toBe("auto");
    expect(beforeContract).toContain("Design contract required");
    expect(rejectedCreate).toContain("change_mode must be one of: migrate");
    expect(afterContract).toBeUndefined();
    expect(record.backend.retryCalls).toBe(1);
  });

  it("keeps the request-start Design profile across asynchronous preparation", async () => {
    useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "export const App = () => 'design';" });
    const hook = renderGenerator();
    const preparation = deferred<void>();
    seedContractForNextGeneration = contractFor("extend");
    let generation!: Promise<void>;

    await act(async () => {
      generation = hook.result.current.generate(
        "Refine the interface",
        undefined,
        {
          prepareRun: () => preparation.promise,
          skipAutomaticDesignReview: true,
        },
      );
      await Promise.resolve();
    });
    useConversationStore.getState().setWorkspaceMode("auto");
    preparation.resolve();
    await act(async () => generation);

    expect(records).toHaveLength(1);
    expect(records[0].backend.seedSubmission).toBe('{"accepted":true}');
    expect(records[0].backend.systemPromptSuffix).toContain("<design_mode>");
    expect(runtimeMocks.buildToolSetForRun).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "design", mode: "chat" }),
    );
  });

  it("retains Design context for Plan entered from Design", async () => {
    useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore.getState().setWorkspaceMode("plan");
    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "export const App = () => 'plan';" });
    const hook = renderGenerator();

    await act(async () => {
      await hook.result.current.generate(
        "Plan the interface change",
        undefined,
        {
          skipAutomaticDesignReview: true,
        },
      );
    });

    expect(records).toHaveLength(1);
    expect(records[0].backend.getRunContext().mode).toBe("plan");
    expect(records[0].backend.systemPromptSuffix).toContain("<design_mode>");
    expect(runtimeMocks.buildToolSetForRun).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "design", mode: "plan" }),
    );
  });

  it("starts a current automatic repair with the sealed Design profile", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "export const App = () => 'repair';" });
    const expectedRevision =
      useConversationStore.getState().conversations[conversationId];
    const hook = renderGenerator();

    await act(async () => {
      await hook.result.current.generate("Repair reviewed issue", undefined, {
        reusableDesignContract: contractFor("extend"),
        messageOrigin: "design_auto_fix",
        expectedConversationId: conversationId,
        expectedProjectSource: {
          files: expectedRevision.files,
          appliedSystemKey: "",
          workspaceMode: "design",
        },
        skipAutomaticDesignReview: true,
      });
    });

    expect(records).toHaveLength(1);
    expect(runtimeMocks.buildToolSetForRun).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "design", mode: "chat" }),
    );
    expect(
      useConversationStore
        .getState()
        .conversations[conversationId].messages.some(
          (message) => message.metadata?.origin === "design_auto_fix",
        ),
    ).toBe(true);
  });

  it("keeps the default Auto retry profile ungated by Design policy", async () => {
    useConversationStore.getState().createConversation();
    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "export const App = () => 'auto';" });
    const hook = renderGenerator();

    await act(async () => {
      await hook.result.current.generate("Initial request", undefined, {
        skipAutomaticDesignReview: true,
      });
    });

    expect(records).toHaveLength(1);
    const record = records[0];
    let authorization: string | void | undefined = undefined;
    record.backend.retryAction = async (backend) => {
      authorization = await record.extras.authorizeToolCall?.(
        "write_file",
        { path: "src/App.tsx", content: "changed" },
        toolContextFor(backend),
      );
      return resultFor(backend);
    };

    await act(async () => {
      await hook.result.current.retry();
    });

    expect(authorization).toBeUndefined();
    expect(record.backend.getRunContext().mode).toBe("chat");
  });

  it("refuses to replay a hidden automatic turn as a user retry", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setMessages([
      { role: "user", content: "Build the project" },
      {
        role: "user",
        content: "Automatic QA",
        metadata: { origin: "auto_qa" },
      },
      {
        role: "assistant",
        content: "Automatic QA failed",
        isError: true,
        errorRetryable: false,
      },
    ]);
    const hook = renderGenerator();

    await act(async () => {
      await hook.result.current.retry();
    });

    expect(records).toHaveLength(0);
    const messages =
      useConversationStore.getState().conversations[conversationId].messages;
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      isError: true,
      errorRetryable: false,
    });
    expect(messages.at(-1)?.content).not.toBe("Automatic QA failed");
  });

  it("does not let a retry continue after switching conversations", async () => {
    const firstConversationId = useConversationStore
      .getState()
      .createConversation();
    useConversationStore
      .getState()
      .setFilesForConversation(firstConversationId, {
        "src/App.tsx": "export const App = () => 'first';",
      });
    const secondConversationId = useConversationStore
      .getState()
      .createConversation();
    useConversationStore
      .getState()
      .setFilesForConversation(secondConversationId, {
        "src/App.tsx": "export const App = () => 'second';",
      });
    useConversationStore.getState().switchConversation(firstConversationId);
    const hook = renderGenerator();
    const secondConversationBefore =
      useConversationStore.getState().conversations[secondConversationId];
    const retryDeferred = deferred<GenerateResult>();
    retryGateForNextBackend = retryDeferred;
    let retryPromise!: Promise<void>;

    await act(async () => {
      retryPromise = hook.result.current.retry();
      await waitFor(() => expect(records).toHaveLength(1));
    });
    expect(records).toHaveLength(1);

    await act(async () => {
      useConversationStore.getState().switchConversation(secondConversationId);
      retryDeferred.resolve(resultFor(records[0].backend));
      await retryPromise;
    });

    expect(records[0].backend.retryCalls).toBe(1);
    expect(useConversationStore.getState().activeId).toBe(secondConversationId);
    expect(
      useConversationStore.getState().conversations[secondConversationId],
    ).toEqual(secondConversationBefore);
    expect(hook.result.current.isGenerating).toBe(false);
  });
});
