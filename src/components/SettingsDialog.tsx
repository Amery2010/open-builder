import { useState, useEffect } from "react";
import { Key, Globe, Cpu } from "lucide-react";
import { AISettings } from "../lib/settings";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AISettings;
  onSave: (settings: AISettings) => void;
}

export function SettingsDialog({
  isOpen,
  onClose,
  settings,
  onSave,
}: SettingsDialogProps) {
  const [formData, setFormData] = useState<AISettings>(settings);

  useEffect(() => {
    setFormData(settings);
  }, [settings]);

  const handleSave = () => {
    onSave(formData);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>AI 模型设置</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor="apiKey">
              <Key size={16} className="inline mr-1" />
              API Key
            </Label>
            <Input
              id="apiKey"
              type="password"
              value={formData.apiKey}
              onChange={(e) =>
                setFormData({ ...formData, apiKey: e.target.value })
              }
              placeholder="sk-..."
            />
            <p className="text-xs text-muted-foreground">
              你的 API 密钥，将保存在浏览器本地存储中
            </p>
          </div>

          {/* API URL */}
          <div className="space-y-2">
            <Label htmlFor="apiUrl">
              <Globe size={16} className="inline mr-1" />
              API URL
            </Label>
            <Input
              id="apiUrl"
              type="text"
              value={formData.apiUrl}
              onChange={(e) =>
                setFormData({ ...formData, apiUrl: e.target.value })
              }
              placeholder="https://api.openai.com/v1/chat/completions"
            />
            <p className="text-xs text-muted-foreground">
              OpenAI 兼容的 API 端点地址
            </p>
          </div>

          {/* Model */}
          <div className="space-y-2">
            <Label htmlFor="model">
              <Cpu size={16} className="inline mr-1" />
              模型名称
            </Label>
            <Input
              id="model"
              type="text"
              value={formData.model}
              onChange={(e) =>
                setFormData({ ...formData, model: e.target.value })
              }
              placeholder="gpt-4o"
            />
            <p className="text-xs text-muted-foreground">
              AI 模型的名称，如 gpt-4o、deepseek-chat 等
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSave}>保存设置</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
