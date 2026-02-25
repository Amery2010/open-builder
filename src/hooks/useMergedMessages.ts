import { useMemo } from "react";
import type { Message } from "../types";
import type { MergedMessage, Block, TextBlock, ToolBlock } from "../types";

const TOOL_NAMES: Record<string, string> = {
  list_files: "列出文件",
  read_file: "读取文件",
  read_files: "读取文件",
  write_file: "写入文件",
  patch_file: "修改文件",
  delete_file: "删除文件",
};

function mergeMessages(messages: Message[]): MergedMessage[] {
  const merged: MergedMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      const contents: string[] = [];
      let j = i;
      while (j < messages.length && messages[j].role === "user") {
        const c = messages[j].content?.trim();
        if (c) contents.push(c);
        j++;
      }
      if (contents.length > 0) {
        merged.push({
          role: "user",
          blocks: [{ type: "text", content: contents.join("\n\n"), id: `text-${i}` }],
          id: `user-${i}`,
        });
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
          const text = cur.content?.trim();
          if (text) {
            blocks.push({ type: "text", content: text, id: `text-${i}-${bi++}` } as TextBlock);
          }
          if (cur.tool_calls) {
            for (const tc of cur.tool_calls) {
              let args: Record<string, any> = {};
              try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
              let result = "";
              for (let k = j + 1; k < messages.length; k++) {
                if (messages[k].role === "tool" && messages[k].tool_call_id === tc.id) {
                  result = messages[k].content?.trim() || "";
                  break;
                }
              }
              const isReadFiles = tc.function.name === "read_files";
              const paths: string[] | undefined = isReadFiles ? (args.paths as string[]) : undefined;
              blocks.push({
                type: "tool",
                toolName: tc.function.name,
                title: isReadFiles
                  ? `读取 ${paths?.length ?? 0} 个文件`
                  : (TOOL_NAMES[tc.function.name] || tc.function.name),
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
