import { useState, useRef, useEffect } from "react";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatInput } from "./chat/ChatInput";
import { EmptyState } from "./chat/EmptyState";
import { MessageBubble } from "./chat/MessageBubble";
import { MobilePreview } from "./chat/MobilePreview";
import { SettingsWarning } from "./chat/SettingsWarning";
import { SessionList } from "./chat/SessionList";
import { useMergedMessages } from "../hooks/useMergedMessages";
import { useIsMobile } from "../hooks/useIsMobile";
import type { Message, ProjectFiles } from "../types";

interface ChatInterfaceProps {
  messages: Message[];
  isGenerating: boolean;
  hasValidSettings: boolean;
  onGenerate: (prompt: string, images?: string[]) => Promise<void>;
  onStop: () => void;
  onRetry: () => Promise<void>;
  onOpenSettings: () => void;
  files: ProjectFiles;
  template: string;
  sandpackKey: number;
  isProjectInitialized: boolean;
}

export function ChatInterface({
  messages,
  isGenerating,
  hasValidSettings,
  onGenerate,
  onStop,
  onRetry,
  onOpenSettings,
  files,
  template,
  sandpackKey,
  isProjectInitialized,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [showSessionList, setShowSessionList] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mergedMessages = useMergedMessages(messages);
  const isMobile = useIsMobile();

  // Find the last assistant message index for the generating indicator
  let lastAssistantIdx = -1;
  for (let i = mergedMessages.length - 1; i >= 0; i--) {
    if (mergedMessages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if ((!input.trim() && images.length === 0) || isGenerating) return;
    if (!hasValidSettings) {
      onOpenSettings();
      return;
    }
    const prompt = input.trim();
    const imgs = [...images];
    setInput("");
    setImages([]);
    await onGenerate(prompt, imgs.length > 0 ? imgs : undefined);
  };

  return (
    <div className="flex flex-col h-screen bg-background border-r">
      <ChatHeader
        isGenerating={isGenerating}
        onOpenSettings={onOpenSettings}
        onToggleSessionList={() => setShowSessionList((v) => !v)}
      />

      {showSessionList ? (
        <SessionList onClose={() => setShowSessionList(false)} />
      ) : (
        <>
          <div
            className="flex flex-col flex-1 p-4 pb-0 overflow-y-auto space-y-4"
            style={{ scrollbarGutter: "stable" }}
          >
            {!hasValidSettings && (
              <SettingsWarning onOpenSettings={onOpenSettings} />
            )}

            {messages.length === 0 && hasValidSettings && (
              <EmptyState onSelectSuggestion={setInput} />
            )}

            {mergedMessages.map((msg, i) => {
              const isLastAssistant =
                msg.role === "assistant" && i === lastAssistantIdx;
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isGenerating={isGenerating}
                  isLastAssistant={isLastAssistant}
                  onRetry={isLastAssistant && !isGenerating ? onRetry : undefined}
                />
              );
            })}

            {isMobile && isProjectInitialized && !isGenerating && (
              <MobilePreview files={files} template={template} sandpackKey={sandpackKey} />
            )}

            <div ref={messagesEndRef} />
          </div>

          <ChatInput
            input={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            onStop={onStop}
            isGenerating={isGenerating}
            images={images}
            onImagesChange={setImages}
          />
        </>
      )}
    </div>
  );
}
