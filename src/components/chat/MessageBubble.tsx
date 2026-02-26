import { MarkdownContent } from "./MarkdownContent";
import { ToolCallCard } from "./ToolCallCard";
import { GeneratingIndicator } from "./GeneratingIndicator";
import type { MergedMessage, TextBlock, ImageBlock } from "../../types";

interface MessageBubbleProps {
  message: MergedMessage;
  isGenerating?: boolean;
}

export function MessageBubble({
  message,
  isGenerating = false,
}: MessageBubbleProps) {
  if (message.role === "user") {
    const textBlocks = message.blocks.filter(
      (b): b is TextBlock => b.type === "text",
    );
    const imageBlocks = message.blocks.filter(
      (b): b is ImageBlock => b.type === "image",
    );

    return (
      <div className="flex justify-end">
        <div className="bg-slate-100 px-4 py-2.5 rounded-2xl rounded-tr-sm max-w-[80%]">
          {imageBlocks.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-2">
              {imageBlocks.map((img) => (
                <img
                  key={img.id}
                  src={img.url}
                  alt=""
                  className="max-w-48 max-h-48 rounded-lg object-cover"
                />
              ))}
            </div>
          )}
          {textBlocks.length > 0 && (
            <MarkdownContent
              content={textBlocks.map((b) => b.content).join("\n\n")}
              variant="user"
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 space-y-2">
      {message.blocks.map((block) => {
        if (block.type === "text") {
          return (
            <div key={block.id} className="text-sm text-foreground">
              <MarkdownContent content={block.content} variant="assistant" />
            </div>
          );
        }
        if (block.type === "tool") {
          return <ToolCallCard key={block.id} {...block} />;
        }
        return null;
      })}
      {isGenerating && <GeneratingIndicator />}
    </div>
  );
}
