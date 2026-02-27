import { useMemo } from "react";
import type { Message, ContentPart } from "../types";
import type {
  MergedMessage,
  Block,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
} from "../types";

const TOOL_NAMES: Record<string, string> = {
  init_project: "初始化项目",
  manage_dependencies: "管理依赖",
  list_files: "列出项目文件",
  // read_file: "读取文件",
  read_files: "读取文件",
  write_file: "写入文件",
  patch_file: "修改文件",
  delete_file: "删除文件",
  search_in_files: "搜索文件内容",
  web_search: "搜索网络",
  web_reader: "读取网页",
};

/** Extract plain text from message content (string or multi-part array) */
function getTextContent(
  content: string | ContentPart[] | null | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  return content
    .filter(
      (p): p is Extract<ContentPart, { type: "text" }> => p.type === "text",
    )
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

function mergeMessages(messages: Message[]): MergedMessage[] {
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
          // Thinking block (before text content)
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
              const isWebSearch = tc.function.name === "web_search";
              const isWebReader = tc.function.name === "web_reader";
              const paths: string[] | undefined = isReadFiles
                ? (args.paths as string[])
                : undefined;
              blocks.push({
                type: "tool",
                toolName: tc.function.name,
                title: isReadFiles
                  ? `读取 ${paths?.length ?? 0} 个文件`
                  : isWebSearch
                    ? `搜索: ${args.query || ""}`
                    : isWebReader
                      ? `读取 ${(args.urls as string[])?.length ?? 0} 个网页`
                      : TOOL_NAMES[tc.function.name] || tc.function.name,
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

export function useMergedMessages(messages: Message[]): MergedMessage[] {
  return useMemo(() => mergeMessages(messages), [messages]);
}
