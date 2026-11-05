import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBMIT_DESIGN_CONTRACT_TOOL } from "../design/run-contract-tool";
import { BUILTIN_TOOLS } from "./tools-schema";
import { DISPATCH_SUBAGENT_TOOL } from "../tools/subagent-tool";

const { streamTextMock } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

import { WebAppGenerator } from "./generator";

function streamParts(parts: readonly unknown[]) {
  return {
    stream: (async function* () {
      for (const part of parts) yield part;
    })(),
  };
}

function createGenerator(
  overrides: Partial<ConstructorParameters<typeof WebAppGenerator>[0]> = {},
  events: ConstructorParameters<typeof WebAppGenerator>[1] = {},
) {
  return new WebAppGenerator(
    {
      apiBaseUrl: "https://example.test/v1",
      apiKey: "test",
      model: "test",
      tools: { ask_user_question: BUILTIN_TOOLS.ask_user_question },
      stream: true,
      retryDelay: 0,
      maxRetries: 1,
      ...overrides,
    },
    events,
  );
}

afterEach(() => {
  streamTextMock.mockReset();
  vi.restoreAllMocks();
});

describe("WebAppGenerator unlimited runs", () => {
  it("continues beyond 30 model iterations without a final-iteration instruction", async () => {
    let requests = 0;
    streamTextMock.mockImplementation(() => {
      requests += 1;
      return requests <= 35
        ? streamParts([
            {
              type: "tool-call",
              toolCallId: `read-${requests}`,
              toolName: "list_files",
              input: {},
            },
          ])
        : streamParts([{ type: "text-delta", text: "All work finished." }]);
    });

    const result = await createGenerator({
      tools: { list_files: BUILTIN_TOOLS.list_files },
    }).generate("Inspect every module");

    expect(result).toMatchObject({
      text: "All work finished.",
      aborted: false,
      maxIterationsReached: false,
    });
    expect(
      result.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(35);
    expect(streamTextMock).toHaveBeenCalledTimes(36);
    const signals = new Set(
      streamTextMock.mock.calls.map(([request]) => request.abortSignal),
    );
    expect(signals.size).toBe(1);
    expect(
      streamTextMock.mock.calls.every(
        ([request]) => !request.instructions.includes("Final iteration"),
      ),
    ).toBe(true);
  });

  it("honors an explicit iteration budget without injecting a stop instruction", async () => {
    streamTextMock.mockImplementation(() =>
      streamParts([
        {
          type: "tool-call",
          toolCallId: `read-${streamTextMock.mock.calls.length}`,
          toolName: "list_files",
          input: {},
        },
      ]),
    );
    const result = await createGenerator({
      maxIterations: 2,
      tools: { list_files: BUILTIN_TOOLS.list_files },
    }).generate("Inspect modules with an explicit budget");

    expect(result.maxIterationsReached).toBe(true);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(
      streamTextMock.mock.calls.every(
        ([request]) => !request.instructions.includes("Final iteration"),
      ),
    ).toBe(true);
  });

  it("keeps a Stop at the tool-result boundary across provider requests", async () => {
    streamTextMock
      .mockReturnValueOnce(
        streamParts([
          {
            type: "tool-call",
            toolCallId: "read-1",
            toolName: "list_files",
            input: {},
          },
        ]),
      )
      .mockImplementation(() =>
        streamParts([{ type: "text-delta", text: "A new turn." }]),
      );
    const generator = createGenerator(
      { tools: { list_files: BUILTIN_TOOLS.list_files } },
      { onToolResult: () => generator.abort() },
    );

    const stopped = await generator.generate("Inspect the project");

    expect(stopped.aborted).toBe(true);
    expect(
      stopped.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(1);
    expect(streamTextMock).toHaveBeenCalledOnce();
    const stoppedSignal = streamTextMock.mock.calls[0][0].abortSignal;
    expect(stoppedSignal.aborted).toBe(true);

    const next = await generator.generate("Continue");
    expect(next).toMatchObject({ aborted: false, text: "A new turn." });
    expect(streamTextMock.mock.calls[1][0].abortSignal).not.toBe(stoppedSignal);
  });

  it("does not send a retry when Stop is requested by the retry callback", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    streamTextMock
      .mockReturnValueOnce(
        streamParts([
          {
            type: "error",
            error: Object.assign(new Error("unavailable"), {
              isRetryable: true,
            }),
          },
        ]),
      )
      .mockReturnValueOnce(
        streamParts([{ type: "text-delta", text: "Unexpected retry" }]),
      );
    const generator = createGenerator({}, { onRetry: () => generator.abort() });

    const result = await generator.generate("Build it");

    expect(result.aborted).toBe(true);
    expect(streamTextMock).toHaveBeenCalledOnce();
  });

  it("queues every subagent dispatch while running at most three concurrently", async () => {
    let active = 0;
    let peak = 0;
    const dispatchSubagent = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return { text: "Analysis complete" };
    });
    streamTextMock
      .mockReturnValueOnce(
        streamParts(
          Array.from({ length: 7 }, (_, index) => ({
            type: "tool-call",
            toolCallId: `dispatch-${index}`,
            toolName: "dispatch_subagent",
            input: {
              subagent: "code-explorer",
              task: `Inspect module ${index}`,
            },
          })),
        ),
      )
      .mockReturnValueOnce(
        streamParts([{ type: "text-delta", text: "All seven finished." }]),
      );

    const result = await createGenerator({
      tools: DISPATCH_SUBAGENT_TOOL,
      dispatchSubagent,
    }).generate("Inspect seven modules");

    expect(dispatchSubagent).toHaveBeenCalledTimes(7);
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(result.text).toBe("All seven finished.");
    expect(
      result.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.content),
    ).toEqual(Array(7).fill("Analysis complete"));
  });

  it("keeps late subagent files from committing after Stop", async () => {
    let finish!: (value: {
      text: string;
      files: Record<string, string>;
    }) => void;
    const gate = new Promise<{ text: string; files: Record<string, string> }>(
      (resolve) => {
        finish = resolve;
      },
    );
    const dispatchSubagent = vi.fn(() => gate);
    const onFileChange = vi.fn();
    streamTextMock.mockReturnValueOnce(
      streamParts(
        Array.from({ length: 7 }, (_, index) => ({
          type: "tool-call",
          toolCallId: `dispatch-${index}`,
          toolName: "dispatch_subagent",
          input: { subagent: "code-reviewer", task: `Review ${index}` },
        })),
      ),
    );
    const generator = createGenerator(
      {
        tools: DISPATCH_SUBAGENT_TOOL,
        initialFiles: { "src/App.tsx": "before" },
        dispatchSubagent,
      },
      { onFileChange },
    );
    const pending = generator.generate("Review modules");
    await vi.waitFor(() => expect(dispatchSubagent).toHaveBeenCalledTimes(3));

    generator.abort();
    finish({ text: "Late response", files: { "src/App.tsx": "late" } });
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(generator.getFiles()).toEqual({ "src/App.tsx": "before" });
    expect(onFileChange).not.toHaveBeenCalled();
    expect(dispatchSubagent).toHaveBeenCalledTimes(3);
    expect(streamTextMock).toHaveBeenCalledOnce();
  });

  it("does not start queued subagents or another request after Stop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatchSubagent = vi.fn(async () => {
      await gate;
      return { text: "Analysis complete" };
    });
    streamTextMock
      .mockReturnValueOnce(
        streamParts(
          Array.from({ length: 7 }, (_, index) => ({
            type: "tool-call",
            toolCallId: `dispatch-${index}`,
            toolName: "dispatch_subagent",
            input: {
              subagent: "code-explorer",
              task: `Inspect module ${index}`,
            },
          })),
        ),
      )
      .mockReturnValueOnce(
        streamParts([{ type: "text-delta", text: "Unexpected continuation" }]),
      );
    const generator = createGenerator(
      { tools: DISPATCH_SUBAGENT_TOOL, dispatchSubagent },
      {
        onToolResult: (_name, _args, _text, id) => {
          if (id === "dispatch-2") generator.abort();
        },
      },
    );

    const pending = generator.generate("Inspect seven modules");
    await vi.waitFor(() => expect(dispatchSubagent).toHaveBeenCalledTimes(3));
    release();
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(dispatchSubagent).toHaveBeenCalledTimes(3);
    expect(streamTextMock).toHaveBeenCalledOnce();
    const toolResults = result.messages.filter(
      (message) => message.role === "tool",
    );
    expect(toolResults).toHaveLength(7);
    expect(
      toolResults
        .slice(0, 3)
        .every((message) => message.content === "Analysis complete"),
    ).toBe(true);
    expect(
      toolResults
        .slice(3)
        .every(
          (message) =>
            message.toolOutput?.isError &&
            String(message.content).includes("cancelled"),
        ),
    ).toBe(true);

    await generator.generate("Continue after Stop");
    const continuation = streamTextMock.mock.calls[1][0].messages;
    const parts = continuation.flatMap((message: { content: unknown }) =>
      Array.isArray(message.content) ? message.content : [],
    );
    expect(
      parts.filter((part: { type: string }) => part.type === "tool-call"),
    ).toHaveLength(7);
    expect(
      parts.filter((part: { type: string }) => part.type === "tool-result"),
    ).toHaveLength(7);
  });
});

