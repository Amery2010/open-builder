import type { Message } from "../ai/generator";
import type { CompressedContext, ProjectFiles } from "../../types";
import type { ProviderConfig } from "../ai/provider-config";
import { buildProjectFilesPromptListing } from "./project-files";
import { projectFilesForModel } from "./project-file-policy";
import {
  redactSensitiveText,
  sanitizeToolResultForHistory,
  serializeToolArgumentsForHistory,
} from "./message-security";

export interface CompressResult {
  summary: string;
  fromIndex: number;
}

export const COMPRESSED_CONTEXT_LIMITS = {
  maxSummaryChars: 80_000,
} as const;

const TOOL_RESULT_MAX_CHARS = 600;

function truncateForSummary(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `... [truncated ${text.length - max} chars]`;
}

export function normalizeCompressedSummary(summary: string): string {
  const sanitized = redactSensitiveText(summary);
  if (sanitized.length <= COMPRESSED_CONTEXT_LIMITS.maxSummaryChars) {
    return sanitized;
  }
  return (
    sanitized.slice(0, COMPRESSED_CONTEXT_LIMITS.maxSummaryChars) +
    `\n\n[compressed context truncated after ${COMPRESSED_CONTEXT_LIMITS.maxSummaryChars} chars]`
  );
}

function formatContentForSummary(m: Message): string {
  if (typeof m.content === "string") return redactSensitiveText(m.content);
  if (!Array.isArray(m.content)) return "";
  return m.content
    .map((part) => {
      if (part.type === "text") return redactSensitiveText(part.text);
      if (part.type === "image_url")
        return "[Image attachment omitted from summary]";
      return `[PDF attachment: ${JSON.stringify(part.file.filename)} | ${part.file.mediaType}]`;
    })
    .join("\n");
}

function findToolCallForMessage(messages: Message[], index: number) {
  const toolCallId = messages[index]?.tool_call_id;
  if (!toolCallId) return undefined;
  for (let current = index - 1; current >= 0; current--) {
    const call = messages[current].tool_calls?.find(
      (item) => item.id === toolCallId,
    );
    if (call) return call;
  }
  return undefined;
}

function attachmentSummary(m: Message): string {
  const attachments = m.metadata?.attachments;
  if (!attachments?.length) return "";
  return attachments
    .map(
      (attachment) =>
        `[Attachment: ${JSON.stringify(attachment.name)} | ${attachment.mimeType} | ${attachment.size} bytes]`,
    )
    .join("\n");
}

function formatMessageForSummary(
  messages: Message[],
  index: number,
): string | null {
  const m = messages[index];
  if (m.role === "system") return null;
  if (m.metadata?.origin) return null;

  if (m.role === "tool") {
    const call = findToolCallForMessage(messages, index);
    const rawBody = formatContentForSummary(m);
    const body = sanitizeToolResultForHistory(
      call?.function.name ?? "unknown",
      call?.function.arguments ?? "{}",
      rawBody,
    );
    return `tool_result: ${truncateForSummary(body, TOOL_RESULT_MAX_CHARS)}`;
  }

  const body = [formatContentForSummary(m), attachmentSummary(m)]
    .filter(Boolean)
    .join("\n");

  if (m.role === "assistant" && m.tool_calls?.length) {
    const calls = m.tool_calls
      .map((tc) => {
        const args = truncateForSummary(
          serializeToolArgumentsForHistory(
            tc.function.name,
            tc.function.arguments ?? "{}",
          ),
          200,
        );
        return `${tc.function.name}(${args})`;
      })
      .join(", ");
    return body
      ? `assistant: ${body}\nassistant_tool_calls: ${calls}`
      : `assistant_tool_calls: ${calls}`;
  }

  return `${m.role}: ${body}`;
}

function buildFileInventory(files: ProjectFiles | undefined): string {
  if (!files) return "";
  const listing = buildProjectFilesPromptListing(projectFilesForModel(files));
  return listing.includes("The project is empty") ? "" : listing;
}

export async function compressContext(
  messages: Message[],
  cfg: ProviderConfig,
  existingContext?: CompressedContext,
  files?: ProjectFiles,
  generateTextOverride?: (
    instructions: string,
    prompt: string,
  ) => Promise<string>,
): Promise<CompressResult | null> {
  const userIndices = messages.reduce<number[]>((acc, m, i) => {
    if (m.role === "user" && !m.metadata?.origin) acc.push(i);
    return acc;
  }, []);
  if (userIndices.length < 2) return null;

  const fromIndex = userIndices[userIndices.length - 1];
  if (fromIndex <= 0) return null;

  let text: string;
  if (existingContext && existingContext.fromIndex > 0) {
    const newer = messages
      .slice(existingContext.fromIndex, fromIndex)
      .map((_, offset) =>
        formatMessageForSummary(messages, existingContext.fromIndex + offset),
      )
      .filter((line): line is string => line !== null)
      .join("\n");
    text = `[Previous summary]\n${normalizeCompressedSummary(existingContext.summary)}\n\n[Recent conversation]\n${newer}`;
  } else {
    const older = messages.slice(0, fromIndex);
    text = older
      .map((_, index) => formatMessageForSummary(messages, index))
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  const instructions =
    "Summarize this development conversation for an agent that must continue the work without seeing the original. Cover: what the user asked for, what was built or changed, key tool operations (files read and written, searches and their results), decisions and their reasons, and the current project state. Preserve every detail needed to continue; drop everything else. Write compact prose, no preamble.";
  const generated = generateTextOverride
    ? await generateTextOverride(instructions, text)
    : await (async () => {
        const [{ generateText }, { getProviderModel }] = await Promise.all([
          import("ai"),
          import("../ai/provider"),
        ]);
        return (
          await generateText({
            model: getProviderModel(cfg),
            instructions,
            prompt: text,
          })
        ).text;
      })();

  const summary = normalizeCompressedSummary(
    (generated || "") + buildFileInventory(files),
  );

  return { summary, fromIndex };
}
