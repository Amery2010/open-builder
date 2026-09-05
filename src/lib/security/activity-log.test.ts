// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPermissionActivity,
  getPermissionActivity,
  recordPermissionActivity,
  recordPermissionActivityStrict,
  subscribePermissionActivity,
  PermissionActivityStorageError,
} from "./activity-log";

describe("permission activity log", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    clearPermissionActivity();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps only an origin and redacts credential-like reason text", () => {
    recordPermissionActivity({
      conversationId: "conversation-a",
      tool: "mcp_demo_search",
      source: "mcp",
      mode: "chat",
      platform: "desktop",
      decision: "denied",
      target: "https://api.example.com/private?token=secret-value",
      reason: "Authorization: Bearer top-secret?key=also-secret",
      mcp: {
        serverId: "demo",
        serverName: "Demo Bearer server-secret",
        toolTitle: "Search?token=tool-secret",
      },
    });

    const [entry] = getPermissionActivity();
    expect(entry.target).toBe("https://api.example.com");
    expect(entry.reason).toContain("Bearer [REDACTED]");
    expect(JSON.stringify(entry)).not.toContain("top-secret");
    expect(JSON.stringify(entry)).not.toContain("also-secret");
    expect(JSON.stringify(entry)).not.toContain("server-secret");
    expect(JSON.stringify(entry)).not.toContain("tool-secret");
  });

  it("filters entries by conversation and excludes legacy unscoped records", () => {
    recordPermissionActivity({
      conversationId: "conversation-a",
      tool: "read_file",
      source: "builtin",
      mode: "chat",
      platform: "web",
      decision: "allowed",
    });
    recordPermissionActivity({
      conversationId: "conversation-b",
      tool: "write_file",
      source: "builtin",
      mode: "chat",
      platform: "web",
      decision: "requested",
    });
    recordPermissionActivity({
      tool: "legacy_tool",
      source: "unknown",
      mode: "chat",
      platform: "web",
      decision: "allowed",
    });

    expect(
      getPermissionActivity("conversation-a").map((entry) => entry.tool),
    ).toEqual(["read_file"]);
    expect(
      getPermissionActivity("conversation-b").map((entry) => entry.tool),
    ).toEqual(["write_file"]);
    expect(getPermissionActivity()).toHaveLength(3);
  });

  it("notifies same-window subscribers after persisted changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePermissionActivity(listener);

    recordPermissionActivity({
      conversationId: "conversation-a",
      tool: "read_file",
      source: "builtin",
      mode: "chat",
      platform: "web",
      decision: "allowed",
    });
    clearPermissionActivity();
    unsubscribe();
    recordPermissionActivity({
      conversationId: "conversation-a",
      tool: "list_files",
      source: "builtin",
      mode: "chat",
      platform: "web",
      decision: "allowed",
    });

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("bounds the local history", () => {
    for (let index = 0; index < 220; index += 1) {
      recordPermissionActivity({
        tool: `tool-${index}`,
        source: "builtin",
        mode: "chat",
        platform: "web",
        decision: "allowed",
      });
    }

    const entries = getPermissionActivity();
    expect(entries).toHaveLength(200);
    expect(entries[0].tool).toBe("tool-20");
    expect(entries.at(-1)?.tool).toBe("tool-219");
  });

  it("reads legacy entries and persists a redacted v2 Broker record", () => {
    values.set(
      "open-builder-permission-activity",
      JSON.stringify([
        {
          id: "legacy",
          at: 1,
          tool: "legacy_tool",
          source: "unknown",
          mode: "chat",
          platform: "web",
          decision: "allowed",
        },
      ]),
    );

    recordPermissionActivityStrict({
      version: 2,
      conversationId: "conversation-a",
      requestId: "request-1",
      sessionId: "session-1",
      hostRunId: "run-1",
      callId: "call-1",
      runtime: "local_cli",
      tool: "delete_file",
      source: "project",
      mode: "chat",
      platform: "desktop",
      decision: "requested",
      operation: "delete",
      scope: { kind: "exact", paths: ["src/token=secret.ts"] },
      affectedPaths: ["src/token=secret.ts"],
      affectedCount: 1,
      reason: "Bearer private-value",
    });

    const entries = getPermissionActivity();
    expect(entries[0]).toMatchObject({ id: "legacy" });
    expect("version" in entries[0]).toBe(false);
    expect(entries[1]).toMatchObject({
      version: 2,
      runtime: "local_cli",
      operation: "delete",
      affectedCount: 1,
    });
    expect(JSON.stringify(entries[1])).not.toContain("private-value");
  });

  it("fails closed through the strict API while legacy logging stays best-effort", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "[]",
      setItem: () => {
        throw new Error("disk full");
      },
      removeItem: vi.fn(),
    });
    const input = {
      version: 2 as const,
      conversationId: "conversation-a",
      tool: "delete_file",
      source: "project" as const,
      mode: "chat" as const,
      platform: "web" as const,
      decision: "execution_started" as const,
    };

    expect(() => recordPermissionActivityStrict(input)).toThrow(
      PermissionActivityStorageError,
    );
    expect(() => recordPermissionActivity(input)).not.toThrow();
  });

  it("retains the complete normalized scope beyond the old display cap", () => {
    const paths = Array.from(
      { length: 80 },
      (_, index) => `src/generated/file-${index}.ts`,
    );
    recordPermissionActivityStrict({
      version: 2,
      conversationId: "conversation-a",
      tool: "rename_file",
      source: "project",
      mode: "chat",
      platform: "web",
      decision: "execution_started",
      operation: "move",
      scope: { kind: "exact", paths },
      affectedPaths: paths,
      affectedCount: paths.length,
    });

    const [entry] = getPermissionActivity("conversation-a");
    expect(entry.scope).toEqual({ kind: "exact", paths });
    expect(entry.affectedPaths).toEqual(paths);
  });

  it("drops unknown runtime fields instead of treating types as a security boundary", () => {
    recordPermissionActivityStrict({
      version: 2,
      conversationId: "conversation-a",
      tool: "delete_file",
      source: "project",
      mode: "chat",
      platform: "web",
      decision: "requested",
      patch: "Bearer patch-secret",
      content: "private file content",
      envValue: "environment-secret",
      providerStderr: "provider-secret",
    } as Parameters<typeof recordPermissionActivityStrict>[0]);

    const serialized = JSON.stringify(getPermissionActivity());
    expect(serialized).not.toContain("patch-secret");
    expect(serialized).not.toContain("private file content");
    expect(serialized).not.toContain("environment-secret");
    expect(serialized).not.toContain("provider-secret");
  });
});
