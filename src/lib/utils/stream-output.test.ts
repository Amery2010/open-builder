import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { appendBufferedAssistantOutput } from "./stream-output";

describe("appendBufferedAssistantOutput", () => {
  it("creates an assistant message when completion beats the first frame", () => {
    const messages: Message[] = [{ role: "user", content: "Build it" }];

    expect(
      appendBufferedAssistantOutput(messages, {
        thinking: "Checking constraints",
        text: "Done",
      }),
    ).toEqual([
      ...messages,
      {
        role: "assistant",
        content: "Done",
        thinking: "Checking constraints",
      },
    ]);
  });

  it("appends both buffers to the existing assistant message", () => {
    const messages: Message[] = [
      { role: "assistant", content: "Hel", thinking: "Plan" },
    ];

    expect(
      appendBufferedAssistantOutput(messages, {
        thinking: " first",
        text: "lo",
      }),
    ).toEqual([
      {
        role: "assistant",
        content: "Hello",
        thinking: "Plan first",
      },
    ]);
  });

  it("starts a new assistant thinking phase after a tool result", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        thinking: "Inspect",
        tool_calls: [
          {
            id: "read-1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "read-1", content: "file contents" },
    ];

    expect(
      appendBufferedAssistantOutput(messages, { thinking: "Verify" }),
    ).toEqual([
      ...messages,
      { role: "assistant", content: null, thinking: "Verify" },
    ]);
  });
});
