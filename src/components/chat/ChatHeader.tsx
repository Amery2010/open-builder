import { PanelLeft, Settings, Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConversationStore } from "../../store/conversation";

interface ChatHeaderProps {
  isGenerating: boolean;
  onOpenSettings: () => void;
  onToggleSessionList: () => void;
}

export function ChatHeader({
  onOpenSettings,
  onToggleSessionList,
}: ChatHeaderProps) {
  const title = useConversationStore((s) =>
    s.activeId ? (s.conversations[s.activeId]?.title ?? "新应用") : "新应用",
  );

  return (
    <div className="h-14 px-3 border-b bg-background flex items-center justify-between shrink-0">
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleSessionList}
        title="会话列表"
        className="h-8 w-8 shrink-0"
      >
        <PanelLeft size={18} />
      </Button>
      <span className="text-sm font-medium truncate px-2 flex-1 text-center">
        {title}
      </span>
      <div>
        <a href="https://github.com/Amery2010/open-builder" target="_blank">
          <Button
            variant="ghost"
            size="icon"
            title="开源代码"
            className="h-8 w-8 shrink-0"
          >
            <Github size={18} />
          </Button>
        </a>
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          title="AI 模型设置"
          className="h-8 w-8 shrink-0"
        >
          <Settings size={18} />
        </Button>
      </div>
    </div>
  );
}
