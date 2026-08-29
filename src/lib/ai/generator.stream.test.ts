import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("throws after a retryable stream error exhausts the retry limit", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onRetry = vi.fn();
    const failure = () =>
      streamParts([
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
      createGenerator({}, { onRetry }).generate("Build it"),
    ).rejects.toThrow("temporary tool failure");
    expect(onRetry).toHaveBeenCalledOnce();
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });
});
