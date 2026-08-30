import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  ToolExecutionContext,
  ToolExecutionOutput,
} from "../ai/generator-types";
import { TOOL_POLICY_VERSION } from "../ai/tool-policy-version";
import { useMcpStore } from "../../store/mcp";
import { compareMcpDiscovery } from "./fingerprint";
import { createMcpToolAlias } from "./alias";
import { MCP_LIMITS } from "./limits";
import { normalizeMcpToolResult } from "./result";
import {
  redactKnownMcpServerSecrets,
  redactMcpErrorForServer,
} from "./redaction";
import { McpNeedsAuthError, RemoteMcpClient } from "./remote-client";
import { buildMcpRuntimeBundle, type McpRuntimeBundle } from "./runtime";
import {
  callTauriStdioTool,
  connectTauriStdio,
  createTauriMcpFetch,
  disconnectTauriStdio,
  getMcpPlatformCapabilities,
  isTauriMcpHost,
  listTauriStdioTools,
  setTauriMcpRemotePolicy,
  startTauriOAuthLoopback,
  type McpPlatformCapabilities,
} from "./tauri-host";
import type {
  McpCallToolResultLike,
  McpOAuthConfig,
  McpPlatform,
  McpServerDiscovery,
  McpServerEntry,
} from "./types";
import {
  hasCurrentMcpElevatedPermission,
  McpValidationError,
  validateMcpServerEntry,
} from "./validation";
import { recordPermissionActivity } from "../security/activity-log";
import { validateMcpToolInput } from "./tool-input-validator";
import {
  assertMcpLifecycleCurrent,
  captureMcpLifecycleEpoch,
  isMcpLifecycleCurrent,
  McpLifecycleRevokedError,
} from "./revocation";

type LiveConnection =
  | {
      kind: "remote";
      updatedAt: number;
      client: RemoteMcpClient;
      discovery?: McpServerDiscovery;
    }
  | {
      kind: "stdio";
      updatedAt: number;
      discovery: McpServerDiscovery;
    };

export interface PrepareMcpRuntimeOptions {
  includeMcp?: boolean;
}

function confirmIssuerOrigin(origin: string): boolean {
  if (typeof window === "undefined") return false;
  return window.confirm(
    `This MCP server wants to contact a different OAuth origin:\n\n${origin}\n\nAllow this origin for this server?`,
  );
}

function platformFromCapabilities(
  capabilities: McpPlatformCapabilities,
): McpPlatform {
  if (!isTauriMcpHost()) return "web";
  return capabilities.stdio ? "desktop" : "mobile";
}

async function ensureStoreHydrated(): Promise<void> {
  if (useMcpStore.getState()._hasHydrated) return;
  await useMcpStore.persist.rehydrate();
}

export class McpConnectionManager {
  private readonly connections = new Map<string, LiveConnection>();
  private readonly pendingAuthorizationUrls = new Map<string, URL>();
  private capabilitiesPromise?: Promise<McpPlatformCapabilities>;

  private capabilities(): Promise<McpPlatformCapabilities> {
    this.capabilitiesPromise ??= getMcpPlatformCapabilities();
    return this.capabilitiesPromise;
  }

  private async persistOAuth(
    serverId: string,
    oauth: McpOAuthConfig,
    lifecycleEpoch: number,
  ): Promise<void> {
    assertMcpLifecycleCurrent(lifecycleEpoch);
    const server = useMcpStore.getState().getServer(serverId);
    if (!server) return;
    const updated: McpServerEntry = {
      ...server,
      oauth,
      updatedAt: Date.now(),
    };
    const validation = validateMcpServerEntry(updated, {
      platform: platformFromCapabilities(await this.capabilities()),
      pageProtocol:
        typeof window === "undefined" ? undefined : window.location.protocol,
    });
    assertMcpLifecycleCurrent(lifecycleEpoch);
    if (!validation.valid) throw new McpValidationError(validation.errors);
    useMcpStore.setState((state) => ({
      servers: { ...state.servers, [serverId]: updated },
    }));
    const connection = this.connections.get(serverId);
    if (connection) connection.updatedAt = updated.updatedAt;
  }

