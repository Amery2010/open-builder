import type { Message, ContentPart } from "../types";
import type {
  MergedMessage,
  Block,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
} from "../types";
import { getT } from "../i18n";

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
      const match = /^\[File: (.+?)(?:\s*\|\s*(\d+))?\]\n([\s\S]*)$/.exec(p.text);
      return match ? { name: match[1], size: match[2] ? parseInt(match[2], 10) : 0, text: match[3] } : null;
    })
    .filter((f): f is { name: string; size: number; text: string } => f !== null);
}

export function mergeMessages(messages: Message[]): MergedMessage[] {
  const t = getT();
  const merged: MergedMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      const blocks: Block[] = [];
      let j = i;
      let bi = 0;
      while (j < messages.length && messages[j].role === "user") {
        const text = getTextContent(messages[j].content);
        if (text) {
          blocks.push({ type: "text", content: text, id: `text-${i}-${bi++}` });
        }
        for (const url of getImageUrls(messages[j].content)) {
          blocks.push({ type: "image", url, id: `img-${i}-${bi++}` });
        }
        for (const file of getFileAttachments(messages[j].content)) {
          blocks.push({ type: "file", name: file.name, content: file.text, size: file.size, id: `file-${i}-${bi++}` });
        }
        j++;
      }
      if (blocks.length > 0) {
        merged.push({ role: "user", blocks, id: `user-${i}` });
      }
      i = j - 1;
    } else if (msg.role === "assistant") {
      const blocks: Block[] = [];
      let j = i;
      let bi = 0;

      while (
        j < messages.length &&
        (messages[j].role === "assistant" || messages[j].role === "tool")
      ) {
        const cur = messages[j];
        if (cur.role === "assistant") {
          if (cur.thinking) {
            blocks.push({
              type: "thinking",
              content: cur.thinking,
              id: `thinking-${i}-${bi++}`,
            } as ThinkingBlock);
          }
          const text = getTextContent(cur.content);
          if (text) {
            blocks.push({
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
              for (let k = j + 1; k < messages.length; k++) {
                if (
                  messages[k].role === "tool" &&
                  messages[k].tool_call_id === tc.id
                ) {
                  result = getTextContent(messages[k].content) || "";
                  break;
                }
              }
              const isReadFiles = tc.function.name === "read_files";
              const paths: string[] | undefined = isReadFiles
                ? (args.paths as string[])
                : undefined;
              const toolName = tc.function.name as keyof typeof t.tool.names;

              // Generate title based on tool type
              let title = t.tool.names[toolName] || tc.function.name;
              if (isReadFiles) {
                title = `${t.tool.found}${paths?.length ?? 0} ${t.tool.files}`;
              } else if (args.query) {
                title = `${t.tool.names[toolName]}: ${args.query}`;
              } else if (args.packageName) {
                title = `${t.tool.names[toolName]}: ${args.packageName}`;
              } else if (args.urls) {
                title = `${t.tool.found}${(args.urls as string[])?.length ?? 0} ${t.tool.pages}`;
              }

              blocks.push({
                type: "tool",
                toolName: tc.function.name,
                title,
                path: args.path || "",
                paths,
                result,
                id: `tool-${tc.id}`,
              } as ToolBlock);
              bi++;
            }
          }
        }
        j++;
      }

      if (blocks.length > 0) {
        merged.push({ role: "assistant", blocks, id: `assistant-${i}` });
      }
      i = j - 1;
    }
  }

  return merged;
}
