import { useState, useRef, useEffect, useMemo, memo } from "react";
import type React from "react";
import {
  Send,
  Settings,
  Sparkles,
  Square,
  ChevronRight,
  FolderOpen,
  Folder,
  File,
  Eye,
  FilePen,
  Wrench,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Message } from "../lib/web-app-generator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

interface ChatInterfaceProps {
  onGenerate: (prompt: string) => Promise<void>;
  onStop: () => void;
  isGenerating: boolean;
  messages: Message[];
  onOpenSettings: () => void;
  hasValidSettings: boolean;
}

// Tool name/icon maps
const TOOL_NAMES: Record<string, string> = {
  list_files: "列出文件",
  read_file: "读取文件",
  write_file: "写入文件",
  patch_file: "修改文件",
  delete_file: "删除文件",
};

const TOOL_ICONS: Record<string, React.ReactNode> = {
  list_files: <FolderOpen size={14} className="text-yellow-500" />,
  read_file: <Eye size={14} className="text-blue-400" />,
  write_file: <FilePen size={14} className="text-green-500" />,
  patch_file: <Wrench size={14} className="text-orange-400" />,
  delete_file: <Trash2 size={14} className="text-red-400" />,
};

// ─── Block types ────────────────────────────────────────────────────────────

interface TextBlock {
  type: "text";
  content: string;
  id: string;
}

interface ToolBlock {
  type: "tool";
  toolName: string;
  title: string;
  path: string;
  result: string;
  id: string;
}

type Block = TextBlock | ToolBlock;

interface MergedMessage {
  role: "user" | "assistant";
  blocks: Block[];
  id: string;
}

// ─── mergeMessages ───────────────────────────────────────────────────────────

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
          blocks: [
            { type: "text", content: contents.join("\n\n"), id: `text-${i}` },
          ],
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
            blocks.push({
              type: "text",
              content: text,
              id: `text-${i}-${bi++}`,
            });
          }
          if (cur.tool_calls) {
            for (const tc of cur.tool_calls) {
              let args: Record<string, string> = {};
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
                  result = messages[k].content?.trim() || "";
                  break;
                }
              }
              blocks.push({
                type: "tool",
                toolName: tc.function.name,
                title: TOOL_NAMES[tc.function.name] || tc.function.name,
                path: args.path || "",
                result,
                id: `tool-${tc.id}`,
              });
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

// ─── FileTree ─────────────────────────────────────────────────────────────────

type TreeNode = { [key: string]: TreeNode | null };

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = {};
  for (const p of paths) {
    const parts = p.trim().split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node[part] = null;
      } else {
        node[part] = (node[part] as TreeNode) || {};
        node = node[part] as TreeNode;
      }
    }
  }
  return root;
}

function TreeNodeRow({
  name,
  node,
  depth,
}: {
  name: string;
  node: TreeNode | null;
  depth: number;
}) {
  const isDir = node !== null;
  return (
    <>
      <div
        className="flex items-center gap-1.5 py-0.5"
        style={{ paddingLeft: depth * 14 }}
      >
        {isDir ? (
          <Folder size={12} className="text-yellow-500 shrink-0" />
        ) : (
          <File size={12} className="text-muted-foreground shrink-0" />
        )}
        <span className="text-xs font-mono text-foreground/80">{name}</span>
      </div>
      {isDir &&
        Object.entries(node!)
          .sort(([, a], [, b]) => {
            // dirs first
            if (a !== null && b === null) return -1;
            if (a === null && b !== null) return 1;
            return 0;
          })
          .map(([childName, childNode]) => (
            <TreeNodeRow
              key={childName}
              name={childName}
              node={childNode}
              depth={depth + 1}
            />
          ))}
    </>
  );
}

function FileTreeView({ content }: { content: string }) {
  const paths = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "(empty)");
  if (paths.length === 0)
    return <span className="text-xs text-muted-foreground">（空）</span>;
  const tree = buildTree(paths);
  return (
    <div className="py-0.5">
      {Object.entries(tree)
        .sort(([, a], [, b]) => {
          if (a !== null && b === null) return -1;
          if (a === null && b !== null) return 1;
          return 0;
        })
        .map(([name, node]) => (
          <TreeNodeRow key={name} name={name} node={node} depth={0} />
        ))}
    </div>
  );
}

