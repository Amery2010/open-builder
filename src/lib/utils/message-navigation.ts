import type { Message } from "../../types";
import { mergeMessages } from "./merge-messages";
import { truncate } from "./truncate";

const MERGED_ID_RE = /^(?:assistant|user)-(\d+)$/;

export function getMergedMessageStartIndex(
  mergedId: string,
  messages?: readonly Message[],
): number | null {
  const stableIndex = messages?.findIndex(
    (message) => message.id && `${message.role}-${message.id}` === mergedId,
  );
  if (stableIndex !== undefined && stableIndex >= 0) return stableIndex;
  const match = MERGED_ID_RE.exec(mergedId);
  if (!match) return null;
  const idx = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(idx) ? idx : null;
}

export function findAssistantGroupEnd(
  messages: Message[],
  mergedId: string,
): number {
  if (!mergedId.startsWith("assistant-")) return messages.length;
  const startIdx = getMergedMessageStartIndex(mergedId, messages);
  if (startIdx === null || startIdx >= messages.length) return messages.length;
  let j = startIdx;
  while (
    j < messages.length &&
    (messages[j].role === "assistant" || messages[j].role === "tool")
  ) {
    j++;
  }
  return j;
}

export function findPrecedingUserLabel(
  messages: Message[],
  mergedId: string,
): string {
  const merged = mergeMessages(messages);
  const idx = merged.findIndex((m) => m.id === mergedId);
  if (idx <= 0) return "";
  for (let i = idx - 1; i >= 0; i--) {
    if (merged[i].role === "user") {
      const textBlock = merged[i].blocks.find((b) => b.type === "text");
      if (textBlock && "content" in textBlock) {
        const text = textBlock.content;
        return truncate(text, 30);
      }
    }
  }
  return "";
}
