import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServerEntry } from "../lib/mcp/validation";
import { MCP_STORE_VERSION, useMcpStore } from "./mcp";
import { TOOL_POLICY_VERSION } from "../lib/ai/tool-policy-version";
import {
  beginMcpLifecycleRevocation,
  finishMcpLifecycleRevocation,
} from "../lib/mcp/revocation";
import {
  AGNES_MCP_DEFINITION_VERSION,
  createDefaultAgnesMcpSettings,
} from "../lib/mcp/agnes/types";

const records = vi.hoisted(() => new Map<string, string>());

vi.mock("localforage", () => ({
  default: {
    createInstance: () => ({
      getItem: async (key: string) => records.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        records.set(key, value);
      },
      removeItem: async (key: string) => {
        records.delete(key);
      },
    }),
  },
}));

describe("MCP store", () => {
  beforeEach(() => {
    records.clear();
    useMcpStore.setState({
      globalEnabled: true,
      agnes: createDefaultAgnesMcpSettings(),
      servers: {},
      runtime: {},
      _hasHydrated: true,
    });
  });

  it("persists server configuration but excludes runtime connection state", () => {
    const entry = createMcpServerEntry(
      {
        name: "Remote",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer locally-persisted" },
      },
      { id: "remote" },
    );
    useMcpStore.getState().registerServer(entry);
    useMcpStore.getState().setRuntimeState("remote", {
      status: "error",
      error: "Authorization: Bearer runtime-secret",
    });

    expect(useMcpStore.getState().runtime.remote.error).not.toContain(
      "runtime-secret",
    );
    const partialize = useMcpStore.persist.getOptions().partialize;
    const persisted = partialize?.(useMcpStore.getState()) as Record<
      string,
      unknown
    >;
    expect(persisted).toHaveProperty("servers.remote.headers.Authorization");
    expect(persisted).not.toHaveProperty("runtime");
    expect(persisted).not.toHaveProperty("_hasHydrated");
  });

  it("approves discovery, marks runtime clean, and enforces read-only permissions", async () => {
    const entry = createMcpServerEntry(
      {
        name: "Remote",
        transport: "streamable-http",
        url: "https://example.com/mcp",
      },
      { id: "remote" },
    );
    useMcpStore.getState().registerServer(entry);
    await useMcpStore.getState().approveServer("remote", {
      instructions: "External instructions",
      tools: [
        {
          name: "write",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: false },
        },
      ],
    });

    expect(useMcpStore.getState().runtime.remote).toMatchObject({
      status: "ready",
      drift: { status: "clean" },
    });
    useMcpStore.getState().setToolApproval("remote", "write", {
      allowInPlanMode: true,
      allowForSubagents: true,
    });
    expect(useMcpStore.getState().servers.remote.tools.write).toMatchObject({
      allowInPlanMode: false,
      allowForSubagents: false,
    });
  });

  it("removes ephemeral state together with a deleted server", () => {
    const entry = createMcpServerEntry(
      {
        name: "Remote",
        transport: "streamable-http",
        url: "https://example.com/mcp",
      },
      { id: "remote" },
    );
    useMcpStore.getState().registerServer(entry);
    useMcpStore.getState().setRuntimeState("remote", { status: "connecting" });
    useMcpStore.getState().deleteServer("remote");
    expect(useMcpStore.getState().servers.remote).toBeUndefined();
    expect(useMcpStore.getState().runtime.remote).toBeUndefined();
  });

  it("persists the current tool policy with elevated grants", async () => {
    const entry = createMcpServerEntry(
      {
        name: "Remote",
        transport: "streamable-http",
        url: "https://example.com/mcp",
      },
      { id: "remote" },
    );
    useMcpStore.getState().registerServer(entry);
    await useMcpStore.getState().approveServer("remote", {
      tools: [
        {
          name: "read",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    });

    useMcpStore.getState().setToolApproval("remote", "read", {
      allowInPlanMode: true,
    });

    expect(useMcpStore.getState().servers.remote.tools.read).toMatchObject({
      allowInPlanMode: true,
      elevatedPermissionsPolicyVersion: TOOL_POLICY_VERSION,
    });
    const partialize = useMcpStore.persist.getOptions().partialize;
    expect(partialize?.(useMcpStore.getState())).toHaveProperty(
      "servers.remote.tools.read.elevatedPermissionsPolicyVersion",
      TOOL_POLICY_VERSION,
    );
  });

  it("migrates stale elevated grants to false until the user reapproves", async () => {
    const entry = createMcpServerEntry(
      {
        name: "Remote",
        transport: "streamable-http",
        url: "https://example.com/mcp",
      },
      { id: "remote" },
    );
    entry.tools.read = {
      name: "read",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      fingerprint: "fingerprint",
      enabled: true,
      allowInPlanMode: true,
      allowForSubagents: true,
      elevatedPermissionsPolicyVersion: "older-policy",
    };
    const migrate = useMcpStore.persist.getOptions().migrate;
    const migrated = (await migrate?.(
      { globalEnabled: true, servers: { remote: entry } },
      MCP_STORE_VERSION - 1,
    )) as Pick<ReturnType<typeof useMcpStore.getState>, "servers">;

    expect(migrated.servers.remote.tools.read).toMatchObject({
      allowInPlanMode: false,
      allowForSubagents: false,
    });
    expect(
      migrated.servers.remote.tools.read.elevatedPermissionsPolicyVersion,
    ).toBeUndefined();
  });

  it("normalizes Agnes definition grants after same-version hydration", () => {
    const stale = createDefaultAgnesMcpSettings(1);
    stale.enabled = true;
    stale.apiKey = "agnes-secret";
    stale.definitionVersion = AGNES_MCP_DEFINITION_VERSION - 1;
    stale.tools.generate_image = {
      enabled: true,
      allowForSubagents: true,
      subagentPolicyVersion: TOOL_POLICY_VERSION,
    };
    const finishHydration = useMcpStore.persist
      .getOptions()
      .onRehydrateStorage?.(useMcpStore.getState());
    useMcpStore.setState({ agnes: stale });
    finishHydration?.(useMcpStore.getState(), undefined);

    expect(useMcpStore.getState().agnes.tools.generate_image).toMatchObject({
      enabled: false,
      allowForSubagents: false,
    });
  });

  it("does not let hydration that predates full clear restore MCP servers", () => {
    const finishHydration = useMcpStore.persist
      .getOptions()
      .onRehydrateStorage?.(useMcpStore.getState());
    const revocation = beginMcpLifecycleRevocation();
    try {
      const entry = createMcpServerEntry(
        {
          name: "Stale",
          transport: "streamable-http",
          url: "https://example.com/mcp",
        },
        { id: "stale" },
      );
      // Simulate Zustand applying an old storage read immediately before its
      // hydration completion callback runs.
      useMcpStore.setState({ servers: { stale: entry } });
      finishHydration?.(useMcpStore.getState(), undefined);

      expect(useMcpStore.getState().servers).toEqual({});
      expect(useMcpStore.getState().runtime).toEqual({});
    } finally {
      finishMcpLifecycleRevocation(revocation);
    }
  });

  it("persists Agnes configuration, keeps its key out of runtime, and removes it on reset", () => {
    const agnes = createDefaultAgnesMcpSettings(1);
    agnes.apiKey = "agnes-secret";
    agnes.enabled = true;
    agnes.tools.generate_image.enabled = true;
    useMcpStore.setState({ agnes });

    const partialize = useMcpStore.persist.getOptions().partialize;
    const persisted = partialize?.(useMcpStore.getState()) as Record<
      string,
      unknown
    >;
    expect(persisted).toHaveProperty("agnes.apiKey", "agnes-secret");
    expect(persisted).not.toHaveProperty("runtime");

    useMcpStore.getState().setAgnesApiKey("");
    expect(useMcpStore.getState().agnes).toMatchObject({
      apiKey: "",
      enabled: false,
    });
  });

  it("requires fresh approval after an Agnes definition change", async () => {
    const stale = createDefaultAgnesMcpSettings(1);
    stale.enabled = true;
    stale.apiKey = "agnes-secret";
    stale.definitionVersion = AGNES_MCP_DEFINITION_VERSION - 1;
    stale.tools.generate_image = {
      enabled: true,
      allowForSubagents: true,
      subagentPolicyVersion: TOOL_POLICY_VERSION,
    };
    const migrate = useMcpStore.persist.getOptions().migrate;
    const migrated = (await migrate?.(
      { globalEnabled: true, agnes: stale, servers: {} },
      MCP_STORE_VERSION - 1,
    )) as Pick<ReturnType<typeof useMcpStore.getState>, "agnes">;

    expect(migrated.agnes.enabled).toBe(true);
    expect(migrated.agnes.tools.generate_image).toMatchObject({
      enabled: false,
      allowForSubagents: false,
    });
  });

  it("never grants video tools to subagents", () => {
    const agnes = createDefaultAgnesMcpSettings(1);
    agnes.apiKey = "agnes-secret";
    agnes.updatedAt = Date.now() + 1_000;
    useMcpStore.setState({ agnes });

    useMcpStore.getState().setAgnesToolApproval("create_video", {
      enabled: true,
      allowForSubagents: true,
    });
    expect(useMcpStore.getState().agnes.tools.create_video).toEqual({
      enabled: true,
      allowForSubagents: false,
    });
    expect(useMcpStore.getState().agnes.updatedAt).toBe(agnes.updatedAt + 1);
  });
});
