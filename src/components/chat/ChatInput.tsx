import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ChatInputProps {
  input: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.SyntheticEvent<HTMLFormElement>) => void;
  onStop: () => void;
  isGenerating: boolean;
}

export function ChatInput({ input, onChange, onSubmit, onStop, isGenerating }: ChatInputProps) {
  return (
    <div className="p-4 border-t bg-background shrink-0">
      <form onSubmit={onSubmit} className="relative">
        <Input
          type="text"
          value={input}
          onChange={(e) => onChange(e.target.value)}
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
  );
}
