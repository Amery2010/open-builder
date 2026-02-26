import { Eye, Code2, Monitor, Tablet, Smartphone, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import type { ProjectFiles } from "@/types";

export type ViewMode = "preview" | "code";
export type DeviceSize = "desktop" | "tablet" | "mobile";

interface ViewToolbarProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  deviceSize: DeviceSize;
  onDeviceSizeChange: (size: DeviceSize) => void;
  files: ProjectFiles;
}

async function downloadAsZip(files: ProjectFiles) {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  saveAs(blob, "project.zip");
}

export function ViewToolbar({
  viewMode,
  onViewModeChange,
  deviceSize,
  onDeviceSizeChange,
  files,
}: ViewToolbarProps) {
  return (
    <div className="h-14 border-b bg-background px-4 flex items-center justify-between shrink-0 z-10">
      <div className="flex items-center gap-1 p-0.5 rounded-lg border">
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

      <div className="flex items-center gap-2">
        {viewMode === "preview" && (
          <div className="flex items-center gap-1 p-0.5 rounded-lg border">
            <Button
              variant={deviceSize === "desktop" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => onDeviceSizeChange("desktop")}
              title="桌面视图"
              className="desktop"
            >
              <Monitor size={16} />
            </Button>
            <Button
              variant={deviceSize === "tablet" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => onDeviceSizeChange("tablet")}
              title="平板视图"
              className="tablet"
            >
              <Tablet size={16} />
            </Button>
            <Button
              variant={deviceSize === "mobile" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => onDeviceSizeChange("mobile")}
              title="手机视图"
              className="mobile"
            >
              <Smartphone size={16} />
            </Button>
          </div>
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => downloadAsZip(files)}
          title="下载项目"
        >
          <Download size={16} />
        </Button>
      </div>
    </div>
  );
}
