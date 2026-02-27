import { Button } from "@/components/ui/button";

const SUGGESTIONS = [
  { icon: "📝", text: "创建一个待办事项应用" },
  { icon: "☁️", text: "创建一个天气卡片" },
  { icon: "💡", text: "创建一个计算器" },
];

interface EmptyStateProps {
  onSelectSuggestion: (text: string) => void;
}

export function EmptyState({ onSelectSuggestion }: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-12 text-center">
      <img className="w-16 h-16 mb-4" src="/logo.svg" alt="logo" />
      <h3 className="text-base font-semibold mb-2">开始创建你的应用</h3>
      <p className="text-sm text-muted-foreground max-w-xs mb-6">
        告诉我你想要什么样的应用，我会帮你生成完整的代码
      </p>
      <div className="space-y-2 w-full max-w-xs">
        {SUGGESTIONS.map(({ icon, text }) => (
          <Button
            key={text}
            variant="outline"
            className="w-full justify-start h-auto py-2.5 text-left"
            onClick={() => onSelectSuggestion(text)}
          >
            <span className="text-base mr-2">{icon}</span>
            <span className="text-sm">{text}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
