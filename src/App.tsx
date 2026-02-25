import { useState, useRef } from "react";
import { ChatInterface } from "./components/ChatInterface";
import { CodeViewer } from "./components/CodeViewer";
import { SettingsDialog } from "./components/SettingsDialog";
import { createOpenAIGenerator } from "./lib/openai-client";
import {
  WebAppGenerator,
  ProjectFiles,
  Message,
} from "./lib/web-app-generator";
import { VITE_REACT_TYPESCRIPT_TEMPLATE } from "./constants/template";
import {
  AISettings,
  loadSettings,
  saveSettings,
  isSettingsValid,
} from "./lib/settings";

export default function App() {
  const [files, setFiles] = useState<ProjectFiles>(
    Object.fromEntries(
      Object.entries(VITE_REACT_TYPESCRIPT_TEMPLATE.files).map(
        ([path, file]) => [
          // 移除前导斜杠，统一使用不带前导斜杠的格式存储
          path.startsWith("/") ? path.slice(1) : path,
          file.code,
        ],
      ),
    ),
  );
  const [currentFile, setCurrentFile] = useState<string>("src/App.tsx");
  const [isGenerating, setIsGenerating] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [settings, setSettings] = useState<AISettings>(loadSettings());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const generatorRef = useRef<WebAppGenerator | null>(null);

  // 检查设置是否有效
  const hasValidSettings = isSettingsValid(settings);

  // 初始化生成器
  const getGenerator = () => {
    // 如果设置无效，返回 null
    if (!hasValidSettings) {
      return null;
    }

    // 如果设置改变了，重新创建生成器
    if (generatorRef.current) {
      const currentSettings = generatorRef.current as any;
      if (
        currentSettings._apiKey !== settings.apiKey ||
        currentSettings._apiUrl !== settings.apiUrl ||
        currentSettings._model !== settings.model
      ) {
        generatorRef.current = null;
      }
    }

    if (!generatorRef.current) {
      generatorRef.current = createOpenAIGenerator(
        {
          apiKey: settings.apiKey,
          apiUrl: settings.apiUrl,
          model: settings.model,
          stream: true,
        },
        {
          onText: (delta) => {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant") {
                // 创建新对象，避免 mutate prev
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: (last.content || "") + delta },
                ];
              }
              return [...prev, { role: "assistant", content: delta }];
            });
          },
          onToolCall: (name, id) => {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant") {
                const alreadyExists = last.tool_calls?.some(
                  (tc) => tc.id === id,
                );
                if (alreadyExists) return prev;
                const newToolCall = {
                  id,
                  type: "function" as const,
                  function: { name, arguments: "" },
                };
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    tool_calls: [...(last.tool_calls || []), newToolCall],
                  },
                ];
              }
              return prev;
            });
          },
          onToolResult: (name, args, result) => {
            // 实时添加 tool result，尝试找到对应的 tool_call_id
            setMessages((prev) => {
              const newMessages = [...prev];

              // 查找最后一条 assistant 消息中的 tool call
              for (let i = newMessages.length - 1; i >= 0; i--) {
                if (
                  newMessages[i].role === "assistant" &&
                  newMessages[i].tool_calls
                ) {
                  const toolCall = newMessages[i].tool_calls!.find(
                    (tc) =>
                      tc.function.name === name &&
                      !newMessages.some(
                        (m) => m.role === "tool" && m.tool_call_id === tc.id,
                      ),
                  );

                  if (toolCall) {
                    return [
                      ...newMessages,
                      {
                        role: "tool",
                        content: result,
                        tool_call_id: toolCall.id,
                      },
                    ];
                  }
                  break;
                }
              }

              // 如果找不到匹配的 tool call，仍然添加 result
              return [
                ...newMessages,
                {
                  role: "tool",
                  content: result,
                  tool_call_id: "",
                },
              ];
            });
          },
          onFileChange: (newFiles, changes) => {
            setFiles(newFiles);
          },
          onComplete: (result) => {
            // 完成时确保消息同步
            setMessages(result.messages);
          },
          onError: (error) => {
            console.error("Generation error:", error);
          },
        },
        files,
      );
    }
    return generatorRef.current;
  };

  const handleGenerate = async (prompt: string) => {
    if (!hasValidSettings) {
      setIsSettingsOpen(true);
      return;
    }

    setIsGenerating(true);

    // 添加用户消息到聊天记录
    const userMessage: Message = {
      role: "user",
      content: prompt,
    };
    setMessages((prev) => [...prev, userMessage]);

    try {
      const generator = getGenerator();
      if (generator) {
        await generator.generate(prompt);
      }
    } catch (error) {
      console.error("Error generating code:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleStopGeneration = () => {
    const generator = generatorRef.current;
    if (generator) {
      generator.abort();
    }
    setIsGenerating(false);
  };

  const handleFileChange = (path: string, content: string) => {
    setFiles((prev) => ({ ...prev, [path]: content }));
    const generator = generatorRef.current;
    if (generator) {
      generator.setFiles({ ...files, [path]: content });
    }
  };

  const handleSaveSettings = (newSettings: AISettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
    // 清除旧的生成器，下次使用时会用新设置创建
    generatorRef.current = null;
  };

  return (
    <div className="flex h-screen w-full bg-background">
      {/* Left Panel - Chat */}
      <div className="w-100 shrink-0 h-full">
        <ChatInterface
          onGenerate={handleGenerate}
          onStop={handleStopGeneration}
          isGenerating={isGenerating}
          messages={messages}
          onOpenSettings={() => setIsSettingsOpen(true)}
          hasValidSettings={hasValidSettings}
        />
      </div>

      {/* Right Panel - Code/Preview */}
      <div className="flex-1 h-full min-w-0">
        <CodeViewer
          files={files}
          currentFile={currentFile}
          onFileSelect={setCurrentFile}
          onFileChange={handleFileChange}
        />
      </div>

      {/* Settings Dialog */}
      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
      />
    </div>
  );
}
