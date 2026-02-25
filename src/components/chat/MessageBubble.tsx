import { MarkdownContent } from "./MarkdownContent";
import { ToolCallCard } from "./ToolCallCard";
import type { MergedMessage, TextBlock } from "../../types";

interface MessageBubbleProps {
  message: MergedMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
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
