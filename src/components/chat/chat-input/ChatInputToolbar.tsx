import { lazy, Suspense, useState } from "react";
import {
  Cable,
  Check,
  CodeXml,
  FileText,
  FolderUp,
  Image,
  ListTodo,
  Loader2,
  Palette,
  Paperclip,
  PencilRuler,
  SendHorizonal,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useT } from "../../../i18n";
import { SkillsMenu } from "./SkillsMenu";
import type { WorkspaceMode } from "../../../types";

const McpMenu = lazy(() =>
  import("./McpMenu").then((module) => ({ default: module.McpMenu })),
);

interface ChatInputToolbarProps {
  onPickImage: () => void;
  onPickFile: () => void;
  onUploadProject: () => void;
  onManageSkills?: () => void;
  onManageMcp?: () => void;
  onManageDesignSystems?: () => void;
  designSystemName?: string;
  designSystemLabel?: string;
  onReconnectMcp?: () => Promise<void> | void;
  skillsAvailable: boolean;
  skillsInitializing: boolean;
  forcedSkillIds: readonly string[];
  onForcedSkillIdsChange: (ids: string[]) => void;
  workspaceMode: WorkspaceMode;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  isGenerating: boolean;
  isProcessingImages?: boolean;
  isSubmitting?: boolean;
  hasContent: boolean;
  isHoveringStop: boolean;
  onHoveringStopChange: (v: boolean) => void;
  onStop: () => void;
}

function DeferredMcpMenu({
  onManage,
  onReconnectAll,
}: {
  onManage: () => void;
  onReconnectAll?: () => Promise<void> | void;
}) {
  const t = useT();
  const [requested, setRequested] = useState(false);
  const [open, setOpen] = useState(false);
  const fallback = (
    <TooltipIconButton
      label={t.mcp.title}
      type="button"
      size="icon"
      variant="ghost"
      className="size-7 text-muted-foreground hover:text-foreground"
      onClick={() => {
        setRequested(true);
        setOpen(true);
      }}
    >
      {requested ? (
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
      ) : (
        <Cable size={16} aria-hidden="true" />
      )}
    </TooltipIconButton>
  );

  if (!requested) return fallback;
  return (
    <Suspense fallback={fallback}>
      <McpMenu
        onManage={onManage}
        onReconnectAll={onReconnectAll}
        open={open}
        onOpenChange={setOpen}
      />
    </Suspense>
  );
}