  private async validate(entry: McpServerEntry): Promise<void> {
    const capabilities = await this.capabilities();
    const validation = validateMcpServerEntry(entry, {
      platform: platformFromCapabilities(capabilities),
      pageProtocol:
        typeof window === "undefined" ? undefined : window.location.protocol,
    });
    if (!validation.valid) throw new McpValidationError(validation.errors);
  }

  private async createRemote(
    entry: McpServerEntry,
    lifecycleEpoch: number,
    redirectToAuthorization?: (url: URL) => void | Promise<void>,
  ): Promise<RemoteMcpClient> {
    const capabilities = await this.capabilities();
    assertMcpLifecycleCurrent(lifecycleEpoch);
    const origin = new URL(entry.url!).origin;
    const credentialsConfigured = Boolean(
      entry.oauth || Object.keys(entry.headers ?? {}).length > 0,
    );
    const approvedOrigins = new Set([origin]);
    const approveOrigin = async (candidate: string): Promise<boolean> => {
      assertMcpLifecycleCurrent(lifecycleEpoch);
      if (approvedOrigins.has(candidate)) return true;
      if (!confirmIssuerOrigin(candidate)) return false;
      approvedOrigins.add(candidate);
      if (capabilities.remoteStreaming) {
        await setTauriMcpRemotePolicy(
          entry.id,
          [...approvedOrigins],
          credentialsConfigured,
          () => isMcpLifecycleCurrent(lifecycleEpoch),
        );
      }
      return true;
    };
    let fetchImpl: ReturnType<typeof createTauriMcpFetch> | undefined;
    if (capabilities.remoteStreaming) {
      await setTauriMcpRemotePolicy(
        entry.id,
        [origin],
        credentialsConfigured,
        () => isMcpLifecycleCurrent(lifecycleEpoch),
      );
      assertMcpLifecycleCurrent(lifecycleEpoch);
      fetchImpl = createTauriMcpFetch(
        entry.id,
        [origin],
        approveOrigin,
        approvedOrigins,
        credentialsConfigured,
        () => isMcpLifecycleCurrent(lifecycleEpoch),
      );
    }
    return new RemoteMcpClient(entry, {
      fetch: fetchImpl,
      persistOAuth: (serverId, oauth) =>
        this.persistOAuth(serverId, oauth, lifecycleEpoch),
      redirectToAuthorization: async (url) => {
        assertMcpLifecycleCurrent(lifecycleEpoch);
        this.pendingAuthorizationUrls.set(entry.id, url);
        await redirectToAuthorization?.(url);
        assertMcpLifecycleCurrent(lifecycleEpoch);
      },
      confirmCrossOriginIssuer: (issuer, server) =>
        issuer.origin === server.origin || approveOrigin(issuer.origin),
    });
  }

  private async connectEntry(
    entry: McpServerEntry,
    lifecycleEpoch: number,
    redirectToAuthorization?: (url: URL) => void | Promise<void>,
  ): Promise<McpServerDiscovery> {
    await this.validate(entry);
    assertMcpLifecycleCurrent(lifecycleEpoch);
    const existing = this.connections.get(entry.id);
    if (existing && existing.updatedAt !== entry.updatedAt) {
      await this.close(entry.id);
    }
    const current = this.connections.get(entry.id);
    if (current?.kind === "remote") {
      const discovery = await current.client.discovery();
      assertMcpLifecycleCurrent(lifecycleEpoch);
      current.discovery = discovery;
      return discovery;
    }
    if (current?.kind === "stdio") {
      const refreshed = await listTauriStdioTools(entry.id);
      assertMcpLifecycleCurrent(lifecycleEpoch);
      current.discovery = {
        instructions: refreshed.instructions ?? current.discovery.instructions,
        tools: refreshed.tools,
      };
      return current.discovery;
    }

    if (entry.transport === "stdio") {
      const capabilities = await this.capabilities();
      if (!capabilities.stdio) {
        throw new Error("Local stdio MCP servers are desktop-only.");
      }
      const discovery = await connectTauriStdio(entry, () =>
        isMcpLifecycleCurrent(lifecycleEpoch),
      );
      if (!isMcpLifecycleCurrent(lifecycleEpoch)) {
        await disconnectTauriStdio(entry.id).catch(() => {});
        throw new McpLifecycleRevokedError();
      }
      this.connections.set(entry.id, {
        kind: "stdio",
        updatedAt: entry.updatedAt,
        discovery,
      });
      return discovery;
    }

    const client = await this.createRemote(
      entry,
      lifecycleEpoch,
      redirectToAuthorization,
    );
    assertMcpLifecycleCurrent(lifecycleEpoch);
    this.connections.set(entry.id, {
      kind: "remote",
      updatedAt: entry.updatedAt,
      client,
    });
    const discovery = await client.connect();
    if (!isMcpLifecycleCurrent(lifecycleEpoch)) {
      const staleConnection = this.connections.get(entry.id);
      if (
        staleConnection?.kind === "remote" &&
        staleConnection.client === client
      ) {
        this.connections.delete(entry.id);
      }
      await client.close().catch(() => {});
      throw new McpLifecycleRevokedError();
    }
    const connection = this.connections.get(entry.id);
    if (connection?.kind === "remote") connection.discovery = discovery;
    return discovery;
  }

