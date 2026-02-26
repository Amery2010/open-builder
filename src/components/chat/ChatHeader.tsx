import { Sparkles, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatHeaderProps {
  isGenerating: boolean;
  onOpenSettings: () => void;
}

export function ChatHeader({ isGenerating, onOpenSettings }: ChatHeaderProps) {
  return (
    <div className="h-14 px-4 border-b bg-background flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-linear-to-br from-purple-500 to-pink-500 flex items-center justify-center">
          <Sparkles size={16} className="text-white" />
        </div>
        <div>
          <h2 className="font-semibold text-sm">AI 助手</h2>
          <p className="text-xs text-muted-foreground">
            {isGenerating ? "正在思考..." : "随时为你服务"}
          </p>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onOpenSettings}
        className="h-8 w-8"
      >
        <Settings size={18} />
      </Button>
    </div>
  );
}
