// @vitest-environment jsdom

import type { ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../types";
import { BUILTIN_TOOLS } from "../ai/tools-schema";
import type { GeneratorEvents } from "../ai/generator-types";
import { DISPATCH_SUBAGENT_TOOL } from "../tools/subagent-tool";
import { computeConversationFingerprint } from "./context";
import { createLocalAgentGenerator, runLocalUtilityText } from "./generator";
import type { LocalAgentEvent, LocalAgentStartRequest } from "./types";
import type { LocalAgentProvider } from "./providers";
import { buildCustomSystemPromptSection } from "../ai/custom-system-prompt";

const localAgentMocks = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  resolve: vi.fn(),
}));

const attachmentMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("./tauri", () => ({
  queryLocalAgentSupport: vi.fn(async () => true),
  resetLocalAgentSupportCache: vi.fn(),
  supportsLocalAgents: vi.fn(async () => true),
  startLocalAgent: localAgentMocks.start,
  cancelLocalAgent: localAgentMocks.cancel,
  resolveLocalAgentTool: localAgentMocks.resolve,
}));

vi.mock("../attachments/store", () => ({
  resolveAttachmentForModel: attachmentMocks.resolve,
}));

function baseConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation-1",
    title: "Local CLI",
    messages: [],
    files: {},
    template: "vite-react-ts",
    isProjectInitialized: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function generator(
  conversation: Conversation,
  saveSession = vi.fn(),
  onText = vi.fn(),
  options: {
    tools?: ToolSet;
    customToolHandler?: (name: string, args: unknown) => Promise<string>;
    maxIterations?: number;
    dispatchSubagent?: (
      name: string,
      task: string,
    ) => Promise<{ text: string }>;
    requestPlanApproval?: () => Promise<{ approved: boolean }>;
    onPlanApproved?: () => ToolSet;
    authorizeToolCall?: (name: string) => string | undefined;
    executionMode?: "chat" | "plan";
    nativeSearch?: boolean;
    provider?: LocalAgentProvider;
    onFileChange?: NonNullable<GeneratorEvents["onFileChange"]>;
    onLocalCliPrepared?: NonNullable<GeneratorEvents["onLocalCliPrepared"]>;
    onError?: NonNullable<GeneratorEvents["onError"]>;
  } = {},
) {
  const tools = options.tools ?? {};
  const instance = createLocalAgentGenerator(
    {
      provider: options.provider ?? "codex",
      nativeSearch: options.nativeSearch ?? false,
      conversationId: conversation.id,
      getConversation: () => conversation,
      saveSession,
    },
    {
      onText,
      onFileChange: options.onFileChange,
      onLocalCliPrepared: options.onLocalCliPrepared,
      onError: options.onError,
    },
    conversation.files,
    tools,
    options.customToolHandler,
    {
      tools,
      executionMode: options.executionMode ?? "chat",
      runtimePlatform: "desktop",
      systemPrompt: "Open Builder system",
      maxIterations: options.maxIterations,
      dispatchSubagent: options.dispatchSubagent
        ? async (name, task) => options.dispatchSubagent!(name, task)
        : undefined,
      requestPlanApproval: options.requestPlanApproval
        ? async () => options.requestPlanApproval!()
        : undefined,
      onPlanApproved: options.onPlanApproved,
      authorizeToolCall: options.authorizeToolCall,
    },
  );
  instance.syncMessages(conversation.messages);
  return { instance, saveSession, onText };
}

function completeRun(
  onEvent: (event: LocalAgentEvent) => void,
  runId: string,
  sessionId = "thread-1",
) {
  onEvent({
    type: "prepared",
    compatibilityKey: `compat-${sessionId}`,
    installationFingerprint: "install-1",
    cliVersion: "codex-cli 1.0.0",
    actualModel: "gpt-5.6-sol",
    actualEffort: "high",
    resumed: false,
  });
  onEvent({
    type: "session",
    sessionId,
    cliVersion: "codex-cli 1.0.0",
  });
  onEvent({ type: "textDelta", delta: "Built locally" });
  onEvent({ type: "done", aborted: false, sessionId });
  return runId;
}

