import {
  FolderOutput,
  MoreHorizontal,
  Palette,
  ScanSearch,
  Shapes,
} from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { PreviewDeviceSelector } from "../code-viewer/ViewToolbar";
import { useT } from "../../i18n";
import type { PreviewView } from "../../types";

export function DesignCanvasActions({
  device,
  onDevice,
  onSystems,
  onTokens,
  onReview,
  onExport,
  busy,
}: {
  device: PreviewView;
  onDevice: (view: PreviewView) => void;
  onSystems?: () => void;
  onTokens: () => void;
  onReview?: () => void;
  onExport?: () => void;
  busy: boolean;
}) {
  const t = useT();
  const items = [
    { label: t.toolbar.designSystem, icon: Palette, action: onSystems },
    { label: t.toolbar.designTokens, icon: Shapes, action: onTokens },
    { label: t.toolbar.reviewDesign, icon: ScanSearch, action: onReview },
    { label: t.toolbar.exportDirectory, icon: FolderOutput, action: onExport },
  ].filter((item) => item.action);
  return (
    <>
      {items.map((item) => (
        <Tooltip key={item.label}>
          <TooltipTrigger asChild>
            <Button
              className="hidden xl:inline-flex"
              size="icon-sm"
              variant="ghost"
              aria-label={item.label}
              disabled={busy}
              onClick={item.action}
            >
              <item.icon size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{item.label}</TooltipContent>
        </Tooltip>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="inline-flex xl:hidden"
            variant="ghost"
            size="icon-sm"
            aria-label={t.designCanvas.more}
          >
            <MoreHorizontal size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {items.map((item) => (
            <DropdownMenuItem
              key={item.label}
              disabled={busy}
              onSelect={item.action}
            >
              <item.icon size={16} />
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <PreviewDeviceSelector value={device} onChange={onDevice} />
    </>
  );
}
