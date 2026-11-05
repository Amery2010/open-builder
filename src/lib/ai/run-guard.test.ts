import { describe, expect, it } from "vitest";
import type { Message } from "./generator-types";
import {
  findPendingToolCall,
  isGenerationRunCurrent,
  isGeneratorConstructionCurrent,
} from "./run-guard";

describe("generation run guard", () => {
  it("accepts events only for the active conversation and current run", () => {
    expect(isGenerationRunCurrent("a", "a", "a")).toBe(true);
    expect(isGenerationRunCurrent("a", "b", "a")).toBe(false);
    expect(isGenerationRunCurrent("a", "a", "b")).toBe(false);
    expect(isGenerationRunCurrent(null, "a", "a")).toBe(false);
  });

  it("publishes a constructed generator only for the current epoch, config, and conversation", () => {
    expect(isGeneratorConstructionCurrent(2, 2, "a", "a", "a", true)).toBe(
      true,
    );
    expect(isGeneratorConstructionCurrent(1, 2, "a", "a", "a", true)).toBe(
      false,
    );
    expect(isGeneratorConstructionCurrent(2, 2, "a", "b", "a", true)).toBe(
      false,
    );
    expect(isGeneratorConstructionCurrent(2, 2, "a", "a", "a", false)).toBe(
      false,
    );
  });

  it("matches explicit tool results only by exact call id", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "first",
            type: "function",
            function: { name: "WebSearch", arguments: "" },
          },
          {
            id: "second",
            type: "function",
            function: { name: "WebFetch", arguments: "" },
          },
        ],
      },
    ];

    expect(findPendingToolCall(messages, "second")).toEqual({
      messageIndex: 0,
      toolCallIndex: 1,
    });
    expect(findPendingToolCall(messages, "missing")).toBeNull();
    expect(
      findPendingToolCall(
        [
          ...messages,
          { role: "tool", content: "done", tool_call_id: "second" },
        ],
        "second",
      ),
    ).toBeNull();
  });

  it("uses the first unresolved call only for legacy events without an id", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "first",
            type: "function",
            function: { name: "WebSearch", arguments: "" },
          },
          {
            id: "second",
            type: "function",
            function: { name: "WebFetch", arguments: "" },
          },
        ],
      },
      { role: "tool", content: "done", tool_call_id: "first" },
    ];

    expect(findPendingToolCall(messages)).toEqual({
      messageIndex: 0,
      toolCallIndex: 1,
    });
  });

  it("pairs a reused call id with its latest turn occurrence", () => {
    const repeatedCall = {
      id: "call-1",
      type: "function" as const,
      function: { name: "read_files", arguments: "{}" },
    };
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [repeatedCall],
      },
      { role: "tool", tool_call_id: "call-1", content: "old result" },
      { role: "user", content: "Run it again" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ ...repeatedCall }],
      },
    ];

    expect(findPendingToolCall(messages, "call-1")).toEqual({
      messageIndex: 3,
      toolCallIndex: 0,
    });
    expect(findPendingToolCall(messages)).toEqual({
      messageIndex: 3,
      toolCallIndex: 0,
    });

    messages.push({
      role: "tool",
      tool_call_id: "call-1",
      content: "new result",
    });
    expect(findPendingToolCall(messages, "call-1")).toBeNull();
    expect(findPendingToolCall(messages)).toBeNull();
  });
});

describe("cancelPendingToolCalls", () => {
  it("closes incomplete tool groups before a later user message without losing work", async () => {
    const { cancelPendingToolCalls } = await import("./run-guard");
    const messages: Message[] = [
      { role: "user", content: "Build" },
      {
        role: "assistant",
        content: "Saved one file",
        tool_calls: [
          {
            id: "done",
            type: "function",
            function: { name: "write_file", arguments: "{}" },
          },
          {
            id: "pending",
            type: "function",
            function: { name: "read_files", arguments: "" },
          },
        ],
      },
      { role: "tool", tool_call_id: "done", content: "Saved" },
      { role: "user", content: "Continue" },
    ];
    const result = cancelPendingToolCalls(messages);
    expect(result.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    expect(result[1].content).toBe("Saved one file");
    expect(result[2]).toEqual(messages[2]);
    expect(result[3]).toMatchObject({
      tool_call_id: "pending",
      toolOutput: { isError: true },
    });
    expect(cancelPendingToolCalls(result)).toEqual(result);
  });
});
