import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface SettingsWarningProps {
  onOpenSettings: () => void;
}

export function SettingsWarning({ onOpenSettings }: SettingsWarningProps) {
  return (
    <Card className="p-4 bg-yellow-50 border-yellow-200">
      <div className="flex items-start gap-3">
        <Settings size={20} className="text-yellow-600 mt-0.5 shrink-0" />
        <div className="flex-1">
          <h3 className="font-medium text-yellow-900 text-sm mb-1">需要配置 AI 模型</h3>
          <p className="text-xs text-yellow-800 mb-3">请先配置 API Key 和模型设置才能开始使用</p>
          <Button onClick={onOpenSettings} size="sm" className="h-8 bg-yellow-600 hover:bg-yellow-700">
            打开设置
          </Button>
        </div>
      </div>
    </Card>
  );
}
