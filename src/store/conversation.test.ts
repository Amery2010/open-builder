import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateConversationState, useConversationStore } from "./conversation";
import { useSnapshotStore } from "./snapshot";
import { PROJECT_FILE_LIMITS } from "../lib/utils/project-files";

const localforageMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  const removeItem = vi.fn(async (key: string) => {
    store.delete(key);
  });
  const adapter = {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem,
  };
  return {
    ...adapter,
    createInstance: () => adapter,
  };
});

vi.mock("localforage", () => ({
  default: localforageMock,
}));

describe("conversation store", () => {
  beforeEach(() => {
    localforageMock.removeItem.mockClear();
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: false,
    });
    useSnapshotStore.setState({ snapshots: {}, _hasHydrated: true });
  });

  it("rejects oversized project trees from setFiles", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = useConversationStore.getState().createConversation();

    useConversationStore.getState().setFiles({
      "src/large.ts": "x".repeat(PROJECT_FILE_LIMITS.maxFileBytes + 1),
    });

    expect(useConversationStore.getState().conversations[id].files).toEqual({});
    warn.mockRestore();
  });

  it("rejects oversized project trees when adding a conversation", () => {
    expect(() =>
      useConversationStore.getState().addConversation({
        id: "imported",
        title: "Imported",
        messages: [],
        files: {
          "src/large.ts": "x".repeat(PROJECT_FILE_LIMITS.maxFileBytes + 1),
        },
        template: "vite-react-ts",
        isProjectInitialized: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    ).toThrow(/too large/i);
  });

  it("writes compressed context to the requested conversation, not the active one", () => {
    const first = useConversationStore.getState().createConversation();
    const second = useConversationStore.getState().createConversation();

    useConversationStore.getState().setCompressedContextForConversation(first, {
      fromIndex: 1.8,
      summary: "summary",
    });

    const state = useConversationStore.getState();

    expect(state.activeId).toBe(second);
    expect(state.conversations[first].compressedContext).toMatchObject({
      fromIndex: 1,
      summary: "summary",
    });
    expect(state.conversations[second].compressedContext).toBeUndefined();
  });

  it("redacts credentials before persisting compressed context", () => {
    const sentinel = "persisted-summary-secret-sentinel";
    const id = useConversationStore.getState().createConversation();

    useConversationStore.getState().setCompressedContextForConversation(id, {
      fromIndex: 1,
      summary: `{"api_key":"${sentinel}"}`,
    });

    const summary =
      useConversationStore.getState().conversations[id].compressedContext
        ?.summary;
    expect(summary).not.toContain(sentinel);
    expect(summary).toContain("[REDACTED]");
  });

  it("clears conversation context without deleting project files or snapshots", () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore.getState().setDefaultPreviewView("mobile");
    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          messages: [{ role: "user", content: "Build it" }],
          files: { "src/App.tsx": "export default function App() {}" },
          activeFile: "src/App.tsx",
          template: "react-ts",
          isProjectInitialized: true,
          compressedContext: { summary: "Earlier work", fromIndex: 1 },
        },
      },
    }));
    useSnapshotStore.setState({
      snapshots: {
        [id]: [
          {
            id: "snapshot-1",
            conversationId: id,
            messageId: "assistant-1",
            patches: {},
            addedFiles: { "src/App.tsx": "export default function App() {}" },
            deletedFiles: [],
            createdAt: 1,
          },
        ],
      },
    });

    useConversationStore.getState().clearContext();

    const conversation = useConversationStore.getState().conversations[id];
    expect(conversation.messages).toEqual([]);
    expect(conversation.compressedContext).toBeUndefined();
    expect(conversation.files).toEqual({
      "src/App.tsx": "export default function App() {}",
    });
    expect(conversation.activeFile).toBe("src/App.tsx");
    expect(conversation.template).toBe("react-ts");
    expect(conversation.isProjectInitialized).toBe(true);
    expect(conversation.defaultPreviewView).toBe("mobile");
    expect(useSnapshotStore.getState().snapshots[id]).toHaveLength(1);
  });

  it("resets project state and deletes only the active conversation snapshots", () => {
    const first = useConversationStore.getState().createConversation();
    const second = useConversationStore.getState().createConversation();
    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [second]: {
          ...state.conversations[second],
          messages: [{ role: "user", content: "Build it" }],
          files: { "src/App.tsx": "old code" },
          activeFile: "src/App.tsx",
          template: "nextjs",
          isProjectInitialized: true,
          compressedContext: { summary: "Old context", fromIndex: 1 },
        },
      },
    }));
    useConversationStore.getState().setDefaultPreviewView("tablet");
    useSnapshotStore.setState({
      snapshots: {
        [first]: [],
        [second]: [
          {
            id: "snapshot-2",
            conversationId: second,
            messageId: "assistant-2",
            patches: {},
            addedFiles: { "src/App.tsx": "old code" },
            deletedFiles: [],
            createdAt: 2,
          },
        ],
      },
    });

    useConversationStore.getState().resetProject();

    const conversation = useConversationStore.getState().conversations[second];
    expect(conversation).toMatchObject({
      messages: [],
      files: {},
      template: "vite-react-ts",
      defaultPreviewView: "desktop",
      isProjectInitialized: false,
    });
    expect(conversation.compressedContext).toBeUndefined();
    expect(conversation.activeFile).toBeUndefined();
    expect(useSnapshotStore.getState().snapshots[second]).toBeUndefined();
    expect(useSnapshotStore.getState().snapshots[first]).toEqual([]);
  });

  it("atomically replaces a project while preserving chat and clearing derived state", () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          messages: [{ role: "user", content: "Import the project" }],
          files: { "src/old.ts": "old" },
          localAgentSessions: {
            codex: {
              provider: "codex",
              sessionId: "thread-1",
              transcriptFingerprint: "fingerprint",
              cliVersion: "1.0.0",
              updatedAt: 1,
            },
          },
        },
      },
    }));
    useSnapshotStore.setState({
      snapshots: {
        [id]: [
          {
            id: "snapshot-old",
            conversationId: id,
            messageId: "assistant-old",
            patches: {},
            addedFiles: { "src/old.ts": "old" },
            deletedFiles: [],
            createdAt: 1,
          },
        ],
      },
    });

    const result = useConversationStore.getState().replaceProject({
      files: { "README.md": "imported" },
      template: "static",
      previewMode: "code-only",
      activeFile: "README.md",
    });

    expect(result).toEqual({ ok: true });
    expect(useConversationStore.getState().conversations[id]).toMatchObject({
      messages: [{ role: "user", content: "Import the project" }],
      files: { "README.md": "imported" },
      template: "static",
      previewMode: "code-only",
      defaultPreviewView: "desktop",
      activeFile: "README.md",
      isProjectInitialized: true,
    });
    expect(
      useConversationStore.getState().conversations[id].localAgentSessions,
    ).toBeUndefined();
    expect(useSnapshotStore.getState().snapshots[id]).toBeUndefined();
  });

  it("can persist a delayed edit to a conversation that is no longer active", () => {
    const first = useConversationStore.getState().createConversation();
    const second = useConversationStore.getState().createConversation();

    useConversationStore
      .getState()
      .setFilesForConversation(first, { "src/App.tsx": "saved edit" });

    const state = useConversationStore.getState();
    expect(state.activeId).toBe(second);
    expect(state.conversations[first].files).toEqual({
      "src/App.tsx": "saved edit",
    });
    expect(state.conversations[first].isProjectInitialized).toBe(true);
    expect(state.conversations[first].activeFile).toBe("src/App.tsx");
    expect(state.conversations[second].files).toEqual({});
  });

  it("withdraws only the final genuine user message and returns it for draft restoration", () => {
    const id = useConversationStore.getState().createConversation();
    const finalMessage = {
      role: "user" as const,
      content: "Build the app",
      forcedSkillIds: ["ui-review"],
    };
    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          messages: [
            { role: "assistant" as const, content: "Ready" },
            finalMessage,
          ],
        },
      },
    }));

    expect(useConversationStore.getState().withdrawLastUserMessage(id)).toBe(
      finalMessage,
    );
    expect(useConversationStore.getState().conversations[id].messages).toEqual([
      { role: "assistant", content: "Ready" },
    ]);
  });

  it("withdraws the final visible user message together with hidden trailing records", () => {
    const id = useConversationStore.getState().createConversation();
    const finalMessage = { role: "user" as const, content: "Build the app" };
    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          messages: [
            { role: "assistant" as const, content: "Ready" },
            finalMessage,
            {
              role: "assistant" as const,
              content: null,
              tool_calls: [
                {
                  id: "memory-call",
                  type: "function" as const,
                  function: { name: "manage_memories", arguments: "{}" },
                },
              ],
            },
            {
              role: "tool" as const,
              tool_call_id: "memory-call",
              content: "OK",
            },
          ],
        },
      },
    }));

    expect(useConversationStore.getState().withdrawLastUserMessage(id)).toBe(
      finalMessage,
    );
    expect(useConversationStore.getState().conversations[id].messages).toEqual([
      { role: "assistant", content: "Ready" },
    ]);
  });

  it("does not withdraw an internal activity or a user with visible follow-up", () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          messages: [
            {
              role: "user" as const,
              content: "First",
              metadata: { origin: "auto_qa" as const },
            },
            { role: "assistant" as const, content: "Answer" },
          ],
        },
      },
    }));

    expect(
      useConversationStore.getState().withdrawLastUserMessage(id),
    ).toBeUndefined();
    expect(
      useConversationStore.getState().conversations[id].messages,
    ).toHaveLength(2);

    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          messages: [
            { role: "assistant" as const, content: "Answer" },
            {
              role: "user" as const,
              content: "Internal",
              metadata: { origin: "auto_qa" as const },
            },
          ],
        },
      },
    }));
    expect(
      useConversationStore.getState().withdrawLastUserMessage(id),
    ).toBeUndefined();

    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          messages: [
            { role: "user" as const, content: "Build the app" },
            { role: "assistant" as const, content: "Visible response" },
          ],
        },
      },
    }));
    expect(
      useConversationStore.getState().withdrawLastUserMessage(id),
    ).toBeUndefined();
  });

  it("derives project initialization atomically from the file tree", () => {
    const id = useConversationStore.getState().createConversation();

    useConversationStore.getState().setFiles({ "index.html": "<main />" });
    expect(useConversationStore.getState().conversations[id]).toMatchObject({
      activeFile: "index.html",
      isProjectInitialized: true,
    });

    useConversationStore.getState().setFiles({});
    expect(useConversationStore.getState().conversations[id]).toMatchObject({
      activeFile: undefined,
      isProjectInitialized: false,
    });
  });

  it("normalizes imported and forked project state", () => {
    const imported = useConversationStore.getState().addConversation({
      id: "imported",
      title: "Imported",
      messages: [],
      files: { "src/App.tsx": "app" },
      activeFile: "missing.ts",
      template: "vite-react-ts",
      isProjectInitialized: false,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(
      useConversationStore.getState().conversations[imported],
    ).toMatchObject({
      activeFile: "src/App.tsx",
      isProjectInitialized: true,
    });

    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [imported]: {
          ...state.conversations[imported],
          isProjectInitialized: false,
        },
      },
    }));
    const fork = useConversationStore.getState().forkConversation();
    expect(useConversationStore.getState().conversations[fork]).toMatchObject({
      activeFile: "src/App.tsx",
      isProjectInitialized: true,
    });
  });

  it("persists default preview view, treats same-value updates as no-ops, and forks it", () => {
    const original = useConversationStore.getState().createConversation();
    const initialUpdatedAt =
      useConversationStore.getState().conversations[original].updatedAt;

    useConversationStore.getState().setDefaultPreviewView("tablet");
    const updated = useConversationStore.getState().conversations[original];
    expect(updated.defaultPreviewView).toBe("tablet");
    const afterUpdate = updated.updatedAt;

    useConversationStore.getState().setDefaultPreviewView("tablet");
    expect(
      useConversationStore.getState().conversations[original].updatedAt,
    ).toBe(afterUpdate);
    expect(afterUpdate).toBeGreaterThanOrEqual(initialUpdatedAt);

    const fork = useConversationStore.getState().forkConversation();
    expect(
      useConversationStore.getState().conversations[fork].defaultPreviewView,
    ).toBe("tablet");
  });

  it("keeps workspace mode per conversation and returns approved plans to Design", () => {
    const designConversation = useConversationStore
      .getState()
      .createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore.getState().setWorkspaceMode("plan");

    expect(
      useConversationStore.getState().conversations[designConversation],
    ).toMatchObject({ workspaceMode: "plan", planReturnMode: "design" });

    expect(
      useConversationStore.getState().returnFromPlan(designConversation),
    ).toBe("design");
    expect(
      useConversationStore.getState().conversations[designConversation],
    ).toMatchObject({ workspaceMode: "design" });
    expect(
      useConversationStore.getState().conversations[designConversation]
        .planReturnMode,
    ).toBeUndefined();

    const autoConversation = useConversationStore
      .getState()
      .createConversation();
    expect(
      useConversationStore.getState().conversations[autoConversation]
        .workspaceMode,
    ).toBe("auto");
    expect(
      useConversationStore.getState().conversations[designConversation]
        .workspaceMode,
    ).toBe("design");
  });

  it("migrates the old global Plan flag once into the active conversation", () => {
    const id = useConversationStore.getState().createConversation();

    expect(useConversationStore.getState().migrateLegacyPlanMode(true)).toBe(
      true,
    );
    expect(useConversationStore.getState().conversations[id]).toMatchObject({
      workspaceMode: "plan",
      planReturnMode: "auto",
    });
    expect(useConversationStore.getState().migrateLegacyPlanMode(false)).toBe(
      false,
    );
    expect(
      useConversationStore.getState().conversations[id].workspaceMode,
    ).toBe("plan");
  });

  it("upgrades root-level legacy DESIGN.md as a read-only reference", () => {
    const persisted = {
      activeId: "legacy",
      conversations: {
        legacy: {
          id: "legacy",
          title: "Legacy",
          messages: [],
          files: { "DESIGN.md": "# Existing visual direction" },
          template: "static",
          isProjectInitialized: true,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    };

    const migrated = migrateConversationState(persisted, 3);
    expect(migrated.conversations.legacy).toMatchObject({
      workspaceMode: "auto",
      designState: {
        appliedSystem: { id: "legacy-design-md", source: "legacy" },
      },
    });
  });

  it("normalizes missing and invalid persisted preview preferences to desktop", () => {
    const persisted = {
      activeId: "invalid-preview",
      conversations: {
        "missing-preview": {
          id: "missing-preview",
          title: "Missing",
          messages: [],
          files: {},
          template: "vite-react-ts",
          isProjectInitialized: false,
          createdAt: 1,
          updatedAt: 1,
        },
        "invalid-preview": {
          id: "invalid-preview",
          title: "Invalid",
          messages: [],
          files: {},
          template: "vite-react-ts",
          defaultPreviewView: "phone",
          isProjectInitialized: false,
          createdAt: 2,
          updatedAt: 2,
        },
      },
    };

    const migrated = migrateConversationState(persisted, 4);
    expect(migrated.conversations["missing-preview"]).toMatchObject({
      defaultPreviewView: "desktop",
    });
    expect(migrated.conversations["invalid-preview"]).toMatchObject({
      defaultPreviewView: "desktop",
    });
  });

  it("repairs stale v1 project flags without changing other persisted fields", () => {
    const persisted = {
      activeId: "with-files",
      untouched: "value",
      conversations: {
        "with-files": {
          id: "with-files",
          title: "With files",
          messages: [],
          files: { "src/App.tsx": "app" },
          activeFile: "missing.ts",
          template: "vite-react-ts",
          isProjectInitialized: false,
          createdAt: 1,
          updatedAt: 2,
        },
        empty: {
          id: "empty",
          title: "Empty",
          messages: [],
          files: {},
          activeFile: "missing.ts",
          template: "vite-react-ts",
          isProjectInitialized: true,
          createdAt: 3,
          updatedAt: 4,
        },
      },
    };

    const migrated = migrateConversationState(persisted, 1);

    expect(migrated.activeId).toBe("with-files");
    expect(migrated.untouched).toBe("value");
    expect(migrated.conversations["with-files"]).toMatchObject({
      activeFile: "src/App.tsx",
      previewMode: "sandpack",
      isProjectInitialized: true,
      updatedAt: 2,
    });
    expect(migrated.conversations.empty).toMatchObject({
      activeFile: undefined,
      previewMode: "sandpack",
      isProjectInitialized: false,
      updatedAt: 4,
    });
  });

  it("persists an active file and falls back when that file is removed", () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({
      "src/App.tsx": "app",
      "src/main.tsx": "main",
    });
    useConversationStore.getState().setActiveFile("src/main.tsx");
    expect(useConversationStore.getState().conversations[id].activeFile).toBe(
      "src/main.tsx",
    );

    useConversationStore.getState().setFiles({ "src/App.tsx": "app" });
    expect(useConversationStore.getState().conversations[id].activeFile).toBe(
      "src/App.tsx",
    );
  });

  it("preserves shared attachment blobs until the final fork is deleted", async () => {
    const original = useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({ "src/App.tsx": "app" });
    useConversationStore.getState().setActiveFile("src/App.tsx");
    useConversationStore.getState().setMessages([
      {
        role: "user",
        content: "Review",
        metadata: {
          attachments: [
            {
              id: "shared-pdf",
              type: "file",
              name: "spec.pdf",
              mimeType: "application/pdf",
              size: 10,
            },
          ],
        },
      },
    ]);
    const fork = useConversationStore.getState().forkConversation();

    expect(useConversationStore.getState().conversations[fork].activeFile).toBe(
      "src/App.tsx",
    );
    useConversationStore.getState().deleteConversation(fork);
    await Promise.resolve();
    expect(localforageMock.removeItem).not.toHaveBeenCalledWith("shared-pdf");

    useConversationStore.getState().deleteConversation(original);
    await Promise.resolve();
    expect(localforageMock.removeItem).toHaveBeenCalledWith("shared-pdf");
  });

  it("forks project asset references and releases the Blob after the final owner", async () => {
    const original = useConversationStore.getState().createConversation();
    const asset = {
      path: "public/generated/hero.png",
      blobRef: `sha256:${"b".repeat(64)}`,
      mimeType: "image/png" as const,
      size: 9,
      digest: "b".repeat(64),
      modulePath: "src/generated-assets/hero-bbbbbbbb.js",
      publicPath: "/generated/hero.png",
    };
    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [original]: {
          ...state.conversations[original],
          assets: { [asset.path]: asset },
        },
      },
    }));
    const fork = useConversationStore.getState().forkConversation();

    useConversationStore.getState().deleteConversation(fork);
    await vi.waitFor(() => {
      expect(localforageMock.removeItem).not.toHaveBeenCalledWith(
        asset.blobRef,
      );
    });
    useConversationStore.getState().deleteConversation(original);
    await vi.waitFor(() => {
      expect(localforageMock.removeItem).toHaveBeenCalledWith(asset.blobRef);
    });
  });

  it("keeps provider sessions independent and excludes them from forks", () => {
    const original = useConversationStore.getState().createConversation();
    const session = {
      provider: "codex" as const,
      sessionId: "thread-1",
      transcriptFingerprint: "fingerprint-1",
      cliVersion: "1.0.0",
      model: "codex-model",
      updatedAt: 1,
    };
    useConversationStore
      .getState()
      .setLocalAgentSessionForConversation(original, "codex", session);
    useConversationStore
      .getState()
      .setLocalAgentSessionForConversation(original, "claude", {
        ...session,
        provider: "claude",
        sessionId: "session-2",
      });
    useConversationStore
      .getState()
      .setLocalAgentSessionForConversation(original, "pi", {
        ...session,
        provider: "pi",
        sessionId: "session-3",
      });
    useConversationStore
      .getState()
      .setLocalAgentSessionForConversation(original, "antigravity", {
        ...session,
        provider: "antigravity",
        sessionId: "conversation-4",
      });

    expect(
      useConversationStore.getState().conversations[original]
        .localAgentSessions,
    ).toMatchObject({
      codex: { sessionId: "thread-1" },
      claude: { sessionId: "session-2" },
      pi: { sessionId: "session-3" },
      antigravity: { sessionId: "conversation-4" },
    });

    const fork = useConversationStore.getState().forkConversation();
    expect(
      useConversationStore.getState().conversations[fork].localAgentSessions,
    ).toBeUndefined();
  });

  it("invalidates external sessions when context or project authority changes", () => {
    const id = useConversationStore.getState().createConversation();
    const session = {
      provider: "codex" as const,
      sessionId: "thread-1",
      transcriptFingerprint: "fingerprint-1",
      cliVersion: "1.0.0",
      updatedAt: 1,
    };
    const installSession = () =>
      useConversationStore
        .getState()
        .setLocalAgentSessionForConversation(id, "codex", session);

    installSession();
    useConversationStore.getState().clearContext();
    expect(
      useConversationStore.getState().conversations[id].localAgentSessions,
    ).toBeUndefined();

    installSession();
    useConversationStore.getState().setCompressedContextForConversation(id, {
      summary: "new authority",
      fromIndex: 1,
    });
    expect(
      useConversationStore.getState().conversations[id].localAgentSessions,
    ).toBeUndefined();

    installSession();
    useConversationStore.getState().resetProject();
    expect(
      useConversationStore.getState().conversations[id].localAgentSessions,
    ).toBeUndefined();
  });

  it("writes asynchronous design decisions to their originating conversation", () => {
    const first = useConversationStore.getState().createConversation();
    const second = useConversationStore.getState().createConversation();
    expect(useConversationStore.getState().activeId).toBe(second);

    useConversationStore.getState().setDesignStateForConversation(first, {
      recommendation: {
        systemId: null,
        reason: "No system is needed.",
        createdAt: 1,
      },
    });

    expect(
      useConversationStore.getState().conversations[first].designState
        ?.recommendation?.systemId,
    ).toBeNull();
    expect(
      useConversationStore.getState().conversations[second].designState,
    ).toBeUndefined();
  });

  it("updates an originating conversation's messages after the user switches away", () => {
    const origin = useConversationStore.getState().createConversation();
    const active = useConversationStore.getState().createConversation();

    useConversationStore
      .getState()
      .setMessagesForConversation(origin, (messages) => [
        ...messages,
        { role: "tool", tool_call_id: "video", content: "completed" },
      ]);

    expect(useConversationStore.getState().activeId).toBe(active);
    expect(
      useConversationStore.getState().conversations[origin].messages,
    ).toEqual([{ role: "tool", tool_call_id: "video", content: "completed" }]);
    expect(
      useConversationStore.getState().conversations[active].messages,
    ).toEqual([]);
  });
});
