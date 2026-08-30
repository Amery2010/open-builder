import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  FileJson2,
  Inbox,
  Loader2,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useT } from "../../i18n";
import {
  applyMcpServersImport,
  previewMcpServersImport,
} from "../../lib/mcp/importer";
import type {
  McpImportPreview,
  McpPlatform,
  McpServerDraft,
  McpServerEntry,
} from "../../lib/mcp/types";
import { createMcpServerEntry } from "../../lib/mcp/validation";
import { AGNES_API_ORIGIN } from "../../lib/mcp/agnes/types";
import { useMcpStore } from "../../store/mcp";
import { AgnesMcpCard } from "./AgnesMcpCard";
import { McpJsonImporter } from "./McpJsonImporter";
import { McpServerCard } from "./McpServerCard";
import { McpServerEditor } from "./McpServerEditor";

type McpCatalogFilter = "all" | "ready" | "attention" | "remote" | "stdio";

async function getMcpManager() {
  return (
    await import("../../lib/mcp/connection-manager")
  ).getMcpConnectionManager();
}

export interface McpPanelProps {
  open: boolean;
  onClose: () => void;
  platform?: McpPlatform;
  onTestServer?: (serverId: string) => Promise<void> | void;
  onReconnectServer?: (serverId: string) => Promise<void> | void;
  onAuthorizeServer?: (serverId: string) => Promise<void> | void;
  onReviewServer?: (serverId: string) => Promise<void> | void;
}

function inferMcpPlatform(): McpPlatform {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return "web";
  }
  if (
    typeof navigator !== "undefined" &&
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  ) {
    return "mobile";
  }
  return "desktop";
}

function serverMatchesFilter(
  server: McpServerEntry,
  status: string,
  filter: McpCatalogFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "ready") return status === "ready";
  if (filter === "attention") {
    return (
      status === "needs_auth" || status === "error" || status === "drifted"
    );
  }
  if (filter === "stdio") return server.transport === "stdio";
  return server.transport !== "stdio";
}

