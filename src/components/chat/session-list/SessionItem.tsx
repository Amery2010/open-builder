import { memo, useEffect, useRef, useState } from "react";
import {
  Trash2,
  Pencil,
  Check,
  X,
  EllipsisVertical,
  Pin,
  Archive,
  Sparkles,
  LayoutTemplate,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { requestConfirmation } from "@/lib/confirmation";
import { formatDeleteConfirmation } from "@/lib/utils/delete-confirmation";
import { useT } from "../../../i18n";
import type { Conversation } from "../../../types";

export interface SessionItemProps {
  conv: Conversation;
  isActive: boolean;
  isSmartRenaming: boolean;
  displayTitle: (conv: Conversation) => string;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onSmartRename: (convId: string) => void;
  onSaveAsTemplate: (convId: string) => void;
  canSaveAsTemplate: boolean;
  pin: (id: string) => void;
  unpin: (id: string) => void;
  archive: (id: string) => void;
  unarchive: (id: string) => void;
  onDelete: (id: string) => void;
  deleteDisabled: boolean;
  defaultEditValue: string;
}

export const SessionItem = memo(function SessionItem({
  conv,
  isActive,
  isSmartRenaming,
  displayTitle,
  onSelect,
  onRename,
  onSmartRename,
  onSaveAsTemplate,
  canSaveAsTemplate,
  pin,
  unpin,
  archive,
  unarchive,
  onDelete,
  deleteDisabled,
  defaultEditValue,
}: SessionItemProps) {
  const t = useT();
  const [isEditing, setIsEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const startEdit = () => {
    setEditingTitle(defaultEditValue);
    setIsEditing(true);
  };

  const commitEdit = () => {
    const next = editingTitle.trim();
    if (next) onRename(conv.id, next);
    setIsEditing(false);
  };

  const cancelEdit = () => {
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") cancelEdit();
  };

  const confirmDelete = async () => {
    if (
      await requestConfirmation({
        title: t.sessions.delete,
        message: formatDeleteConfirmation(
          t.sessions.deleteConfirm,
          displayTitle(conv),
        ),
        confirmLabel: t.sessions.delete,
        cancelLabel: t.sessions.cancelEdit,
        destructive: true,
      })
    ) {
      onDelete(conv.id);
    }
  };

  return (
    <div
      className={cn(
        "group flex h-14 items-center gap-2 px-3 hover:bg-muted/50 focus-within:bg-muted/50",
        isActive && "bg-muted",
      )}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          name={`session-title-${conv.id}`}
          aria-label={t.sessions.rename}
          autoComplete="off"
          spellCheck={false}
          className="text-sm flex-1 bg-transparent border-b border-primary min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={editingTitle}
          onChange={(e) => setEditingTitle(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => onSelect(conv.id)}
          aria-current={isActive ? "page" : undefined}
        >
          <span
            className={cn(
              "block text-sm truncate",
              isSmartRenaming && "animate-pulse",
            )}
          >
            {displayTitle(conv)}
          </span>
        </button>
      )}

      {isEditing ? (
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={t.sessions.confirmEdit}
            onClick={(e) => {
              e.stopPropagation();
              commitEdit();
            }}
          >
            <Check size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={t.sessions.cancelEdit}
            onClick={(e) => {
              e.stopPropagation();
              cancelEdit();
            }}
          >
            <X size={12} />
          </Button>
        </div>
      ) : (
        <div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                aria-label={t.sessions.actionsMenu}
              >
                <EllipsisVertical size={14} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {conv.pinned ? (
                <DropdownMenuItem onSelect={() => unpin(conv.id)}>
                  <Pin size={14} className="rotate-45" />
                  {t.sessions.unpin}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => pin(conv.id)}>
                  <Pin size={14} />
                  {t.sessions.pin}
                </DropdownMenuItem>
              )}
              {conv.archived ? (
                <DropdownMenuItem onSelect={() => unarchive(conv.id)}>
                  <Archive size={14} />
                  {t.sessions.unarchive}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => archive(conv.id)}>
                  <Archive size={14} />
                  {t.sessions.archive}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={startEdit}>
                <Pencil size={14} />
                {t.sessions.rename}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onSmartRename(conv.id)}
                disabled={conv.messages.length === 0}
              >
                <Sparkles size={14} />
                {t.sessions.smartRename}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onSaveAsTemplate(conv.id)}
                disabled={!canSaveAsTemplate}
              >
                <LayoutTemplate size={14} />
                {t.sessions.templates.saveAs}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={confirmDelete}
                disabled={deleteDisabled}
              >
                <Trash2 size={14} />
                {t.sessions.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
});
