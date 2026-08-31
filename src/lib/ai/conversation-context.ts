import type { Conversation, Message } from "../../types";
import { normalizeCompressedSummary } from "../utils/compress-context";

export function isErrorMessage(message: Message): boolean {
  if (message.role !== "assistant") return false;
  if (message.isError) return true;
  // Backward compatibility: old locally synthesized failures used this prefix.
  return (
    typeof message.content === "string" && message.content.startsWith("⚠️")
  );
}

/** Review activity blocks are persisted for UI history but never sent to a model. */
export function isUiOnlyMessage(message: Message): boolean {
  return Boolean(
    message.metadata?.origin === "design_review" &&
    message.metadata.reviewJobId,
  );
}

export function removeErrorMessages(messages: readonly Message[]): Message[] {
  return messages.filter((message) => !isErrorMessage(message));
}

/** Build the persisted-conversation portion of a model request. Attachments are
 * hydrated separately at the final request boundary. */
export function messagesForConversationContinuation(
  conversation: Conversation,
): Message[] {
  const context = conversation.compressedContext;
  if (!context) {
    return removeErrorMessages(conversation.messages).filter(
      (message) => !isUiOnlyMessage(message),
    );
  }
  const recent = removeErrorMessages(
    conversation.messages.slice(context.fromIndex),
  ).filter((message) => !isUiOnlyMessage(message));
  return [
    {
      role: "user",
      content: `[Previous conversation summary]\n${normalizeCompressedSummary(context.summary)}`,
    },
    {
      role: "assistant",
      content:
        "Understood. I'll continue based on the conversation summary above.",
    },
    ...recent,
  ];
}
