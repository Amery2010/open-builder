import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_POLICY_VERSION } from "../ai/tool-policy-version";
import type { ToolExecutionContext } from "../ai/generator-types";
import { createSkillActiveContext } from "../skills/active-context";
import { useMcpStore } from "../../store/mcp";
import { createMcpToolAlias } from "./alias";
import { McpConnectionManager } from "./connection-manager";
import type { McpServerEntry } from "./types";
import { createMcpServerEntry } from "./validation";

const localforageMock = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const adapter = {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return value;
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return { ...adapter, createInstance: () => adapter };
});

vi.mock("localforage", () => ({ default: localforageMock }));

function chatContext(alias: string): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    toolCallId: "call-1",
    skillContext: createSkillActiveContext(),
    run: {
      runId: "run-1",
      mode: "chat",
      platform: "web",
      runtime: "api",
      allowedMcpAliases: new Set([alias]),
      activeSkillIds: new Set(),
      approvedSkillScriptHashes: new Set(),
      policyVersion: TOOL_POLICY_VERSION,
    },
  };
}

describe("McpConnectionManager tool errors", () => {
  afterEach(() => {
    useMcpStore.setState({
      globalEnabled: true,
      servers: {},
      runtime: {},
      _hasHydrated: true,
    });
  });

  it("returns a redacted error when a remote tool leaks configured secrets", async () => {
    const sentinels = {
      header: "header-exception-sentinel",
      env: "env-exception-sentinel",
      client: "client-exception-sentinel",
      access: "access-exception-sentinel",
      refresh: "refresh-exception-sentinel",
      verifier: "verifier-exception-sentinel",
    };
    const base = createMcpServerEntry(
      {
        name: "Remote errors",
        enabled: true,
        transport: "streamable-http",
        url: "https://mcp.example.com/rpc",
      },
      { id: "remote-errors", now: 1 },
    );
    const server: McpServerEntry = {
      ...base,
      headers: { "X-Custom": sentinels.header },
      env: { MCP_SECRET: sentinels.env },
      oauth: {
        type: "authorization-code",
        clientRegistration: "manual",
        clientId: "client-id",
        clientSecret: sentinels.client,
        scopes: [],
        tokens: {
          accessToken: sentinels.access,
          refreshToken: sentinels.refresh,
        },
        pendingAuthorization: {
          state: "state-exception-sentinel",
          codeVerifier: sentinels.verifier,
          createdAt: 1,
        },
      },
      tools: {
        explode: {
          name: "explode",
          inputSchema: { type: "object" },
          fingerprint: "approved-tool",
          enabled: true,
          allowInPlanMode: false,
          allowForSubagents: false,
        },
      },
    };
    useMcpStore.setState({
      globalEnabled: true,
      servers: { [server.id]: server },
      runtime: {
        [server.id]: {
          status: "ready",
          drift: {
            status: "clean",
            added: [],
            removed: [],
            changed: [],
            instructionsChanged: false,
            currentFingerprint: "approved-server",
          },
          updatedAt: 1,
        },
      },
      _hasHydrated: true,
    });
    const thrownText = Object.values(sentinels).join(" ");
    const manager = new McpConnectionManager();
    const callTool = vi.fn().mockRejectedValue(new Error(thrownText));
    (
      manager as unknown as {
        connections: Map<string, unknown>;
      }
    ).connections.set(server.id, {
      kind: "remote",
      updatedAt: server.updatedAt,
      client: { callTool },
    });
    const alias = createMcpToolAlias(server.id, "explode");

    const result = await manager.callTool(
      server.id,
      "explode",
      {},
      chatContext(alias),
    );
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
    for (const sentinel of Object.values(sentinels)) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  it("rejects invalid approved tool arguments before invoking the transport", async () => {
    const base = createMcpServerEntry(
      {
        name: "Validated remote",
        enabled: true,
        transport: "streamable-http",
        url: "https://mcp.example.com/rpc",
      },
      { id: "validated-remote", now: 1 },
    );
    const server: McpServerEntry = {
      ...base,
      tools: {
        lookup: {
          name: "lookup",
          inputSchema: {
            type: "object",
            properties: { id: { type: "integer" } },
            required: ["id"],
            additionalProperties: false,
          },
          fingerprint: "approved-tool",
          enabled: true,
          allowInPlanMode: false,
          allowForSubagents: false,
        },
      },
    };
    useMcpStore.setState({
      globalEnabled: true,
      servers: { [server.id]: server },
      runtime: {
        [server.id]: {
          status: "ready",
          drift: {
            status: "clean",
            added: [],
            removed: [],
            changed: [],
            instructionsChanged: false,
            currentFingerprint: "approved-server",
          },
          updatedAt: 1,
        },
      },
      _hasHydrated: true,
    });
    const manager = new McpConnectionManager();
    const callTool = vi.fn();
    (
      manager as unknown as {
        connections: Map<string, unknown>;
      }
    ).connections.set(server.id, {
      kind: "remote",
      updatedAt: server.updatedAt,
      client: { callTool },
    });
    const alias = createMcpToolAlias(server.id, "lookup");
    const args = { id: "1", extra: true };

    await expect(
      manager.callTool(server.id, "lookup", args, chatContext(alias)),
    ).resolves.toMatchObject({ isError: true });
    expect(args).toEqual({ id: "1", extra: true });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("rejects invalid stdio arguments at the same shared boundary", async () => {
    const base = createMcpServerEntry(
      {
        name: "Validated stdio",
        enabled: true,
        transport: "stdio",
        command: "fixture-mcp",
      },
      { id: "validated-stdio", now: 1 },
    );
    const server: McpServerEntry = {
      ...base,
      tools: {
        lookup: {
          name: "lookup",
          inputSchema: {
            type: "object",
            properties: { id: { type: "integer" } },
            required: ["id"],
            additionalProperties: false,
          },
          fingerprint: "approved-tool",
          enabled: true,
          allowInPlanMode: false,
          allowForSubagents: false,
        },
      },
    };
    useMcpStore.setState({
      globalEnabled: true,
      servers: { [server.id]: server },
      runtime: {
        [server.id]: {
          status: "ready",
          drift: {
            status: "clean",
            added: [],
            removed: [],
            changed: [],
            instructionsChanged: false,
            currentFingerprint: "approved-server",
          },
          updatedAt: 1,
        },
      },
      _hasHydrated: true,
    });
    const manager = new McpConnectionManager();
    (
      manager as unknown as {
        connections: Map<string, unknown>;
      }
    ).connections.set(server.id, {
      kind: "stdio",
      updatedAt: server.updatedAt,
      discovery: { tools: [] },
    });
    const alias = createMcpToolAlias(server.id, "lookup");

    const result = await manager.callTool(
      server.id,
      "lookup",
      { id: "not-an-integer" },
      chatContext(alias),
    );

    expect(result).toMatchObject({
      isError: true,
      text: expect.stringMatching(/invalid arguments/i),
    });
  });
});
