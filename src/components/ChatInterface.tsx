import { useState, useRef, useEffect } from "react";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatInput } from "./chat/ChatInput";
import { EmptyState } from "./chat/EmptyState";
import { MessageBubble } from "./chat/MessageBubble";
import { SettingsWarning } from "./chat/SettingsWarning";
import { useMergedMessages } from "../hooks/useMergedMessages";
import type { Message } from "../types";

interface ChatInterfaceProps {
  messages: Message[];
  isGenerating: boolean;
  hasValidSettings: boolean;
  onGenerate: (prompt: string, images?: string[]) => Promise<void>;
  onStop: () => void;
  onOpenSettings: () => void;
}

export function ChatInterface({
  messages,
  isGenerating,
  hasValidSettings,
  onGenerate,
  onStop,
  onOpenSettings,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mergedMessages = useMergedMessages(messages);

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
      <ChatHeader isGenerating={isGenerating} onOpenSettings={onOpenSettings} />

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

        {mergedMessages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isGenerating={isGenerating}
          />
        ))}

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
    </div>
  );
}
