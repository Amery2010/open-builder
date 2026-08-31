import type { Conversation, Message, ProjectFiles } from "../../types";
import {
  isErrorMessage,
  isUiOnlyMessage,
  messagesForConversationContinuation,
} from "../ai/conversation-context";
import { filterMemoryMessages } from "../utils/memory-filter";

const MAX_BOOTSTRAP_CHARS = 512 * 1024;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "modelOutput")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function fingerprintMessage(message: Message): unknown {
  const content = Array.isArray(message.content)
    ? message.content.map((part) => {
        if (part.type === "text") return part;
        if (part.type === "image_url") return { type: "image" };
        return {
          type: "file",
          filename: part.file.filename,
          mediaType: part.file.mediaType,
        };
      })
    : message.content;
  return stableValue({
    role: message.role,
    content,
    toolCalls: message.tool_calls,
    toolCallId: message.tool_call_id,
    thinking: message.thinking,
    forcedSkillIds: message.forcedSkillIds,
    metadata: message.metadata,
    toolOutput: message.toolOutput
      ? {
          text: message.toolOutput.text,
          isError: message.toolOutput.isError,
          structuredContent: message.toolOutput.structuredContent,
          source: message.toolOutput.source,
        }
      : undefined,
  });
}

async function digestText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function fingerprintFiles(files: ProjectFiles): Promise<unknown[]> {
  return Promise.all(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([path, content]) => [path, await digestText(content)]),
  );
}

export async function computeConversationFingerprint(
  conversation: Pick<
    Conversation,
    "messages" | "files" | "compressedContext" | "template"
  >,
): Promise<string> {
  const compressedContext = conversation.compressedContext
    ? {
        ...conversation.compressedContext,
        fromIndex:
          conversation.compressedContext.fromIndex -
          conversation.messages
            .slice(0, conversation.compressedContext.fromIndex)
            .filter(isUiOnlyMessage).length,
      }
    : undefined;
  const payload = {
    version: 1,
    template: conversation.template,
    compressedContext,
    messages: filterMemoryMessages(conversation.messages)
      .filter((message) => !isErrorMessage(message))
      .filter((message) => !isUiOnlyMessage(message))
      .map(fingerprintMessage),
    files: await fingerprintFiles(conversation.files),
  };
  return digestText(JSON.stringify(stableValue(payload)));
}

function printableContent(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image_url") return "[Image attachment]";
      return `[File attachment: ${part.file.filename} (${part.file.mediaType})]`;
    })
    .join("\n");
}

export function formatConversationBootstrap(
  conversation: Pick<Conversation, "messages" | "compressedContext">,
): string {
  const sections: string[] = [];
  const canonicalMessages = filterMemoryMessages(
    messagesForConversationContinuation(conversation as Conversation),
  );
  for (const message of canonicalMessages) {
    if (isErrorMessage(message)) continue;
    const label = message.role.toUpperCase();
    const body = printableContent(message);
    const toolCalls = message.tool_calls?.length
      ? `\n[Tool calls]\n${message.tool_calls
          .map(
            (call) =>
              `${call.function.name}(${call.function.arguments || "{}"})`,
          )
          .join("\n")}`
      : "";
    const toolOutput =
      message.role === "tool" && message.toolOutput?.text
        ? message.toolOutput.text
        : "";
    sections.push(`[${label}]\n${body || toolOutput}${toolCalls}`);
  }
  const joined = sections.join("\n\n");
  if (joined.length <= MAX_BOOTSTRAP_CHARS) return joined;
  return `[Earlier application history omitted to fit the local CLI context.]\n\n${joined.slice(
    -MAX_BOOTSTRAP_CHARS,
  )}`;
}
