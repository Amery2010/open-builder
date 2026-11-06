import type { Message, ContentPart } from "../../types";
import type {
  MergedMessage,
  Block,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
  SkillLoadItem,
} from "../../types";
import { getT, type Translations } from "../../i18n";
import { agnesToolNameFromAlias } from "../mcp/agnes/aliases";
import {
  AGNES_MCP_SERVER_ID,
  isAgnesMediaToolContent,
  type AgnesToolName,
} from "../mcp/agnes/types";

function getAgnesToolName(
  toolName: string,
  toolOutput?: Message["toolOutput"],
): AgnesToolName | undefined {
  const source = toolOutput?.source;
  if (source) {
    if (source.serverId !== AGNES_MCP_SERVER_ID) return undefined;
    return source.toolName === "generate_image" ||
      source.toolName === "create_video" ||
      source.toolName === "get_video_status"
      ? source.toolName
      : undefined;
  }
  return agnesToolNameFromAlias(toolName);
}

/** Extract plain text from message content (string or multi-part array),
 *  excluding file attachment parts (prefixed with [File: ...]) */
function getTextContent(
  content: string | ContentPart[] | null | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  return content
    .filter(
      (p): p is Extract<ContentPart, { type: "text" }> => p.type === "text",
    )
    .filter((p) => !p.text.startsWith("[File: "))
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Extract image URLs from multi-part content */
function getImageUrls(
  content: string | ContentPart[] | null | undefined,
): string[] {
  if (!content || typeof content === "string") return [];
  return content
    .filter(
      (p): p is Extract<ContentPart, { type: "image_url" }> =>
        p.type === "image_url",
    )
    .map((p) => p.image_url.url);
}

/** Extract file attachment info from multi-part content */
function getFileAttachments(
  content: string | ContentPart[] | null | undefined,
): Array<{ name: string; size: number; text: string }> {
  if (!content || typeof content === "string") return [];
  return content
    .filter(
      (p): p is Extract<ContentPart, { type: "text" }> => p.type === "text",
    )
    .filter((p) => p.text.startsWith("[File: "))
    .map((p) => {
      // Format: [File: name | size]\ncontent  or  [File: name]\ncontent (legacy)
      const match = /^\[File: (.+?)(?:\s*\|\s*(\d+))?\]\n([\s\S]*)$/.exec(
        p.text,
      );
      return match
        ? {
            name: match[1],
            size: match[2] ? parseInt(match[2], 10) : 0,
            text: match[3],
          }
        : null;
    })
    .filter(
      (f): f is { name: string; size: number; text: string } => f !== null,
    );
}

function aggregateSkillLoads(blocks: Block[], t: Translations): Block[] {
  const skillIndexes = blocks.flatMap((block, index) =>
    block.type === "tool" &&
    (block.toolName === "list_skills" || block.toolName === "read_skill")
      ? [index]
      : [],
  );
  const readBlocks = blocks.filter(
    (block): block is ToolBlock =>
      block.type === "tool" && block.toolName === "read_skill",
  );
  if (readBlocks.length === 0) return blocks;

  const byName = new Map<string, SkillLoadItem>();
  for (const block of readBlocks) {
    const rawName = block.rawArgs?.name;
    const name =
      typeof rawName === "string" && rawName.trim()
        ? rawName.trim()
        : block.title;
    const rawReference = block.rawArgs?.reference_path;
    const referencePath =
      typeof rawReference === "string" && rawReference.trim()
        ? rawReference.trim()
        : undefined;
    const failed =
      block.toolOutput?.isError === true || block.result.startsWith("Error");
    const nextStatus: SkillLoadItem["status"] = failed
      ? "failed"
      : block.result || block.toolOutput
        ? "completed"
        : "running";
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, {
        name,
        ...(referencePath ? { referencePaths: [referencePath] } : {}),
        status: nextStatus,
        ...(failed && block.result ? { error: block.result } : {}),
      });
      continue;
    }

    if (existing.status === "failed" || nextStatus === "failed") {
      existing.status =
        existing.status === "failed" && nextStatus === "failed"
          ? "failed"
          : "attention";
    } else if (existing.status === "attention") {
      existing.status = "attention";
    } else if (existing.status === "running" || nextStatus === "running") {
      existing.status = "running";
    } else {
      existing.status = "completed";
    }
    if (referencePath && !existing.referencePaths?.includes(referencePath)) {
      existing.referencePaths = [
        ...(existing.referencePaths ?? []),
        referencePath,
      ];
    }
    if (!existing.error && failed && block.result) {
      existing.error = block.result;
    }
  }

  const firstIndex = skillIndexes[0];
  const firstRead = readBlocks[0];
  const aggregate: ToolBlock = {
    type: "tool",
    toolName: "read_skill",
    title: t.tool.names.read_skill,
    path: "",
    result: "",
    toolCallId: firstRead.toolCallId,
    skillLoads: Array.from(byName.values()),
    id: `tool-skill-loads-${firstRead.toolCallId}`,
  };

  const next: Block[] = [];
  blocks.forEach((block, index) => {
    if (index === firstIndex) next.push(aggregate);
    if (
      block.type === "tool" &&
      (block.toolName === "list_skills" || block.toolName === "read_skill")
    ) {
      return;
    }
    next.push(block);
  });
  return next;
}

