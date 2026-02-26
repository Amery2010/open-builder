import { useState, useRef, useEffect } from "react";
import { Plus, Trash2, MessageSquare, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConversationStore } from "../../store/conversation";
import { cn } from "@/lib/utils";

interface SessionListProps {
  onClose: () => void;
}

export function SessionList({ onClose }: SessionListProps) {
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const createConversation = useConversationStore((s) => s.createConversation);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const renameConversation = useConversationStore((s) => s.renameConversation);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const sorted = Object.values(conversations).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  const handleNew = () => {
    createConversation();
    onClose();
  };

  const handleSelect = (id: string) => {
    if (editingId === id) return;
    switchConversation(id);
    onClose();
  };

  const startEdit = (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingTitle(title);
  };

  const commitEdit = () => {
    if (editingId && editingTitle.trim()) {
      renameConversation(editingId, editingTitle.trim());
    }
    setEditingId(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") cancelEdit();
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="px-3 py-2.5 border-b flex items-center justify-between">
        <span className="text-sm font-medium">会话列表</span>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleNew}>
          <Plus size={16} />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sorted.map((conv) => (
          <div
            key={conv.id}
            className={cn(
              "flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-muted/50 group",
              conv.id === activeId && "bg-muted",
            )}
            onClick={() => handleSelect(conv.id)}
          >
            <MessageSquare size={14} className="shrink-0 text-muted-foreground" />

            {editingId === conv.id ? (
              <input
                ref={inputRef}
                className="text-sm flex-1 bg-transparent border-b border-primary outline-none min-w-0"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="text-sm truncate flex-1">{conv.title}</span>
            )}

            {editingId === conv.id ? (
              <div className="flex items-center gap-0.5 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={(e) => { e.stopPropagation(); commitEdit(); }}
                >
                  <Check size={12} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
                >
                  <X size={12} />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={(e) => startEdit(e, conv.id, conv.title)}
                >
                  <Pencil size={12} />
                </Button>
                {sorted.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(conv.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
