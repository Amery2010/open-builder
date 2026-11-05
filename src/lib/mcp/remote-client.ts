import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type FetchLike,
  type Tool,
} from "@modelcontextprotocol/client";
import { APP_VERSION } from "../app-version";
import { MCP_LIMITS } from "./limits";
import { createMcpOAuthProvider, validateOAuthCallbackState } from "./oauth";
import type {
  JsonObject,
  McpAuthorizationCodeOAuthConfig,
  McpOAuthConfig,
  McpServerDiscovery,
  McpServerEntry,
  McpToolDefinition,
} from "./types";

type RemoteTransport = StreamableHTTPClientTransport | SSEClientTransport;

export interface RemoteMcpClientOptions {
  fetch?: FetchLike;
  persistOAuth?: (
    serverId: string,
    config: McpOAuthConfig,
  ) => void | Promise<void>;
  redirectToAuthorization?: (url: URL) => void | Promise<void>;
  confirmCrossOriginIssuer?: (
    issuer: URL,
    server: URL,
  ) => boolean | Promise<boolean>;
}

export class McpNeedsAuthError extends Error {
  constructor() {
    super("MCP server requires authorization.");
    this.name = "McpNeedsAuthError";
  }
}

function asJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return { type: "object", properties: {} } as JsonObject;
}

function normalizeTool(tool: Tool): McpToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: asJsonObject(tool.inputSchema),
    outputSchema: tool.outputSchema
      ? asJsonObject(tool.outputSchema)
      : undefined,
    annotations: tool.annotations
      ? {
          title: tool.annotations.title,
          readOnlyHint: tool.annotations.readOnlyHint,
          destructiveHint: tool.annotations.destructiveHint,
          idempotentHint: tool.annotations.idempotentHint,
          openWorldHint: tool.annotations.openWorldHint,
        }
      : undefined,
    _meta: tool._meta ? asJsonObject(tool._meta) : undefined,
  };
}

function timeoutFor(entry: McpServerEntry): number {
  return entry.requestTimeoutMs ?? MCP_LIMITS.defaultRequestTimeoutMs;
}

export class RemoteMcpClient {
  private client?: Client;
  private transport?: RemoteTransport;
  private connected = false;
  private oauthConfig?: McpOAuthConfig;

  constructor(
    readonly entry: McpServerEntry,
    private readonly options: RemoteMcpClientOptions = {},
  ) {
    if (entry.transport === "stdio") {
      throw new Error("RemoteMcpClient cannot use stdio transport.");
    }
    if (!entry.url) throw new Error("Remote MCP URL is required.");
    this.oauthConfig = entry.oauth;
  }

  private createClient(): Client {
    return new Client(
      { name: "open-builder", version: APP_VERSION },
      {
        capabilities: {},
        versionNegotiation: {
          mode: "auto",
          probe: { timeoutMs: timeoutFor(this.entry), maxRetries: 0 },
        },
        listMaxPages: 64,
      },
    );
  }

  private createTransport(): RemoteTransport {
    const authProvider = this.oauthConfig
      ? createMcpOAuthProvider({
          serverUrl: this.entry.url!,
          config: this.oauthConfig,
          persist: (config) => {
            this.oauthConfig = config;
            return this.options.persistOAuth?.(this.entry.id, config);
          },
          redirectToAuthorization: this.options.redirectToAuthorization,
          confirmCrossOriginIssuer: this.options.confirmCrossOriginIssuer,
        })
      : undefined;
    const common = {
      authProvider,
      fetch: this.options.fetch,
      requestInit: {
        headers: new Headers(this.entry.headers ?? {}),
      },
      // A 403 never changes transport. Client-credential flows cannot widen
      // scopes interactively; authorization-code flows remain SDK-gated.
      ...(this.oauthConfig?.type === "client-credentials"
        ? { onInsufficientScope: "throw" as const }
        : {}),
    };
    const url = new URL(this.entry.url!);
    return this.entry.transport === "sse"
      ? new SSEClientTransport(url, common)
      : new StreamableHTTPClientTransport(url, {
          ...common,
          reconnectionOptions: {
            initialReconnectionDelay: 1_000,
            maxReconnectionDelay: 10_000,
            reconnectionDelayGrowFactor: 1.5,
            maxRetries: 2,
          },
        });
  }

  async connect(): Promise<McpServerDiscovery> {
    if (this.connected && this.client) return this.discovery();
    this.client = this.createClient();
    this.transport = this.createTransport();
    try {
      await this.client.connect(this.transport, {
        timeout: timeoutFor(this.entry),
      });
      this.connected = true;
      return await this.discovery();
    } catch (error) {
      if (UnauthorizedError.isInstance(error)) {
        throw new McpNeedsAuthError();
      }
      throw error;
    }
  }

  async finishAuthorization(
    callbackParams: URLSearchParams,
  ): Promise<McpServerDiscovery> {
    if (this.oauthConfig?.type !== "authorization-code") {
      throw new Error("This MCP server does not use authorization-code OAuth.");
    }
    try {
      validateOAuthCallbackState(
        this.oauthConfig as McpAuthorizationCodeOAuthConfig,
        callbackParams,
      );
    } catch (error) {
      this.oauthConfig = {
        ...(this.oauthConfig as McpAuthorizationCodeOAuthConfig),
        pendingAuthorization: undefined,
      };
      await this.options.persistOAuth?.(this.entry.id, this.oauthConfig);
      throw error;
    }
    if (!this.transport) this.transport = this.createTransport();
    await this.transport.finishAuth(callbackParams);
    this.client = this.createClient();
    await this.client.connect(this.transport, {
      timeout: timeoutFor(this.entry),
    });
    this.connected = true;
    return this.discovery();
  }

  async discovery(): Promise<McpServerDiscovery> {
    if (!this.client || !this.connected) {
      throw new Error("MCP server is not connected.");
    }
    const listed = await this.client.listTools(undefined, {
      timeout: timeoutFor(this.entry),
      cacheMode: "refresh",
    });
    return {
      instructions: this.client.getInstructions(),
      tools: listed.tools.map(normalizeTool),
    };
  }

  async callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    if (!this.client || !this.connected) {
      throw new Error("MCP server is not connected.");
    }
    signal?.throwIfAborted();
    try {
      return await this.client.callTool(
        {
          name,
          arguments:
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {},
        },
        {
          // Keep the original request alive for three waiting windows. Reissuing
          // an MCP tool could duplicate writes that completed after a timeout.
          timeout: timeoutFor(this.entry) * 3,
          signal,
        },
      );
    } catch (error) {
      // The SDK can wrap cancellation as REQUEST_TIMEOUT. Preserve Stop so it
      // cannot be mistaken for a retryable transport failure by callers.
      signal?.throwIfAborted();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (client) await client.close();
  }
}