describe("WebAppGenerator streaming failures", () => {
  it("fails after three total attempts by default without SDK retry multiplication", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onRetry = vi.fn();
    streamTextMock.mockImplementation(() =>
      streamParts([
        {
          type: "error",
          error: Object.assign(new Error("Request timed out"), {
            name: "TimeoutError",
            isRetryable: true,
          }),
        },
      ]),
    );

    await expect(
      createGenerator({ maxRetries: undefined }, { onRetry }).generate(
        "Build it",
      ),
    ).rejects.toThrow("Request timed out");

    expect(streamTextMock).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(
      streamTextMock.mock.calls.every(([request]) => request.maxRetries === 0),
    ).toBe(true);
  });

  it("accepts a successful third attempt after two request timeouts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const timedOut = () =>
      streamParts([
        {
          type: "error",
          error: Object.assign(new Error("Request timed out"), {
            name: "TimeoutError",
            isRetryable: true,
          }),
        },
      ]);
    streamTextMock
      .mockImplementationOnce(timedOut)
      .mockImplementationOnce(timedOut)
      .mockReturnValueOnce(
        streamParts([{ type: "text-delta", text: "Recovered" }]),
      );

    const result = await createGenerator({ maxRetries: undefined }).generate(
      "Build it",
    );

    expect(result).toMatchObject({ text: "Recovered", aborted: false });
    expect(streamTextMock).toHaveBeenCalledTimes(3);
  });

  it("turns an invalid Host tool input into a tool result and continues", async () => {
    const customToolHandler = vi.fn(async () =>
      JSON.stringify({ accepted: true }),
    );
    const onError = vi.fn();
    const onToolResult = vi.fn();
    const invalidInput = {
      surface_mode: "operate",
      change_mode: "create",
      audience: "Weather app users",
      primary_goal: "Show the forecast",
      concept: "A compact weather interface",
      system_id: "graphite",
      translation: {
        foundations: "Semantic tokens",
        composition: "Responsive grid",
        components: "Forecast cards",
      },
      acceptance: ["Seven days are visible"],
    };
    const correctedInput = {
      ...invalidInput,
      target: "Weather forecast pages",
      preserve: ["Existing routes and accessibility"],
    };
    streamTextMock
      .mockReturnValueOnce(
        streamParts([
          {
            type: "tool-input-start",
            id: "contract-1",
            toolName: "submit_design_contract",
          },
          {
            type: "tool-call",
            toolCallId: "contract-1",
            toolName: "submit_design_contract",
            input: invalidInput,
            dynamic: true,
            invalid: true,
            error: new Error("target and preserve are required"),
          },
          {
            type: "tool-error",
            toolCallId: "contract-1",
            toolName: "submit_design_contract",
            input: invalidInput,
            dynamic: true,
            error: new Error("target and preserve are required"),
          },
        ]),
      )
      .mockReturnValueOnce(
        streamParts([
          {
            type: "tool-input-start",
            id: "contract-2",
            toolName: "submit_design_contract",
          },
          {
            type: "tool-call",
            toolCallId: "contract-2",
            toolName: "submit_design_contract",
            input: invalidInput,
            dynamic: true,
            invalid: true,
            error: new Error("target and preserve are required"),
          },
          {
            type: "tool-error",
            toolCallId: "contract-2",
            toolName: "submit_design_contract",
            input: invalidInput,
            dynamic: true,
            error: new Error("target and preserve are required"),
          },
        ]),
      )
      .mockReturnValueOnce(
        streamParts([
          {
            type: "tool-input-start",
            id: "contract-3",
            toolName: "submit_design_contract",
          },
          {
            type: "tool-call",
            toolCallId: "contract-3",
            toolName: "submit_design_contract",
            input: correctedInput,
          },
        ]),
      )
      .mockReturnValueOnce(
        streamParts([{ type: "text-delta", text: "I will correct it." }]),
      );

    const result = await createGenerator(
      {
        tools: SUBMIT_DESIGN_CONTRACT_TOOL,
        customToolHandler,
      },
      { onError, onToolResult },
    ).generate("Build a weather app");

    expect(result.text).toBe("I will correct it.");
    expect(result.files).toEqual({});
    expect(customToolHandler).toHaveBeenCalledOnce();
    expect(customToolHandler).toHaveBeenCalledWith(
      "submit_design_contract",
      correctedInput,
      expect.any(Object),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledWith(
      "submit_design_contract",
      invalidInput,
      expect.stringContaining('Invalid arguments for "submit_design_contract"'),
      "contract-1",
      expect.objectContaining({ isError: true }),
    );
    expect(streamTextMock).toHaveBeenCalledTimes(4);
    const retryMessages = JSON.stringify(
      streamTextMock.mock.calls[1][0].messages,
    );
    expect(retryMessages).toContain("Invalid arguments");
    expect(retryMessages).toContain("target");
    expect(retryMessages).toContain("preserve");
    expect(JSON.stringify(streamTextMock.mock.calls[2][0].messages)).toContain(
      "contract-2",
    );
  });

  it("keeps provider-executed invalid tool errors fatal", async () => {
    const onError = vi.fn();
    streamTextMock.mockReturnValueOnce(
      streamParts([
        {
          type: "tool-call",
          toolCallId: "provider-call",
          toolName: "ask_user_question",
          input: {},
          dynamic: true,
          invalid: true,
          providerExecuted: true,
          error: new Error("provider tool input failed"),
        },
        {
          type: "tool-error",
          toolCallId: "provider-call",
          toolName: "ask_user_question",
          input: {},
          dynamic: true,
          providerExecuted: true,
          error: Object.assign(new Error("provider tool input failed"), {
            isRetryable: false,
          }),
        },
      ]),
    );

    await expect(
      createGenerator({}, { onError }).generate("Build it"),
    ).rejects.toThrow("provider tool input failed");
    expect(onError).toHaveBeenCalledOnce();
    expect(streamTextMock).toHaveBeenCalledOnce();
  });

  it("retries the post-question provider iteration without replaying the question", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const askUserQuestion = vi.fn(async () => ({
      answers: [
        {
          header: "Runtime",
          question: "Where should it run?",
          selected: ["Browser"],
        },
      ],
    }));
    const onRetry = vi.fn();
    streamTextMock
      .mockReturnValueOnce(
        streamParts([
          {
            type: "tool-input-start",
            id: "ask-1",
            toolName: "ask_user_question",
          },
          {
            type: "tool-call",
            toolCallId: "ask-1",
            toolName: "ask_user_question",
            input: {
              questions: [
                {
                  header: "Runtime",
                  question: "Where should it run?",
                  multiSelect: false,
                  options: [
                    {
                      label: "Browser (Recommended)",
                      description: "Use the browser runtime.",
                    },
                    {
                      label: "Desktop",
                      description: "Use the desktop runtime.",
                    },
                  ],
                },
              ],
            },
          },
        ]),
      )
      .mockReturnValueOnce(
        streamParts([
          {
            type: "error",
            error: {
              message: "provider unavailable",
              statusCode: 503,
              isRetryable: true,
            },
          },
        ]),
      )
      .mockReturnValueOnce(
        streamParts([{ type: "text-delta", text: "Continuing work." }]),
      );

    const generator = createGenerator({ askUserQuestion }, { onRetry });
    const result = await generator.generate("Build it");

    expect(askUserQuestion).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(streamTextMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(streamTextMock.mock.calls[2][0].messages)).toContain(
      "Browser",
    );
    expect(result.text).toBe("Continuing work.");
    expect(result.aborted).toBe(false);
  });

  it("does not retry an aborted stream", async () => {
    const onRetry = vi.fn();
    streamTextMock.mockReturnValueOnce(
      streamParts([{ type: "abort", reason: "user stopped" }]),
    );

    const result = await createGenerator({}, { onRetry }).generate("Build it");

    expect(result.aborted).toBe(true);
    expect(onRetry).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledOnce();
  });

  it("surfaces a non-retryable 4xx stream error immediately", async () => {
    const onRetry = vi.fn();
    streamTextMock.mockReturnValueOnce(
      streamParts([
        {
          type: "error",
          error: Object.assign(new Error("invalid request"), {
            statusCode: 400,
            isRetryable: false,
          }),
        },
      ]),
    );

    await expect(
      createGenerator({}, { onRetry }).generate("Build it"),
    ).rejects.toThrow("invalid request");
    expect(onRetry).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledOnce();
  });

  it("keeps provider-owned invalid tool errors fatal and exhausts retries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onRetry = vi.fn();
    const failure = () =>
      streamParts([
        {
          type: "tool-call",
          toolCallId: "provider-tool",
          toolName: "provider_tool",
          input: {},
          dynamic: true,
          invalid: true,
          error: new Error("temporary tool failure"),
        },
        {
          type: "tool-error",
          toolCallId: "provider-tool",
          toolName: "provider_tool",
          input: {},
          error: Object.assign(new Error("temporary tool failure"), {
            statusCode: 500,
            isRetryable: true,
          }),
        },
      ]);
    streamTextMock
      .mockReturnValueOnce(failure())
      .mockReturnValueOnce(failure());

    await expect(
      createGenerator(
        {
          tools: {
            provider_tool: SUBMIT_DESIGN_CONTRACT_TOOL.submit_design_contract,
          },
          providerToolNames: ["provider_tool"],
        },
        { onRetry },
      ).generate("Build it"),
    ).rejects.toThrow("temporary tool failure");
    expect(onRetry).toHaveBeenCalledOnce();
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });
});

