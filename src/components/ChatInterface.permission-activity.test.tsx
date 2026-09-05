// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPermissionActivity,
  recordPermissionActivity,
} from "../lib/security/activity-log";
import { useConversationStore } from "../store/conversation";
import { useInteractiveStore } from "../store/interactive";
import { useProjectPermissionStore } from "../store/project-permission";
import { useSnapshotStore } from "../store/snapshot";
import type { Conversation } from "../types";
import type { ProjectPermissionRequest } from "../lib/security/project-permission-broker";
import { ChatInterface } from "./ChatInterface";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    getVirtualItems: () => [],
    measureElement: vi.fn(),
  }),
}));

vi.mock("./chat/ChatHeader", () => ({
  ChatHeader: (props: {
    onOpenPermissionActivity: () => void;
    permissionActivityCount: number;
  }) => (
    <button
      type="button"
      disabled={props.permissionActivityCount === 0}
      onClick={props.onOpenPermissionActivity}
    >
      Permission activity: {props.permissionActivityCount}
    </button>
  ),
}));
vi.mock("./chat/PermissionActivityDialog", () => ({
  PermissionActivityDialog: (props: {
    conversationId: string;
    onClose: () => void;
  }) => (
    <div role="dialog">
      Permission dialog for {props.conversationId}
      <button type="button" onClick={props.onClose}>
        Close
      </button>
    </div>
  ),
}));
vi.mock("./chat/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("./chat/ChatInput", () => ({
  ChatInput: (props: { onSlashCommand: (command: string) => void }) => (
    <button type="button" onClick={() => props.onSlashCommand("clear")}>
      Clear context
    </button>
  ),
}));

function conversation(id: string): Conversation {
  return {
    id,
    title: "New App",
    messages: [],
    files: {},
    template: "vite-react-ts",
    previewMode: "sandpack",
    isProjectInitialized: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

const baseProps = {
  messages: [],
  isGenerating: false,
  hasConfiguredModelRuntime: true,
  onGenerate: vi.fn(async () => undefined),
  onStop: vi.fn(),
  onOpenSettings: vi.fn(),
  onSetFiles: vi.fn(),
  onImportProject: vi.fn(() => ({ ok: true as const })),
  files: {},
  template: "vite-react-ts",
  previewMode: "sandpack" as const,
  sandpackKey: 0,
  onReloadPreview: vi.fn(),
  isProjectInitialized: false,
  showInlinePreview: false,
  onCompressContext: vi.fn(async () => undefined),
  onRetry: vi.fn(async () => undefined),
  onContinue: vi.fn(async () => undefined),
  onReview: vi.fn(async () => undefined),
  onHealthCheck: vi.fn(async () => undefined),
};

describe("ChatInterface permission activity", () => {
  beforeEach(() => {
    localStorage.clear();
    clearPermissionActivity();
    Element.prototype.scrollIntoView = vi.fn();
    useInteractiveStore.setState({ pending: [] });
    useProjectPermissionStore.setState({ pending: null, authorities: {} });
    useSnapshotStore.setState({ snapshots: {} });
    useConversationStore.setState({
      activeId: "conversation-a",
      conversations: {
        "conversation-a": conversation("conversation-a"),
        "conversation-b": conversation("conversation-b"),
      },
      _hasHydrated: true,
    });
  });

  it("updates the current-session count live and closes the dialog on switch", async () => {
    const user = userEvent.setup();
    render(<ChatInterface {...baseProps} />);

    const activityButton = screen.getByRole("button", {
      name: "Permission activity: 0",
    });
    expect(activityButton).toBeDisabled();

    act(() => {
      recordPermissionActivity({
        conversationId: "conversation-b",
        tool: "write_file",
        source: "builtin",
        mode: "chat",
        platform: "web",
        decision: "allowed",
      });
    });
    expect(activityButton).toBeDisabled();

    act(() => {
      recordPermissionActivity({
        conversationId: "conversation-a",
        tool: "read_file",
        source: "builtin",
        mode: "chat",
        platform: "web",
        decision: "allowed",
      });
    });
    const enabledButton = await screen.findByRole("button", {
      name: "Permission activity: 1",
    });
    await user.click(enabledButton);
    expect(
      await screen.findByText("Permission dialog for conversation-a"),
    ).toBeInTheDocument();

    act(() =>
      useConversationStore.getState().switchConversation("conversation-b"),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Permission dialog for conversation-a"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Permission activity: 1" }),
    ).toBeEnabled();
  });

  it("tears down runtime permission state before clearing context", async () => {
    const user = userEvent.setup();
    const onContextClear = vi.fn();
    render(<ChatInterface {...baseProps} onContextClear={onContextClear} />);

    await user.click(screen.getByRole("button", { name: "Clear context" }));

    await waitFor(() => expect(onContextClear).toHaveBeenCalledOnce());
  });

  it("makes the underlying chat inert while permission is pending", async () => {
    const request: ProjectPermissionRequest = {
      requestId: "request-1",
      sessionId: "session-1",
      conversationId: "conversation-a",
      runId: "run-1",
      callId: "call-1",
      tool: "delete_file",
      runtime: "api",
      operation: "delete",
      sessionEligible: true,
      scope: { kind: "exact", paths: ["src/old.ts"] },
      affectedPaths: ["src/old.ts"],
      affectedCount: 1,
      projectRevision: 0,
      authorityId: "authority-1",
      requirementDigest: "digest-1",
    };
    const decision = useProjectPermissionStore
      .getState()
      .requestDecision(request, new AbortController().signal);

    render(<ChatInterface {...baseProps} />);

    await screen.findByRole("dialog");
    expect(
      screen.getByText("Clear context").closest(".contents"),
    ).toHaveAttribute("inert");
    useProjectPermissionStore.getState().cancelPending("test cleanup");
    await expect(decision).rejects.toMatchObject({ name: "AbortError" });
  });
});
