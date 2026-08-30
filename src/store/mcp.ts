import localforage from "localforage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  approveMcpDiscovery,
  compareMcpDiscovery,
  type ApproveMcpDiscoveryOptions,
} from "../lib/mcp/fingerprint";
import { TOOL_POLICY_VERSION } from "../lib/ai/tool-policy-version";
import { MCP_LIMITS } from "../lib/mcp/limits";
import { redactMcpError } from "../lib/mcp/redaction";
import type {
  McpServerDiscovery,
  McpServerEntry,
  McpServerRuntimeState,
  McpToolApproval,
} from "../lib/mcp/types";
import {
  assertMcpToolLimit,
  McpValidationError,
  sanitizeMcpToolPermissions,
  validateMcpServerEntry,
} from "../lib/mcp/validation";
import { createLocalforageStorage } from "./utils/localforage-storage";
import {
  captureMcpLifecycleEpoch,
  isMcpLifecycleCurrent,
} from "../lib/mcp/revocation";
import {
  AGNES_TOOL_NAMES,
  createDefaultAgnesMcpSettings,
  normalizeAgnesMcpSettings,
  type AgnesMcpSettings,
  type AgnesToolApproval,
  type AgnesToolName,
} from "../lib/mcp/agnes/types";

export const MCP_STORE_VERSION = 3;

type McpServerPatch = Partial<
  Omit<McpServerEntry, "id" | "createdAt" | "tools">
>;

type McpToolApprovalPatch = Partial<
  Pick<McpToolApproval, "enabled" | "allowInPlanMode" | "allowForSubagents">
>;

type McpRuntimePatch = Partial<Omit<McpServerRuntimeState, "updatedAt">> & {
  updatedAt?: number;
};

export interface McpState {
  /** Optional master switch. Per-server `enabled` remains the primary UI control. */
  globalEnabled: boolean;
  /** Managed Agnes adapter. Kept separate from user-importable MCP servers. */
  agnes: AgnesMcpSettings;
  servers: Record<string, McpServerEntry>;
  /** Session-only connection state; excluded from persisted storage. */
  runtime: Record<string, McpServerRuntimeState>;
  _hasHydrated: boolean;

  registerServer: (entry: McpServerEntry) => void;
  updateServer: (id: string, patch: McpServerPatch) => void;
  deleteServer: (id: string) => void;
  replaceServers: (servers: Record<string, McpServerEntry>) => void;
  setGlobalEnabled: (enabled: boolean) => void;
  setAgnesApiKey: (apiKey: string) => void;
  setAgnesEnabled: (enabled: boolean) => void;
  setAgnesToolApproval: (
    toolName: AgnesToolName,
    patch: Partial<AgnesToolApproval>,
  ) => void;
  setServerEnabled: (id: string, enabled: boolean) => void;
  setToolApproval: (
    serverId: string,
    toolName: string,
    patch: McpToolApprovalPatch,
  ) => void;
  approveServer: (
    serverId: string,
    discovery: McpServerDiscovery,
    options?: ApproveMcpDiscoveryOptions,
  ) => Promise<McpServerEntry>;
  setRuntimeState: (serverId: string, patch: McpRuntimePatch) => void;
  clearRuntimeState: (serverId: string) => void;
  clearAllRuntime: () => void;

  getServer: (id: string) => McpServerEntry | undefined;
  listServers: () => McpServerEntry[];
}

function assertUniqueName(
  servers: Record<string, McpServerEntry>,
  name: string,
  exceptId?: string,
): void {
  const normalized = name.trim().toLowerCase();
  if (
    Object.values(servers).some(
      (server) =>
        server.id !== exceptId &&
        server.name.trim().toLowerCase() === normalized,
    )
  ) {
    throw new McpValidationError([
      {
        path: "name",
        code: "duplicate",
        message: `An MCP server named "${name}" already exists.`,
      },
    ]);
  }
}

