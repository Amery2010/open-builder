import {
  Eye,
  Code2,
  Monitor,
  Tablet,
  Smartphone,
  Download,
  Minus,
  Plus,
  Shapes,
  MousePointerClick,
  CircleHelp,
  FolderOutput,
  ScanSearch,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import { useT } from "../../i18n";
import type { ProjectFiles } from "@/types";
import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type ViewMode = "preview" | "code";
export type DeviceSize = "desktop" | "tablet" | "mobile";

export const MIN_PREVIEW_SCALE = 0.25;
export const MAX_PREVIEW_SCALE = 1.5;
export const PREVIEW_SCALE_STEP = 0.1;

export function clampPreviewScale(scale: number): number {
  const clamped = Math.min(
    MAX_PREVIEW_SCALE,
    Math.max(MIN_PREVIEW_SCALE, scale),
  );
  return Math.round(clamped * 100) / 100;
}

interface ViewToolbarProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  deviceSize: DeviceSize;
  onDeviceSizeChange: (size: DeviceSize) => void;
  files: ProjectFiles;
  previewEnabled?: boolean;
  previewScale?: number;
  onPreviewZoomIn?: () => void;
  onPreviewZoomOut?: () => void;
  onReloadPreview?: () => void;
  designMode?: boolean;
  designSelectionSupported?: boolean;
  designSelectionActive?: boolean;
  onToggleDesignSelection?: () => void;
  designSelectionUnavailableReason?: string;
  onOpenDesignTokens?: () => void;
  desktopMode?: boolean;
  onExportDirectory?: () => void;
  onOpenDesignReview?: () => void;
  isGenerating?: boolean;
}

async function downloadAsZip(files: ProjectFiles) {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  saveAs(blob, "project.zip");
}

function ToolbarIconButton({
  label,
  selected = false,
  variant = "ghost",
  onClick,
  disabled = false,
  className,
  children,
}: {
  label: string;
  selected?: boolean;
  variant?: "ghost" | "outline";
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={selected ? "secondary" : variant}
          size="icon-sm"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={selected}
          className={className}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ViewToolbar({
  viewMode,
  onViewModeChange,
  deviceSize,
  onDeviceSizeChange,
  files,
  previewEnabled = true,
  previewScale = 1,
  onPreviewZoomIn,
  onPreviewZoomOut,
  onReloadPreview,
  designMode = false,
  designSelectionSupported = false,
  designSelectionActive = false,
  onToggleDesignSelection,
  designSelectionUnavailableReason,
  onOpenDesignTokens,
  desktopMode = false,
  onExportDirectory,
  onOpenDesignReview,
  isGenerating = false,
}: ViewToolbarProps) {
  const t = useT();
  return (
    <div className="h-14 border-b bg-background px-4 flex items-center justify-between shrink-0 z-10">
      <div className="flex items-center gap-1 p-0.5 rounded-lg border">
        {previewEnabled && (
          <Button
            variant={viewMode === "preview" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onViewModeChange("preview")}
            className="gap-2"
          >
            <Eye size={16} />
            {t.toolbar.preview}
          </Button>
        )}
        <Button
          variant={viewMode === "code" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onViewModeChange("code")}
          className="gap-2"
        >
          <Code2 size={16} />
          {t.toolbar.code}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        {previewEnabled && viewMode === "preview" && (
          <div className="flex items-center gap-1">
            {designMode && onOpenDesignReview && (
              <ToolbarIconButton
                onClick={onOpenDesignReview}
                label={t.toolbar.reviewDesign}
                disabled={isGenerating}
              >
                <ScanSearch size={15} />
              </ToolbarIconButton>
            )}
            {designMode && designSelectionSupported && (
              <ToolbarIconButton
                selected={designSelectionActive}
                onClick={() => onToggleDesignSelection?.()}
                disabled={isGenerating}
                label={
                  designSelectionActive
                    ? t.toolbar.stopSelecting
                    : t.toolbar.selectElement
                }
              >
                <MousePointerClick size={15} />
              </ToolbarIconButton>
            )}
            {designMode &&
              !designSelectionSupported &&
              designSelectionUnavailableReason && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="inline-flex size-8 items-center justify-center text-muted-foreground"
                      aria-label={designSelectionUnavailableReason}
                      tabIndex={0}
                    >
                      <CircleHelp size={15} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {designSelectionUnavailableReason}
                  </TooltipContent>
                </Tooltip>
              )}
            {onReloadPreview && (
              <ToolbarIconButton
                onClick={onReloadPreview}
                label={t.toolbar.reloadPreview}
              >
                <RefreshCw size={15} />
              </ToolbarIconButton>
            )}
            <div
              role="group"
              aria-label={t.toolbar.zoomLevel}
              className="flex h-8 items-center rounded-lg border border-border/70 p-0.5"
            >
              <ToolbarIconButton
                onClick={() => onPreviewZoomOut?.()}
                label={t.toolbar.zoomOut}
                disabled={previewScale <= MIN_PREVIEW_SCALE}
                className="size-7 text-muted-foreground hover:text-foreground"
              >
                <Minus size={13} />
              </ToolbarIconButton>
              <output
                aria-label={t.toolbar.zoomLevel}
                className="w-8 text-center font-mono text-[10px] font-medium tabular-nums text-muted-foreground"
              >
                {Math.round(previewScale * 100)}
              </output>
              <ToolbarIconButton
                onClick={() => onPreviewZoomIn?.()}
                label={t.toolbar.zoomIn}
                disabled={previewScale >= MAX_PREVIEW_SCALE}
                className="size-7 text-muted-foreground hover:text-foreground"
              >
                <Plus size={13} />
              </ToolbarIconButton>
            </div>
            <div className="flex items-center gap-1 p-0.5 rounded-lg border">
              <ToolbarIconButton
                selected={deviceSize === "desktop"}
                onClick={() => onDeviceSizeChange("desktop")}
                label={t.toolbar.desktop}
                className="desktop"
              >
                <Monitor size={16} />
              </ToolbarIconButton>
              <ToolbarIconButton
                selected={deviceSize === "tablet"}
                onClick={() => onDeviceSizeChange("tablet")}
                label={t.toolbar.tablet}
                className="tablet"
              >
                <Tablet size={16} />
              </ToolbarIconButton>
              <ToolbarIconButton
                selected={deviceSize === "mobile"}
                onClick={() => onDeviceSizeChange("mobile")}
                label={t.toolbar.mobile}
                className="mobile"
              >
                <Smartphone size={16} />
              </ToolbarIconButton>
            </div>
          </div>
        )}

        {viewMode === "code" && (
          <div className="flex items-center gap-1">
            {designMode && onOpenDesignTokens && (
              <ToolbarIconButton
                onClick={onOpenDesignTokens}
                label={t.toolbar.designTokens}
                disabled={isGenerating}
              >
                <Shapes size={15} />
              </ToolbarIconButton>
            )}
            <ToolbarIconButton
              onClick={() => downloadAsZip(files)}
              label={t.toolbar.download}
            >
              <Download size={16} />
            </ToolbarIconButton>
            {desktopMode && onExportDirectory && (
              <ToolbarIconButton
                onClick={onExportDirectory}
                label={t.toolbar.exportDirectory}
                disabled={isGenerating}
              >
                <FolderOutput size={16} />
              </ToolbarIconButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
