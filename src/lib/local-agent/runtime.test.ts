import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalAgentEvent,
  LocalAgentStartRequest,
  LocalCliFailure,
  LocalToolResolution,
} from "./types";
import {
  LocalCliRuntime,
  LocalCliRuntimeError,
  normalizeLocalCliProbe,
} from "./runtime";

const tauriMocks = vi.hoisted(() => ({
  supports: vi.fn(),
  probe: vi.fn(),
  start: vi.fn(),
  resolve: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("./tauri", () => ({
  supportsLocalAgents: tauriMocks.supports,
  probeLocalAgent: tauriMocks.probe,
  startLocalAgent: tauriMocks.start,
  resolveLocalAgentTool: tauriMocks.resolve,
  cancelLocalAgent: tauriMocks.cancel,
}));

function request(
  overrides: Partial<LocalAgentStartRequest> = {},
): LocalAgentStartRequest {
  return {
    provider: "codex",
    systemPrompt: "system",
    prompt: "hello",
    bootstrapContext: "history",
    scope: { kind: "conversation", id: "conversation-1" },
    tools: [],
    nativeSearch: false,
    maxToolCalls: 4,
    mode: "chat",
    ...overrides,
  };
}

function preparedEvent(
  overrides: Partial<LocalAgentEvent> = {},
): LocalAgentEvent {
  return {
    type: "prepared",
    compatibilityKey: "compat-1",
    installationFingerprint: "install-1",
    cliVersion: "codex 1.0.0",
    actualModel: "gpt-5.6-sol",
    actualEffort: "high",
    resumed: false,
    ...overrides,
  } as LocalAgentEvent;
}

describe("LocalCliRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.supports.mockResolvedValue(true);
    tauriMocks.resolve.mockResolvedValue(undefined);
    tauriMocks.cancel.mockResolvedValue(true);
  });

  it("normalizes readiness fields while preserving legacy availability", () => {
    const result = normalizeLocalCliProbe({
      provider: "codex",
      availability: "ready",
      setupCommand: "codex login",
      models: [],
      efforts: [],
      preferenceDecision: { kind: "keep", unverified: true },
      capabilities: {
        sessions: true,
        reasoning: true,
        tools: true,
        nativeSearch: true,
      },
    });

    expect(result).toMatchObject({
      status: "ready",
      catalogAuthority: "partial",
      capabilities: {
        imageGeneration: false,
        imageEditing: false,
        mediaCapabilitiesVerified: false,
      },
    });
    expect(result.checkedAt).toBeTypeOf("number");
  });

  it("uses the backend probe as the authoritative inspect operation", async () => {
    tauriMocks.probe.mockResolvedValue({
      provider: "claude",
      availability: "ready",
      status: "verificationRequired",
      setupCommand: "claude login",
      models: [],
      efforts: [],
      preferenceDecision: { kind: "keep", unverified: true },
      capabilities: {
        sessions: true,
        reasoning: true,
        tools: true,
        nativeSearch: true,
      },
    });

    const result = await new LocalCliRuntime().inspect({
      provider: "claude",
      preference: { model: "", effort: "" },
      forceRefresh: true,
    });

    expect(result.status).toBe("verificationRequired");
    expect(tauriMocks.probe).toHaveBeenCalledWith(
      "claude",
      { model: "", effort: "" },
      true,
    );
  });

  it("reports an unsupported host without probing a provider", async () => {
    tauriMocks.supports.mockResolvedValue(false);

    const result = await new LocalCliRuntime().inspect({
      provider: "codex",
      preference: { model: "", effort: "" },
    });

    expect(result).toMatchObject({
      availability: "unsupported",
      status: "unavailable",
      reasonCode: "hostUnsupported",
    });
    expect(tauriMocks.probe).not.toHaveBeenCalled();
  });

  it("aggregates lifecycle metadata and resolves Done exactly once", async () => {
    let emit!: (event: LocalAgentEvent) => void;
    tauriMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        emit = onEvent;
        queueMicrotask(() => {
          onEvent({ type: "status", state: "streaming" });
          onEvent(preparedEvent());
          onEvent({
            type: "session",
            sessionId: "thread-1",
            cliVersion: "codex 1.0.0",
          });
          onEvent({ type: "textDelta", delta: "hello " });
          onEvent({ type: "reasoningDelta", delta: "thinking" });
          onEvent({ type: "usage", inputTokens: 3, outputTokens: 2 });
          onEvent({ type: "warning", message: "gateway fallback" });
          onEvent({ type: "done", aborted: false, sessionId: "thread-1" });
          onEvent({
            type: "done",
            aborted: false,
            sessionId: "thread-duplicate",
          });
        });
        return "run-1";
      },
    );
    const events: LocalAgentEvent[] = [];
    const runtime = new LocalCliRuntime();

    const result = await runtime.run(request(), {
      onEvent: (event) => events.push(event),
    });

    expect(emit).toBeTypeOf("function");
    expect(result).toMatchObject({
      runId: "run-1",
      sessionId: "thread-1",
      text: "hello ",
      reasoning: "thinking",
      prepared: {
        compatibilityKey: "compat-1",
        installationFingerprint: "install-1",
        resumed: false,
      },
      usage: { inputTokens: 3, outputTokens: 2 },
      warnings: ["gateway fallback"],
      status: { state: "streaming" },
      aborted: false,
    });
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
  });

  it("serializes host tool execution and resolves each call once", async () => {
    tauriMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        onEvent({
          type: "toolRequest",
          runId: "run-tool",
          callId: "call-1",
          name: "list_files",
          arguments: { path: "." },
        });
        onEvent({
          type: "toolRequest",
          runId: "run-tool",
          callId: "call-1",
          name: "list_files",
          arguments: { path: "." },
        });
        onEvent({ type: "done", aborted: false });
        return "run-tool";
      },
    );
    const resolution: LocalToolResolution = { text: "src/App.tsx" };
    const executeHostTool = vi.fn(async () => ({
      resolution,
      hadSideEffect: false,
    }));

    await new LocalCliRuntime().run(request(), { executeHostTool });

    expect(executeHostTool).toHaveBeenCalledOnce();
    expect(tauriMocks.resolve).toHaveBeenCalledOnce();
    expect(tauriMocks.resolve).toHaveBeenCalledWith(
      "run-tool",
      "call-1",
      resolution,
    );
  });

  it("records a Host side effect only after the hook reports crossing the seam", async () => {
    tauriMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        onEvent({
          type: "toolRequest",
          runId: "run-side-effect",
          callId: "call-write",
          name: "write_file",
          arguments: {},
        });
        queueMicrotask(() => {
          onEvent({
            type: "error",
            message: "session unavailable",
            retryable: false,
            failure: {
              code: "sessionUnavailable",
              phase: "handshake",
              provider: "codex",
              safeMessage: "The saved local CLI session is unavailable.",
              diagnosticId: "diag-side-effect",
              hadActivity: true,
              hadHostSideEffect: false,
              retryPolicy: "freshSessionSafe",
            },
          });
          onEvent({ type: "done", aborted: false });
        });
        return "run-side-effect";
      },
    );
    const pending = new LocalCliRuntime().run(request(), {
      executeHostTool: async () => ({
        resolution: { text: "written" },
        hadSideEffect: true,
      }),
    });

    await expect(pending).rejects.toMatchObject({
      failure: {
        code: "sessionUnavailable",
        hadHostSideEffect: true,
      },
    });
  });

  it("fails closed for unknown events because metadata is provider-scoped", async () => {
    tauriMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        onEvent({ type: "mystery_progress" } as unknown as LocalAgentEvent);
        onEvent({ type: "done", aborted: false });
        return "run-metadata";
      },
    );
    await expect(new LocalCliRuntime().run(request())).rejects.toMatchObject({
      failure: { code: "protocolViolation" },
    });
    expect(tauriMocks.cancel).toHaveBeenCalledWith("run-metadata");
  });

  it("fails closed when a tool request has no host bridge", async () => {
    tauriMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        onEvent({
          type: "toolRequest",
          runId: "run-no-bridge",
          callId: "call-no-bridge",
          name: "write_file",
          arguments: {},
        });
        onEvent({ type: "done", aborted: false });
        return "run-no-bridge";
      },
    );

    await expect(new LocalCliRuntime().run(request())).rejects.toMatchObject({
      failure: { code: "toolBridgeFailed", hadHostSideEffect: false },
    });
    expect(tauriMocks.resolve).toHaveBeenCalledWith(
      "run-no-bridge",
      "call-no-bridge",
      expect.objectContaining({ isError: true }),
    );
    expect(tauriMocks.cancel).toHaveBeenCalledWith("run-no-bridge");
  });

  it("keeps Prepared outside the activity gate but counts a Session event", async () => {
    const unavailable: LocalCliFailure = {
      code: "sessionUnavailable",
      phase: "handshake",
      provider: "codex",
      safeMessage: "The saved local CLI session is no longer available.",
      diagnosticId: "diag-session",
      hadActivity: false,
      hadHostSideEffect: false,
      retryPolicy: "freshSessionSafe",
    };
    tauriMocks.start.mockImplementationOnce(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        onEvent(preparedEvent());
        onEvent({
          type: "error",
          message: "missing",
          retryable: false,
          failure: unavailable,
        });
        onEvent({ type: "done", aborted: false });
        return "run-prepared-only";
      },
    );
    await expect(new LocalCliRuntime().run(request())).rejects.toMatchObject({
      failure: { code: "sessionUnavailable", hadActivity: false },
    });

    tauriMocks.start.mockImplementationOnce(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        onEvent({
          type: "session",
          sessionId: "thread-1",
          cliVersion: "codex 1.0.0",
        });
        onEvent({
          type: "error",
          message: "missing",
          retryable: false,
          failure: unavailable,
        });
        onEvent({ type: "done", aborted: false });
        return "run-session";
      },
    );
    await expect(new LocalCliRuntime().run(request())).rejects.toMatchObject({
      failure: { code: "sessionUnavailable", hadActivity: true },
    });
  });

  it("preserves typed failure codes and never surfaces raw diagnostic text", async () => {
    const failure: LocalCliFailure = {
      code: "credentialRejected",
      phase: "handshake",
      provider: "codex",
      safeMessage: "The local CLI rejected its configured credentials.",
      diagnosticId: "diagnostic-1",
      hadActivity: false,
      hadHostSideEffect: false,
      retryPolicy: "afterSetup",
    };
    tauriMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        onEvent({
          type: "error",
          message: "safe",
          retryable: false,
          failure,
        });
        onEvent({ type: "done", aborted: false });
        return "run-error";
      },
    );

    const error = await new LocalCliRuntime()
      .run(request())
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(LocalCliRuntimeError);
    expect(error).toMatchObject({
      message: failure.safeMessage,
      failure,
    });
    expect((error as Error).message).not.toContain("api-key");
    expect(tauriMocks.cancel).toHaveBeenCalledWith("run-error");
  });

  it("settles when the event consumer throws on Done", async () => {
    tauriMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        onEvent({ type: "done", aborted: false });
        return "run-consumer-error";
      },
    );

    await expect(
      new LocalCliRuntime().run(request(), {
        onEvent: () => {
          throw new Error("consumer failed");
        },
      }),
    ).rejects.toMatchObject({
      failure: { code: "processExit" },
    });
    expect(tauriMocks.cancel).toHaveBeenCalledWith("run-consumer-error");
  });

  it("reports an abort, not a bridge failure, when Stop interrupts a host tool", async () => {
    let emit!: (event: LocalAgentEvent) => void;
    tauriMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        emit = onEvent;
        return "run-stop-during-tool";
      },
    );
    tauriMocks.resolve.mockRejectedValue(
      new Error("local agent run is not active"),
    );
    const controller = new AbortController();
    let finishTool!: () => void;
    const executeHostTool = vi.fn(
      () =>
        new Promise<{
          resolution: LocalToolResolution;
          hadSideEffect: boolean;
        }>((resolve) => {
          finishTool = () =>
            resolve({ resolution: { text: "late" }, hadSideEffect: false });
        }),
    );

    const pending = new LocalCliRuntime().run(
      request(),
      { executeHostTool },
      controller.signal,
    );
    await vi.waitFor(() => expect(tauriMocks.start).toHaveBeenCalledOnce());
    emit({
      type: "toolRequest",
      runId: "run-stop-during-tool",
      callId: "call-slow",
      name: "list_files",
      arguments: {},
    });
    await vi.waitFor(() => expect(executeHostTool).toHaveBeenCalledOnce());
    controller.abort();
    finishTool();
    emit({ type: "done", aborted: true });

    await expect(pending).resolves.toMatchObject({
      runId: "run-stop-during-tool",
      aborted: true,
    });
  });

  it("treats an AbortError from an in-flight host tool as an aborted run", async () => {
    let emit!: (event: LocalAgentEvent) => void;
    tauriMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        emit = onEvent;
        return "run-tool-abort-error";
      },
    );
    const executeHostTool = vi.fn(async () => {
      throw new DOMException("The tool was cancelled.", "AbortError");
    });

    const pending = new LocalCliRuntime().run(request(), { executeHostTool });
    await vi.waitFor(() => expect(tauriMocks.start).toHaveBeenCalledOnce());
    emit({
      type: "toolRequest",
      runId: "run-tool-abort-error",
      callId: "call-aborted",
      name: "list_files",
      arguments: {},
    });
    await vi.waitFor(() =>
      expect(tauriMocks.cancel).toHaveBeenCalledWith("run-tool-abort-error"),
    );
    emit({ type: "done", aborted: true });

    await expect(pending).resolves.toMatchObject({
      runId: "run-tool-abort-error",
      aborted: true,
    });
    expect(tauriMocks.resolve).not.toHaveBeenCalled();
  });

  it("cancels an active run when its AbortSignal fires", async () => {
    let emit!: (event: LocalAgentEvent) => void;
    tauriMocks.start.mockImplementation(
      async (
        _request: LocalAgentStartRequest,
        onEvent: (event: LocalAgentEvent) => void,
      ) => {
        emit = onEvent;
        return "run-abort";
      },
    );
    const controller = new AbortController();
    const pending = new LocalCliRuntime().run(request(), {}, controller.signal);
    await vi.waitFor(() => expect(tauriMocks.start).toHaveBeenCalledOnce());
    controller.abort();
    expect(tauriMocks.cancel).toHaveBeenCalledWith("run-abort");
    emit({ type: "done", aborted: true });

    await expect(pending).resolves.toMatchObject({
      runId: "run-abort",
      aborted: true,
    });
  });
});
