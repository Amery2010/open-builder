import { X, FileText } from "lucide-react";
import type { Attachment } from "../../../types";
import { formatAttachmentBytes } from "../../../lib/utils/attachments";

function getFileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : "";
}

interface AttachmentPreviewProps {
  attachments: Attachment[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}

export function AttachmentPreview({
  attachments,
  onRemove,
  disabled = false,
}: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex gap-2 mb-2 flex-wrap">
      {attachments.map((att, i) => (
        <div
          key={i}
          className="relative group rounded-lg overflow-hidden border"
        >
          {att.type === "image" ? (
            <div className="w-16 h-16">
              <img
                src={att.previewUrl ?? att.content}
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
                {formatAttachmentBytes(att.size)}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => onRemove(i)}
            disabled={disabled}
            aria-label={`Remove ${att.name}`}
            className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity disabled:pointer-events-none"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