function assertServerSet(servers: Record<string, McpServerEntry>): void {
  if (Object.keys(servers).length > MCP_LIMITS.maxServers) {
    throw new McpValidationError([
      {
        path: "servers",
        code: "too_many",
        message: `At most ${MCP_LIMITS.maxServers} MCP servers are allowed.`,
      },
    ]);
  }
  const names = new Set<string>();
  for (const [id, server] of Object.entries(servers)) {
    if (id !== server.id) {
      throw new McpValidationError([
        {
          path: `servers.${id}`,
          code: "id_mismatch",
          message: "Server record key must match its id.",
        },
      ]);
    }
    const validation = validateMcpServerEntry(server);
    if (!validation.valid) throw new McpValidationError(validation.errors);
    const name = server.name.trim().toLowerCase();
    if (names.has(name)) {
      throw new McpValidationError([
        {
          path: `servers.${id}.name`,
          code: "duplicate",
          message: `Duplicate MCP server name "${server.name}".`,
        },
      ]);
    }
    names.add(name);
  }
  assertMcpToolLimit(servers);
}

function assertCombinedToolLimit(
  servers: Record<string, McpServerEntry>,
  agnes: AgnesMcpSettings,
): void {
  const external = Object.values(servers).reduce(
    (count, server) =>
      count +
      (server.enabled
        ? Object.values(server.tools).filter((tool) => tool.enabled).length
        : 0),
    0,
  );
  const managed =
    agnes.enabled && agnes.apiKey.trim()
      ? AGNES_TOOL_NAMES.filter((name) => agnes.tools[name].enabled).length
      : 0;
  if (external + managed > MCP_LIMITS.maxEnabledTools) {
    throw new McpValidationError([
      {
        path: "tools",
        code: "too_many_enabled",
        message: `At most ${MCP_LIMITS.maxEnabledTools} MCP tools may be enabled; received ${external + managed}.`,
      },
    ]);
  }
}

const mcpStorage = createLocalforageStorage(
  localforage.createInstance({ name: "open-builder-mcp" }),
);

function revokeAgnesRuntime(): void {
  void Promise.all([
    import("../lib/mcp/agnes/video-task-manager"),
    import("../lib/mcp/agnes/service"),
  ])
    .then(([tasks, service]) => {
      tasks.stopAgnesVideoTasks();
      service.abortAgnesMcpRequests();
    })
    .catch(() => {
      // State checks still prevent stale results from publishing if lazy loading
      // the revocation helpers fails during shutdown.
    });
}

function nextAgnesRevision(settings: AgnesMcpSettings): number {
  return Math.max(Date.now(), settings.updatedAt + 1);
}

