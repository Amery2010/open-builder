import { useState, useRef, useCallback, useEffect } from "react";
import { SendHorizonal, Square, Loader2, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatInputProps {
  input: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.SyntheticEvent<HTMLFormElement>) => void;
  onStop: () => void;
  isGenerating: boolean;
  images: string[];
  onImagesChange: (images: string[]) => void;
}

export function ChatInput({
  input,
  onChange,
  onSubmit,
  onStop,
  isGenerating,
  images,
  onImagesChange,
}: ChatInputProps) {
  const [isHoveringStop, setIsHoveringStop] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  // Reset textarea height when input is cleared (e.g. after submit)
  useEffect(() => {
    if (!input && textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const form = e.currentTarget.closest("form");
      if (form) form.requestSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) readFileAsDataURL(file);
        return;
      }
    }
  };

  const readFileAsDataURL = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        onImagesChange([...images, reader.result]);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(readFileAsDataURL);
    e.target.value = "";
  };

  const removeImage = (index: number) => {
    onImagesChange(images.filter((_, i) => i !== index));
  };

  const hasContent = input.trim() || images.length > 0;

  return (
    <div className="p-4 border-t bg-background shrink-0">
      <form onSubmit={onSubmit}>
        {images.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {images.map((src, i) => (
              <div
                key={i}
                className="relative group w-16 h-16 rounded-lg overflow-hidden border"
              >
                <img src={src} alt="" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              onChange(e.target.value);
              autoResize();
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="描述你想要的应用..."
            rows={1}
            disabled={isGenerating}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2.5 pr-20 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none overflow-y-auto"
            style={{ maxHeight: 200 }}
          />
          <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1">
            {!isGenerating && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  title="上传图片"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlus size={16} />
                </Button>
              </>
            )}
            {isGenerating ? (
              <Button
                type="button"
                size="icon"
                onClick={onStop}
                variant={isHoveringStop ? "destructive" : "secondary"}
                className="h-7 w-7 transition-all duration-200 rounded-full"
                title="停止生成"
                onMouseEnter={() => setIsHoveringStop(true)}
                onMouseLeave={() => setIsHoveringStop(false)}
              >
                <span
                  className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ${isHoveringStop ? "opacity-0 scale-50" : "opacity-100 scale-100"}`}
                >
                  <Loader2 size={16} className="animate-spin" />
                </span>
                <span
                  className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ${isHoveringStop ? "opacity-100 scale-100" : "opacity-0 scale-50"}`}
                >
                  <Square size={14} fill="currentColor" />
                </span>
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!hasContent}
                className="h-7 w-7"
                title="发送消息"
              >
                <SendHorizonal size={16} />
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
