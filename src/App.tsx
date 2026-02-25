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
            console.log("AI:", delta);
            // 实时更新最后一条 assistant 消息
            setMessages((prev) => {
              const newMessages = [...prev];
              const lastMsg = newMessages[newMessages.length - 1];

              if (lastMsg && lastMsg.role === "assistant") {
                // 更新现有的 assistant 消息
                lastMsg.content = (lastMsg.content || "") + delta;
              } else {
                // 创建新的 assistant 消息
                newMessages.push({
                  role: "assistant",
                  content: delta,
                });
              }

              return newMessages;
            });
          },
          onToolCall: (name, id) => {
            console.log(`Tool call: ${name} (${id})`);
          },
          onToolResult: (name, args, result) => {
            console.log(`Tool result: ${name}`, { args, result });
          },
          onFileChange: (newFiles, changes) => {
            setFiles(newFiles);
            console.log("Files changed:", changes);
          },
          onComplete: (result) => {
            // 完成时用完整的消息替换
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
      <div className="w-[400px] shrink-0 h-full">
        <ChatInterface
          onGenerate={handleGenerate}
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
