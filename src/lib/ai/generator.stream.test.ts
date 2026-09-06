import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBMIT_DESIGN_CONTRACT_TOOL } from "../design/run-contract-tool";
import { BUILTIN_TOOLS } from "./tools-schema";

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

describe("WebAppGenerator streaming failures", () => {
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
