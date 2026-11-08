import { ScrollArea } from "@/components/ui/scroll-area";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCommandPaletteStore } from "../../store/command-palette";
import { useT } from "../../i18n";

export interface CommandAction {
  id: string;
  label: string;
  group?: string;
  shortcut?: string;
  hidden?: boolean;
  run: () => void;
}

interface CommandPaletteProps {
  actions: CommandAction[];
}

export function CommandPalette({ actions }: CommandPaletteProps) {
  const t = useT();
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return actions.filter((a) => {
      if (a.hidden) return false;
      if (!q) return true;
      return a.label.toLowerCase().includes(q);
    });
  }, [actions, query]);

  useEffect(() => {
    if (selectedIdx >= filtered.length) {
      setSelectedIdx(0);
    }
  }, [filtered.length, selectedIdx]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item =
      list.querySelectorAll<HTMLElement>('[role="option"]')[selectedIdx];
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const runAt = (idx: number) => {
    const action = filtered[idx];
    if (!action) return;
    setOpen(false);
    // Defer so the dialog close transition doesn't fight focus changes.
    queueMicrotask(() => action.run());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setSelectedIdx((i) => (i + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setSelectedIdx((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runAt(selectedIdx);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="flex flex-col max-w-md p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {t.commandPalette.placeholder}
        </DialogTitle>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.commandPalette.placeholder}
          className="h-11 rounded-none border-0 border-b focus-visible:ring-0 focus-visible:border-b"
        />
        <ScrollArea
          viewportRef={listRef}
          className="max-h-72"
          contentClassName="py-1"
          viewportProps={{ role: "listbox" }}
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-xs text-muted-foreground text-center">
              {t.commandPalette.empty}
            </p>
          ) : (
            filtered.map((action, idx) => (
              <button
                key={action.id}
                type="button"
                role="option"
                aria-selected={idx === selectedIdx}
                onClick={() => runAt(idx)}
                onMouseEnter={() => setSelectedIdx(idx)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-sm text-left cursor-pointer ${
                  idx === selectedIdx
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/50"
                }`}
              >
                <span className="flex-1 truncate">{action.label}</span>
                {action.shortcut && (
                  <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5 font-mono">
                    {action.shortcut}
                  </kbd>
                )}
              </button>
            ))
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
