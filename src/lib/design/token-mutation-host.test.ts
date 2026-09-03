import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { useDesignReviewStore } from "../../store/design-review";
import { useSnapshotStore } from "../../store/snapshot";
import { mutateConversationDesignTokens } from "./token-mutation-host";

const localforageMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  const adapter = {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
  };
  return { ...adapter, createInstance: () => adapter };
});

vi.mock("localforage", () => ({ default: localforageMock }));

const digest = "a".repeat(64);
const tokens = `/* package sha256 ${digest} */
:root {
  --bg: #ffffff;
  --surface: #f8f8f8;
  --fg: #111111;
  --muted: #666666;
  --border: #dddddd;
  --accent: #6541f5;
  --accent-on: #ffffff;
  --success: #188038;
  --warn: #9a6700;
  --danger: #d1242f;
  --font-display: "Inter", system-ui;
  --font-body: system-ui;
  --radius-md: 8px;
  --section-y-desktop: 96px;
  --container-max: 1200px;
  --motion-base: 180ms;
}`;

function seedConversation(): string {
  return useConversationStore.getState().addConversation({
    id: "token-conversation",
    title: "Token project",
    messages: [],
    files: { "tokens.css": tokens, "src/App.tsx": "export default 1" },
    template: "vite-react-ts",
    previewMode: "sandpack",
    isProjectInitialized: true,
    workspaceMode: "design",
    designState: {
      selectedSystem: {
        id: "stripe",
        name: "Stripe",
        source: "builtin",
        version: "2",
        digest,
      },
      appliedSystem: {
        id: "stripe",
        name: "Stripe",
        source: "builtin",
        version: "2",
        digest,
      },
    },
    createdAt: 1,
    updatedAt: 1,
  });
}

beforeEach(() => {
  useConversationStore.setState({ conversations: {}, activeId: null });
  useSnapshotStore.setState({ snapshots: {}, _hasHydrated: true });
  useDesignReviewStore.getState().reset();
  useDesignReviewStore.setState({
    runsByConversation: {},
    selectedRunIdByConversation: {},
  });
});

describe("store-backed Design Token Mutation", () => {
  it("commits once and creates a restorable snapshot", async () => {
    const conversationId = seedConversation();
    const result = await mutateConversationDesignTokens({
      conversationId,
      principal: "user",
      changes: [{ token: "--accent", value: "#112233" }],
      snapshotLabel: "Token edit",
    });

    expect(result).toMatchObject({ ok: true, status: "updated" });
    expect(
      useConversationStore.getState().conversations[conversationId].files[
        "tokens.css"
      ],
    ).toContain("--accent: #112233;");
    expect(
      useSnapshotStore.getState().getSnapshots(conversationId),
    ).toHaveLength(1);
  });

  it("does not write when snapshot storage is not ready", async () => {
    const conversationId = seedConversation();
    useSnapshotStore.setState({ _hasHydrated: false });
    const result = await mutateConversationDesignTokens({
      conversationId,
      principal: "user",
      changes: [{ token: "--accent", value: "#112233" }],
    });

    expect(result).toMatchObject({
      ok: false,
      code: "snapshot_prepare_failed",
    });
    expect(
      useConversationStore.getState().conversations[conversationId].files[
        "tokens.css"
      ],
    ).toBe(tokens);
  });

  it("rejects a same-timestamp Conversation replacement before commit", async () => {
    const conversationId = seedConversation();
    const mutation = mutateConversationDesignTokens({
      conversationId,
      principal: "user",
      changes: [{ token: "--accent", value: "#112233" }],
    });
    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...state.conversations[conversationId],
          title: "Concurrent edit",
          // Deliberately preserve updatedAt to prove the CAS does not rely on
          // millisecond timestamp uniqueness.
          updatedAt: state.conversations[conversationId].updatedAt,
        },
      },
    }));

    await expect(mutation).resolves.toMatchObject({
      ok: false,
      code: "project_commit_failed",
    });
    expect(
      useConversationStore.getState().conversations[conversationId].files[
        "tokens.css"
      ],
    ).toBe(tokens);
    expect(useSnapshotStore.getState().getSnapshots(conversationId)).toEqual(
      [],
    );
  });
});
