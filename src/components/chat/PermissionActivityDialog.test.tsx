// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { useMcpStore } from "../../store/mcp";
import { createMcpToolAlias } from "../../lib/mcp/alias";
import { createMcpServerEntry } from "../../lib/mcp/validation";
import {
  clearPermissionActivity,
  recordPermissionActivity,
} from "../../lib/security/activity-log";
import type {
  ProjectPermissionAuthoritySnapshot,
  ProjectPermissionSession,
} from "../../lib/security/project-permission-broker";
import {
  publishProjectPermissionAuthority,
  registerProjectPermissionSession,
  useProjectPermissionStore,
} from "../../store/project-permission";
import { PermissionActivityDialog } from "./PermissionActivityDialog";

describe("PermissionActivityDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    clearPermissionActivity();
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useMcpStore.setState({
      servers: {},
      runtime: {},
      globalEnabled: true,
      _hasHydrated: true,
    });
    useProjectPermissionStore.setState({ pending: null, authorities: {} });
  });

  it("shows only the current conversation with localized tool names", () => {
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
      platform: "desktop",
      decision: "denied",
    });
    recordPermissionActivity({
      tool: "legacy_tool",
      source: "unknown",
      mode: "chat",
      platform: "web",
      decision: "allowed",
    });

    render(
      <PermissionActivityDialog
        open
        conversationId="conversation-a"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Read File")).toBeInTheDocument();
    expect(screen.queryByText("Write File")).not.toBeInTheDocument();
    expect(screen.queryByText("Unknown Tool")).not.toBeInTheDocument();
    expect(screen.getByText("Allowed")).toBeInTheDocument();
    expect(screen.getByText("Built-in tool")).toBeInTheDocument();
  });

  it("updates in the same window and keeps MCP identifiers in details", async () => {
    const user = userEvent.setup();
    render(
      <PermissionActivityDialog
        open
        conversationId="conversation-a"
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText("No permission activity in this conversation."),
    ).toBeInTheDocument();

    act(() => {
      recordPermissionActivity({
        conversationId: "conversation-a",
        tool: "mcp_demo_search_abc123",
        source: "mcp",
        mode: "plan",
        platform: "desktop",
        decision: "requested",
        mcp: {
          serverId: "demo",
          serverName: "Demo server",
          toolTitle: "Search records",
        },
      });
    });

    expect(
      await screen.findByText("Demo server / Search records"),
    ).toBeInTheDocument();
    const identifier = screen.getByText("mcp_demo_search_abc123");
    const details = identifier.closest("details");
    expect(details).not.toHaveAttribute("open");

    await user.click(screen.getByText("Technical details"));
    expect(details).toHaveAttribute("open");
  });

  it("resolves persisted MCP aliases and falls back to the raw tool name", () => {
    const base = createMcpServerEntry(
      {
        name: "Demo catalog",
        enabled: true,
        transport: "streamable-http",
        url: "https://mcp.example.test/rpc",
      },
      { id: "demo", now: 1 },
    );
    useMcpStore.setState({
      servers: {
        [base.id]: {
          ...base,
          tools: {
            search: {
              name: "search",
              title: "Search records",
              inputSchema: { type: "object" },
              fingerprint: "approved-search",
              enabled: true,
              allowInPlanMode: false,
              allowForSubagents: false,
            },
          },
        },
      },
    });
    recordPermissionActivity({
      conversationId: "conversation-a",
      tool: createMcpToolAlias(base.id, "search"),
      source: "mcp",
      mode: "chat",
      platform: "web",
      decision: "denied",
    });
    recordPermissionActivity({
      conversationId: "conversation-a",
      tool: "inspect",
      source: "mcp",
      mode: "chat",
      platform: "web",
      decision: "allowed",
      mcp: { serverId: "other", serverName: "Other server" },
    });

    render(
      <PermissionActivityDialog
        open
        conversationId="conversation-a"
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Demo catalog / Search records"),
    ).toBeInTheDocument();
    expect(screen.getByText("Other server / inspect")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PermissionActivityDialog
        open
        conversationId="conversation-a"
        onClose={onClose}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("revokes an active session grant and rotates Host authority", async () => {
    const user = userEvent.setup();
    let authority: ProjectPermissionAuthoritySnapshot = {
      id: "authority-1",
      digest: "digest-1",
      revision: 1,
      sessionId: "session-1",
      conversationId: "conversation-a",
      policyVersion: "test",
      projectRevision: 0,
      bypassEnabled: false,
      closed: false,
      grants: [
        {
          id: "grant-1",
          operation: "delete",
          scope: { kind: "subtree", path: "src/legacy" },
        },
      ],
    };
    const session = {
      authority: () => authority,
      change: vi.fn((change: { type: string; grantId?: string }) => {
        if (change.type === "revoke_grant" && change.grantId === "grant-1") {
          authority = {
            ...authority,
            id: "authority-2",
            digest: "digest-2",
            revision: 2,
            grants: [],
          };
        }
      }),
      authorize: vi.fn(),
      settle: vi.fn(),
    } as unknown as ProjectPermissionSession;
    const rotateHostAuthority = vi.fn();
    registerProjectPermissionSession(
      "conversation-a",
      session,
      rotateHostAuthority,
    );
    render(
      <PermissionActivityDialog
        open
        conversationId="conversation-a"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/src\/legacy/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke" }));

    expect(rotateHostAuthority).toHaveBeenCalledOnce();
    expect(
      await screen.findByText("There are no active session grants."),
    ).toBeInTheDocument();
    authority = { ...authority, closed: true };
    publishProjectPermissionAuthority("conversation-a", session);
  });
});