export const useMcpStore = create<McpState>()(
  persist(
    (set, get) => ({
      globalEnabled: true,
      agnes: createDefaultAgnesMcpSettings(),
      servers: {},
      runtime: {},
      _hasHydrated: false,

      registerServer: (entry) => {
        const validation = validateMcpServerEntry(entry);
        if (!validation.valid) throw new McpValidationError(validation.errors);
        const current = get().servers;
        if (current[entry.id]) {
          throw new McpValidationError([
            {
              path: "id",
              code: "duplicate",
              message: `MCP server id "${entry.id}" already exists.`,
            },
          ]);
        }
        assertUniqueName(current, entry.name);
        const servers = { ...current, [entry.id]: entry };
        assertServerSet(servers);
        assertCombinedToolLimit(servers, get().agnes);
        set({ servers });
      },

      updateServer: (id, patch) => {
        const existing = get().servers[id];
        if (!existing) throw new Error(`Unknown MCP server "${id}".`);
        const updated: McpServerEntry = {
          ...existing,
          ...patch,
          id,
          createdAt: existing.createdAt,
          tools: existing.tools,
          updatedAt: patch.updatedAt ?? Date.now(),
        };
        const validation = validateMcpServerEntry(updated);
        if (!validation.valid) throw new McpValidationError(validation.errors);
        assertUniqueName(get().servers, updated.name, id);
        const servers = { ...get().servers, [id]: updated };
        assertMcpToolLimit(servers);
        assertCombinedToolLimit(servers, get().agnes);
        set((state) => {
          const { [id]: _removed, ...remainingRuntime } = state.runtime;
          return { servers, runtime: remainingRuntime };
        });
      },

      deleteServer: (id) =>
        set((state) => {
          if (!state.servers[id]) return state;
          const { [id]: _server, ...servers } = state.servers;
          const { [id]: _runtime, ...runtime } = state.runtime;
          return { servers, runtime };
        }),

      replaceServers: (servers) => {
        assertServerSet(servers);
        assertCombinedToolLimit(servers, get().agnes);
        set({ servers, runtime: {} });
      },

      setGlobalEnabled: (globalEnabled) => {
        if (globalEnabled) {
          assertMcpToolLimit(get().servers);
          assertCombinedToolLimit(get().servers, get().agnes);
        }
        if (!globalEnabled) revokeAgnesRuntime();
        set({ globalEnabled });
      },

      setAgnesApiKey: (apiKey) => {
        const existing = get().agnes;
        if (apiKey !== existing.apiKey) revokeAgnesRuntime();
        const agnes = {
          ...existing,
          apiKey,
          ...(apiKey.trim() ? {} : { enabled: false }),
          updatedAt: nextAgnesRevision(existing),
        };
        assertCombinedToolLimit(get().servers, agnes);
        set({ agnes });
      },

      setAgnesEnabled: (enabled) => {
        const existing = get().agnes;
        if (enabled && !existing.apiKey.trim()) {
          throw new Error("Configure the Agnes API key before enabling it.");
        }
        const agnes = {
          ...existing,
          enabled,
          updatedAt: nextAgnesRevision(existing),
        };
        assertCombinedToolLimit(get().servers, agnes);
        if (!enabled) revokeAgnesRuntime();
        set({ agnes });
      },

      setAgnesToolApproval: (toolName, patch) => {
        const existing = get().agnes;
        const current = existing.tools[toolName];
        if (!current) throw new Error(`Unknown Agnes tool "${toolName}".`);
        const enabled = patch.enabled ?? current.enabled;
        const updated: AgnesToolApproval = {
          enabled,
          allowForSubagents:
            toolName === "generate_image" &&
            enabled &&
            (patch.allowForSubagents ?? current.allowForSubagents),
          ...(toolName === "generate_image" &&
          enabled &&
          (patch.allowForSubagents ?? current.allowForSubagents)
            ? { subagentPolicyVersion: TOOL_POLICY_VERSION }
            : {}),
        };
        const agnes = {
          ...existing,
          tools: { ...existing.tools, [toolName]: updated },
          updatedAt: nextAgnesRevision(existing),
        };
        assertCombinedToolLimit(get().servers, agnes);
        const permissionRevoked =
          (current.enabled && !updated.enabled) ||
          (current.allowForSubagents && !updated.allowForSubagents);
        if (permissionRevoked) revokeAgnesRuntime();
        set({ agnes });
      },

      setServerEnabled: (id, enabled) => {
        const existing = get().servers[id];
        if (!existing) throw new Error(`Unknown MCP server "${id}".`);
        const servers = {
          ...get().servers,
          [id]: { ...existing, enabled, updatedAt: Date.now() },
        };
        assertMcpToolLimit(servers);
        assertCombinedToolLimit(servers, get().agnes);
        set((state) => ({
          servers,
          ...(!enabled
            ? {
                runtime: {
                  ...state.runtime,
                  [id]: {
                    status: "idle" as const,
                    updatedAt: Date.now(),
                  },
                },
              }
            : {}),
        }));
      },

      setToolApproval: (serverId, toolName, patch) => {
        const server = get().servers[serverId];
        if (!server) throw new Error(`Unknown MCP server "${serverId}".`);
        const tool = server.tools[toolName];
        if (!tool) throw new Error(`Unknown MCP tool "${toolName}".`);
        const currentPermissions =
          tool.elevatedPermissionsPolicyVersion === TOOL_POLICY_VERSION
            ? tool
            : {
                ...tool,
                allowInPlanMode: false,
                allowForSubagents: false,
                elevatedPermissionsPolicyVersion: undefined,
              };
        const updatedTool = sanitizeMcpToolPermissions({
          ...currentPermissions,
          ...patch,
          elevatedPermissionsPolicyVersion:
            patch.allowInPlanMode === true || patch.allowForSubagents === true
              ? TOOL_POLICY_VERSION
              : currentPermissions.elevatedPermissionsPolicyVersion,
        });
        if (!updatedTool.allowInPlanMode && !updatedTool.allowForSubagents) {
          updatedTool.elevatedPermissionsPolicyVersion = undefined;
        }
        const updatedServer: McpServerEntry = {
          ...server,
          tools: { ...server.tools, [toolName]: updatedTool },
          updatedAt: Date.now(),
        };
        const servers = { ...get().servers, [serverId]: updatedServer };
        assertMcpToolLimit(servers);
        assertCombinedToolLimit(servers, get().agnes);
        set({ servers });
      },

      approveServer: async (serverId, discovery, options) => {
        const current = get().servers[serverId];
        if (!current) throw new Error(`Unknown MCP server "${serverId}".`);
        const approved = await approveMcpDiscovery(current, discovery, options);
        const latest = get().servers[serverId];
        if (!latest)
          throw new Error(
            `MCP server "${serverId}" was deleted during approval.`,
          );
        const merged: McpServerEntry = {
          ...approved,
          // Preserve config edits made while async fingerprints were calculated.
          name: latest.name,
          transport: latest.transport,
          url: latest.url,
          headers: latest.headers,
          oauth: latest.oauth,
          command: latest.command,
          args: latest.args,
          env: latest.env,
          cwd: latest.cwd,
          requestTimeoutMs: latest.requestTimeoutMs,
        };
        const servers = { ...get().servers, [serverId]: merged };
        assertMcpToolLimit(servers);
        assertCombinedToolLimit(servers, get().agnes);
        const drift = await compareMcpDiscovery(merged, discovery);
        set({
          servers,
          runtime: {
            ...get().runtime,
            [serverId]: {
              status: "ready",
              instructions: discovery.instructions,
              tools: discovery.tools,
              drift,
              updatedAt: Date.now(),
            },
          },
        });
        return merged;
      },

      setRuntimeState: (serverId, patch) => {
        if (!get().servers[serverId]) return;
        const existing = get().runtime[serverId];
        const status = patch.status ?? existing?.status ?? "idle";
        const next: McpServerRuntimeState = {
          ...existing,
          ...patch,
          status,
          ...(patch.error !== undefined
            ? { error: redactMcpError(patch.error) }
            : {}),
          updatedAt: patch.updatedAt ?? Date.now(),
        };
        set((state) => ({
          runtime: { ...state.runtime, [serverId]: next },
        }));
      },

      clearRuntimeState: (serverId) =>
        set((state) => {
          const { [serverId]: _removed, ...runtime } = state.runtime;
          return { runtime };
        }),

      clearAllRuntime: () => set({ runtime: {} }),

      getServer: (id) => get().servers[id],
      listServers: () => Object.values(get().servers),
    }),
    {
      name: "open-builder-mcp",
      version: MCP_STORE_VERSION,
      storage: createJSONStorage(() => mcpStorage),
      partialize: (state) => ({
        globalEnabled: state.globalEnabled,
        agnes: state.agnes,
        servers: state.servers,
      }),
      migrate: (persisted) => {
        const value = persisted as Partial<McpState> | undefined;
        const servers = Object.fromEntries(
          Object.entries(value?.servers ?? {}).map(([serverId, server]) => [
            serverId,
            {
              ...server,
              tools: Object.fromEntries(
                Object.entries(server.tools).map(([toolName, tool]) => [
                  toolName,
                  tool.elevatedPermissionsPolicyVersion === TOOL_POLICY_VERSION
                    ? tool
                    : {
                        ...tool,
                        allowInPlanMode: false,
                        allowForSubagents: false,
                        elevatedPermissionsPolicyVersion: undefined,
                      },
                ]),
              ),
            },
          ]),
        );
        return {
          globalEnabled: value?.globalEnabled ?? true,
          agnes: normalizeAgnesMcpSettings(value?.agnes),
          servers,
        };
      },
      onRehydrateStorage: () => {
        let hydrationEpoch: number | undefined;
        try {
          hydrationEpoch = captureMcpLifecycleEpoch();
        } catch {
          // A hydration that starts during full clear must not repopulate MCP.
        }
        return () => {
          const stale =
            hydrationEpoch === undefined ||
            !isMcpLifecycleCurrent(hydrationEpoch);
          useMcpStore.setState(
            stale
              ? {
                  globalEnabled: true,
                  agnes: createDefaultAgnesMcpSettings(),
                  servers: {},
                  runtime: {},
                  _hasHydrated: true,
                }
              : {
                  agnes: normalizeAgnesMcpSettings(
                    useMcpStore.getState().agnes,
                  ),
                  runtime: {},
                  _hasHydrated: true,
                },
          );
        };
      },
    },
  ),
);