describe("WebAppGenerator running user instructions", () => {
  it("delivers only after the complete tool group and preserves the active signal", async () => {
    let queued = false;
    const completed: string[] = [];
    const commit = vi.fn(() => {
      expect(completed).toEqual(["first", "second"]);
      return true;
    });
    const prepare = vi.fn(async () => {
      if (!queued) return null;
      queued = false;
      return {
        instructions: [
          {
            id: "update-1",
            message: {
              role: "user" as const,
              content: "Use blue",
              metadata: { instructionId: "update-1" },
            },
            attachments: [],
          },
        ],
        commit,
        fail: vi.fn(),
      };
    });
    streamTextMock
      .mockReturnValueOnce(
        streamParts([
          {
            type: "tool-call",
            toolCallId: "first",
            toolName: "list_files",
            input: {},
          },
          {
            type: "tool-call",
            toolCallId: "second",
            toolName: "list_files",
            input: {},
          },
        ]),
      )
      .mockReturnValueOnce(
        streamParts([{ type: "text-delta", text: "Updated" }]),
      );
    const result = await createGenerator(
      {
        tools: { list_files: BUILTIN_TOOLS.list_files },
        userInstructions: { prepare },
      },
      {
        onToolResult: (_name, _args, _result, id) => {
          completed.push(id);
          queued = true;
        },
      },
    ).generate("Build it");
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
      "assistant",
    ]);
    expect(result.messages[4].metadata?.instructionId).toBe("update-1");
    expect(commit).toHaveBeenCalledOnce();
    expect(streamTextMock.mock.calls[0][0].abortSignal).toBe(
      streamTextMock.mock.calls[1][0].abortSignal,
    );
    expect(streamTextMock.mock.calls[0][0].abortSignal.aborted).toBe(false);
  });

  it("continues after a text-only response when a new instruction arrived", async () => {
    let queued = false;
    let sent = false;
    const onComplete = vi.fn();
    streamTextMock
      .mockReturnValueOnce(streamParts([{ type: "text-delta", text: "First" }]))
      .mockReturnValueOnce(
        streamParts([{ type: "text-delta", text: "Second" }]),
      );
    const result = await createGenerator(
      {
        userInstructions: {
          prepare: async () => {
            if (!queued || sent) return null;
            sent = true;
            return {
              instructions: [
                {
                  id: "u",
                  message: { role: "user", content: "Add footer" },
                  attachments: [],
                },
              ],
              commit: () => true,
              fail: vi.fn(),
            };
          },
        },
      },
      {
        onText: () => {
          queued = true;
        },
        onComplete,
      },
    ).generate("Build");
    expect(result.text).toBe("FirstSecond");
    expect(onComplete).toHaveBeenCalledOnce();
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale instruction commit without another provider request", async () => {
    const instance = createGenerator({
      userInstructions: {
        prepare: async () => ({
          instructions: [
            {
              id: "stale",
              message: { role: "user", content: "Stale" },
              attachments: [],
            },
          ],
          commit: () => false,
          fail: vi.fn(),
        }),
      },
    });
    const result = await instance.generate("Build");
    expect(result.aborted).toBe(true);
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(result.messages).toHaveLength(1);
  });
});