// ─── ToolCallCard ─────────────────────────────────────────────────────────────

function ToolCallCard({
  toolName,
  title,
  path,
  result,
}: Omit<ToolBlock, "type" | "id">) {
  const [expanded, setExpanded] = useState(false);
  const isSuccess = result && (result.startsWith("OK") || result.includes("✓"));
  const isError =
    result && (result.startsWith("Error") || result.includes("✗"));

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden bg-muted/30">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center shrink-0">
          {TOOL_ICONS[toolName] ?? (
            <Wrench size={14} className="text-muted-foreground" />
          )}
        </span>
        <span className="text-xs font-medium flex-1 text-foreground">
          {title}
        </span>
        {path && (
          <Badge
            variant="secondary"
            className="text-xs font-mono h-5 max-w-35 truncate"
          >
            {path}
          </Badge>
        )}
        {result ? (
          <div
            className={cn(
              "w-1.5 h-1.5 rounded-full shrink-0",
              isSuccess && "bg-green-500",
              isError && "bg-red-500",
              !isSuccess && !isError && "bg-gray-400",
            )}
          />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />
        )}
        <ChevronRight
          size={13}
          className={cn(
            "text-muted-foreground transition-transform shrink-0",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && result && (
        <div className="px-3 py-2 border-t border-border/60 bg-muted/20">
          {toolName === "list_files" ? (
            <FileTreeView content={result} />
          ) : toolName === "read_file" ? (
            <span className="text-xs text-muted-foreground italic">
              文件内容已隐藏
            </span>
          ) : (
            <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">
              {result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MarkdownContent (memoized) ───────────────────────────────────────────────

const mdComponents = {
  p: ({ children }: any) => (
    <p className="text-sm leading-relaxed mb-2 last:mb-0">{children}</p>
  ),
  code: ({ className, children, ...props }: any) =>
    !className ? (
      <code
        className="bg-muted-foreground/15 px-1.5 py-0.5 rounded text-xs font-mono"
        {...props}
      >
        {children}
      </code>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    ),
  pre: ({ children }: any) => (
    <pre className="bg-muted-foreground/10 rounded-lg p-3 overflow-x-auto my-2 text-xs">
      {children}
    </pre>
  ),
  ul: ({ children }: any) => (
    <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>
  ),
  li: ({ children }: any) => (
    <li className="text-sm leading-relaxed">{children}</li>
  ),
  h1: ({ children }: any) => (
    <h1 className="text-lg font-semibold mt-3 mb-2 first:mt-0">{children}</h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-base font-semibold mt-3 mb-2 first:mt-0">{children}</h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h3>
  ),
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 italic opacity-80">
      {children}
    </blockquote>
  ),
  a: ({ children, href }: any) => (
    <a
      href={href}
      className="underline hover:opacity-80"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  strong: ({ children }: any) => (
    <strong className="font-semibold">{children}</strong>
  ),
};

const userMdComponents = {
  ...mdComponents,
  code: ({ className, children, ...props }: any) =>
    !className ? (
      <code
        className="bg-primary-foreground/20 text-primary-foreground px-1.5 py-0.5 rounded text-xs font-mono"
        {...props}
      >
        {children}
      </code>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    ),
  pre: ({ children }: any) => (
    <pre className="bg-black/20 rounded-lg p-3 overflow-x-auto my-2 text-xs">
      {children}
    </pre>
  ),
};

const MarkdownContent = memo(
  ({
    content,
    variant,
  }: {
    content: string;
    variant: "user" | "assistant";
  }) => (
    <ReactMarkdown
      rehypePlugins={[rehypeHighlight]}
      components={variant === "user" ? userMdComponents : mdComponents}
    >
      {content}
    </ReactMarkdown>
  ),
);
MarkdownContent.displayName = "MarkdownContent";

// ─── MessageBubble ────────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: MergedMessage }) {
  if (message.role === "user") {
    const textBlock = message.blocks[0] as TextBlock;
    return (
      <div className="flex justify-end">
        <div className="bg-primary text-primary-foreground px-4 py-2.5 rounded-2xl rounded-tr-sm max-w-[80%]">
          <MarkdownContent content={textBlock.content} variant="user" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 space-y-2">
      {message.blocks.map((block) =>
        block.type === "text" ? (
          <div key={block.id} className="text-sm text-foreground">
            <MarkdownContent content={block.content} variant="assistant" />
          </div>
        ) : (
          <ToolCallCard key={block.id} {...block} />
        ),
      )}
    </div>
  );
}

// ─── ChatInterface ────────────────────────────────────────────────────────────

export function ChatInterface({
  onGenerate,
  onStop,
  isGenerating,
  messages,
  onOpenSettings,
  hasValidSettings,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const mergedMessages = useMemo(() => mergeMessages(messages), [messages]);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim() || isGenerating) return;
    if (!hasValidSettings) {
      onOpenSettings();
      return;
    }
    const userMessage = input.trim();
    setInput("");
    await onGenerate(userMessage);
  };

  return (
    <div className="flex flex-col h-screen bg-background border-r">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-background flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-linear-to-br from-purple-500 to-pink-500 flex items-center justify-center">
            <Sparkles size={16} className="text-white" />
          </div>
          <div>
            <h2 className="font-semibold text-sm">AI 助手</h2>
            <p className="text-xs text-muted-foreground">
              {isGenerating ? "正在思考..." : "随时为你服务"}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          className="h-8 w-8"
        >
          <Settings size={18} />
        </Button>
      </div>

      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarGutter: "stable" }}
      >
        <div className="p-4 space-y-5">
          {/* Settings warning */}
          {!hasValidSettings && (
            <Card className="p-4 bg-yellow-50 border-yellow-200">
              <div className="flex items-start gap-3">
                <Settings
                  size={20}
                  className="text-yellow-600 mt-0.5 shrink-0"
                />
                <div className="flex-1">
                  <h3 className="font-medium text-yellow-900 text-sm mb-1">
                    需要配置 AI 模型
                  </h3>
                  <p className="text-xs text-yellow-800 mb-3">
                    请先配置 API Key 和模型设置才能开始使用
                  </p>
                  <Button
                    onClick={onOpenSettings}
                    size="sm"
                    className="h-8 bg-yellow-600 hover:bg-yellow-700"
                  >
                    打开设置
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* Empty state */}
          {messages.length === 0 && hasValidSettings && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-16 h-16 rounded-2xl bg-linear-to-br from-purple-500 to-pink-500 flex items-center justify-center mb-4">
                <Sparkles size={32} className="text-white" />
              </div>
              <h3 className="text-base font-semibold mb-2">开始创建你的应用</h3>
              <p className="text-sm text-muted-foreground max-w-xs mb-6">
                告诉我你想要什么样的应用，我会帮你生成完整的代码
              </p>
              <div className="space-y-2 w-full max-w-xs">
                {[
                  { icon: "💡", text: "创建一个计数器应用" },
                  { icon: "📝", text: "创建一个待办事项应用" },
                  { icon: "📋", text: "创建一个简单的表单" },
                ].map(({ icon, text }) => (
                  <Button
                    key={text}
                    variant="outline"
                    className="w-full justify-start h-auto py-2.5 text-left"
                    onClick={() => setInput(text)}
                  >
                    <span className="text-base mr-2">{icon}</span>
                    <span className="text-sm">{text}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Message list */}
          {mergedMessages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="p-4 border-t bg-background shrink-0">
        <form onSubmit={handleSubmit} className="relative">
          <Input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="描述你想要的应用..."
            className="pr-12 h-11"
            disabled={isGenerating}
          />
          {isGenerating ? (
            <Button
              type="button"
              size="icon"
              onClick={onStop}
              variant="destructive"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8"
              title="停止生成"
            >
              <Square size={16} fill="currentColor" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              disabled={!input.trim()}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8"
              title="发送消息"
            >
              <Send size={16} />
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}
