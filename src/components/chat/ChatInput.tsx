import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  SendHorizonal,
  Square,
  Loader2,
  Plus,
  X,
  Image,
  FileText,
  Paperclip,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "../../i18n";
import type { Attachment } from "../../types";
import type { Message } from "../../lib/generator";

const SLASH_COMMANDS = [
  "new",
  "fork",
  "clear",
  "compact",
  "review",
  "continue",
  "retry",
] as const;

/** Commands that require existing conversation messages */
const NEEDS_MESSAGES = new Set(["fork", "clear", "compact", "review", "continue", "retry"]);

const FILE_ACCEPT =
  "text/*,application/json,application/xml,application/javascript,application/xhtml+xml,application/x-yaml,application/sql,application/graphql,application/ld+json,application/x-sh,application/x-httpd-php,application/typescript,application/pdf";

/** MIME types accepted for file attachments (non-image) */
const FILE_MIME_PREFIXES = ["text/"];
const FILE_MIME_EXACT = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/xhtml+xml",
  "application/x-yaml",
  "application/sql",
  "application/graphql",
  "application/ld+json",
  "application/x-sh",
  "application/x-httpd-php",
  "application/typescript",
  "application/pdf",
]);

function isAcceptedFileType(mime: string): boolean {
  if (FILE_MIME_EXACT.has(mime)) return true;
  return FILE_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

function isImageType(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Format bytes into human-readable string */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Get file extension from filename */
function getFileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : "";
}

interface ChatInputProps {
  input: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.SyntheticEvent<HTMLFormElement>) => void;
  onStop: () => void;
  isGenerating: boolean;
  messages: Message[];
  attachments: Attachment[];
  onAttachmentsChange: (attachments: Attachment[]) => void;
  onSlashCommand: (cmd: string) => void;
}