it("keeps a retry snapshot fixed until the request succeeds, then receives the queued instruction", async () => {
  let queued = false;
  const prepare = vi.fn(async () => {
    if (!queued) return null;
    queued = false;
    return {
      instructions: [
        {
          id: "retry-update",
          message: { role: "user" as const, content: "Also add navigation" },
          attachments: [],
        },
      ],
      commit: () => true,
      fail: vi.fn(),
    };
  });
  streamTextMock
    .mockReturnValueOnce(
      streamParts([
        {
          type: "error",
          error: Object.assign(new Error("Timed out"), { isRetryable: true }),
        },
      ]),
    )
    .mockReturnValueOnce(
      streamParts([{ type: "text-delta", text: "Original result" }]),
    )
    .mockReturnValueOnce(
      streamParts([{ type: "text-delta", text: "Navigation added" }]),
    );
  await createGenerator(
    { userInstructions: { prepare } },
    {
      onRetry: () => {
        queued = true;
      },
    },
  ).generate("Build");
  expect(streamTextMock).toHaveBeenCalledTimes(3);
  const requests = streamTextMock.mock.calls.map(([request]) =>
    JSON.stringify(request.messages),
  );
  expect(requests[0]).toBe(requests[1]);
  expect(requests[1]).not.toContain("Also add navigation");
  expect(requests[2]).toContain("Also add navigation");
});

it.each(["auto_qa", "subagent"] as const)(
  "does not consume foreground instructions during %s",
  async (executionMode) => {
    const prepare = vi.fn();
    streamTextMock.mockReturnValueOnce(
      streamParts([{ type: "text-delta", text: "Checked" }]),
    );
    await createGenerator({
      tools: {},
      executionMode,
      userInstructions: { prepare },
    }).generate("Check");
    expect(prepare).not.toHaveBeenCalled();
  },
);