export function mergeMessages(
  messages: Message[],
  t: Translations = getT(),
): MergedMessage[] {
  const merged: MergedMessage[] = [];
  const agnesVideoOrigins = new Map<string, string>();

  for (const message of messages) {
    if (
      message.role !== "tool" ||
      !message.tool_call_id ||
      getAgnesToolName(
        message.toolOutput?.source?.alias ?? "",
        message.toolOutput,
      ) !== "create_video" ||
      !isAgnesMediaToolContent(message.toolOutput?.structuredContent)
    ) {
      continue;
    }
    const content = message.toolOutput.structuredContent;
    if (content.operation === "create_video" && content.videoId) {
      agnesVideoOrigins.set(content.videoId, message.tool_call_id);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      if (
        msg.metadata?.origin === "design_review" &&
        msg.metadata.reviewJobId
      ) {
        merged.push({
          role: "user",
          blocks: [],
          id: `user-${msg.id ?? i}`,
          origin: "design_review",
          reviewJobId: msg.metadata.reviewJobId,
          reviewSummary: msg.metadata.reviewSummary,
        });
        continue;
      }
      const blocks: Block[] = [];
      const origin = msg.metadata?.origin;
      const instructionId = msg.metadata?.instructionId;
      let j = i;
      let bi = 0;
      while (
        j < messages.length &&
        messages[j].role === "user" &&
        messages[j].metadata?.origin === origin &&
        messages[j].metadata?.instructionId === instructionId
      ) {
        const text = getTextContent(messages[j].content);
        if (text) {
          blocks.push({ type: "text", content: text, id: `text-${i}-${bi++}` });
        }
        for (const url of getImageUrls(messages[j].content)) {
          blocks.push({ type: "image", url, id: `img-${i}-${bi++}` });
        }
        for (const file of getFileAttachments(messages[j].content)) {
          blocks.push({
            type: "file",
            name: file.name,
            content: file.text,
            size: file.size,
            id: `file-${i}-${bi++}`,
          });
        }
        for (const attachment of messages[j].metadata?.attachments ?? []) {
          if (attachment.type === "image") {
            blocks.push({
              type: "image",
              attachmentId: attachment.id,
              name: attachment.name,
              id: `img-${i}-${bi++}`,
            });
          } else {
            blocks.push({
              type: "file",
              name: attachment.name,
              attachmentId: attachment.id,
              mimeType: attachment.mimeType,
              size: attachment.size,
              id: `file-${i}-${bi++}`,
            });
          }
        }
        j++;
      }
      if (blocks.length > 0) {
        merged.push({
          role: "user",
          blocks,
          id: `user-${msg.id ?? i}`,
          origin,
          ...(instructionId ? { instructionId } : {}),
        });
      }
      i = j - 1;
    } else if (msg.role === "assistant") {
      const otherBlocks: Block[] = [];
      let isError = false;
      let errorKind: MergedMessage["errorKind"] | undefined;
      let errorRetryable: boolean | undefined;
      let errorStatus: number | undefined;
      let localCliFailure: MergedMessage["localCliFailure"];
      let localCli: MergedMessage["localCli"];
      let j = i;
      let bi = 0;

      while (
        j < messages.length &&
        (messages[j].role === "assistant" || messages[j].role === "tool")
      ) {
        const cur = messages[j];
        if (cur.role === "assistant") {
          if (cur.isError) {
            isError = true;
            errorKind = errorKind ?? cur.errorKind;
            errorRetryable = errorRetryable ?? cur.errorRetryable;
            errorStatus = errorStatus ?? cur.errorStatus;
            localCliFailure = localCliFailure ?? cur.localCliFailure;
            localCli = localCli ?? cur.metadata?.localCli;
          }
          if (cur.thinking) {
            otherBlocks.push({
              type: "thinking",
              content: cur.thinking,
              id: `thinking-${j}`,
            } as ThinkingBlock);
          }
          const text = getTextContent(cur.content);
          if (text) {
            otherBlocks.push({
              type: "text",
              content: text,
              id: `text-${i}-${bi++}`,
            } as TextBlock);
          }
          if (cur.tool_calls) {
            for (const tc of cur.tool_calls) {
              // Skip memory tool calls — they should be invisible to the user
              if (tc.function.name === "manage_memories") continue;

              let args: Record<string, any> = {};
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                /* ignore */
              }
              let result = "";
              let toolOutput: Message["toolOutput"];
              for (let k = j + 1; k < messages.length; k++) {
                if (
                  messages[k].role === "tool" &&
                  messages[k].tool_call_id === tc.id
                ) {
                  result = getTextContent(messages[k].content) || "";
                  toolOutput = messages[k].toolOutput;
                  break;
                }
              }
              const agnesToolName = getAgnesToolName(
                tc.function.name,
                toolOutput,
              );
              if (agnesToolName === "get_video_status") {
                const structured = isAgnesMediaToolContent(
                  toolOutput?.structuredContent,
                )
                  ? toolOutput.structuredContent
                  : undefined;
                const videoId =
                  structured?.videoId ??
                  (typeof args.video_id === "string"
                    ? args.video_id
                    : undefined);
                const originCallId = videoId
                  ? agnesVideoOrigins.get(videoId)
                  : undefined;
                if (originCallId && originCallId !== tc.id) {
                  continue;
                }
              }
              const isReadFiles = tc.function.name === "read_files";
              const paths: string[] | undefined = isReadFiles
                ? (args.paths as string[])
                : undefined;
              const toolName = tc.function.name as keyof typeof t.tool.names;

              const translatedName = t.tool.names[toolName];
              let title = translatedName
                ? translatedName
                : tc.function.name.startsWith("mcp_")
                  ? t.tool.mcpToolPending
                  : `${t.tool.unknownTool} · ${tc.function.name}`;
              if (toolOutput?.source?.kind === "mcp") {
                title = `${toolOutput.source.serverName} · ${toolOutput.source.toolTitle || toolOutput.source.toolName}`;
              }

              otherBlocks.push({
                type: "tool",
                toolName: tc.function.name,
                title,
                path: args.path || "",
                paths,
                result,
                toolOutput,
                toolCallId: tc.id,
                rawArgs: args,
                id: `tool-${tc.id}`,
              } as ToolBlock);
              bi++;
            }
          }
        }
        j++;
      }

      const blocks = aggregateSkillLoads(otherBlocks, t);

      if (blocks.length > 0) {
        merged.push({
          role: "assistant",
          blocks,
          id: `assistant-${msg.id ?? i}`,
          ...(isError ? { isError: true } : {}),
          ...(errorKind ? { errorKind } : {}),
          ...(errorRetryable !== undefined ? { errorRetryable } : {}),
          ...(errorStatus !== undefined ? { errorStatus } : {}),
          ...(localCliFailure ? { localCliFailure } : {}),
          ...(localCli ? { localCli } : {}),
        });
      }
      i = j - 1;
    }
  }

  return merged;
}

/** Return the final genuine user message when no later message is rendered in
 *  the conversation timeline. Raw internal placeholders may trail it. */
export function findWithdrawableUserMessageIndex(
  messages: Message[],
  mergedMessages: readonly MergedMessage[] = mergeMessages(messages),
): number | null {
  const lastVisible = mergedMessages.at(-1);
  if (
    !lastVisible ||
    lastVisible.role !== "user" ||
    lastVisible.origin !== undefined
  ) {
    return null;
  }

  const match = /^user-(\d+)$/.exec(lastVisible.id);
  const stableIndex = messages.findIndex(
    (message) => message.id && `user-${message.id}` === lastVisible.id,
  );
  if (!match && stableIndex < 0) return null;
  const start = stableIndex >= 0 ? stableIndex : Number.parseInt(match![1], 10);
  if (
    !Number.isSafeInteger(start) ||
    messages[start]?.role !== "user" ||
    messages[start]?.metadata?.origin
  ) {
    return null;
  }

  let end = start;
  while (
    end < messages.length &&
    messages[end].role === "user" &&
    !messages[end].metadata?.origin
  ) {
    end += 1;
  }
  return end - 1;
}
