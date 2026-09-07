import { History, PanelLeftOpen, Settings, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConversationStore, DEFAULT_TITLE } from "../../store/conversation";
import { useT } from "../../i18n";

interface ChatHeaderProps {
  isGenerating: boolean;
  onOpenSettings: () => void;
  onToggleSessionList: () => void;
  onOpenPermissionActivity: () => void;
  onOpenSnapshotHistory: () => void;
  permissionActivityCount: number;
  snapshotCount: number;
}

export function ChatHeader({
  onOpenSettings,
  onToggleSessionList,
  onOpenPermissionActivity,
  onOpenSnapshotHistory,
  permissionActivityCount,
  snapshotCount,
}: ChatHeaderProps) {
  const t = useT();
  const rawTitle = useConversationStore((s) =>
    s.activeId ? (s.conversations[s.activeId]?.title ?? null) : null,
  );
  const title =
    !rawTitle || rawTitle === DEFAULT_TITLE ? t.chat.newApp : rawTitle;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background px-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleSessionList}
            aria-label={t.header.sessions}
            className="h-8 w-8 shrink-0"
          >
            <PanelLeftOpen size={18} aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t.header.sessions}</TooltipContent>
      </Tooltip>
      <h1 className="flex-1 truncate px-2 text-center text-sm font-medium">
        {title}
      </h1>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon"
                onClick={onOpenPermissionActivity}
                disabled={permissionActivityCount === 0}
                aria-label={t.permissionActivity.open}
                className="h-8 w-8 shrink-0 disabled:text-muted-foreground"
              >
                <ShieldCheck size={18} aria-hidden="true" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t.permissionActivity.open}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon"
                onClick={onOpenSnapshotHistory}
                disabled={snapshotCount === 0}
                aria-label={t.snapshots.open}
                className="h-8 w-8 shrink-0"
              >
                <History size={18} aria-hidden="true" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t.snapshots.open}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-settings-focus-fallback="true"
              onClick={onOpenSettings}
              aria-label={t.header.settings}
              className="h-8 w-8 shrink-0"
            >
              <Settings size={18} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t.header.settings}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