describe("LocalAgentGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localAgentMocks.resolve.mockResolvedValue(undefined);
    localAgentMocks.cancel.mockResolvedValue(true);
    attachmentMocks.resolve.mockRejectedValue(
      new Error("attachment unavailable"),
    );
  });

  it("normalizes local CLI deltas and saves provider session metadata", async () => {
    let request: LocalAgentStartRequest | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() => completeRun(onEvent, "run-1"));
        return "run-1";
      },
    );
    const context = baseConversation();
    const { instance, onText, saveSession } = generator(context);

    const result = await instance.generate("Build it");

    expect(request).toMatchObject({
      provider: "codex",
      prompt: "Build it",
      mode: "chat",
      tools: [],
      nativeSearch: false,
      maxToolCalls: 30,
    });
    expect(onText).toHaveBeenCalledWith("Built locally");
    expect(result.text).toBe("Built locally");
    expect(result.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Built locally",
    });
    expect(saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        sessionId: "thread-1",
        cliVersion: "codex-cli 1.0.0",
        compatibilityKey: "compat-thread-1",
        installationFingerprint: "install-1",
      }),
    );
    expect(request).toMatchObject({
      scope: { kind: "conversation", id: "conversation-1" },
      sessionCompatibilityKey: undefined,
    });

    instance.abort();
    expect(localAgentMocks.cancel).not.toHaveBeenCalled();
  });

  it("persists safe local CLI lifecycle telemetry on the assistant message", async () => {
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        queueMicrotask(() => {
          onEvent({ type: "status", state: "streaming" });
          onEvent({ type: "textDelta", delta: "Done" });
          onEvent({ type: "usage", inputTokens: 8, outputTokens: 2 });
          onEvent({ type: "warning", message: "Gateway fallback" });
          onEvent({
            type: "done",
            aborted: false,
            sessionId: "thread-telemetry",
          });
        });
        return "run-telemetry";
      },
    );

    const { instance } = generator(baseConversation());
    await instance.generate("Run with telemetry");

    expect(instance.getMessages().at(-1)).toMatchObject({
      role: "assistant",
      metadata: {
        localCli: {
          provider: "codex",
          status: { state: "streaming" },
          usage: { inputTokens: 8, outputTokens: 2 },
          warnings: ["Gateway fallback"],
        },
      },
    });
  });

  it("reports prepared metadata so the observation cache can be refreshed", async () => {
    const onLocalCliPrepared = vi.fn();
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        queueMicrotask(() => completeRun(onEvent, "run-prepared"));
        return "run-prepared";
      },
    );
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      onLocalCliPrepared,
    });

    await instance.generate("Build with the local CLI");

    expect(onLocalCliPrepared).toHaveBeenCalledWith("codex", {
      compatibilityKey: "compat-thread-1",
      installationFingerprint: "install-1",
      cliVersion: "codex-cli 1.0.0",
      actualModel: "gpt-5.6-sol",
      actualEffort: "high",
      resumed: false,
    });
  });

  it("writes project files through the Host bridge and reports FileChange", async () => {
    const onFileChange = vi.fn();
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        queueMicrotask(() => {
          onEvent({
            type: "toolRequest",
            runId: "run-write",
            callId: "write-file",
            name: "write_file",
            arguments: {
              path: "src/App.tsx",
              content: "export default function App() { return null; }",
            },
          });
          onEvent({ type: "done", aborted: false });
        });
        return "run-write";
      },
    );
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      tools: { write_file: BUILTIN_TOOLS.write_file },
      onFileChange,
    });

    await instance.generate("Create the app entrypoint");

    expect(instance.getFiles()).toEqual({
      "src/App.tsx": "export default function App() { return null; }",
    });
    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        "src/App.tsx": "export default function App() { return null; }",
      }),
      [expect.objectContaining({ path: "src/App.tsx", action: "created" })],
    );
    expect(localAgentMocks.resolve).toHaveBeenCalledWith(
      "run-write",
      "write-file",
      expect.objectContaining({ isError: undefined }),
    );
  });

  it("enforces host write authorization for local CLI tool requests", async () => {
    const authorizeToolCall = vi.fn((name: string) =>
      name === "write_file" ? "Design contract required." : undefined,
    );
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        queueMicrotask(() => {
          onEvent({
            type: "toolRequest",
            runId: "run-authorization",
            callId: "write-before-contract",
            name: "write_file",
            arguments: {
              path: "src/App.tsx",
              content: "export default function App() { return null; }",
            },
          });
          onEvent({ type: "done", aborted: false });
        });
        return "run-authorization";
      },
    );
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      tools: { write_file: BUILTIN_TOOLS.write_file },
      authorizeToolCall,
    });

    await instance.generate("Write before submitting a Design contract");

    expect(instance.getFiles()).toEqual({});
    expect(authorizeToolCall).toHaveBeenCalledWith(
      "write_file",
      expect.objectContaining({ path: "src/App.tsx" }),
      expect.anything(),
    );
    expect(localAgentMocks.resolve).toHaveBeenCalledWith(
      "run-authorization",
      "write-before-contract",
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("Design contract required"),
      }),
    );
  });

  it("cannot execute a tool omitted from the run authority snapshot", async () => {
    let request: LocalAgentStartRequest | undefined;
    const customToolHandler = vi.fn(async () => "must not execute");
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() => {
          onEvent({
            type: "toolRequest",
            runId: "run-hidden-tool",
            callId: "hidden-tool-call",
            name: "screenshot_to_code",
            arguments: { url: "https://example.test" },
          });
          onEvent({ type: "done", aborted: false });
        });
        return "run-hidden-tool";
      },
    );
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      tools: { screenshot_to_code: BUILTIN_TOOLS.write_file },
      customToolHandler,
    });

    await instance.generate("Attempt a hidden tool");

    expect(request?.tools).toEqual([]);
    expect(customToolHandler).not.toHaveBeenCalled();
    expect(localAgentMocks.resolve).toHaveBeenCalledWith(
      "run-hidden-tool",
      "hidden-tool-call",
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("not authorized"),
      }),
    );
  });

  it("includes the shared custom prompt suffix in Local CLI requests", async () => {
    let request: LocalAgentStartRequest | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() => completeRun(onEvent, "run-custom"));
        return "run-custom";
      },
    );
    const { instance } = generator(baseConversation());
    instance.setSystemPromptSuffix(
      buildCustomSystemPromptSection("[custom-local-cli]"),
    );

    await instance.generate("Build it");

    expect(request?.systemPrompt).toContain("[custom-local-cli]");
    expect(request?.systemPrompt).toContain("not the user's ProjectFiles");
    expect(request?.systemPrompt).toContain(
      "does not make the Open Builder project read-only",
    );
  });

  it("reports prepared metadata from Local CLI utility runs", async () => {
    const onPrepared = vi.fn();
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        queueMicrotask(() => completeRun(onEvent, "run-utility-prepared"));
        return "run-utility-prepared";
      },
    );

    await runLocalUtilityText(
      { provider: "codex", model: "", effort: "" },
      "Create a title",
      "Original request",
      { onPrepared },
    );

    expect(onPrepared).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ installationFingerprint: "install-1" }),
    );
  });

  it("aborts a local utility title call when its timeout expires", async () => {
    localAgentMocks.start.mockResolvedValue("utility-timeout-run");

    await expect(
      runLocalUtilityText(
        { provider: "codex", model: "", effort: "" },
        "Create a title",
        "Original request",
        { timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(localAgentMocks.cancel).toHaveBeenCalledWith("utility-timeout-run");
  });

  it("aborts a running local utility call from an external signal", async () => {
    localAgentMocks.start.mockResolvedValue("utility-abort-run");
    const controller = new AbortController();
    const pending = runLocalUtilityText(
      { provider: "codex", model: "", effort: "" },
      "Create a title",
      "Original request",
      { signal: controller.signal },
    );
    await vi.waitFor(() =>
      expect(localAgentMocks.start).toHaveBeenCalledOnce(),
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() =>
      expect(localAgentMocks.cancel).toHaveBeenCalledWith("utility-abort-run"),
    );
  });

  it("resumes only when the authoritative transcript fingerprint matches", async () => {
    const messages: Conversation["messages"] = [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier response" },
    ];
    const files = { "src/App.tsx": "export default function App() {}" };
    const fingerprint = await computeConversationFingerprint({
      messages,
      files,
      compressedContext: undefined,
      template: "vite-react-ts",
    });
    const matching = baseConversation({
      messages,
      files,
      localAgentSessions: {
        codex: {
          provider: "codex",
          sessionId: "thread-existing",
          transcriptFingerprint: fingerprint,
          compatibilityKey: "compat-thread-existing",
          cliVersion: "codex-cli 1.0.0",
          updatedAt: 1,
        },
      },
    });
    const requests: LocalAgentStartRequest[] = [];
    localAgentMocks.start.mockImplementation(
      async (
        request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        requests.push(request);
        queueMicrotask(() => completeRun(onEvent, "run-1", "thread-existing"));
        return "run-1";
      },
    );

    await generator(matching).instance.generate("Next request");
    expect(requests[0].sessionId).toBe("thread-existing");
    expect(requests[0].bootstrapContext).toContain("Earlier request");

    requests.length = 0;
    const mismatched = baseConversation({
      ...matching,
      localAgentSessions: {
        codex: {
          ...matching.localAgentSessions!.codex!,
          transcriptFingerprint: "stale-fingerprint",
        },
      },
    });
    await generator(mismatched).instance.generate("Next request");
    expect(requests[0].sessionId).toBeUndefined();
    expect(requests[0].bootstrapContext).toContain("Earlier request");
  });

  it("excludes the optimistically stored current request by canonical index", async () => {
    const previousMessages: Conversation["messages"] = [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier response" },
    ];
    const fingerprint = await computeConversationFingerprint({
      messages: previousMessages,
      files: {},
      compressedContext: undefined,
      template: "vite-react-ts",
    });
    const currentPrompt = "Next request with expanded context";
    const storedConversation = baseConversation({
      messages: [
        ...previousMessages,
        { role: "user", content: "Next request" },
      ],
      localAgentSessions: {
        codex: {
          provider: "codex",
          sessionId: "thread-existing",
          transcriptFingerprint: fingerprint,
          compatibilityKey: "compat-thread-existing",
          cliVersion: "codex-cli 1.0.0",
          updatedAt: 1,
        },
      },
    });
    let request: LocalAgentStartRequest | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() =>
          completeRun(onEvent, "run-indexed", "thread-existing"),
        );
        return "run-indexed";
      },
    );
    const instance = createLocalAgentGenerator(
      {
        provider: "codex",
        nativeSearch: false,
        conversationId: storedConversation.id,
        getConversation: () => storedConversation,
      },
      {},
      storedConversation.files,
      {},
      undefined,
      {
        tools: {},
        executionMode: "chat",
        runtimePlatform: "desktop",
        systemPrompt: "Open Builder system",
      },
    );
    instance.syncMessages(previousMessages);

    await instance.generate(currentPrompt, [], {
      currentMessageIndex: previousMessages.length,
    });

    expect(request?.sessionId).toBe("thread-existing");
    expect(request?.bootstrapContext).toContain("Earlier request");
    expect(request?.bootstrapContext).not.toContain("Next request");
    expect(request?.bootstrapContext).not.toContain(currentPrompt);
    expect(request?.prompt).toBe(currentPrompt);
  });

  it("never resumes a session owned by another CLI provider", async () => {
    const messages: Conversation["messages"] = [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier response" },
    ];
    const fingerprint = await computeConversationFingerprint({
      messages,
      files: {},
      compressedContext: undefined,
      template: "vite-react-ts",
    });
    const conversation = baseConversation({
      messages,
      localAgentSessions: {
        codex: {
          provider: "codex",
          sessionId: "codex-thread",
          transcriptFingerprint: fingerprint,
          compatibilityKey: "compat-codex-thread",
          cliVersion: "codex-cli 1.0.0",
          updatedAt: 1,
        },
      },
    });
    let request: LocalAgentStartRequest | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() => completeRun(onEvent, "run-pi", "pi-session"));
        return "run-pi";
      },
    );

    await generator(conversation, vi.fn(), vi.fn(), {
      provider: "pi",
    }).instance.generate("Continue with Pi");

    expect(request).toMatchObject({ provider: "pi" });
    expect(request?.sessionId).toBeUndefined();
    expect(request?.bootstrapContext).toContain("Earlier request");
  });

  it("resumes Antigravity only from its provider-scoped conversation", async () => {
    const messages: Conversation["messages"] = [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier response" },
    ];
    const fingerprint = await computeConversationFingerprint({
      messages,
      files: {},
      compressedContext: undefined,
      template: "vite-react-ts",
    });
    const conversation = baseConversation({
      messages,
      localAgentSessions: {
        codex: {
          provider: "codex",
          sessionId: "codex-thread",
          transcriptFingerprint: fingerprint,
          cliVersion: "codex-cli 1.0.0",
          updatedAt: 1,
        },
        antigravity: {
          provider: "antigravity",
          sessionId: "agy-conversation",
          transcriptFingerprint: fingerprint,
          compatibilityKey: "compat-agy-conversation",
          cliVersion: "agy 1.1.22",
          updatedAt: 2,
        },
      },
    });
    let request: LocalAgentStartRequest | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() =>
          completeRun(onEvent, "run-antigravity", "agy-conversation"),
        );
        return "run-antigravity";
      },
    );

    await generator(conversation, vi.fn(), vi.fn(), {
      provider: "antigravity",
    }).instance.generate("Continue with Antigravity");

    expect(request).toMatchObject({
      provider: "antigravity",
      sessionId: "agy-conversation",
    });
    expect(request?.bootstrapContext).toContain("Earlier request");
  });

  it("rebuilds once after a pre-activity resume failure and never replays other failures", async () => {
    const messages: Conversation["messages"] = [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier response" },
    ];
    const fingerprint = await computeConversationFingerprint({
      messages,
      files: {},
      compressedContext: undefined,
      template: "vite-react-ts",
    });
    const conversation = baseConversation({
      messages,
      localAgentSessions: {
        codex: {
          provider: "codex",
          sessionId: "missing-thread",
          transcriptFingerprint: fingerprint,
          compatibilityKey: "compat-missing-thread",
          cliVersion: "codex-cli 1.0.0",
          updatedAt: 1,
        },
      },
    });
    let calls = 0;
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        calls += 1;
        queueMicrotask(() => {
          if (calls === 1) {
            onEvent({
              type: "error",
              message: "thread not found while resuming",
              retryable: false,
              failure: {
                code: "sessionUnavailable",
                phase: "handshake",
                provider: "codex",
                safeMessage:
                  "The saved local CLI session is no longer available.",
                diagnosticId: "diag-session-missing",
                hadActivity: false,
                hadHostSideEffect: false,
                retryPolicy: "freshSessionSafe",
              },
            });
            onEvent({ type: "done", aborted: false });
          } else {
            completeRun(onEvent, "run-2", "thread-new");
          }
        });
        return `run-${calls}`;
      },
    );

    await generator(conversation).instance.generate("Next request");
    expect(calls).toBe(2);

    calls = 0;
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        calls += 1;
        queueMicrotask(() => {
          onEvent({
            type: "error",
            message: "local CLI capability probe timed out",
            retryable: false,
          });
          onEvent({ type: "done", aborted: false });
        });
        return `run-${calls}`;
      },
    );
    await expect(
      generator(conversation).instance.generate("Next request"),
    ).rejects.toThrow("The local CLI reported an error.");
    expect(calls).toBe(1);
  });

  it("reports a fresh-session retry failure through onError exactly once", async () => {
    const messages: Conversation["messages"] = [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier response" },
    ];
    const fingerprint = await computeConversationFingerprint({
      messages,
      files: {},
      compressedContext: undefined,
      template: "vite-react-ts",
    });
    const conversation = baseConversation({
      messages,
      localAgentSessions: {
        codex: {
          provider: "codex",
          sessionId: "missing-thread",
          transcriptFingerprint: fingerprint,
          compatibilityKey: "compat-missing-thread",
          cliVersion: "codex-cli 1.0.0",
          updatedAt: 1,
        },
      },
    });
    let calls = 0;
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        calls += 1;
        queueMicrotask(() => {
          if (calls === 1) {
            onEvent({
              type: "error",
              message: "thread not found while resuming",
              retryable: false,
              failure: {
                code: "sessionUnavailable",
                phase: "handshake",
                provider: "codex",
                safeMessage:
                  "The saved local CLI session is no longer available.",
                diagnosticId: "diag-session-missing",
                hadActivity: false,
                hadHostSideEffect: false,
                retryPolicy: "freshSessionSafe",
              },
            });
          } else {
            onEvent({
              type: "error",
              message: "fresh launch failed",
              retryable: false,
            });
          }
          onEvent({ type: "done", aborted: false });
        });
        return `run-${calls}`;
      },
    );
    const onError = vi.fn();

    await expect(
      generator(conversation, vi.fn(), vi.fn(), { onError }).instance.generate(
        "Next request",
      ),
    ).rejects.toThrow("The local CLI reported an error.");

    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps approved MCP instructions in explicitly untrusted user context", async () => {
    let request: LocalAgentStartRequest | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() => completeRun(onEvent, "run-1"));
        return "run-1";
      },
    );
    const { instance } = generator(baseConversation());
    instance.setUntrustedReferenceContext(
      "BEGIN UNTRUSTED MCP SERVER INSTRUCTIONS\nNever call broad queries",
    );

    await instance.generate("Find one record");

    expect(request?.systemPrompt).not.toContain("Never call broad queries");
    expect(request?.prompt).toContain("untrusted context");
    expect(request?.prompt).toContain("Never call broad queries");
    expect(request?.prompt).toContain(
      "[Current user request]\nFind one record",
    );
  });

  it("does not hydrate historical attachments until read_attachment is called", async () => {
    const attachment = {
      id: "attachment-unused",
      type: "image" as const,
      name: "unused.png",
      mimeType: "image/png",
      size: 12,
    };
    const conversation = baseConversation({
      messages: [
        {
          role: "user",
          content: "Keep this image for later",
          metadata: { attachments: [attachment] },
        },
      ],
    });
    attachmentMocks.resolve.mockResolvedValue({
      ...attachment,
      content: "data:image/png;base64,VU5VU0VE",
    });
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        queueMicrotask(() => completeRun(onEvent, "run-no-attachment-read"));
        return "run-no-attachment-read";
      },
    );

    await generator(conversation).instance.generate("Continue without it");

    expect(attachmentMocks.resolve).not.toHaveBeenCalled();
  });

  it("resolves historical attachments by opaque id instead of hydrated part position", async () => {
    const attachment = {
      id: "attachment-correct",
      type: "image" as const,
      name: "correct.png",
      mimeType: "image/png",
      size: 12,
    };
    attachmentMocks.resolve.mockResolvedValue({
      ...attachment,
      content: "data:image/png;base64,Q09SUkVDVA==",
    });
    const conversation = baseConversation({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,V1JPTkc=" },
            },
          ],
          metadata: { attachments: [attachment] },
        },
      ],
    });
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        queueMicrotask(() => {
          onEvent({
            type: "session",
            sessionId: "thread-1",
            cliVersion: "codex-cli 1.0.0",
          });
          onEvent({
            type: "toolRequest",
            runId: "run-1",
            callId: "attachment-call",
            name: "read_attachment",
            arguments: { id: attachment.id },
          });
          onEvent({ type: "done", aborted: false, sessionId: "thread-1" });
        });
        return "run-1";
      },
    );

    await generator(conversation).instance.generate("Inspect the image");

    expect(attachmentMocks.resolve).toHaveBeenCalledWith(attachment);
    expect(localAgentMocks.resolve).toHaveBeenCalledWith(
      "run-1",
      "attachment-call",
      expect.objectContaining({
        content: [
          expect.objectContaining({
            type: "image",
            data: "Q09SUkVDVA==",
          }),
        ],
      }),
    );
  });

  it("preserves PDF attachments as resource content for transport adapters", async () => {
    const attachment = {
      id: "attachment-pdf",
      type: "file" as const,
      name: "brief.pdf",
      mimeType: "application/pdf",
      size: 8,
      content: "data:application/pdf;base64,JVBERi0xLjQ=",
    };
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        queueMicrotask(() => {
          onEvent({
            type: "toolRequest",
            runId: "run-pdf",
            callId: "attachment-pdf-call",
            name: "read_attachment",
            arguments: { id: attachment.id },
          });
          onEvent({ type: "done", aborted: false });
        });
        return "run-pdf";
      },
    );

    await generator(baseConversation()).instance.generate("Inspect the PDF", [
      attachment,
    ]);

    expect(localAgentMocks.resolve).toHaveBeenCalledWith(
      "run-pdf",
      "attachment-pdf-call",
      expect.objectContaining({
        content: [
          expect.objectContaining({
            type: "resource",
            mimeType: "application/pdf",
            blob: "JVBERi0xLjQ=",
          }),
        ],
      }),
    );
  });

  it("uses a non-replaying continuation prompt only after failed activity", async () => {
    const requests: LocalAgentStartRequest[] = [];
    let calls = 0;
    localAgentMocks.start.mockImplementation(
      async (
        request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        requests.push(request);
        calls += 1;
        queueMicrotask(() => {
          if (calls === 1) {
            onEvent({
              type: "nativeTool",
              callId: "search-1",
              name: "WebSearch",
              phase: "started",
            });
            onEvent({
              type: "error",
              message: "provider stream failed",
              retryable: false,
            });
            onEvent({ type: "done", aborted: false });
          } else {
            completeRun(onEvent, `run-${calls}`, `thread-${calls}`);
          }
        });
        return `run-${calls}`;
      },
    );
    const { instance } = generator(baseConversation());

    await expect(instance.generate("Create the report")).rejects.toThrow(
      "The local CLI reported an error.",
    );
    await instance.retry();

    expect(requests[1].prompt).toContain("Do not repeat completed tool calls");
    expect(requests[1].prompt).not.toBe("Create the report");

    calls = 0;
    requests.length = 0;
    localAgentMocks.start.mockImplementation(
      async (
        request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        requests.push(request);
        calls += 1;
        queueMicrotask(() => {
          if (calls === 1) {
            onEvent({
              type: "error",
              message: "provider unavailable",
              retryable: false,
            });
            onEvent({ type: "done", aborted: false });
          } else {
            completeRun(onEvent, `run-${calls}`, `thread-${calls}`);
          }
        });
        return `run-${calls}`;
      },
    );
    const noActivity = generator(baseConversation()).instance;
    await expect(noActivity.generate("Keep the original")).rejects.toThrow(
      "The local CLI reported an error.",
    );
    await noActivity.retry();
    expect(requests[1].prompt).toBe("Keep the original");
    expect(requests[1].bootstrapContext).not.toContain("Keep the original");
  });

  it("passes the remaining shared tool budget into plan continuation", async () => {
    const starts: LocalAgentStartRequest[] = [];
    let calls = 0;
    localAgentMocks.start.mockImplementation(
      async (
        request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        starts.push(request);
        calls += 1;
        const current = calls;
        queueMicrotask(() => {
          onEvent({
            type: "session",
            sessionId: "thread-plan",
            cliVersion: "codex-cli 1.0.0",
          });
          onEvent(
            current === 1
              ? {
                  type: "toolRequest",
                  runId: `run-${current}`,
                  callId: "approve-plan",
                  name: "exit_plan_mode",
                  arguments: { plan: "Implement it" },
                }
              : {
                  type: "toolRequest",
                  runId: `run-${current}`,
                  callId: "extra-tool",
                  name: "list_files",
                  arguments: {},
                },
          );
          onEvent({
            type: "done",
            aborted: false,
            sessionId: "thread-plan",
          });
        });
        return `run-${current}`;
      },
    );
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      tools: { exit_plan_mode: BUILTIN_TOOLS.exit_plan_mode },
      executionMode: "plan",
      maxIterations: 2,
      requestPlanApproval: async () => ({ approved: true }),
      onPlanApproved: () => ({
        list_files: BUILTIN_TOOLS.list_files,
        write_file: BUILTIN_TOOLS.write_file,
        screenshot_to_code: BUILTIN_TOOLS.write_file,
      }),
    });

    const result = await instance.generate("Plan and build");

    expect(starts).toHaveLength(2);
    expect(starts[1].mode).toBe("chat");
    expect(starts.map((request) => request.maxToolCalls)).toEqual([2, 1]);
    expect(starts[0].tools.map((tool) => tool.name)).toEqual([
      "exit_plan_mode",
    ]);
    expect(starts[1].tools.map((tool) => tool.name)).toEqual([
      "list_files",
      "write_file",
    ]);
    expect(result.maxIterationsReached).toBe(true);
    expect(result.aborted).toBe(false);
    expect(localAgentMocks.resolve).toHaveBeenCalledWith(
      "run-2",
      "extra-tool",
      expect.objectContaining({ isError: undefined }),
    );
  });

  it("does not start plan continuation after consuming the final allowance", async () => {
    const starts: LocalAgentStartRequest[] = [];
    localAgentMocks.start.mockImplementation(
      async (
        request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        starts.push(request);
        queueMicrotask(() => {
          onEvent({
            type: "session",
            sessionId: "thread-plan",
            cliVersion: "codex-cli 1.0.0",
          });
          onEvent({
            type: "toolRequest",
            runId: "run-1",
            callId: "approve-plan",
            name: "exit_plan_mode",
            arguments: { plan: "Implement it" },
          });
          onEvent({
            type: "done",
            aborted: false,
            sessionId: "thread-plan",
          });
        });
        return "run-1";
      },
    );
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      tools: { exit_plan_mode: BUILTIN_TOOLS.exit_plan_mode },
      executionMode: "plan",
      maxIterations: 1,
      requestPlanApproval: async () => ({ approved: true }),
      onPlanApproved: () => ({ list_files: BUILTIN_TOOLS.list_files }),
    });

    const result = await instance.generate("Plan and build");

    expect(starts).toHaveLength(1);
    expect(starts[0].maxToolCalls).toBe(1);
    expect(result.maxIterationsReached).toBe(true);
  });

  it("disables provider-native search for automatic QA", async () => {
    let request: LocalAgentStartRequest | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() => completeRun(onEvent, "run-qa"));
        return "run-qa";
      },
    );
    const conversation = baseConversation();
    const fingerprint = await computeConversationFingerprint(conversation);
    conversation.localAgentSessions = {
      codex: {
        provider: "codex",
        sessionId: "main-thread",
        transcriptFingerprint: fingerprint,
        compatibilityKey: "main-compatibility",
        cliVersion: "codex-cli 1.0.0",
        updatedAt: 1,
      },
    };
    const { instance, saveSession } = generator(
      conversation,
      vi.fn(),
      vi.fn(),
      {
        nativeSearch: true,
      },
    );
    instance.setExecutionMode("auto_qa");

    await instance.generate("Run automatic QA");

    expect(request).toMatchObject({
      mode: "auto_qa",
      nativeSearch: false,
      sessionId: undefined,
      scope: { kind: "utility" },
    });
    expect(saveSession).not.toHaveBeenCalled();
  });

  it("blocks Pi built-in search before starting a local CLI turn", async () => {
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      provider: "pi",
      nativeSearch: true,
    });

    await expect(instance.generate("Search the web")).rejects.toThrow(
      "Choose Tavily, Firecrawl, Exa, or Disabled",
    );
    expect(localAgentMocks.start).not.toHaveBeenCalled();
  });

  it("disables provider-native search for a restricted chat profile", async () => {
    let request: LocalAgentStartRequest | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() => completeRun(onEvent, "run-review"));
        return "run-review";
      },
    );
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      nativeSearch: true,
    });
    instance.setNativeSearchAllowed(false);

    await instance.generate("Run read-only Design Review");

    expect(request).toMatchObject({ mode: "chat", nativeSearch: false });
  });

  it("isolates a restricted profile from normal conversation bootstrap", async () => {
    let request: LocalAgentStartRequest | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() => completeRun(onEvent, "run-isolated"));
        return "run-isolated";
      },
    );
    const conversation = baseConversation({
      messages: [{ role: "user", content: "private historical attachment" }],
    });
    const { instance } = generator(conversation);
    instance.syncMessages([]);
    instance.setConversationContextAllowed(false);

    await instance.generate("Run isolated review");

    expect(request?.sessionId).toBeUndefined();
    expect(request?.bootstrapContext).not.toContain(
      "private historical attachment",
    );
  });

  it("drops queued tool requests after the user aborts the run", async () => {
    let emit: ((event: LocalAgentEvent) => void) | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        emit = onEvent;
        return "run-abort";
      },
    );
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      tools: { write_file: BUILTIN_TOOLS.write_file },
    });
    const pending = instance.generate("Write files");
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));

    emit!({
      type: "toolRequest",
      runId: "run-abort",
      callId: "write-after-stop",
      name: "write_file",
      arguments: { path: "src/late.ts", content: "export {};" },
    });
    instance.abort();
    emit!({ type: "done", aborted: true });

    await expect(pending).resolves.toMatchObject({ aborted: true });
    expect(instance.getFiles()).toEqual({});
    expect(localAgentMocks.resolve).not.toHaveBeenCalled();
  });

  it("stops the run when native tool calls exhaust the budget before any host tool", async () => {
    let emit: ((event: LocalAgentEvent) => void) | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        emit = onEvent;
        return "run-native-budget";
      },
    );
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      maxIterations: 1,
      nativeSearch: true,
    });
    const pending = instance.generate("Search the web twice");
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));

    emit!({
      type: "nativeTool",
      callId: "search-1",
      name: "web_search",
      phase: "started",
    });
    expect(localAgentMocks.cancel).not.toHaveBeenCalled();
    emit!({
      type: "nativeTool",
      callId: "search-2",
      name: "web_search",
      phase: "started",
    });
    expect(localAgentMocks.cancel).toHaveBeenCalledWith("run-native-budget");
    emit!({ type: "done", aborted: true });

    await expect(pending).resolves.toMatchObject({
      maxIterationsReached: true,
    });
  });

  it("cancels when cumulative renderer output exceeds its limit", async () => {
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        queueMicrotask(() => {
          onEvent({
            type: "textDelta",
            delta: "x".repeat(16 * 1024 * 1024 + 1),
          });
          onEvent({ type: "done", aborted: true });
        });
        return "run-output-limit";
      },
    );

    await expect(
      generator(baseConversation()).instance.generate("Generate too much"),
    ).rejects.toThrow(/renderer limit/i);
    expect(localAgentMocks.cancel).toHaveBeenCalledWith("run-output-limit");
  });

  it("allows at most three subagent dispatches in one logical local turn", async () => {
    const dispatch = vi.fn(async () => ({ text: '{"ok":true}' }));
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        queueMicrotask(() => {
          onEvent({
            type: "session",
            sessionId: "thread-1",
            cliVersion: "codex-cli 1.0.0",
          });
          for (let index = 1; index <= 4; index += 1) {
            onEvent({
              type: "toolRequest",
              runId: "run-1",
              callId: `subagent-${index}`,
              name: "dispatch_subagent",
              arguments: { subagent: "code-reviewer", task: `Review ${index}` },
            });
          }
          onEvent({ type: "done", aborted: false, sessionId: "thread-1" });
        });
        return "run-1";
      },
    );
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      tools: DISPATCH_SUBAGENT_TOOL,
      maxIterations: 10,
      dispatchSubagent: dispatch,
    });

    const result = await instance.generate("Delegate reviews");

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.maxIterationsReached).toBe(true);
    expect(localAgentMocks.cancel).toHaveBeenCalledWith("run-1");
  });

  it("does not resume a legacy session without a compatibility key", async () => {
    const messages: Conversation["messages"] = [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier response" },
    ];
    const fingerprint = await computeConversationFingerprint({
      messages,
      files: {},
      compressedContext: undefined,
      template: "vite-react-ts",
    });
    const conversation = baseConversation({
      messages,
      localAgentSessions: {
        codex: {
          provider: "codex",
          sessionId: "legacy-thread",
          transcriptFingerprint: fingerprint,
          cliVersion: "codex-cli 1.0.0",
          updatedAt: 1,
        },
      },
    });
    let request: LocalAgentStartRequest | undefined;
    localAgentMocks.start.mockImplementation(
      async (
        currentRequest: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        request = currentRequest;
        queueMicrotask(() => completeRun(onEvent, "run-legacy"));
        return "run-legacy";
      },
    );

    await generator(conversation).instance.generate("Continue safely");

    expect(request?.sessionId).toBeUndefined();
    expect(request?.sessionCompatibilityKey).toBeUndefined();
    expect(request?.bootstrapContext).toContain("Earlier request");
  });

  it("does not infer a fresh-session retry from prose when typed failure is present", async () => {
    const messages: Conversation["messages"] = [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier response" },
    ];
    const fingerprint = await computeConversationFingerprint({
      messages,
      files: {},
      compressedContext: undefined,
      template: "vite-react-ts",
    });
    const conversation = baseConversation({
      messages,
      localAgentSessions: {
        codex: {
          provider: "codex",
          sessionId: "typed-thread",
          transcriptFingerprint: fingerprint,
          compatibilityKey: "compat-typed-thread",
          cliVersion: "codex-cli 1.0.0",
          updatedAt: 1,
        },
      },
    });
    let calls = 0;
    localAgentMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        calls += 1;
        queueMicrotask(() => {
          onEvent({
            type: "error",
            message: "thread not found while resuming",
            retryable: false,
            failure: {
              code: "protocolViolation",
              phase: "handshake",
              provider: "codex",
              safeMessage: "The local CLI returned an unsupported response.",
              diagnosticId: "diag-protocol",
              hadActivity: false,
              hadHostSideEffect: false,
              retryPolicy: "none",
            },
          });
          onEvent({ type: "done", aborted: false });
        });
        return `run-typed-${calls}`;
      },
    );

    await expect(
      generator(conversation).instance.generate("Continue safely"),
    ).rejects.toThrow("unsupported response");
    expect(calls).toBe(1);
  });
});