export function ChatInput({
  input,
  onChange,
  onSubmit,
  onStop,
  isGenerating,
  messages,
  attachments,
  onAttachmentsChange,
  onSlashCommand,
}: ChatInputProps) {
  const t = useT();
  const [isHoveringStop, setIsHoveringStop] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [showMenu, setShowMenu] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);

  // Slash menu: show when input starts with "/" and has no spaces
  const slashMatch = /^\/(\S*)$/.exec(input);

  const hasMessages = messages.length > 0;
  const lastMsg = hasMessages ? messages[messages.length - 1] : null;
  const lastIsError =
    lastMsg?.role === "assistant" &&
    typeof lastMsg.content === "string" &&
    lastMsg.content.startsWith("⚠️");

  const filteredCmds = useMemo(() => {
    if (!slashMatch) return [];
    const q = slashMatch[1].toLowerCase();
    return SLASH_COMMANDS.filter((c) => {
      if (!c.startsWith(q)) return false;
      // Commands requiring messages
      if (NEEDS_MESSAGES.has(c) && !hasMessages) return false;
      // /retry only when last message is an error
      if (c === "retry") return lastIsError;
      // /continue only when there are messages and last is not an error
      if (c === "continue") return hasMessages && !lastIsError;
      return true;
    });
  }, [slashMatch?.[1], hasMessages, lastIsError]);
  const showSlashMenu = filteredCmds.length > 0 && !isGenerating;

  // Reset selection when filtered commands change
  useEffect(() => {
    setSelectedIdx(0);
  }, [filteredCmds.length]);

  // Scroll selected item into view when navigating with keyboard
  useEffect(() => {
    const menu = slashMenuRef.current;
    if (!menu) return;
    const item = menu.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  // Close attachment menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

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
    if (showSlashMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => (i + 1) % filteredCmds.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx(
          (i) => (i - 1 + filteredCmds.length) % filteredCmds.length,
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        onSlashCommand(filteredCmds[selectedIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onChange("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const form = e.currentTarget.closest("form");
      if (form) form.requestSubmit();
    }
  };

  /** Process a single File into an Attachment */
  const processFile = useCallback(
    (file: File) => {
      if (isImageType(file.type)) {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            onAttachmentsChange([
              ...attachments,
              {
                type: "image",
                name: file.name || "pasted-image",
                content: reader.result,
                size: file.size,
              },
            ]);
          }
        };
        reader.readAsDataURL(file);
      } else if (isAcceptedFileType(file.type)) {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            onAttachmentsChange([
              ...attachments,
              {
                type: "file",
                name: file.name,
                content: reader.result,
                size: file.size,
              },
            ]);
          }
        };
        if (file.type === "application/pdf") {
          reader.readAsDataURL(file);
        } else {
          reader.readAsText(file);
        }
      }
    },
    [attachments, onAttachmentsChange],
  );

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (isImageType(item.type)) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          processFile(file);
          return;
        }
      }
      if (isAcceptedFileType(item.type)) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          processFile(file);
          return;
        }
      }
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(processFile);
    e.target.value = "";
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(processFile);
    e.target.value = "";
  };

  // Drag & drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    Array.from(files).forEach((file) => {
      if (isImageType(file.type) || isAcceptedFileType(file.type)) {
        processFile(file);
      }
    });
  };

  const removeAttachment = (index: number) => {
    onAttachmentsChange(attachments.filter((_, i) => i !== index));
  };

  const hasContent = input.trim() || attachments.length > 0;

  return (
    <div
      className={`p-2 bg-background shrink-0 transition-colors ${isDragOver ? "ring-2 ring-primary/50 ring-inset rounded-lg bg-primary/5" : ""}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <form onSubmit={onSubmit}>
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {attachments.map((att, i) => (
              <div
                key={i}
                className="relative group rounded-lg overflow-hidden border"
              >
                {att.type === "image" ? (
                  <div className="w-16 h-16">
                    <img
                      src={att.content}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="flex flex-col justify-center gap-0.5 px-3 h-16 bg-muted min-w-24 max-w-40">
                    <div className="flex items-center gap-1.5">
                      <FileText
                        size={14}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span
                        className="line-clamp-2 text-xs font-medium"
                        title={att.name}
                      >
                        {att.name}
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground pl-5.5">
                      {getFileExt(att.name)}
                      {getFileExt(att.name) && " · "}
                      {formatFileSize(att.size)}
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
          {showSlashMenu && (
            <div ref={slashMenuRef} className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-lg shadow-md overflow-y-auto z-10 max-h-[min(200px,32dvh)]">
              {filteredCmds.map((cmd, i) => (
                <button
                  key={cmd}
                  type="button"
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors cursor-pointer ${i === selectedIdx ? "bg-accent" : "hover:bg-accent/50"}`}
                  onMouseEnter={() => setSelectedIdx(i)}
                  onClick={() => onSlashCommand(cmd)}
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {t.slash[cmd].name}
                  </span>
                  <span className="text-muted-foreground">
                    {t.slash[cmd].desc}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Hidden file inputs */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleImageSelect}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_ACCEPT}
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* Left side: attachment button with menu */}
          {!isGenerating && (
            <div ref={menuRef} className="absolute left-1.5 bottom-1.5 z-10">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="w-7 h-7 text-muted-foreground hover:text-foreground"
                title={t.chat.attachment}
                onClick={() => setShowMenu((v) => !v)}
              >
                <Plus size={16} />
              </Button>
              {showMenu && (
                <div className="absolute bottom-full left-0 mb-1 bg-popover border rounded-lg shadow-md overflow-hidden z-20 min-w-36">
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 transition-colors cursor-pointer"
                    onClick={() => {
                      imageInputRef.current?.click();
                      setShowMenu(false);
                    }}
                  >
                    <Image size={14} />
                    {t.chat.uploadImage}
                  </button>
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 transition-colors cursor-pointer"
                    onClick={() => {
                      fileInputRef.current?.click();
                      setShowMenu(false);
                    }}
                  >
                    <Paperclip size={14} />
                    {t.chat.uploadFile}
                  </button>
                </div>
              )}
            </div>
          )}

          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              onChange(e.target.value);
              autoResize();
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t.chat.placeholder}
            rows={1}
            disabled={isGenerating}
            className="pl-10 pr-12 md:text-base resize-none overflow-y-auto min-h-0"
            style={{ maxHeight: 200 }}
          />

          {/* Right side: send/stop buttons */}
          <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1">
            {isGenerating ? (
              <Button
                type="button"
                size="icon"
                onClick={onStop}
                variant={isHoveringStop ? "destructive" : "secondary"}
                className="w-7 h-7 transition-all duration-200 rounded-full"
                title={t.chat.stopGeneration}
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
                className="w-7 h-7"
                title={t.chat.send}
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
