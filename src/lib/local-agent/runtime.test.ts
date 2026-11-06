import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalAgentEvent,
  LocalAgentProvider,
  LocalAgentStartRequest,
  LocalCliFailure,
  LocalToolResolution,
} from "./types";
import {
  LocalCliRuntime,
  LOCAL_CLI_IDLE_MESSAGE,
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "reports an unsolicited provider cancellation (typed cancellation: %s)",
    async (typedCancellation) => {
      tauriMocks.start.mockImplementation(async (_request, onEvent) => {
        onEvent(preparedEvent());
        if (typedCancellation) {
          onEvent({
            type: "error",
            message: "cancelled",
            retryable: false,
            failure: {
              code: "cancelled",
              phase: "shutdown",
              provider: "codex",
              safeMessage: "The local CLI run was cancelled.",
              diagnosticId: "provider-cancelled",
              hadActivity: false,
              hadHostSideEffect: false,
              retryPolicy: "none",
            },
          });
        }
        onEvent({ type: "done", aborted: true });
        return "run-provider-cancelled";
      });

      await expect(new LocalCliRuntime().run(request())).rejects.toMatchObject({
        name: "LocalCliRuntimeError",
        failure: {
          code: "processExit",
          phase: "stream",
          retryPolicy: "manual",
          hadActivity: false,
          hadHostSideEffect: false,
          diagnosticId: expect.any(String),
        },
      });
    },
  );

  it("waits for committed host work before reporting provider cancellation", async () => {
    const onEvent = vi.fn();
    tauriMocks.start.mockImplementation(async (_request, emit) => {
      emit({ type: "textDelta", delta: "Partial response" });
      emit({
        type: "toolRequest",
        runId: "run-provider-cancelled",
        callId: "write-1",
        name: "write_file",
        arguments: { path: "src/App.tsx", content: "updated" },
      });
      emit({ type: "done", aborted: true });
      return "run-provider-cancelled";
    });

    await expect(
      new LocalCliRuntime().run(request(), {
        onEvent,
        executeHostTool: async () => ({
          resolution: { text: "Written" },
          hadSideEffect: true,
        }),
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "processExit",
        hadActivity: true,
        hadHostSideEffect: true,
        retryPolicy: "manual",
      },
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "textDelta",
      delta: "Partial response",
    });
    expect(tauriMocks.resolve).toHaveBeenCalledOnce();
    expect(tauriMocks.start).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps backend activity flags when cancellation ends with aborted=%s",
    async (aborted) => {
      tauriMocks.start.mockImplementation(async (_request, emit) => {
        emit({
          type: "error",
          message: "cancelled",
          retryable: false,
          failure: {
            code: "cancelled",
            phase: "shutdown",
            provider: "codex",
            safeMessage: "The local CLI run was cancelled.",
            diagnosticId: "provider-cancelled-after-activity",
            hadActivity: true,
            hadHostSideEffect: true,
            retryPolicy: "none",
          },
        });
        emit({ type: "done", aborted });
        return "run-provider-cancelled";
      });

      await expect(new LocalCliRuntime().run(request())).rejects.toMatchObject({
        name: "LocalCliRuntimeError",
        failure: {
          code: "processExit",
          hadActivity: true,
          hadHostSideEffect: true,
          retryPolicy: "manual",
        },
      });
    },
  );

  it("logs monotonic lifecycle timings once without request or result content", async () => {
    let now = 10;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    tauriMocks.start.mockImplementation(async (_request, emit) => {
      now = 30;
      emit(preparedEvent({ resumed: true }));
      now = 60;
      emit({ type: "session", sessionId: "private-session", cliVersion: "1" });
      now = 90;
      emit({ type: "reasoningDelta", delta: "private reasoning" });
      now = 120;
      emit({ type: "textDelta", delta: "private response" });
      now = 150;
      emit({ type: "done", aborted: false });
      emit({ type: "done", aborted: false });
      return "run-timings";
    });

    await new LocalCliRuntime().run(request({ prompt: "private prompt" }));

    expect(debug).toHaveBeenCalledExactlyOnceWith("[local-cli] run timing", {
      runId: "run-timings",
      provider: "codex",
      preparationMs: 20,
      handshakeMs: 30,
      firstActivityMs: 80,
      firstTextMs: 110,
      firstReasoningMs: 80,
      transport: "unknown",
      textGranularity: "unknown",
      reasoningTextSupport: "unknown",
      protocolFallback: null,
      reasoningReceived: true,
      deliveryBarrierMs: 0,
      barrierBufferedEvents: 0,
      totalMs: 140,
      outcome: "completed",
      resumed: true,
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain("private");
  });

  it("forwards distinct text and thinking chunks before the terminal event", async () => {
    let emit!: (event: LocalAgentEvent) => void;
    const onEvent = vi.fn();
    tauriMocks.start.mockImplementation(async (_request, callback) => {
      emit = callback;
      emit(
        preparedEvent({
          outputCapabilities: {
            transport: "codexAppServer",
            textGranularity: "delta",
            reasoningText: "supported",
          },
        }),
      );
      return "incremental-run";
    });
    let completed = false;
    const run = new LocalCliRuntime().run(request(), { onEvent });
    void run.then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    emit({ type: "textDelta", delta: "你好🌱 " });
    emit({ type: "reasoningDelta", delta: "先检查 " });
    emit({ type: "textDelta", delta: "world" });
    emit({ type: "reasoningDelta", delta: "边界" });
    emit({ type: "reasoningDelta", delta: "" });
    expect(onEvent.mock.calls.slice(1).map(([event]) => event)).toEqual([
      { type: "textDelta", delta: "你好🌱 " },
      { type: "reasoningDelta", delta: "先检查 " },
      { type: "textDelta", delta: "world" },
      { type: "reasoningDelta", delta: "边界" },
    ]);
    await Promise.resolve();
    expect(completed).toBe(false);
    emit({ type: "done", aborted: false });
    await expect(run).resolves.toMatchObject({
      text: "你好🌱 world",
      reasoning: "先检查 边界",
      prepared: { outputCapabilities: { transport: "codexAppServer" } },
    });
  });

  it.each([
    undefined,
    { transport: "futureProtocol", reasoningText: "supported" },
  ])(
    "accepts older or unknown optional output metadata: %j",
    async (outputCapabilities) => {
      tauriMocks.start.mockImplementation(async (_request, emit) => {
        emit({ ...preparedEvent(), outputCapabilities });
        emit({ type: "textDelta", delta: "Still works" });
        emit({ type: "done", aborted: false });
        return "compatible-run";
      });
      await expect(new LocalCliRuntime().run(request())).resolves.toMatchObject(
        {
          text: "Still works",
          prepared: { resumed: false },
        },
      );
    },
  );

  it("normalizes output capability aliases without treating reasoning support as observed text", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    tauriMocks.start.mockImplementation(async (_request, emit) => {
      emit({
        ...preparedEvent(),
        output_capabilities: {
          transport: "codexExec",
          text_granularity: "message",
          reasoning_text: "supported",
        },
      });
      emit({ type: "textDelta", delta: "Answer" });
      emit({ type: "done", aborted: false });
      return "fallback-run";
    });
    const result = await new LocalCliRuntime().run(request());
    expect(result.prepared?.outputCapabilities).toEqual({
      transport: "codexExec",
      textGranularity: "message",
      reasoningText: "supported",
    });
    expect(debug).toHaveBeenCalledWith(
      "[local-cli] run timing",
      expect.objectContaining({
        transport: "codexExec",
        protocolFallback: true,
        reasoningReceived: false,
        firstReasoningMs: null,
      }),
    );
  });

  it("measures receipt during the delivery barrier while preserving instruction ordering", async () => {
    let now = 10;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    let emit!: (event: LocalAgentEvent) => void;
    let release!: () => void;
    const order: string[] = [];
    const executeHostTool = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        resolution: { text: "PRIVATE_RESULT" },
        hadSideEffect: false,
        onDelivered: () => {
          order.push("instruction-delivered");
        },
      };
    });
    tauriMocks.start.mockImplementation(async (_request, callback) => {
      emit = callback;
      return "barrier-run";
    });
    tauriMocks.resolve.mockImplementation(async () => {
      now = 100;
    });
    const run = new LocalCliRuntime().run(request(), {
      getToolAuthorityEpoch: () => 1,
      executeHostTool,
      onEvent: (event) => {
        if (event.type === "textDelta" || event.type === "reasoningDelta")
          order.push(event.type);
      },
    });
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    now = 30;
    emit({
      type: "toolRequest",
      runId: "barrier-run",
      callId: "tool-1",
      name: "read_files",
      arguments: {},
    });
    await vi.waitFor(() => expect(executeHostTool).toHaveBeenCalledOnce());
    now = 50;
    emit({ type: "textDelta", delta: "PRIVATE_TEXT" });
    emit({ type: "reasoningDelta", delta: "PRIVATE_REASONING" });
    expect(order).toEqual([]);
    now = 90;
    release();
    await vi.waitFor(() =>
      expect(order).toEqual([
        "instruction-delivered",
        "textDelta",
        "reasoningDelta",
      ]),
    );
    now = 130;
    emit({ type: "done", aborted: false });
    await run;
    expect(debug).toHaveBeenCalledWith(
      "[local-cli] run timing",
      expect.objectContaining({
        firstTextMs: 40,
        firstReasoningMs: 40,
        deliveryBarrierMs: 70,
        barrierBufferedEvents: 2,
        reasoningReceived: true,
      }),
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain("PRIVATE");
  });

  it("logs Host execution and delivery phases without argument or result content", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    tauriMocks.start.mockImplementation(async (_request, emit) => {
      emit({
        type: "toolRequest",
        runId: "trace-run",
        callId: "read-1",
        name: "read_files",
        arguments: { path: "PRIVATE_PATH" },
      });
      emit({ type: "done", aborted: false });
      return "trace-run";
    });
    await new LocalCliRuntime().run(request(), {
      executeHostTool: async () => ({
        resolution: { text: "PRIVATE_CONTENT" },
        hadSideEffect: false,
      }),
    });
    const phases = debug.mock.calls
      .filter(([message]) => message === "[local-cli] host tool")
      .map(([, value]) => value);
    expect(phases.map(({ phase }) => phase)).toEqual([
      "started",
      "executed",
      "delivered",
    ]);
    expect(phases[1]).toMatchObject({
      runId: "trace-run",
      callId: "read-1",
      resultChars: 15,
      isError: false,
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain("PRIVATE");
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

  it("names the requested provider when inspect rejects it", async () => {
    await expect(
      new LocalCliRuntime().inspect({
        provider: "unknown-cli" as LocalAgentProvider,
        preference: { model: "", effort: "" },
      }),
    ).rejects.toMatchObject({
      failure: { code: "selectionRejected", provider: "unknown-cli" },
    });
    expect(tauriMocks.probe).not.toHaveBeenCalled();
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

  it("correlates a failed run with its diagnostic ID without logging provider content", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    tauriMocks.start.mockImplementation(async (_request, emit) => {
      emit({
        type: "error",
        message: "private stderr sentinel",
        retryable: false,
        failure: {
          code: "protocolViolation",
          phase: "stream",
          provider: "codex",
          safeMessage: "private provider diagnostic sentinel",
          diagnosticId: "diag-preserved-protocol",
          hadActivity: true,
          hadHostSideEffect: true,
          retryPolicy: "none",
        },
      });
      emit({ type: "done", aborted: false });
      return "run-preserved-protocol";
    });

    await expect(new LocalCliRuntime().run(request())).rejects.toMatchObject({
      failure: { code: "protocolViolation" },
    });
    expect(debug).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(
      "[local-cli] run timing",
      expect.objectContaining({
        runId: "run-preserved-protocol",
        outcome: "failed",
        failure: {
          diagnosticId: "diag-preserved-protocol",
          code: "protocolViolation",
          phase: "stream",
          retryPolicy: "none",
          hadActivity: true,
          hadHostSideEffect: true,
        },
      }),
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain("private");
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

  it("shows an idle notice after 120 seconds, pauses for Host work, and clears it on activity", async () => {
    vi.useFakeTimers();
    let emit!: (event: LocalAgentEvent) => void;
    tauriMocks.start.mockImplementation(async (_request, onEvent) => {
      emit = onEvent;
      return "idle-run";
    });
    let release!: () => void;
    const executeHostTool = vi.fn(
      () =>
        new Promise<{
          resolution: LocalToolResolution;
          hadSideEffect: boolean;
        }>((resolve) => {
          release = () =>
            resolve({ resolution: { text: "read" }, hadSideEffect: false });
        }),
    );
    const onEvent = vi.fn();
    const controller = new AbortController();
    const pending = new LocalCliRuntime().run(
      request(),
      { onEvent, executeHostTool },
      controller.signal,
    );
    try {
      await vi.advanceTimersByTimeAsync(119_999);
      expect(onEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: LOCAL_CLI_IDLE_MESSAGE }),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(onEvent).toHaveBeenCalledWith({
        type: "status",
        state: "streaming",
        message: LOCAL_CLI_IDLE_MESSAGE,
      });
      emit({ type: "textDelta", delta: "progress" });
      expect(onEvent).toHaveBeenCalledWith({
        type: "status",
        state: "streaming",
      });
      onEvent.mockClear();
      emit({
        type: "toolRequest",
        runId: "idle-run",
        callId: "waiting-tool",
        name: "read_files",
        arguments: {},
      });
      await vi.advanceTimersByTimeAsync(240_000);
      expect(onEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: LOCAL_CLI_IDLE_MESSAGE }),
      );
      release();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ message: LOCAL_CLI_IDLE_MESSAGE }),
      );
      expect(tauriMocks.cancel).not.toHaveBeenCalled();
      emit({ type: "done", aborted: false });
      await expect(pending).resolves.toMatchObject({ aborted: false });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      release?.();
      emit?.({ type: "done", aborted: true });
      vi.useRealTimers();
    }
  });

  it.each(["execution", "delivery"])(
    "settles Stop while Host %s ignores cancellation",
    async (stage) => {
      let emit!: (event: LocalAgentEvent) => void;
      tauriMocks.start.mockImplementation(async (_request, onEvent) => {
        emit = onEvent;
        return "run-unresponsive";
      });
      const controller = new AbortController();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const onDelivered = vi.fn();
      const onDeliveryFailed = vi.fn();
      const executeHostTool = vi.fn(async () => {
        if (stage === "execution") await blocked;
        return {
          resolution: { text: "late" },
          hadSideEffect: false,
          onDelivered,
          onDeliveryFailed,
        };
      });
      if (stage === "delivery")
        tauriMocks.resolve.mockImplementation(() => blocked);
      let settled = false;
      const pending = new LocalCliRuntime()
        .run(
          request(),
          { executeHostTool, getToolAuthorityEpoch: () => 1 },
          controller.signal,
        )
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.waitFor(() => expect(tauriMocks.start).toHaveBeenCalledOnce());
      emit({
        type: "toolRequest",
        runId: "run-unresponsive",
        callId: "slow",
        name: "read_files",
        arguments: {},
      });
      await vi.waitFor(() => expect(executeHostTool).toHaveBeenCalledOnce());
      if (stage === "delivery")
        await vi.waitFor(() =>
          expect(tauriMocks.resolve).toHaveBeenCalledOnce(),
        );
      controller.abort();
      emit({ type: "done", aborted: true });
      try {
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
      } finally {
        release();
      }
      expect(await pending).toMatchObject({ aborted: true });
      await Promise.resolve();
      expect(onDelivered).not.toHaveBeenCalled();
      expect(onDeliveryFailed).toHaveBeenCalledOnce();
      if (stage === "execution")
        expect(tauriMocks.resolve).not.toHaveBeenCalled();
    },
  );

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

it.each([true, false])(
  "filters optional isolation diagnostics to fixed enums (valid=%s)",
  async (valid) => {
    const runtime = new LocalCliRuntime({
      start: async (_request, emit) => {
        emit({
          type: "error",
          message: "Isolation denied",
          retryable: false,
          failure: {
            code: "isolationViolation",
            phase: "stream",
            provider: "codex",
            safeMessage: "Isolation denied",
            diagnosticId: "diag-isolation",
            hadActivity: true,
            hadHostSideEffect: false,
            retryPolicy: "none",
            isolationReason: valid ? "invalidDiscovery" : "private arguments",
            itemKind: valid ? "mcpToolCall" : "private capability data",
          },
        } as unknown as LocalAgentEvent);
        emit({ type: "done", aborted: false });
        return "run-isolation";
      },
      cancel: async () => true,
    });
    const error = await runtime
      .run(request())
      .catch((cause: LocalCliRuntimeError) => cause);
    expect(error).toBeInstanceOf(LocalCliRuntimeError);
    if (!(error instanceof LocalCliRuntimeError))
      throw new Error("Expected runtime error");
    expect(error.failure.isolationReason).toBe(
      valid ? "invalidDiscovery" : undefined,
    );
    expect(error.failure.itemKind).toBe(valid ? "mcpToolCall" : undefined);
  },
);

it("stamps requests arriving before delivery ACK with the barrier's original authority", async () => {
  let emit!: (event: LocalAgentEvent) => void;
  let epoch = 0;
  const received: Array<{ callId: string; epoch?: number }> = [];
  const runtime = new LocalCliRuntime({
    start: async (_request, onEvent) => {
      emit = onEvent;
      emit({
        type: "toolRequest",
        runId: "run",
        callId: "first",
        name: "list_files",
        arguments: {},
      });
      return "run";
    },
    resolveTool: async (_run, callId) => {
      if (callId === "first")
        emit({
          type: "toolRequest",
          runId: "run",
          callId: "old-write",
          name: "write_file",
          arguments: {},
        });
      else emit({ type: "done", aborted: false });
    },
  });
  await runtime.run(request(), {
    getToolAuthorityEpoch: () => epoch,
    executeHostTool: async (call) => {
      received.push({ callId: call.callId, epoch: call.authorityEpoch });
      if (call.callId === "first") epoch += 1;
      return {
        resolution: { text: "result" },
        hadSideEffect: false,
        onDelivered: () => {},
      };
    },
  });
  expect(received).toEqual([
    { callId: "first", epoch: 0 },
    { callId: "old-write", epoch: 0 },
  ]);
});

function recoveryRun() {
  return {
    runId: "original-run",
    request: request(),
    terminal: false,
    context: {
      version: 1 as const,
      identity: {
        conversationId: "conversation-1",
        branchId: "main",
        checkoutEpoch: 0,
      },
      messages: [],
      skillIds: [],
      app: {},
    },
  };
}

it("recovers the original stream, deduplicates replay/live overlap, and never redispatches resolved tools", async () => {
  const run = recoveryRun();
  const lease = { owner: "new-page", epoch: 2 };
  let emit!: (envelope: import("./types").LocalRecoveryEnvelope) => void;
  const event = (sequence: number, event: LocalAgentEvent) => ({
    runId: run.runId,
    sequence,
    event,
  });
  const queued = event(3, {
    type: "toolRequest",
    runId: run.runId,
    callId: "queued",
    name: "write_file",
    arguments: {},
  });
  const start = vi.fn();
  const claimTool = vi.fn(async () => ({ status: "execute" as const }));
  const resolveTool = vi.fn(async () =>
    emit(event(5, { type: "done", aborted: false })),
  );
  const runtime = new LocalCliRuntime({
    start,
    claimTool,
    resolveTool,
    attach: async (_id, callback) => {
      emit = callback;
      emit(queued); // A snapshot/live overlap must still dispatch exactly once.
      emit(event(4, { type: "textDelta", delta: "after" }));
      return {
        ...run,
        lease,
        uncertain: false,
        resolutions: { completed: { text: "already written" } },
        events: [
          event(1, { type: "textDelta", delta: "before" }),
          event(2, {
            type: "toolRequest",
            runId: run.runId,
            callId: "completed",
            name: "write_file",
            arguments: {},
          }),
          queued,
        ],
      };
    },
  });
  let writes = 0;
  const calls: string[] = [];
  const result = await runtime.run(
    run.request,
    {
      executeHostTool: async (call) => {
        calls.push(call.callId);
        if (!call.recoveredResolution) writes += 1;
        return {
          resolution: call.recoveredResolution ?? { text: "newly written" },
          hadSideEffect: !call.recoveredResolution,
        };
      },
    },
    undefined,
    run,
  );
  expect(result.text).toBe("beforeafter");
  expect(result.runId).toBe("original-run");
  expect(start).not.toHaveBeenCalled();
  expect(calls).toEqual(["completed", "queued"]);
  expect(writes).toBe(1);
  expect(claimTool).toHaveBeenCalledTimes(1);
  expect(resolveTool).toHaveBeenCalledTimes(1);
  expect(claimTool).toHaveBeenCalledWith(run.runId, "queued", lease);
});

it("waits for project persistence before acknowledging an executed tool to Native", async () => {
  let flush!: () => void;
  const persisted = new Promise<void>((resolve) => {
    flush = resolve;
  });
  const run = recoveryRun();
  let emit!: (event: LocalAgentEvent) => void;
  const resolveTool = vi.fn(async () => {
    emit({ type: "done", aborted: false });
  });
  const runtime = new LocalCliRuntime({
    start: async (_request, onEvent) => {
      emit = onEvent;
      emit({
        type: "toolRequest",
        runId: "original-run",
        callId: "write",
        name: "write_file",
        arguments: {},
      });
      return "original-run";
    },
    claimTool: async () => ({ status: "execute" }),
    resolveTool,
  });
  const execution = vi.fn(async () => ({
    resolution: { text: "written" },
    hadSideEffect: true,
  }));
  const completion = runtime.run(
    { ...run.request, recovery: { owner: "page", context: run.context } },
    {
      executeHostTool: execution,
      beforeToolDelivery: () => persisted,
    },
  );
  await vi.waitFor(() => expect(execution).toHaveBeenCalledTimes(1));
  expect(resolveTool).not.toHaveBeenCalled();
  flush();
  await completion;
  expect(resolveTool).toHaveBeenCalledTimes(1);
});

it("waits for the terminal event and reports unknown outcomes without repeating a dispatched tool", async () => {
  const run = recoveryRun();
  let finish!: () => void;
  const execute = vi.fn(
    async (call: import("./runtime").LocalCliHostToolRequest) => {
      expect(call.recoveredResolution?.isError).toBe(true);
      return { resolution: call.recoveredResolution!, hadSideEffect: false };
    },
  );
  const claim = vi.fn();
  const runtime = new LocalCliRuntime({
    claimTool: claim,
    cancel: async () => true,
    attach: async (_id, emit) => {
      finish = () =>
        emit({
          runId: run.runId,
          sequence: 2,
          event: { type: "done", aborted: true },
        });
      return {
        ...run,
        lease: { owner: "new", epoch: 2 },
        uncertain: true,
        resolutions: {},
        events: [
          {
            runId: run.runId,
            sequence: 1,
            event: {
              type: "toolRequest",
              runId: run.runId,
              callId: "unknown",
              name: "write_file",
              arguments: {},
            },
          },
        ],
      };
    },
  });
  let settled = false;
  const result = runtime.run(
    run.request,
    { executeHostTool: execute },
    undefined,
    run,
  );
  const assertion = expect(result).rejects.toMatchObject({
    failure: { code: "recoveryUncertain" },
  });
  void result
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  expect(claim).not.toHaveBeenCalled();
  finish();
  await assertion;
});
