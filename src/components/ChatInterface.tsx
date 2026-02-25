import { useState, useRef, useEffect } from "react";
import { Send, User, Loader2, Settings, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Message, ToolCall } from "../lib/web-app-generator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

interface ChatInterfaceProps {
  onGenerate: (prompt: string) => Promise<void>;
  isGenerating: boolean;
  messages: Message[];
  onOpenSettings: () => void;
  hasValidSettings: boolean;
}

// Tool Call 名称映射
const TOOL_NAMES: Record<string, string> = {
  list_files: "列出文件",
  read_file: "读取文件",
  write_file: "写入文件",
  patch_file: "修改文件",
  delete_file: "删除文件",
};

// Tool Call 显示组件
function ToolCallItem({ toolCall }: { toolCall: ToolCall }) {
  const toolName = toolCall.function.name;
  let args: any = {};

  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    // 忽略解析错误
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
      <div className="flex items-center gap-1.5">
        <div className="w-1 h-1 rounded-full bg-blue-500" />
        <span className="font-medium">{TOOL_NAMES[toolName] || toolName}</span>
      </div>
      {args.path && (
        <Badge variant="secondary" className="text-xs font-mono h-5">
          {args.path}
        </Badge>
      )}
    </div>
  );
}

// Tool Result 显示组件
function ToolResultItem({ content }: { content: string }) {
  const isSuccess = content.startsWith("OK") || content.includes("✓");
  const isError = content.startsWith("Error") || content.includes("✗");

  // 提取简短的结果信息
  const shortContent = content.split("\n")[0].slice(0, 60);

  return (
    <div className="flex items-center gap-2 text-xs py-1">
      <div
        className={cn(
          "w-1 h-1 rounded-full",
          isSuccess && "bg-green-500",
          isError && "bg-red-500",
          !isSuccess && !isError && "bg-gray-400",
        )}
      />
      <span
        className={cn(
          "font-mono",
          isSuccess && "text-green-700",
          isError && "text-red-700",
          !isSuccess && !isError && "text-muted-foreground",
        )}
      >
        {shortContent}
        {content.length > 60 && "..."}
      </span>
    </div>
  );
}

// 合并后的消息类型
interface MergedMessage {
  role: "user" | "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_results?: Array<{ content: string }>;
}

// 合并连续的 assistant 和 tool 消息
function mergeMessages(messages: Message[]): MergedMessage[] {
  const merged: MergedMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      merged.push({
        role: "user",
        content: msg.content,
      });
    } else if (msg.role === "assistant") {
      const mergedMsg: MergedMessage = {
        role: "assistant",
        content: msg.content,
        tool_calls: msg.tool_calls,
        tool_results: [],
      };

      // 收集后续的 tool 消息
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        mergedMsg.tool_results!.push({
          content: messages[j].content || "",
        });
        j++;
      }

      merged.push(mergedMsg);
      i = j - 1; // 跳过已处理的 tool 消息
    }
  }

  return merged;
}

// 消息渲染组件
function MessageBubble({ message }: { message: MergedMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex gap-3 justify-end">
        <div className="flex flex-col items-end max-w-[80%]">
          <div className="bg-primary text-primary-foreground px-4 py-2.5 rounded-2xl rounded-tr-sm">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {message.content}
            </p>
          </div>
        </div>
        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0">
          <User size={16} className="text-primary-foreground" />
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="flex gap-3">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shrink-0">
          <Sparkles size={16} className="text-white" />
        </div>
        <div className="flex flex-col gap-2 max-w-[80%]">
          {message.content && (
            <div className="bg-muted px-4 py-2.5 rounded-2xl rounded-tl-sm">
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {message.content}
              </p>
            </div>
          )}

          {/* 思考过程：Tool Calls 和 Results */}
          {(message.tool_calls?.length || message.tool_results?.length) && (
            <div className="space-y-0.5 px-2">
              {message.tool_calls?.map((toolCall) => (
                <ToolCallItem key={toolCall.id} toolCall={toolCall} />
              ))}
              {message.tool_results?.map((result, idx) => (
                <ToolResultItem key={idx} content={result.content} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

export function ChatInterface({
  onGenerate,
  isGenerating,
  messages,
  onOpenSettings,
  hasValidSettings,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // 合并消息
  const mergedMessages = mergeMessages(messages);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isGenerating) return;

    // 检查设置是否有效
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
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
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
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto"
        style={{ scrollbarGutter: "stable" }}
      >
        <div className="p-4 space-y-4">
          {/* 设置提示 */}
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

          {/* 空状态 */}
          {messages.length === 0 && hasValidSettings && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center mb-4">
                <Sparkles size={32} className="text-white" />
              </div>
              <h3 className="text-base font-semibold mb-2">开始创建你的应用</h3>
              <p className="text-sm text-muted-foreground max-w-xs mb-6">
                告诉我你想要什么样的应用，我会帮你生成完整的代码
              </p>
              <div className="space-y-2 w-full max-w-xs">
                <Button
                  variant="outline"
                  className="w-full justify-start h-auto py-2.5 text-left"
                  onClick={() => setInput("创建一个计数器应用")}
                >
                  <span className="text-base mr-2">💡</span>
                  <span className="text-sm">创建一个计数器应用</span>
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start h-auto py-2.5 text-left"
                  onClick={() => setInput("创建一个待办事项应用")}
                >
                  <span className="text-base mr-2">📝</span>
                  <span className="text-sm">创建一个待办事项应用</span>
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start h-auto py-2.5 text-left"
                  onClick={() => setInput("创建一个简单的表单")}
                >
                  <span className="text-base mr-2">📋</span>
                  <span className="text-sm">创建一个简单的表单</span>
                </Button>
              </div>
            </div>
          )}

          {/* 消息列表 */}
          {mergedMessages.map((msg, idx) => (
            <MessageBubble key={idx} message={msg} />
          ))}

          {/* 生成中状态 */}
          {isGenerating && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shrink-0">
                <Sparkles size={16} className="text-white" />
              </div>
              <div className="bg-muted px-4 py-2.5 rounded-2xl rounded-tl-sm flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-sm text-muted-foreground">
                  正在生成...
                </span>
              </div>
            </div>
          )}

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
          <Button
            type="submit"
            size="icon"
            disabled={!input.trim() || isGenerating}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8"
          >
            <Send size={16} />
          </Button>
        </form>
      </div>
    </div>
  );
}
