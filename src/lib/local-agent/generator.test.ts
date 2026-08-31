// @vitest-environment jsdom

import type { ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../types";
import { BUILTIN_TOOLS } from "../ai/tools-schema";
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
    { onText },
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
      }),
    );

    instance.abort();
    expect(localAgentMocks.cancel).not.toHaveBeenCalled();
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
    expect(requests[0].bootstrapContext).toBeUndefined();

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
    ).rejects.toThrow("capability probe timed out");
    expect(calls).toBe(1);
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
      "provider stream failed",
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
      "provider unavailable",
    );
    await noActivity.retry();
    expect(requests[1].prompt).toBe("Keep the original");
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
      onPlanApproved: () => ({ list_files: BUILTIN_TOOLS.list_files }),
    });

    const result = await instance.generate("Plan and build");

    expect(starts).toHaveLength(2);
    expect(starts[1].mode).toBe("chat");
    expect(starts.map((request) => request.maxToolCalls)).toEqual([2, 1]);
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
    const { instance } = generator(baseConversation(), vi.fn(), vi.fn(), {
      nativeSearch: true,
    });
    instance.setExecutionMode("auto_qa");

    await instance.generate("Run automatic QA");

    expect(request).toMatchObject({ mode: "auto_qa", nativeSearch: false });
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
});