export function ChatInputToolbar({
  onPickImage,
  onPickFile,
  onUploadProject,
  onManageSkills,
  onManageMcp,
  onManageDesignSystems,
  designSystemName,
  designSystemLabel,
  onReconnectMcp,
  skillsAvailable,
  skillsInitializing,
  forcedSkillIds,
  onForcedSkillIdsChange,
  workspaceMode,
  setWorkspaceMode,
  isGenerating,
  isProcessingImages = false,
  isSubmitting = false,
  hasContent,
  isHoveringStop,
  onHoveringStopChange,
  onStop,
}: ChatInputToolbarProps) {
  const t = useT();
  const canSend = hasContent && !isProcessingImages && !isSubmitting;

  return (
    <div className="flex items-center justify-between gap-1 px-1.5 py-1 border-t border-border/40">
      <div className="flex items-center gap-0.5">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    aria-label={t.chat.attachment}
                    disabled={isProcessingImages}
                  >
                    <Paperclip size={16} />
                  </Button>
                </DropdownMenuTrigger>
              </span>
            </TooltipTrigger>
            <TooltipContent>{t.chat.attachment}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="top" align="start" className="min-w-36">
            <DropdownMenuItem onSelect={onPickImage}>
              <Image size={14} />
              {t.chat.uploadImage}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onPickFile}>
              <FileText size={14} />
              {t.chat.uploadFile}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isGenerating || isProcessingImages}
              onSelect={onUploadProject}
            >
              <FolderUp size={14} />
              {t.chat.uploadProject}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {skillsAvailable && onManageSkills && (
          <SkillsMenu
            selectedIds={forcedSkillIds}
            onSelectedIdsChange={onForcedSkillIdsChange}
            onManage={onManageSkills}
            initializing={skillsInitializing}
          />
        )}
        {onManageMcp && (
          <DeferredMcpMenu
            onManage={onManageMcp}
            onReconnectAll={onReconnectMcp}
          />
        )}
      </div>

      <div className="flex items-center gap-1">
        {workspaceMode === "design" && onManageDesignSystems && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 max-w-28 gap-1 px-1.5 text-xs text-violet-600 hover:text-violet-700 sm:max-w-36 dark:text-violet-300 dark:hover:text-violet-200"
                aria-label={designSystemLabel ?? t.toolbar.designSystem}
                onClick={onManageDesignSystems}
              >
                <Palette size={14} className="shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {designSystemName ?? t.designSystems.automatic}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {designSystemLabel ?? t.toolbar.designSystem}
            </TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isGenerating}
                    className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                    aria-label={t.chat.planMode.modeMenuLabel}
                  >
                    {workspaceMode === "plan" ? (
                      <ListTodo size={14} />
                    ) : workspaceMode === "design" ? (
                      <PencilRuler size={14} />
                    ) : (
                      <CodeXml size={14} />
                    )}
                    {workspaceMode === "plan"
                      ? t.chat.planMode.planLabel
                      : workspaceMode === "design"
                        ? t.chat.planMode.designLabel
                        : t.chat.planMode.autoLabel}
                  </Button>
                </DropdownMenuTrigger>
              </span>
            </TooltipTrigger>
            <TooltipContent>{t.chat.planMode.modeMenuLabel}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="top" align="end" className="min-w-64">
            <DropdownMenuLabel>
              {t.chat.planMode.modeMenuLabel}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {(
              [
                {
                  value: "auto",
                  icon: CodeXml,
                  label: t.chat.planMode.autoLabel,
                  description: t.chat.planMode.autoDescription,
                },
                {
                  value: "plan",
                  icon: ListTodo,
                  label: t.chat.planMode.planLabel,
                  description: t.chat.planMode.planDescription,
                },
                {
                  value: "design",
                  icon: PencilRuler,
                  label: t.chat.planMode.designLabel,
                  description: t.chat.planMode.designDescription,
                },
              ] as const
            ).map((mode) => {
              const Icon = mode.icon;
              const selected = mode.value === workspaceMode;
              return (
                <DropdownMenuItem
                  key={String(mode.value)}
                  disabled={isGenerating}
                  onSelect={() => setWorkspaceMode(mode.value)}
                  className="items-start gap-2.5 py-2"
                >
                  <Icon size={16} className="mt-0.5" />
                  <div className="flex flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium leading-none">
                      {mode.label}
                    </span>
                    <span className="text-xs text-muted-foreground leading-snug">
                      {mode.description}
                    </span>
                  </div>
                  {selected && (
                    <Check size={14} className="mt-0.5 opacity-70" />
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {isGenerating && !canSend ? (
          <TooltipIconButton
            label={t.chat.stopGeneration}
            type="button"
            size="icon"
            onClick={onStop}
            variant={isHoveringStop ? "destructive" : "secondary"}
            className="relative size-7 rounded-full transition-[opacity,transform,color,background-color,border-color] duration-200"
            onMouseEnter={() => onHoveringStopChange(true)}
            onMouseLeave={() => onHoveringStopChange(false)}
          >
            <span
              className={`absolute inset-0 flex items-center justify-center transition-[opacity,transform,color,background-color,border-color] duration-200 ${isHoveringStop ? "opacity-0 scale-50" : "opacity-100 scale-100"}`}
            >
              <Loader2 size={16} className="animate-spin" />
            </span>
            <span
              className={`absolute inset-0 flex items-center justify-center transition-[opacity,transform,color,background-color,border-color] duration-200 ${isHoveringStop ? "opacity-100 scale-100" : "opacity-0 scale-50"}`}
            >
              <Square size={8} fill="currentColor" />
            </span>
          </TooltipIconButton>
        ) : (
          <TooltipIconButton
            label={t.chat.send}
            type="submit"
            size="icon"
            disabled={!canSend}
            className="size-7"
          >
            <SendHorizonal size={16} />
          </TooltipIconButton>
        )}
      </div>
    </div>
  );
}
