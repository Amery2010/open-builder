import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Cable,
  Loader2,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import { useMcpStore } from "../../../store/mcp";

export interface McpMenuProps {
  onManage: () => void;
  onReconnectAll?: () => Promise<void> | void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

async function getMcpManager() {
  return (
    await import("../../../lib/mcp/connection-manager")
  ).getMcpConnectionManager();
}

export function McpMenu({
  onManage,
  onReconnectAll,
  open,
  onOpenChange,
}: McpMenuProps) {
  const t = useT();
  const servers = useMcpStore((state) => state.servers);
  const agnes = useMcpStore((state) => state.agnes);
  const runtime = useMcpStore((state) => state.runtime);
  const globalEnabled = useMcpStore((state) => state.globalEnabled);
  const hydrated = useMcpStore((state) => state._hasHydrated);
  const setGlobalEnabled = useMcpStore((state) => state.setGlobalEnabled);
  const setAgnesEnabled = useMcpStore((state) => state.setAgnesEnabled);
  const setServerEnabled = useMcpStore((state) => state.setServerEnabled);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entries = useMemo(
    () => Object.values(servers).sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  );
  const enabledEntries = entries.filter((server) => server.enabled);
  const agnesReady =
    agnes.enabled &&
    Boolean(agnes.apiKey.trim()) &&
    Object.values(agnes.tools).some((tool) => tool.enabled);
  const enabledCount = enabledEntries.length + (agnes.enabled ? 1 : 0);
  const readyCount =
    enabledEntries.filter(
      (server) =>
        runtime[server.id]?.status === "ready" &&
        (!runtime[server.id]?.drift ||
          runtime[server.id]?.drift?.status === "clean"),
    ).length + (agnesReady ? 1 : 0);
  const connecting = enabledEntries.some(
    (server) => runtime[server.id]?.status === "connecting",
  );
  const attentionCount =
    enabledEntries.filter((server) => {
      const status = runtime[server.id]?.status;
      return (
        status === "needs_auth" || status === "error" || status === "drifted"
      );
    }).length + (agnes.enabled && !agnesReady ? 1 : 0);
  const statusSummary = t.mcp.readySummary
    .replace("{ready}", String(readyCount))
    .replace("{enabled}", String(enabledCount));
  const accessibleSummary = attentionCount
    ? `${statusSummary}; ${t.mcp.attentionSummary.replace("{count}", String(attentionCount))}`
    : statusSummary;
  const triggerLabel = hydrated
    ? `${t.mcp.title}: ${accessibleSummary}`
    : `${t.mcp.title}: ${t.mcp.loading}`;

  const handleReconnectAll = async () => {
    if (!onReconnectAll || reconnecting) return;
    setReconnecting(true);
    setError(null);
    try {
      await onReconnectAll();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label={triggerLabel}
              >
                {!hydrated || connecting ? (
                  <Loader2
                    size={16}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : attentionCount > 0 ? (
                  <AlertTriangle
                    size={16}
                    className="text-amber-600 dark:text-amber-400"
                    aria-hidden="true"
                  />
                ) : (
                  <Cable size={16} aria-hidden="true" />
                )}
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{triggerLabel}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        className="max-h-80 min-w-72 overflow-y-auto"
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-3">
          <span>{t.mcp.title}</span>
          <span className="text-[10px] font-normal text-muted-foreground">
            {hydrated ? statusSummary : t.mcp.loading}
          </span>
        </DropdownMenuLabel>
        <p className="px-2 pb-1.5 text-[11px] leading-snug text-muted-foreground">
          {t.mcp.menuHint}
        </p>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={globalEnabled}
          disabled={!hydrated}
          onCheckedChange={(checked) => {
            const enabled = Boolean(checked);
            setError(null);
            try {
              setGlobalEnabled(enabled);
              if (!enabled) {
                void getMcpManager().then((manager) => manager.closeAll());
              }
            } catch (reason: unknown) {
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            }
          }}
          onSelect={(event) => event.preventDefault()}
        >
          <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <span>{t.mcp.title}</span>
            <span className="text-[10px] text-muted-foreground">
              {globalEnabled ? t.mcp.enabled : t.mcp.disabled}
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={agnes.enabled}
          disabled={!agnes.apiKey.trim()}
          onCheckedChange={(checked) => {
            setError(null);
            try {
              setAgnesEnabled(Boolean(checked));
            } catch (reason: unknown) {
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            }
          }}
          onSelect={(event) => event.preventDefault()}
        >
          <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <span className="truncate">{t.mcp.agnes.name}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {agnesReady ? t.mcp.status.ready : t.mcp.status.idle}
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        {!hydrated ? (
          <DropdownMenuItem disabled>{t.mcp.loading}</DropdownMenuItem>
        ) : (
          entries.map((server) => {
            const serverRuntime = runtime[server.id];
            const status = serverRuntime?.status ?? "idle";
            const needsReview =
              status === "drifted" ||
              serverRuntime?.drift?.status === "drifted" ||
              serverRuntime?.drift?.status === "unapproved";
            const displayStatus = needsReview ? "drifted" : status;
            return (
              <DropdownMenuCheckboxItem
                key={server.id}
                checked={server.enabled}
                disabled={needsReview}
                onCheckedChange={(checked) => {
                  setError(null);
                  try {
                    setServerEnabled(server.id, Boolean(checked));
                    if (!checked) {
                      void getMcpManager().then((manager) =>
                        manager.close(server.id),
                      );
                    }
                  } catch (reason: unknown) {
                    setError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                  }
                }}
                onSelect={(event) => event.preventDefault()}
              >
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="truncate">{server.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t.mcp.status[displayStatus]}
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
            );
          })
        )}
        {error && (
          <p
            role="alert"
            className="px-2 py-1.5 text-[11px] leading-snug text-destructive"
          >
            {error}
          </p>
        )}
        <DropdownMenuSeparator />
        {onReconnectAll && enabledEntries.length > 0 && (
          <DropdownMenuItem
            disabled={reconnecting || !globalEnabled}
            onSelect={() => void handleReconnectAll()}
          >
            {reconnecting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {t.mcp.refreshAll}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onManage}>
          <Settings2 size={14} />
          {t.mcp.manage}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
