import {
  Eye,
  LayoutGrid,
  ArrowLeft,
  Code2,
  Monitor,
  Tablet,
  Smartphone,
  Minus,
  Plus,
  Shapes,
  MousePointerClick,
  CircleHelp,
  FolderOutput,
  ScanSearch,
  RefreshCw,
  Camera,
  ScanEye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveAs } from "file-saver";
import { useT } from "../../i18n";
import type { PreviewView, ProjectAssets, ProjectFiles } from "@/types";
import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildProjectZip } from "@/lib/project-assets/archive";
import { ProjectBuildDownload } from "./ProjectBuildDownload";
import type { PreviewCaptureScope } from "../../lib/design/preview-runtime";
import type { ScreenshotMode } from "./PreviewScreenshot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export type ViewMode = "preview" | "code";
export type DeviceSize = PreviewView;

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
  assets?: ProjectAssets;
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
  interactionLocked?: boolean;
  onAnnotate?: (scope: PreviewCaptureScope) => void;
  annotationUnavailableReason?: string;
  onScreenshot?: (mode: ScreenshotMode) => void;
  screenshotUnavailableReason?: string;
  designWorkspace?: {
    focused: boolean;
    actions: ReactNode;
  };
}

export async function downloadProjectAsZip(
  files: ProjectFiles,
  assets: ProjectAssets = {},
): Promise<void> {
  saveAs(await buildProjectZip(files, assets), "project.zip");
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

/** Shared device capsule for the live preview and design canvas headers. */
export function PreviewDeviceSelector({
  value,
  onChange,
}: {
  value: DeviceSize;
  onChange: (size: DeviceSize) => void;
}) {
  const t = useT();
  const options = [
    { value: "desktop", icon: Monitor },
    { value: "tablet", icon: Tablet },
    { value: "mobile", icon: Smartphone },
  ] as const;
  return (
    <div
      role="group"
      aria-label={t.toolbar.deviceSize}
      className="inline-flex shrink-0 items-center gap-1 rounded-lg border bg-background/60 p-0.5"
    >
      {options.map((option) => (
        <ToolbarIconButton
          key={option.value}
          selected={value === option.value}
          onClick={() => onChange(option.value)}
          label={t.toolbar[option.value]}
          className={option.value}
        >
          <option.icon size={16} />
        </ToolbarIconButton>
      ))}
    </div>
  );
}

export function ViewToolbar({
  viewMode,
  onViewModeChange,
  deviceSize,
  onDeviceSizeChange,
  files,
  assets = {},
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
  interactionLocked = false,
  onAnnotate,
  annotationUnavailableReason,
  onScreenshot,
  screenshotUnavailableReason,
  designWorkspace,
}: ViewToolbarProps) {
  const t = useT();
  return (
    <div
      inert={interactionLocked}
      data-testid="view-toolbar"
      className="design-workspace-header min-h-14 border-b bg-background px-4 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0 z-10"
    >
      <div className="flex items-center gap-1 p-0.5 rounded-lg border">
        {previewEnabled && (
          <Button
            variant={viewMode === "preview" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onViewModeChange("preview")}
            className="gap-2"
          >
            {designWorkspace ? <LayoutGrid size={16} /> : <Eye size={16} />}
            {designWorkspace ? t.designCanvas.canvas : t.toolbar.preview}
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

      {designWorkspace?.focused && viewMode === "preview" && (
        <Button
          className="mr-auto"
          size="sm"
          variant="ghost"
          onClick={() => onViewModeChange("preview")}
        >
          <ArrowLeft size={16} />
          {t.designCanvas.back}
        </Button>
      )}

      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {previewEnabled &&
        viewMode === "preview" &&
        designWorkspace &&
        !designWorkspace.focused
          ? designWorkspace.actions
          : previewEnabled &&
            viewMode === "preview" && (
              <div className="flex items-center gap-1">
                {onAnnotate && (
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="inline-flex"
                          tabIndex={annotationUnavailableReason ? 0 : undefined}
                        >
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t.annotation.title}
                              disabled={!!annotationUnavailableReason}
                            >
                              <ScanEye size={15} />
                            </Button>
                          </DropdownMenuTrigger>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {annotationUnavailableReason || t.annotation.title}
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onAnnotate("viewport")}>
                        {t.annotation.viewport}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onAnnotate("full-page")}
                      >
                        {t.annotation.fullPage}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {onScreenshot && (
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="inline-flex"
                          tabIndex={screenshotUnavailableReason ? 0 : undefined}
                        >
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t.screenshot.title}
                              disabled={!!screenshotUnavailableReason}
                            >
                              <Camera size={15} />
                            </Button>
                          </DropdownMenuTrigger>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {screenshotUnavailableReason || t.screenshot.title}
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => onScreenshot("viewport")}
                      >
                        {t.screenshot.viewport}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onScreenshot("full-page")}
                      >
                        {t.screenshot.fullPage}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onScreenshot("region")}>
                        {t.screenshot.region}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
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
                <PreviewDeviceSelector
                  value={deviceSize}
                  onChange={onDeviceSizeChange}
                />
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
            <ProjectBuildDownload
              files={files}
              assets={assets}
              isGenerating={isGenerating}
              onDownloadSource={() => downloadProjectAsZip(files, assets)}
            />
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