  async testServer(serverId: string): Promise<McpServerDiscovery | undefined> {
    const lifecycleEpoch = captureMcpLifecycleEpoch();
    await ensureStoreHydrated();
    assertMcpLifecycleCurrent(lifecycleEpoch);
    const store = useMcpStore.getState();
    const entry = store.getServer(serverId);
    if (!entry) throw new Error(`Unknown MCP server "${serverId}".`);
    assertMcpLifecycleCurrent(lifecycleEpoch);
    store.setRuntimeState(serverId, {
      status: "connecting",
      error: undefined,
    });
    try {
      const discovery = await this.connectEntry(entry, lifecycleEpoch);
      const drift = await compareMcpDiscovery(entry, discovery);
      assertMcpLifecycleCurrent(lifecycleEpoch);
      if (
        useMcpStore.getState().getServer(serverId)?.updatedAt !==
        entry.updatedAt
      ) {
        throw new McpLifecycleRevokedError();
      }
      useMcpStore.getState().setRuntimeState(serverId, {
        status: drift.status === "clean" ? "ready" : "drifted",
        instructions: discovery.instructions,
        tools: discovery.tools,
        drift,
        connectedAt: Date.now(),
        error: undefined,
      });
      return discovery;
    } catch (error) {
      if (error instanceof McpLifecycleRevokedError) return undefined;
      if (error instanceof McpNeedsAuthError) {
        assertMcpLifecycleCurrent(lifecycleEpoch);
        useMcpStore.getState().setRuntimeState(serverId, {
          status: "needs_auth",
          error: undefined,
        });
        return undefined;
      }
      const platform = platformFromCapabilities(await this.capabilities());
      if (!isMcpLifecycleCurrent(lifecycleEpoch)) return undefined;
      let message = redactMcpErrorForServer(error, entry);
      if (platform === "web" && error instanceof TypeError) {
        message = `Browser connection failed. Check server CORS, HTTPS, and mixed-content policy. ${message}`;
      }
      useMcpStore.getState().setRuntimeState(serverId, {
        status: "error",
        error: message,
      });
      await this.close(serverId, true);
      return undefined;
    }
  }

  async reconnectServer(
    serverId: string,
  ): Promise<McpServerDiscovery | undefined> {
    await this.close(serverId);
    return this.testServer(serverId);
  }

  async reconnectAll(): Promise<void> {
    const enabledIds = Object.values(useMcpStore.getState().servers)
      .filter((server) => server.enabled)
      .map((server) => server.id);
    await Promise.all(enabledIds.map((serverId) => this.close(serverId)));
    await Promise.all(enabledIds.map((serverId) => this.testServer(serverId)));
  }

