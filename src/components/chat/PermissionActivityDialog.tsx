import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "../../i18n";
import { createMcpToolAlias } from "../../lib/mcp/alias";
import {
  getPermissionActivity,
  subscribePermissionActivity,
  type PermissionActivityEntry,
} from "../../lib/security/activity-log";
import { useMcpStore } from "../../store/mcp";
import {
  revokeProjectPermissionGrant,
  useProjectPermissionStore,
} from "../../store/project-permission";
import type { ProjectPermissionScope } from "../../lib/security/project-permission-broker";

interface PermissionActivityDialogProps {
  open: boolean;
  conversationId: string;
  onClose: () => void;
}

export function PermissionActivityDialog({
  open,
  conversationId,
  onClose,
}: PermissionActivityDialogProps) {
  const t = useT();
  const mcpServers = useMcpStore((state) => state.servers);
  const permissionAuthority = useProjectPermissionStore(
    (state) => state.authorities[conversationId],
  );
  const [entries, setEntries] = useState<PermissionActivityEntry[]>(() =>
    getPermissionActivity(conversationId),
  );

  useEffect(() => {
    const refresh = () => setEntries(getPermissionActivity(conversationId));
    refresh();
    return subscribePermissionActivity(refresh);
  }, [conversationId]);

  const mcpAliases = useMemo(() => {
    const aliases = new Map<
      string,
      { serverName: string; toolName: string; toolTitle?: string }
    >();
    for (const server of Object.values(mcpServers)) {
      for (const tool of Object.values(server.tools)) {
        try {
          aliases.set(createMcpToolAlias(server.id, tool.name), {
            serverName: server.name,
            toolName: tool.name,
            toolTitle: tool.title,
          });
        } catch {
          // Invalid persisted entries are ignored by the display-only lookup.
        }
      }
    }
    return aliases;
  }, [mcpServers]);

  const toolNames = t.tool.names as Record<string, string | undefined>;
  const describeScope = (scope: ProjectPermissionScope) => {
    if (scope.kind === "project") return t.permissionActivity.scopes.project;
    if (scope.kind === "subtree") {
      return `${t.permissionActivity.scopes.subtree}: ${scope.path}`;
    }
    return `${t.permissionActivity.scopes.exact}: ${scope.paths.join(", ")}`;
  };
  const displayToolName = (entry: PermissionActivityEntry) => {
    if (entry.source === "mcp") {
      const resolvedAlias = mcpAliases.get(entry.tool);
      const serverName = entry.mcp?.serverName ?? resolvedAlias?.serverName;
      const toolName =
        entry.mcp?.toolTitle ??
        resolvedAlias?.toolTitle ??
        resolvedAlias?.toolName ??
        entry.tool;
      if (serverName) {
        return `${serverName} / ${toolName}`;
      }
      if (entry.mcp?.toolTitle) return entry.mcp.toolTitle;
      return t.tool.mcpToolPending;
    }
    return toolNames[entry.tool] ?? t.tool.unknownTool;
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-5 pb-4 pt-5 pr-12">
          <DialogTitle>{t.permissionActivity.title}</DialogTitle>
          <DialogDescription>
            {t.permissionActivity.description}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="space-y-3 border-b bg-muted/20 px-5 py-4">
            <h2 className="text-sm font-medium">
              {t.permissionActivity.activeGrants}
            </h2>
            {!permissionAuthority?.grants.length ? (
              <p className="text-xs text-muted-foreground">
                {t.permissionActivity.noActiveGrants}
              </p>
            ) : (
              <div className="space-y-2">
                {permissionAuthority.grants.map((grant) => (
                  <article
                    key={grant.id}
                    className="flex items-start justify-between gap-3 rounded-md border bg-background px-3 py-2.5"
                  >
                    <div className="min-w-0 space-y-1">
                      <Badge variant="secondary">
                        {t.permissionRequest.operation[grant.operation]}
                      </Badge>
                      <p className="break-all text-xs text-muted-foreground">
                        {describeScope(grant.scope)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 px-2 text-xs"
                      onClick={() =>
                        revokeProjectPermissionGrant(conversationId, grant.id)
                      }
                    >
                      {t.permissionActivity.revoke}
                    </Button>
                  </article>
                ))}
              </div>
            )}
          </section>

          {entries.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              {t.permissionActivity.empty}
            </p>
          ) : (
            <div className="divide-y">
              {[...entries].reverse().map((entry) => (
                <article key={entry.id} className="space-y-2.5 px-5 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">
                        {displayToolName(entry)}
                      </h3>
                      <time className="text-xs text-muted-foreground">
                        {new Date(entry.at).toLocaleString()}
                      </time>
                    </div>
                    <Badge
                      variant={
                        entry.decision === "denied"
                          ? "destructive"
                          : entry.decision === "requested"
                            ? "outline"
                            : "secondary"
                      }
                    >
                      {t.permissionActivity.decisions[entry.decision]}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{t.permissionActivity.sources[entry.source]}</span>
                    <span>{t.permissionActivity.modes[entry.mode]}</span>
                    <span>
                      {t.permissionActivity.platforms[entry.platform]}
                    </span>
                    {entry.runtime && (
                      <span>
                        {t.permissionActivity.runtimes[entry.runtime]}
                      </span>
                    )}
                  </div>

                  {(entry.target || entry.reason) && (
                    <dl className="space-y-1 text-xs text-muted-foreground">
                      {entry.target && (
                        <div className="flex gap-1.5">
                          <dt className="shrink-0 font-medium text-foreground/80">
                            {t.permissionActivity.target}:
                          </dt>
                          <dd className="min-w-0 break-all">{entry.target}</dd>
                        </div>
                      )}
                      {entry.reason && (
                        <div className="flex gap-1.5">
                          <dt className="shrink-0 font-medium text-foreground/80">
                            {t.permissionActivity.reason}:
                          </dt>
                          <dd className="min-w-0 break-words">
                            {entry.reason}
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}

                  {entry.scope && (
                    <p className="break-all text-xs text-muted-foreground">
                      {describeScope(entry.scope)}
                    </p>
                  )}

                  <details className="text-xs text-muted-foreground">
                    <summary className="w-fit cursor-pointer select-none hover:text-foreground">
                      {t.permissionActivity.technicalDetails}
                    </summary>
                    <dl className="mt-2 rounded-md bg-muted/50 px-3 py-2">
                      <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                        <dt>{t.permissionActivity.toolIdentifier}</dt>
                        <dd className="break-all font-mono">{entry.tool}</dd>
                      </div>
                    </dl>
                  </details>
                </article>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
