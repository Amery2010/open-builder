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
import { truncate } from "./truncate";
import { TOOL_METADATA } from "../ai/tool-metadata";

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

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      const blocks: Block[] = [];
      const origin = msg.metadata?.origin;
      let j = i;
      let bi = 0;
      while (
        j < messages.length &&
        messages[j].role === "user" &&
        messages[j].metadata?.origin === origin
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
        merged.push({ role: "user", blocks, id: `user-${i}`, origin });
      }
      i = j - 1;
    } else if (msg.role === "assistant") {
      const otherBlocks: Block[] = [];
      let isError = false;
      let errorKind: MergedMessage["errorKind"] | undefined;
      let errorRetryable: boolean | undefined;
      let errorStatus: number | undefined;
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
              } else if (isReadFiles) {
                title = `${t.tool.found}${paths?.length ?? 0} ${t.tool.files}`;
              } else if (args.query) {
                title = `${title}: ${args.query}`;
              } else if (args.packageName) {
                title = `${title}: ${args.packageName}`;
              } else if (args.urls) {
                title = `${t.tool.found}${(args.urls as string[])?.length ?? 0} ${t.tool.pages}`;
              } else if (tc.function.name === "dispatch_subagent") {
                const subName =
                  typeof args.subagent === "string" ? args.subagent : "";
                const subTask =
                  typeof args.task === "string" ? truncate(args.task, 60) : "";
                const subDisplay =
                  t.subagent.names[subName as keyof typeof t.subagent.names] ??
                  subName ??
                  "subagent";
                title = subTask ? `${subDisplay}: ${subTask}` : subDisplay;
              } else {
                const custom = TOOL_METADATA[tc.function.name]?.titleBuilder?.(
                  args,
                  t,
                );
                if (custom !== undefined) title = custom;
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
          id: `assistant-${i}`,
          ...(isError ? { isError: true } : {}),
          ...(errorKind ? { errorKind } : {}),
          ...(errorRetryable !== undefined ? { errorRetryable } : {}),
          ...(errorStatus !== undefined ? { errorStatus } : {}),
        });
      }
      i = j - 1;
    }
  }

  return merged;
}
