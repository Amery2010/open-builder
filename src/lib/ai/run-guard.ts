import type { Message } from "./generator-types";

export const CANCELLED_TOOL_OUTPUT_KIND = "open_builder_cancelled_tool_v1";

export function isGenerationRunCurrent(
  runConversationId: string | null,
  activeConversationId: string | null,
  currentRunConversationId: string | null,
): boolean {
  return (
    !!runConversationId &&
    runConversationId === activeConversationId &&
    runConversationId === currentRunConversationId
  );
}

export function isGeneratorConstructionCurrent(
  expectedEpoch: number,
  currentEpoch: number,
  conversationId: string | null,
  activeConversationId: string | null,
  currentRunConversationId: string | null,
  configMatches: boolean,
): boolean {
  return (
    expectedEpoch === currentEpoch &&
    configMatches &&
    isGenerationRunCurrent(
      conversationId,
      activeConversationId,
      currentRunConversationId,
    )
  );
}

export interface PendingToolCallLocation {
  messageIndex: number;
  toolCallIndex: number;
}

export function findPendingToolCall(
  messages: readonly Message[],
  preferredToolCallId?: string,
): PendingToolCallLocation | null {
  if (preferredToolCallId) {
    let laterResultCount = 0;
    for (
      let messageIndex = messages.length - 1;
      messageIndex >= 0;
      messageIndex--
    ) {
      const message = messages[messageIndex];
      if (
        message.role === "tool" &&
        message.tool_call_id === preferredToolCallId
      ) {
        laterResultCount += 1;
        continue;
      }
      const toolCalls = message.tool_calls;
      const toolCallIndex =
        toolCalls?.findIndex((call) => call.id === preferredToolCallId) ?? -1;
      if (toolCallIndex !== -1) {
        return laterResultCount > 0 ? null : { messageIndex, toolCallIndex };
      }
    }

    return null;
  }

  const laterResultCounts = new Map<string, number>();
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = messages[messageIndex];
    if (message.role === "tool" && message.tool_call_id) {
      laterResultCounts.set(
        message.tool_call_id,
        (laterResultCounts.get(message.tool_call_id) ?? 0) + 1,
      );
      continue;
    }

    const toolCalls = message.tool_calls;
    if (!toolCalls?.length) continue;
    for (
      let toolCallIndex = toolCalls.length - 1;
      toolCallIndex >= 0;
      toolCallIndex--
    ) {
      const id = toolCalls[toolCallIndex].id;
      const completedCount = laterResultCounts.get(id) ?? 0;
      if (completedCount > 0) {
        if (completedCount === 1) laterResultCounts.delete(id);
        else laterResultCounts.set(id, completedCount - 1);
        continue;
      }
      return { messageIndex, toolCallIndex };
    }
  }
  return null;
}

/** Complete abandoned groups before replay without discarding completed work. */
export function cancelPendingToolCalls(
  messages: readonly Message[],
): Message[] {
  const result: Message[] = [];
  let pending = new Map<string, NonNullable<Message["tool_calls"]>[number]>();
  function closeGroup(): void {
    for (const call of pending.values()) {
      const text = "Tool execution was cancelled before a result was received.";
      result.push({
        role: "tool",
        tool_call_id: call.id,
        content: text,
        toolOutput: {
          text,
          isError: true,
          structuredContent: { kind: CANCELLED_TOOL_OUTPUT_KIND },
        },
      });
    }
    pending = new Map();
  }
  for (const message of messages) {
    if (message.role !== "tool") closeGroup();
    result.push(message);
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) pending.set(call.id, call);
    } else if (message.tool_call_id) {
      pending.delete(message.tool_call_id);
    }
  }
  closeGroup();
  return result;
}