export function McpPanel({
  open,
  onClose,
  platform: platformOverride,
  onTestServer,
  onReconnectServer,
  onAuthorizeServer,
  onReviewServer,
}: McpPanelProps) {
  const t = useT();
  const platform = platformOverride ?? inferMcpPlatform();
  const desktop = platform === "desktop";
  const servers = useMcpStore((state) => state.servers);
  const agnes = useMcpStore((state) => state.agnes);
  const runtime = useMcpStore((state) => state.runtime);
  const globalEnabled = useMcpStore((state) => state.globalEnabled);
  const hydrated = useMcpStore((state) => state._hasHydrated);
  const registerServer = useMcpStore((state) => state.registerServer);
  const deleteServer = useMcpStore((state) => state.deleteServer);
  const replaceServers = useMcpStore((state) => state.replaceServers);
  const setGlobalEnabled = useMcpStore((state) => state.setGlobalEnabled);
  const setServerEnabled = useMcpStore((state) => state.setServerEnabled);
  const setToolApproval = useMcpStore((state) => state.setToolApproval);
  const clearRuntimeState = useMcpStore((state) => state.clearRuntimeState);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<McpCatalogFilter>("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [importerOpen, setImporterOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFilter("all");
      setEditorOpen(false);
      setImporterOpen(false);
      setEditingId(null);
      setPendingDeleteId(null);
      setPendingIds(new Set());
      setSaving(false);
      setError(null);
    }
  }, [open]);

  const entries = useMemo(
    () => Object.values(servers).sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  );
  const agnesEnabledToolCount = Object.values(agnes.tools).filter(
    (tool) => tool.enabled,
  ).length;
  const agnesReady =
    agnes.enabled && Boolean(agnes.apiKey.trim()) && agnesEnabledToolCount > 0;
  const enabledCount =
    entries.filter((server) => server.enabled).length + (agnes.enabled ? 1 : 0);
  const readyCount =
    entries.filter(
      (server) =>
        server.enabled &&
        runtime[server.id]?.status === "ready" &&
        (!runtime[server.id]?.drift ||
          runtime[server.id]?.drift?.status === "clean"),
    ).length + (agnesReady ? 1 : 0);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const agnesMatchesQuery =
    !normalizedQuery ||
    [
      t.mcp.agnes.name,
      t.mcp.agnes.builtIn,
      AGNES_API_ORIGIN,
      ...Object.values(t.mcp.agnes.tools).flatMap((tool) => [
        tool.title,
        tool.description,
      ]),
    ]
      .join("\n")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  const agnesMatchesFilter =
    filter === "all" ||
    (filter === "ready" && agnesReady) ||
    (filter === "attention" && agnes.enabled && !agnesReady);
  const agnesVisible = agnesMatchesFilter && agnesMatchesQuery;
  const visibleEntries = useMemo(
    () =>
      entries.filter((server) => {
        const serverRuntime = runtime[server.id];
        const status =
          serverRuntime?.drift && serverRuntime.drift.status !== "clean"
            ? "drifted"
            : (serverRuntime?.status ?? "idle");
        if (!serverMatchesFilter(server, status, filter)) {
          return false;
        }
        if (!normalizedQuery) return true;
        const haystack = [
          server.name,
          server.url ?? "",
          server.command ?? "",
          ...Object.values(server.tools).flatMap((tool) => [
            tool.name,
            tool.title ?? "",
            tool.description ?? "",
          ]),
        ]
          .join("\n")
          .toLocaleLowerCase();
        return haystack.includes(normalizedQuery);
      }),
    [entries, filter, normalizedQuery, runtime],
  );

  const filters: Array<{ value: McpCatalogFilter; label: string }> = [
    { value: "all", label: t.mcp.filters.all },
    { value: "ready", label: t.mcp.filters.ready },
    { value: "attention", label: t.mcp.filters.attention },
    { value: "remote", label: t.mcp.filters.remote },
    ...(desktop
      ? ([{ value: "stdio", label: t.mcp.filters.stdio }] as const)
      : []),
  ];
  const editingServer = editingId ? servers[editingId] : undefined;
  const pendingDeleteServer = pendingDeleteId
    ? servers[pendingDeleteId]
    : undefined;

  const runServerAction = async (
    serverId: string,
    action: ((id: string) => Promise<void> | void) | undefined,
  ) => {
    if (!action || pendingIds.has(serverId)) return;
    setPendingIds((previous) => new Set(previous).add(serverId));
    setError(null);
    try {
      await action(serverId);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPendingIds((previous) => {
        const next = new Set(previous);
        next.delete(serverId);
        return next;
      });
    }
  };

  const handleSave = async (draft: McpServerDraft) => {
    setSaving(true);
    setError(null);
    try {
      const duplicate = entries.find(
        (server) =>
          server.id !== editingId &&
          server.name.trim().toLocaleLowerCase() ===
            draft.name.trim().toLocaleLowerCase(),
      );
      if (duplicate) {
        throw new Error(
          t.mcp.editor.duplicateName.replace("{name}", duplicate.name),
        );
      }
      const next = createMcpServerEntry(draft, {
        id: editingId ?? undefined,
        platform,
        pageProtocol:
          typeof window !== "undefined" ? window.location.protocol : undefined,
      });
      if (editingServer) {
        await (await getMcpManager()).close(editingServer.id);
        replaceServers({
          ...servers,
          [editingServer.id]: {
            ...next,
            id: editingServer.id,
            enabled: false,
            tools: {},
            approvedAt: undefined,
            instructions: undefined,
            instructionsFingerprint: undefined,
            definitionFingerprint: undefined,
            createdAt: editingServer.createdAt,
            updatedAt: Date.now(),
          },
        });
      } else {
        registerServer(next);
      }
      setEditorOpen(false);
      setEditingId(null);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleServer = (serverId: string, enabled: boolean) => {
    setError(null);
    try {
      setServerEnabled(serverId, enabled);
      if (!enabled) {
        void getMcpManager().then((manager) => manager.close(serverId));
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleToolApproval: React.ComponentProps<
    typeof McpServerCard
  >["onSetToolApproval"] = (serverId, toolName, patch) => {
    setError(null);
    try {
      setToolApproval(serverId, toolName, patch);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const previewImport = (source: string): McpImportPreview =>
    previewMcpServersImport(source, {
      platform,
      existingServers: servers,
      pageProtocol:
        typeof window !== "undefined" ? window.location.protocol : undefined,
    });

  const applyImport = async (preview: McpImportPreview): Promise<number> => {
    const result = applyMcpServersImport(preview, servers);
    const manager = await getMcpManager();
    await Promise.all(
      result.replaced.map((serverId) => manager.close(serverId)),
    );
    replaceServers(result.servers);
    return result.added.length + result.replaced.length;
  };

  const confirmDelete = () => {
    if (!pendingDeleteId) return;
    void getMcpManager().then((manager) => manager.close(pendingDeleteId));
    deleteServer(pendingDeleteId);
    clearRuntimeState(pendingDeleteId);
    setPendingDeleteId(null);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="flex max-h-[86vh] flex-col sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t.mcp.title}</DialogTitle>
            <DialogDescription>{t.mcp.description}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <Switch
                checked={globalEnabled}
                disabled={!hydrated}
                onCheckedChange={(enabled) => {
                  setError(null);
                  try {
                    setGlobalEnabled(enabled);
                    if (!enabled) {
                      void getMcpManager().then((manager) =>
                        manager.closeAll(),
                      );
                    }
                  } catch (reason: unknown) {
                    setError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                  }
                }}
                aria-label={globalEnabled ? t.mcp.disableAll : t.mcp.enableAll}
              />
              <div className="min-w-0">
                <p className="text-xs font-medium">
                  {globalEnabled ? t.mcp.enabled : t.mcp.disabled}
                </p>
                <p
                  className="truncate text-[11px] text-muted-foreground"
                  aria-live="polite"
                >
                  {!hydrated
                    ? t.mcp.loading
                    : t.mcp.readySummary
                        .replace("{ready}", String(readyCount))
                        .replace("{enabled}", String(enabledCount))}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 self-end sm:self-auto">
              <Button
                type="button"
                size="sm"
                variant={importerOpen ? "secondary" : "outline"}
                onClick={() => {
                  setImporterOpen((value) => !value);
                  setEditorOpen(false);
                  setEditingId(null);
                }}
              >
                {importerOpen ? <X size={14} /> : <FileJson2 size={14} />}
                {importerOpen ? t.mcp.cancel : t.mcp.editor.json}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={editorOpen && !editingId ? "secondary" : "default"}
                onClick={() => {
                  const opening = !(editorOpen && !editingId);
                  setEditorOpen(opening);
                  setEditingId(null);
                  setImporterOpen(false);
                }}
              >
                {editorOpen && !editingId ? (
                  <X size={14} />
                ) : (
                  <Plus size={14} />
                )}
                {editorOpen && !editingId ? t.mcp.cancel : t.mcp.add}
              </Button>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {desktop ? t.mcp.desktopPlatformHint : t.mcp.webPlatformHint}
          </p>

          {(editorOpen || importerOpen) && <Separator />}

          {editorOpen && (
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <McpServerEditor
                key={editingServer?.id ?? "new"}
                initial={editingServer}
                desktop={desktop}
                busy={saving}
                onCancel={() => {
                  setEditorOpen(false);
                  setEditingId(null);
                }}
                onSave={handleSave}
              />
            </div>
          )}

          {importerOpen && (
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <McpJsonImporter
                onPreview={previewImport}
                onApply={applyImport}
                onImported={() => setError(null)}
              />
            </div>
          )}

          {!editorOpen && !importerOpen && (
            <div className="space-y-2">
              <div className="relative">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t.mcp.search}
                  aria-label={t.mcp.search}
                  className="h-8 pl-8 text-sm"
                />
              </div>
              <div className="flex gap-1 overflow-x-auto pb-0.5">
                {filters.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    variant={filter === option.value ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs"
                    onClick={() => setFilter(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
            >
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <p className="whitespace-pre-wrap">{error}</p>
            </div>
          )}

          {!editorOpen && !importerOpen && (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {!hydrated ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <Loader2
                    size={26}
                    className="mb-2 animate-spin"
                    aria-hidden="true"
                  />
                  <p className="text-sm" aria-live="polite">
                    {t.mcp.loading}
                  </p>
                </div>
              ) : visibleEntries.length === 0 && !agnesVisible ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <Inbox
                    size={28}
                    className="mb-2 opacity-60"
                    aria-hidden="true"
                  />
                  <p className="text-sm">
                    {entries.length === 0 ? t.mcp.empty : t.mcp.emptySearch}
                  </p>
                </div>
              ) : (
                <>
                  {agnesVisible && <AgnesMcpCard platform={platform} />}
                  {visibleEntries.map((server) => (
                    <McpServerCard
                      key={server.id}
                      server={server}
                      runtime={runtime[server.id]}
                      pending={pendingIds.has(server.id)}
                      onToggleServer={handleToggleServer}
                      onSetToolApproval={handleToolApproval}
                      onTest={
                        onTestServer
                          ? (id) => void runServerAction(id, onTestServer)
                          : undefined
                      }
                      onReconnect={
                        onReconnectServer
                          ? (id) => void runServerAction(id, onReconnectServer)
                          : undefined
                      }
                      onAuthorize={
                        onAuthorizeServer
                          ? (id) => void runServerAction(id, onAuthorizeServer)
                          : undefined
                      }
                      onReview={
                        onReviewServer
                          ? (id) => void runServerAction(id, onReviewServer)
                          : undefined
                      }
                      onEdit={(id) => {
                        setEditingId(id);
                        setEditorOpen(true);
                        setImporterOpen(false);
                      }}
                      onDelete={setPendingDeleteId}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {pendingDeleteServer && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setPendingDeleteId(null);
          }}
        >
          <DialogContent className="sm:max-w-sm" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>
                {t.mcp.confirmDelete.replace(
                  "{name}",
                  pendingDeleteServer.name,
                )}
              </DialogTitle>
              <DialogDescription>{t.mcp.confirmDeleteDesc}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setPendingDeleteId(null)}
              >
                {t.mcp.cancel}
              </Button>
              <Button variant="destructive" onClick={confirmDelete}>
                {t.mcp.delete}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