  async approveServer(serverId: string): Promise<void> {
    const lifecycleEpoch = captureMcpLifecycleEpoch();
    const runtime = useMcpStore.getState().runtime[serverId];
    if (!runtime?.tools) {
      throw new Error("Test the MCP server before approving its tools.");
    }
    const discovery: McpServerDiscovery = {
      instructions: runtime.instructions,
      tools: runtime.tools,
    };
    const approved = await useMcpStore
      .getState()
      .approveServer(serverId, discovery, {
        enableServer: true,
        enableNewTools: true,
      });
    assertMcpLifecycleCurrent(lifecycleEpoch);
    const drift = await compareMcpDiscovery(approved, discovery);
    assertMcpLifecycleCurrent(lifecycleEpoch);
    if (!useMcpStore.getState().getServer(serverId)) {
      throw new McpLifecycleRevokedError();
    }
    useMcpStore.getState().setRuntimeState(serverId, {
      status: "ready",
      instructions: discovery.instructions,
      tools: discovery.tools,
      drift,
      connectedAt: Date.now(),
      error: undefined,
    });
  }

  async authorizeServer(serverId: string): Promise<void> {
    const lifecycleEpoch = captureMcpLifecycleEpoch();
    await ensureStoreHydrated();
    assertMcpLifecycleCurrent(lifecycleEpoch);
    let entry = useMcpStore.getState().getServer(serverId);
    if (!entry?.oauth || entry.oauth.type !== "authorization-code") {
      throw new Error("This MCP server does not use authorization-code OAuth.");
    }
    const capabilities = await this.capabilities();
    assertMcpLifecycleCurrent(lifecycleEpoch);

    if (!capabilities.oauthLoopback) {
      let url = this.pendingAuthorizationUrls.get(serverId);
      if (!url) {
        await this.close(serverId);
        await this.connectEntry(entry, lifecycleEpoch);
        url = this.pendingAuthorizationUrls.get(serverId);
      }
      if (!url) throw new Error("OAuth authorization URL was not provided.");
      const popup = window.open(
        url.toString(),
        "open-builder-mcp-oauth",
        "popup,width=620,height=760",
      );
      if (!popup) window.location.assign(url.toString());
      return;
    }

    const requestId = crypto.randomUUID();
    const loopback = await startTauriOAuthLoopback(requestId);
    assertMcpLifecycleCurrent(lifecycleEpoch);
    const oauth = { ...entry.oauth, redirectUri: loopback.redirectUri };
    useMcpStore.getState().updateServer(serverId, { oauth });
    entry = useMcpStore.getState().getServer(serverId)!;
    await this.close(serverId);
    try {
      try {
        await this.connectEntry(entry, lifecycleEpoch, (url) =>
          openUrl(url.toString()),
        );
      } catch (error) {
        if (!(error instanceof McpNeedsAuthError)) throw error;
      }
      const params = await loopback.callback;
      await this.finishAuthorization(serverId, params);
    } finally {
      await loopback.cancel().catch(() => {});
    }
  }

  async finishAuthorization(
    serverId: string,
    params: URLSearchParams,
  ): Promise<void> {
    const lifecycleEpoch = captureMcpLifecycleEpoch();
    const entry = useMcpStore.getState().getServer(serverId);
    if (!entry) throw new Error(`Unknown MCP server "${serverId}".`);
    let connection = this.connections.get(serverId);
    if (connection?.kind !== "remote") {
      const client = await this.createRemote(entry, lifecycleEpoch);
      connection = {
        kind: "remote",
        updatedAt: entry.updatedAt,
        client,
      };
      this.connections.set(serverId, connection);
    }
    const discovery = await connection.client.finishAuthorization(params);
    assertMcpLifecycleCurrent(lifecycleEpoch);
    connection.discovery = discovery;
    const latest = useMcpStore.getState().getServer(serverId) ?? entry;
    const drift = await compareMcpDiscovery(latest, discovery);
    assertMcpLifecycleCurrent(lifecycleEpoch);
    useMcpStore.getState().setRuntimeState(serverId, {
      status: drift.status === "clean" ? "ready" : "drifted",
      instructions: discovery.instructions,
      tools: discovery.tools,
      drift,
      connectedAt: Date.now(),
      error: undefined,
    });
    this.pendingAuthorizationUrls.delete(serverId);
  }

