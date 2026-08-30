import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  Image as ImageIcon,
  KeyRound,
  ShieldCheck,
  Video,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n";
import {
  AGNES_API_ORIGIN,
  AGNES_TOOL_NAMES,
  type AgnesToolName,
} from "../../lib/mcp/agnes/types";
import { useMcpStore } from "../../store/mcp";

export interface AgnesMcpCardProps {
  platform: "web" | "desktop" | "mobile";
}

export function AgnesMcpCard({ platform }: AgnesMcpCardProps) {
  const t = useT();
  const agnes = useMcpStore((state) => state.agnes);
  const setApiKey = useMcpStore((state) => state.setAgnesApiKey);
  const setEnabled = useMcpStore((state) => state.setAgnesEnabled);
  const setToolApproval = useMcpStore((state) => state.setAgnesToolApproval);
  const [expanded, setExpanded] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState(agnes.apiKey);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  useEffect(() => setKeyDraft(agnes.apiKey), [agnes.apiKey]);

  const enabledToolCount = AGNES_TOOL_NAMES.filter(
    (name) => agnes.tools[name].enabled,
  ).length;
  const ready =
    agnes.enabled && Boolean(agnes.apiKey.trim()) && enabledToolCount > 0;
  const toolCopy = useMemo(
    () =>
      ({
        generate_image: {
          title: t.mcp.agnes.tools.generateImage.title,
          description: t.mcp.agnes.tools.generateImage.description,
          icon: ImageIcon,
        },
        create_video: {
          title: t.mcp.agnes.tools.createVideo.title,
          description: t.mcp.agnes.tools.createVideo.description,
          icon: Video,
        },
        get_video_status: {
          title: t.mcp.agnes.tools.getVideoStatus.title,
          description: t.mcp.agnes.tools.getVideoStatus.description,
          icon: CheckCircle2,
        },
      }) satisfies Record<
        AgnesToolName,
        { title: string; description: string; icon: typeof ImageIcon }
      >,
    [t],
  );

  const saveKey = () => {
    setApiKey(keyDraft.trim());
    setCheckResult(null);
  };

  const updateTool = (
    toolName: AgnesToolName,
    patch: { enabled?: boolean; allowForSubagents?: boolean },
  ) => {
    try {
      setToolApproval(toolName, patch);
      setCheckResult(null);
    } catch (reason: unknown) {
      setCheckResult(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const checkConfiguration = () => {
    if (!agnes.apiKey.trim()) {
      setCheckResult(t.mcp.agnes.configMissingKey);
      return;
    }
    if (enabledToolCount === 0) {
      setCheckResult(t.mcp.agnes.configMissingTool);
      return;
    }
    setCheckResult(t.mcp.agnes.configReady);
  };

  return (
    <article className="overflow-hidden rounded-lg border border-border/70 bg-muted/20">
      <div className="flex items-start gap-3 p-3">
        <Switch
          checked={agnes.enabled}
          disabled={!agnes.apiKey.trim()}
          onCheckedChange={(enabled) => {
            try {
              setEnabled(enabled);
              setCheckResult(null);
            } catch (reason: unknown) {
              setCheckResult(
                reason instanceof Error ? reason.message : String(reason),
              );
            }
          }}
          aria-label={
            agnes.enabled
              ? t.mcp.agnes.disableService
              : t.mcp.agnes.enableService
          }
          className="mt-0.5"
        />

        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? t.mcp.close : t.mcp.details}
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{t.mcp.agnes.name}</span>
            <Badge variant="outline" className="h-5 gap-1 text-[10px]">
              <ShieldCheck size={11} aria-hidden="true" />
              {t.mcp.agnes.builtIn}
            </Badge>
            <Badge
              variant={ready ? "secondary" : "outline"}
              className="h-5 text-[10px]"
            >
              {ready ? t.mcp.status.ready : t.mcp.status.idle}
            </Badge>
            <ChevronRight
              size={14}
              className={cn(
                "ml-auto shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
              aria-hidden="true"
            />
          </span>
          <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
            {AGNES_API_ORIGIN}
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {t.mcp.toolsSummary
              .replace("{enabled}", String(enabledToolCount))
              .replace("{total}", String(AGNES_TOOL_NAMES.length))}
          </span>
        </button>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-border/60 bg-background/50 px-3 py-3">
          <section className="space-y-2">
            <div>
              <h4 className="text-xs font-medium">{t.mcp.agnes.apiKey}</h4>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {t.mcp.agnes.localStorageHint}
              </p>
            </div>
            <div className="flex gap-1.5">
              <div className="relative min-w-0 flex-1">
                <KeyRound
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type={showKey ? "text" : "password"}
                  value={keyDraft}
                  onChange={(event) => {
                    setKeyDraft(event.target.value);
                    setCheckResult(null);
                  }}
                  placeholder={t.mcp.agnes.apiKeyPlaceholder}
                  aria-label={t.mcp.agnes.apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 pl-8 pr-9 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((value) => !value)}
                  aria-label={
                    showKey ? t.mcp.agnes.hideApiKey : t.mcp.agnes.showApiKey
                  }
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={keyDraft.trim() === agnes.apiKey}
                onClick={saveKey}
              >
                {t.mcp.save}
              </Button>
              {agnes.apiKey && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => {
                    setKeyDraft("");
                    setApiKey("");
                    setCheckResult(null);
                  }}
                >
                  {t.mcp.agnes.removeKey}
                </Button>
              )}
            </div>
            {platform === "web" && (
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {t.mcp.agnes.webCorsHint}
              </p>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-medium">{t.mcp.server.tools}</h4>
              <p className="text-[10px] text-muted-foreground">
                {t.mcp.agnes.chatDesignOnly}
              </p>
            </div>
            <div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
              {AGNES_TOOL_NAMES.map((toolName) => {
                const approval = agnes.tools[toolName];
                const copy = toolCopy[toolName];
                const ToolIcon = copy.icon;
                return (
                  <div key={toolName} className="space-y-2 bg-muted/20 p-2.5">
                    <div className="flex items-start gap-2">
                      <Switch
                        checked={approval.enabled}
                        disabled={!agnes.apiKey.trim()}
                        onCheckedChange={(enabled) =>
                          updateTool(toolName, { enabled })
                        }
                        aria-label={t.mcp.tool.enable.replace(
                          "{name}",
                          copy.title,
                        )}
                        className="mt-0.5"
                      />
                      <ToolIcon
                        size={15}
                        className="mt-0.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium">
                            {copy.title}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {toolName}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                          {copy.description}
                        </p>
                      </div>
                    </div>

                    {toolName === "generate_image" && (
                      <label className="flex items-center gap-2 pl-14 text-[11px] text-muted-foreground">
                        <Switch
                          checked={approval.allowForSubagents}
                          disabled={!approval.enabled}
                          onCheckedChange={(allowForSubagents) =>
                            updateTool(toolName, { allowForSubagents })
                          }
                          aria-label={`${t.mcp.tool.subagent}: ${copy.title}`}
                        />
                        {t.mcp.agnes.imageSubagent}
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
            <div className="flex flex-wrap gap-3 text-[11px]">
              <a
                href="https://agnes-ai.com/zh-Hans/docs/agnes-image-21-flash"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                {t.mcp.agnes.imageDocs}
                <ExternalLink size={11} aria-hidden="true" />
              </a>
              <a
                href="https://agnes-ai.com/zh-Hans/docs/agnes-video-25-flash"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                {t.mcp.agnes.videoDocs}
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={checkConfiguration}
            >
              {t.mcp.agnes.checkConfiguration}
            </Button>
          </section>
          {checkResult && (
            <p role="status" className="text-[11px] text-muted-foreground">
              {checkResult}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
