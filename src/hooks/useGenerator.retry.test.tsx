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
import { getT } from "../i18n";
import { SAAS_PROTOTYPE_BLUEPRINT_FIXTURE } from "../lib/design/fixtures/saas-prototype";

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
let generateActionForNextBackend:
  ((backend: FakeBackend) => Promise<GenerateResult>) | undefined;

const TEST_API_SETTINGS = {
  apiKey: "test-key",
  apiBaseUrl: "https://api.example.test",
  model: "test-model",
};

type GeneratorExtras = Pick<
  GeneratorOptions,
  "conversationId" | "authorizeToolCall" | "userInstructions"
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

function prototypeFiles(completedPages: number): ProjectFiles {
  const fixture = SAAS_PROTOTYPE_BLUEPRINT_FIXTURE;
  const complete = completedPages >= fixture.pages.length;
  return {
    "package.json": JSON.stringify({
      openBuilder: { profile: "complete-prototype", schemaVersion: 1 },
    }),
    "src/App.tsx": "export default function App() { return null; }",
    "design-project.json": JSON.stringify({
      ...fixture,
      revision: fixture.revision + completedPages,
      buildProgress: {
        ...fixture.buildProgress,
        status: complete ? "complete" : "in-progress",
        percent: complete
          ? 100
          : Math.floor((completedPages / fixture.pages.length) * 100),
        completedPageIds: fixture.pages
          .slice(0, completedPages)
          .map((page) => page.id),
      },
    }),
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
  generateAction = generateActionForNextBackend;
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
    return this.generateAction ? this.generateAction(this) : resultFor(this);
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
    generateActionForNextBackend = undefined;
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

  it.each(["generate", "continueTask"] as const)(
    "continues prototype batches past the old limit through %s",
    async (entry) => {
      useConversationStore.getState().createConversation();
      useConversationStore.getState().setFiles(prototypeFiles(0));
      useSettingsStore.setState((state) => ({
        system: { ...state.system, autoQaEnabled: false },
      }));
      let calls = 0;
      generateActionForNextBackend = async (backend) => {
        calls += 1;
        backend.setFiles(prototypeFiles(calls));
        return resultFor(backend);
      };
      const hook = renderGenerator();

      await act(async () => {
        if (entry === "generate")
          await hook.result.current.generate("Build all pages", undefined, {
            skipAutoQa: true,
            skipAutomaticDesignReview: true,
          });
        else await hook.result.current.continueTask();
      });

      expect(calls).toBe(6);
      expect(
        JSON.parse(records[0].backend.getFiles()["design-project.json"])
          .buildProgress.status,
      ).toBe("complete");
      expect(hook.result.current.isGenerating).toBe(false);
    },
  );

  it.each(["generate", "continueTask"] as const)(
    "reports an unchanged prototype checkpoint instead of repeatedly requesting %s",
    async (entry) => {
      const conversationId = useConversationStore
        .getState()
        .createConversation();
      useConversationStore.getState().setFiles(prototypeFiles(0));
      let calls = 0;
      generateActionForNextBackend = async (backend) => {
        calls += 1;
        if (calls > 2) throw new Error("unexpected repeated batch fixture");
        return resultFor(backend);
      };
      const hook = renderGenerator();

      await act(async () => {
        if (entry === "generate")
          await hook.result.current.generate("Build all pages", undefined, {
            skipAutoQa: true,
            skipAutomaticDesignReview: true,
          });
        else await hook.result.current.continueTask();
      });

      expect(calls).toBe(2);
      expect(hook.result.current.lastError?.message).toContain(
        getT().message.prototypeNoProgress,
      );
      expect(
        useConversationStore.getState().conversations[conversationId].files,
      ).toEqual(prototypeFiles(0));
    },
  );

  it.each(["aborted", "maxIterationsReached"] as const)(
    "preserves a prototype backend's controlled %s outcome",
    async (outcome) => {
      useConversationStore.getState().createConversation();
      useConversationStore.getState().setFiles(prototypeFiles(0));
      let calls = 0;
      generateActionForNextBackend = async (backend) => {
        calls += 1;
        return { ...resultFor(backend), [outcome]: calls === 2 };
      };
      const hook = renderGenerator();

      await act(async () => {
        await hook.result.current.generate("Build all pages", undefined, {
          skipAutoQa: true,
          skipAutomaticDesignReview: true,
        });
      });

      expect(calls).toBe(2);
      expect(hook.result.current.lastError).toBeNull();
    },
  );

  it("does not start another prototype batch after Stop at a batch boundary", async () => {
    useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles(prototypeFiles(0));
    let calls = 0;
    let stop = () => {};
    generateActionForNextBackend = async (backend) => {
      calls += 1;
      backend.setFiles(prototypeFiles(calls));
      stop();
      return resultFor(backend);
    };
    const hook = renderGenerator();
    stop = hook.result.current.stop;

    await act(async () => {
      await hook.result.current.generate("Build all pages", undefined, {
        skipAutoQa: true,
        skipAutomaticDesignReview: true,
      });
    });

    expect(calls).toBe(1);
    expect(hook.result.current.isGenerating).toBe(false);
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

  it("shows a continuation notice instead of completion after reaching the tool budget", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    const hook = renderGenerator();
    await act(async () => {
      await hook.result.current.generate("Build it", undefined, {
        skipAutomaticDesignReview: true,
      });
    });
    const record = records[0];
    record.backend.retryAction = async (backend) => {
      const result = { ...resultFor(backend), maxIterationsReached: true };
      record.events?.onComplete?.(result);
      return result;
    };

    await act(async () => {
      await hook.result.current.retry();
    });

    expect(hook.result.current.runState).toBe("idle");
    expect(hook.result.current.lastError).toBeNull();
    expect(
      useConversationStore
        .getState()
        .conversations[conversationId].messages.at(-1),
    ).toMatchObject({
      role: "assistant",
      content: getT().message.toolBudgetReached,
    });
    expect(record.backend.retryCalls).toBe(1);
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

  it("rejects stopped instance events after another run starts in the same conversation", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    const firstGate = deferred<GenerateResult>();
    const secondGate = deferred<GenerateResult>();
    generateActionForNextBackend = () => firstGate.promise;
    const hook = renderGenerator();
    let first!: Promise<void>;
    await act(async () => {
      first = hook.result.current.generate("First");
    });
    await waitFor(() => expect(records).toHaveLength(1));
    act(() => hook.result.current.stop());
    generateActionForNextBackend = () => secondGate.promise;
    let second!: Promise<void>;
    await act(async () => {
      second = hook.result.current.generate("Second");
    });
    await waitFor(() => expect(records).toHaveLength(2));
    const before =
      useConversationStore.getState().conversations[conversationId];
    act(() => {
      records[0].events?.onText?.("stale text");
      records[0].events?.onFileChange?.({ "stale.ts": "bad" }, []);
      records[0].events?.onError?.(new Error("old failure"));
      records[0].events?.onComplete?.(resultFor(records[0].backend));
    });
    expect(
      useConversationStore.getState().conversations[conversationId],
    ).toEqual(before);
    expect(hook.result.current.lastError).toBeNull();
    expect(hook.result.current.isGenerating).toBe(true);
    await act(async () => {
      firstGate.resolve(resultFor(records[0].backend));
      secondGate.resolve(resultFor(records[1].backend));
      await Promise.all([first, second]);
    });
  });

  it("persists supplements separately, commits once at the boundary, and cancels late ACKs", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    const gate = deferred<GenerateResult>();
    generateActionForNextBackend = () => gate.promise;
    const hook = renderGenerator();
    let generation!: Promise<void>;
    await act(async () => {
      generation = hook.result.current.generate("Build");
    });
    await waitFor(() => expect(records).toHaveLength(1));
    let accepted = false;
    await act(async () => {
      accepted = await hook.result.current.enqueueInstruction("Use blue");
    });
    expect(accepted).toBe(true);
    const store = useConversationStore.getState();
    expect(store.conversations[conversationId].messages).toHaveLength(1);
    expect(
      store.conversations[conversationId].pendingUserInstructions?.[0],
    ).toMatchObject({ content: "Use blue", status: "queued" });
    const record = records[0];
    let batch!: Awaited<
      ReturnType<NonNullable<GeneratorOptions["userInstructions"]>["prepare"]>
    >;
    await act(async () => {
      batch = await record.extras.userInstructions!.prepare(
        record.backend,
        new AbortController().signal,
      );
    });
    expect(batch?.instructions[0].message.content).toBe("Use blue");
    act(() => {
      expect(batch?.commit()).toBe(true);
      expect(batch?.commit()).toBe(false);
    });
    expect(
      useConversationStore
        .getState()
        .conversations[conversationId].messages.map((m) => m.content),
    ).toEqual(["Build", "Use blue"]);
    await act(async () => {
      await hook.result.current.enqueueInstruction("Also green");
      batch = await record.extras.userInstructions!.prepare(
        record.backend,
        new AbortController().signal,
      );
    });
    act(() => hook.result.current.stop());
    expect(batch?.commit()).toBe(false);
    expect(
      useConversationStore.getState().conversations[conversationId]
        .pendingUserInstructions?.[0].status,
    ).toBe("cancelled");
    await act(async () => {
      gate.resolve(resultFor(record.backend));
      await generation;
    });
  });

  it("seals pending tool results on Stop and preserves completed assistant work", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    const gate = deferred<GenerateResult>();
    generateActionForNextBackend = () => gate.promise;
    const hook = renderGenerator();
    let generation!: Promise<void>;
    await act(async () => {
      generation = hook.result.current.generate("Build");
    });
    await waitFor(() => expect(records).toHaveLength(1));
    act(() => {
      records[0].events?.onText?.("Retain this progress");
      records[0].events?.onToolCall?.("read_files", "pending");
      hook.result.current.stop();
    });
    const messages =
      useConversationStore.getState().conversations[conversationId].messages;
    expect(messages.some((m) => m.content === "Retain this progress")).toBe(
      true,
    );
    expect(messages.filter((m) => m.tool_call_id === "pending")).toHaveLength(
      1,
    );
    expect(messages.at(-1)?.toolOutput?.isError).toBe(true);
    await act(async () => {
      gate.resolve(resultFor(records[0].backend));
      await generation;
    });
  });

  it("retains the effective forced-skill union in supplemented history and Retry", async () => {
    const id = useConversationStore.getState().createConversation();
    const secondSkill = {
      ...ART_DIRECT_SKILL,
      id: "code-review",
      name: "Code Review",
    };
    runtimeMocks.isSkillsAvailable.mockReturnValue(true);
    runtimeMocks.getSkillRegistry.mockResolvedValue({
      getAutoEnabled: () => [],
      prepareForcedSkills: async (ids: string[]) =>
        ids.map((skillId) => ({
          entry:
            skillId === ART_DIRECT_SKILL.id ? ART_DIRECT_SKILL : secondSkill,
          content: skillId,
        })),
    });
    runtimeMocks.buildForcedSkillsPromptSection.mockImplementation((items) =>
      items.map((item: { entry: SkillEntry }) => item.entry.id).join("|"),
    );
    const gate = deferred<GenerateResult>();
    generateActionForNextBackend = () => gate.promise;
    const hook = renderGenerator();
    let running!: Promise<void>;
    await act(async () => {
      running = hook.result.current.generate("Build", undefined, {
        forcedSkillIds: [ART_DIRECT_SKILL.id],
      });
    });
    await waitFor(() => expect(records).toHaveLength(1));
    const record = records[0];
    await act(async () => {
      expect(await hook.result.current.enqueueInstruction("Keep layout")).toBe(
        true,
      );
      const textBatch = await record.extras.userInstructions!.prepare(
        record.backend,
        new AbortController().signal,
      );
      expect(textBatch?.instructions[0].message.forcedSkillIds).toEqual([
        ART_DIRECT_SKILL.id,
      ]);
      expect(textBatch?.commit()).toBe(true);
      expect(
        await hook.result.current.enqueueInstruction("", undefined, {
          forcedSkillIds: [secondSkill.id],
        }),
      ).toBe(true);
      const skillBatch = await record.extras.userInstructions!.prepare(
        record.backend,
        new AbortController().signal,
      );
      expect(skillBatch?.instructions[0].message.forcedSkillIds).toEqual([
        ART_DIRECT_SKILL.id,
        secondSkill.id,
      ]);
      expect(skillBatch?.instructions[0].message.content).toBeTruthy();
      expect(skillBatch?.commit()).toBe(true);
      gate.resolve(resultFor(record.backend));
      await running;
    });
    expect(
      useConversationStore.getState().conversations[id].messages.at(-1)
        ?.forcedSkillIds,
    ).toEqual([ART_DIRECT_SKILL.id, secondSkill.id]);
    await act(async () => {
      await hook.result.current.retry();
    });
    expect(
      record.backend
        .getSkillContext()
        .get()
        ?.skills.map((skill) => skill.skillId),
    ).toEqual([ART_DIRECT_SKILL.id, secondSkill.id]);
  });

  it("drains updates submitted during Auto QA after restoring foreground mode", async () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "export const App=1" });
    useSettingsStore.setState((state) => ({
      system: { ...state.system, autoQaEnabled: true },
    }));
    const qaGate = deferred<GenerateResult>();
    let calls = 0;
    generateActionForNextBackend = async (backend) => {
      calls++;
      if (calls === 2) return qaGate.promise;
      if (calls === 3) {
        expect(backend.getRunContext().mode).toBe("chat");
        const batch = await records[0].extras.userInstructions!.prepare(
          backend,
          new AbortController().signal,
        );
        expect(batch?.instructions[0].message.content).toBe(
          "Also change the header",
        );
        expect(batch?.commit()).toBe(true);
      }
      return resultFor(backend);
    };
    const hook = renderGenerator();
    let running!: Promise<void>;
    await act(async () => {
      running = hook.result.current.generate("Build");
    });
    await waitFor(() => expect(calls).toBe(2));
    await act(async () => {
      expect(
        await hook.result.current.enqueueInstruction("Also change the header"),
      ).toBe(true);
    });
    await act(async () => {
      qaGate.resolve(resultFor(records[0].backend));
      await running;
    });
    expect(calls).toBe(4);
    expect(
      useConversationStore.getState().conversations[id].pendingUserInstructions,
    ).toEqual([]);
    expect(
      useConversationStore
        .getState()
        .conversations[id].messages.filter(
          (message) => message.content === "Also change the header",
        ),
    ).toHaveLength(1);
  });

  it("ignores a generator constructed after Stop while the next run is preparing", async () => {
    const id = useConversationStore.getState().createConversation();
    const original = runtimeMocks.buildToolHandlers.getMockImplementation()!;
    const buildGate = deferred<Awaited<ReturnType<typeof original>>>();
    const nextPreparation = deferred<void>();
    runtimeMocks.buildToolHandlers.mockImplementationOnce(
      () => buildGate.promise,
    );
    const hook = renderGenerator();
    let first!: Promise<void>;
    await act(async () => {
      first = hook.result.current.generate("Old");
    });
    await waitFor(() =>
      expect(runtimeMocks.buildToolHandlers).toHaveBeenCalledOnce(),
    );
    act(() => hook.result.current.stop());
    let second!: Promise<void>;
    await act(async () => {
      second = hook.result.current.generate("New", undefined, {
        prepareRun: () => nextPreparation.promise,
      });
    });
    await act(async () => {
      buildGate.resolve(
        await original(runtimeMocks.buildToolHandlers.mock.calls[0][0]),
      );
      await first;
    });
    const before = useConversationStore.getState().conversations[id];
    act(() => {
      records[0]?.events?.onText?.("stale construction");
      records[0]?.events?.onFileChange?.({ "bad.ts": "bad" }, []);
    });
    expect(useConversationStore.getState().conversations[id]).toEqual(before);
    await act(async () => {
      nextPreparation.resolve();
      await second;
    });
    expect(records).toHaveLength(2);
  });

  it("keeps the original run alive if a queued skill disappears before delivery", async () => {
    const id = useConversationStore.getState().createConversation();
    const gate = deferred<GenerateResult>();
    const prepareForcedSkills = vi.fn(async () => [
      { entry: ART_DIRECT_SKILL, content: "skill" },
    ]);
    runtimeMocks.isSkillsAvailable.mockReturnValue(true);
    runtimeMocks.getSkillRegistry.mockResolvedValue({
      getAutoEnabled: () => [],
      prepareForcedSkills,
    });
    generateActionForNextBackend = () => gate.promise;
    const hook = renderGenerator();
    let running!: Promise<void>;
    await act(async () => {
      running = hook.result.current.generate("Build");
    });
    await waitFor(() => expect(records).toHaveLength(1));
    await act(async () => {
      expect(
        await hook.result.current.enqueueInstruction("Review", undefined, {
          forcedSkillIds: [ART_DIRECT_SKILL.id],
        }),
      ).toBe(true);
    });
    prepareForcedSkills.mockRejectedValueOnce(new Error("Skill removed"));
    await act(async () => {
      expect(
        await records[0].extras.userInstructions!.prepare(
          records[0].backend,
          new AbortController().signal,
        ),
      ).toBeNull();
    });
    expect(hook.result.current.isGenerating).toBe(true);
    expect(hook.result.current.lastError).toBeNull();
    expect(
      useConversationStore.getState().conversations[id]
        .pendingUserInstructions?.[0].status,
    ).toBe("failed");
    await act(async () => {
      gate.resolve(resultFor(records[0].backend));
      await running;
    });
  });
});