  async ensureEnabledServers(): Promise<void> {
    const lifecycleEpoch = captureMcpLifecycleEpoch();
    await ensureStoreHydrated();
    assertMcpLifecycleCurrent(lifecycleEpoch);
    const state = useMcpStore.getState();
    if (!state.globalEnabled) {
      await this.closeAll();
      return;
    }
    const enabled = Object.values(state.servers).filter(
      (server) => server.enabled,
    );
    const enabledIds = new Set(enabled.map((server) => server.id));
    await Promise.all(
      [...this.connections.keys()]
        .filter((serverId) => !enabledIds.has(serverId))
        .map((serverId) => this.close(serverId)),
    );
    await Promise.all(enabled.map((server) => this.testServer(server.id)));
  }

  async prepareRuntime(
    options: PrepareMcpRuntimeOptions = {},
  ): Promise<McpRuntimeBundle> {
    if (options.includeMcp !== false) await this.ensureEnabledServers();
    const state = useMcpStore.getState();
    const external = await buildMcpRuntimeBundle({
      globalEnabled: options.includeMcp !== false && state.globalEnabled,
      servers: state.servers,
      runtime: state.runtime,
      caller: this,
    });
    if (
      options.includeMcp === false ||
      !state.globalEnabled ||
      !state.agnes?.enabled ||
      !state.agnes.apiKey.trim()
    ) {
      return external;
    }
    const { buildAgnesMcpRuntimeBundle, mergeMcpRuntimeBundles } =
      await import("./agnes/runtime");
    const managed = await buildAgnesMcpRuntimeBundle(true);
    return mergeMcpRuntimeBundles(external, managed);
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionOutput> {
    const state = useMcpStore.getState();
    const server = state.getServer(serverId);
    const runtime = state.runtime[serverId];
    const tool = server?.tools[toolName];
    const activityContext = {
      conversationId: context?.run.conversationId,
      mcp: {
        serverId,
        serverName: server?.name,
        toolTitle: tool?.title,
      },
    };
    if (!context) {
      recordPermissionActivity({
        ...activityContext,
        tool: toolName,
        source: "mcp",
        mode: "chat",
        platform: "web",
        decision: "denied",
        reason: "missing tool execution context",
      });
      return {
        text: `Error: MCP tool "${toolName}" is not authorized without a tool execution context.`,
        isError: true,
      };
    }
    const alias = createMcpToolAlias(serverId, toolName);
    const allowedByMode =
      context.run.mode === "chat"
        ? true
        : context.run.mode === "plan"
          ? tool !== undefined && hasCurrentMcpElevatedPermission(tool, "plan")
          : context.run.mode === "subagent"
            ? tool !== undefined &&
              hasCurrentMcpElevatedPermission(tool, "subagent")
            : false;
    if (
      context.run.policyVersion !== TOOL_POLICY_VERSION ||
      !context.run.allowedMcpAliases.has(alias) ||
      !allowedByMode ||
      !state.globalEnabled ||
      !server?.enabled ||
      !tool?.enabled ||
      runtime?.status !== "ready" ||
      runtime.drift?.status !== "clean"
    ) {
      recordPermissionActivity({
        ...activityContext,
        tool: toolName,
        source: "mcp",
        mode: context.run.mode,
        platform: context.run.platform,
        decision: "denied",
        target: server?.url,
        reason:
          "server or tool is disabled, disconnected, or awaiting approval",
      });
      return {
        text: `Error: MCP tool "${toolName}" is disabled, disconnected, or awaiting re-approval.`,
        isError: true,
      };
    }
    const inputValidation = await validateMcpToolInput(tool.inputSchema, args);
    if (!inputValidation.success) {
      recordPermissionActivity({
        ...activityContext,
        tool: toolName,
        source: "mcp",
        mode: context.run.mode,
        platform: context.run.platform,
        decision: "denied",
        target: server.url,
        reason: "tool arguments failed the approved JSON Schema",
      });
      return {
        text: `Error: invalid arguments for MCP tool "${toolName}": ${inputValidation.error.message}`,
        isError: true,
      };
    }
    recordPermissionActivity({
      ...activityContext,
      tool: toolName,
      source: "mcp",
      mode: context.run.mode,
      platform: context.run.platform,
      decision: "allowed",
      target: server.url,
    });
    const connection = this.connections.get(serverId);
    if (!connection) {
      return {
        text: `Error: MCP server "${server.name}" is not connected.`,
        isError: true,
      };
    }
    let raw: McpCallToolResultLike;
    try {
      if (connection.kind === "remote") {
        raw = await connection.client.callTool(
          toolName,
          inputValidation.value,
          context.signal,
        );
      } else {
        raw = await callTauriStdioTool(
          serverId,
          context.toolCallId,
          toolName,
          inputValidation.value,
          server.requestTimeoutMs ?? MCP_LIMITS.defaultRequestTimeoutMs,
          context.signal,
        );
      }
    } catch (error) {
      if (context.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return {
        text: `Error: MCP tool "${toolName}" failed: ${redactMcpErrorForServer(error, server)}`,
        isError: true,
      };
    }
    const snapshot = normalizeMcpToolResult(
      redactKnownMcpServerSecrets(raw, server),
      {
        serverId,
        serverName: server.name,
        toolName,
      },
    );
    const { mcpSnapshotToToolExecutionOutput } = await import("./tool-output");
    return mcpSnapshotToToolExecutionOutput(snapshot, {
      serverId,
      serverName: server.name,
      toolName,
      toolTitle: tool.title,
    });
  }

  async close(serverId: string, preserveRuntime = false): Promise<void> {
    const connection = this.connections.get(serverId);
    this.connections.delete(serverId);
    this.pendingAuthorizationUrls.delete(serverId);
    try {
      let closeError: unknown;
      try {
        if ((await this.capabilities()).remoteStreaming) {
          await setTauriMcpRemotePolicy(serverId, []);
        }
      } catch (error) {
        closeError = error;
      }
      try {
        if (connection?.kind === "remote") await connection.client.close();
        else if (connection?.kind === "stdio") {
          await disconnectTauriStdio(serverId);
        }
      } catch (error) {
        closeError ??= error;
      }
      if (closeError) throw closeError;
    } finally {
      const server = useMcpStore.getState().getServer(serverId);
      if (server && !preserveRuntime) {
        useMcpStore.getState().setRuntimeState(serverId, { status: "idle" });
      }
    }
  }

  async closeAll(): Promise<void> {
    const agnes = useMcpStore.getState().agnes;
    if (agnes?.enabled || agnes?.apiKey) {
      const [tasks, service] = await Promise.all([
        import("./agnes/video-task-manager"),
        import("./agnes/service"),
      ]);
      tasks.stopAgnesVideoTasks();
      service.abortAgnesMcpRequests();
    }
    const serverIds = new Set([
      ...this.connections.keys(),
      ...Object.keys(useMcpStore.getState().servers),
    ]);
    await Promise.all([...serverIds].map((id) => this.close(id)));
  }
}

let manager: McpConnectionManager | undefined;

export function getMcpConnectionManager(): McpConnectionManager {
  manager ??= new McpConnectionManager();
  return manager;
}

export async function handleMcpOAuthCallbackFromLocation(): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  const callbackPath = new URL("mcp/oauth/callback/", base).pathname.replace(
    /\/$/,
    "",
  );
  const currentPath = window.location.pathname.replace(/\/$/, "");
  const params = new URLSearchParams(window.location.search);
  const relayed = params.get("open_builder_mcp_oauth_callback") === "1";
  if (currentPath !== callbackPath && !relayed) return false;
  const lifecycleEpoch = captureMcpLifecycleEpoch();
  await ensureStoreHydrated();
  assertMcpLifecycleCurrent(lifecycleEpoch);
  params.delete("open_builder_mcp_oauth_callback");
  const state = params.get("state");
  const server = Object.values(useMcpStore.getState().servers).find(
    (candidate) =>
      candidate.oauth?.type === "authorization-code" &&
      candidate.oauth.pendingAuthorization?.state === state,
  );
  if (!server) throw new Error("No MCP OAuth request matches this callback.");
  await getMcpConnectionManager().finishAuthorization(server.id, params);
  if (window.opener) {
    window.opener.postMessage(
      { type: "open-builder:mcp-oauth-complete", serverId: server.id },
      window.location.origin,
    );
    window.close();
  } else window.history.replaceState({}, "", base.pathname);
  return true;
}
