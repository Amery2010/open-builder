import { Eye, Code2, Monitor, Tablet, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ViewMode = "preview" | "code";
export type DeviceSize = "desktop" | "tablet" | "mobile";

interface ViewToolbarProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  deviceSize: DeviceSize;
  onDeviceSizeChange: (size: DeviceSize) => void;
}

export function ViewToolbar({
  viewMode,
  onViewModeChange,
  deviceSize,
  onDeviceSizeChange,
}: ViewToolbarProps) {
  return (
    <div className="h-14 border-b bg-background px-4 flex items-center justify-between shrink-0 z-10">
      <div className="flex items-center gap-1 bg-muted p-1 rounded-lg">
        <Button
          variant={viewMode === "preview" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onViewModeChange("preview")}
          className="gap-2"
        >
          <Eye size={16} />
          预览
        </Button>
        <Button
          variant={viewMode === "code" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onViewModeChange("code")}
          className="gap-2"
        >
          <Code2 size={16} />
          代码
        </Button>
      </div>

      {viewMode === "preview" && (
        <div className="flex items-center gap-1">
          <Button
            variant={deviceSize === "desktop" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => onDeviceSizeChange("desktop")}
            title="桌面视图"
          >
            <Monitor size={18} />
          </Button>
          <Button
            variant={deviceSize === "tablet" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => onDeviceSizeChange("tablet")}
            title="平板视图"
          >
            <Tablet size={18} />
          </Button>
          <Button
            variant={deviceSize === "mobile" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => onDeviceSizeChange("mobile")}
            title="手机视图"
          >
            <Smartphone size={18} />
          </Button>
        </div>
      )}
    </div>
  );
}
