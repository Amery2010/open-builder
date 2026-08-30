import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../../types";
import type { ToolExecutionOutput } from "../../ai/generator-types";
import { useConversationStore } from "../../../store/conversation";
import { AGNES_TOOL_ALIASES } from "./aliases";
import {
  AgnesVideoTaskManager,
  AGNES_VIDEO_POLLING,
} from "./video-task-manager";
import { AGNES_MCP_SERVER_ID, AGNES_MCP_SERVER_NAME } from "./types";

vi.mock("localforage", () => {
  const records = new Map<string, string>();
  const adapter = {
    getItem: async (key: string) => records.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      records.set(key, value);
    },
    removeItem: async (key: string) => {
      records.delete(key);
    },
  };
  return { default: { ...adapter, createInstance: () => adapter } };
});

function output(
  status: "queued" | "in_progress" | "completed" | "failed",
  extra: Record<string, unknown> = {},
): ToolExecutionOutput {
  return {
    text: JSON.stringify({ status, video_id: "video_1" }),
    isError: status === "failed",
    structuredContent: {
      kind: "agnes_media_v1",
      operation: "create_video",
      mediaType: "video",
      status,
      videoId: "video_1",
      progress: status === "completed" ? 100 : 0,
      size: "720P",
      seconds: "5",
      ratio: "16:9",
      ...extra,
    },
    source: {
      kind: "mcp",
      serverId: AGNES_MCP_SERVER_ID,
      serverName: AGNES_MCP_SERVER_NAME,
      toolName: "create_video",
      toolTitle: "Create video",
      alias: AGNES_TOOL_ALIASES.create_video,
    },
  };
}

function conversation(
  id: string,
  toolOutput?: ToolExecutionOutput,
): Conversation {
  return {
    id,
    title: id,
    messages: toolOutput
      ? [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-video",
                type: "function",
                function: {
                  name: AGNES_TOOL_ALIASES.create_video,
                  arguments: '{"prompt":"A field"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call-video",
            content: toolOutput.text,
            toolOutput,
          },
        ]
      : [],
    files: {},
    template: "vite-react-ts",
    previewMode: "sandpack",
    isProjectInitialized: false,
    workspaceMode: "auto",
    createdAt: 1,
    updatedAt: 1,
  };
}

function currentContent() {
  const message = useConversationStore
    .getState()
    .conversations.origin.messages.find(
      (candidate) => candidate.role === "tool",
    );
  return message?.toolOutput?.structuredContent as Record<string, unknown>;
}

describe("Agnes video placeholder polling", () => {
  let manager: AgnesVideoTaskManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    useConversationStore.setState({
      conversations: {
        origin: conversation("origin", output("queued")),
        other: conversation("other"),
      },
      activeId: "origin",
      _hasHydrated: true,
    });
    manager = new AgnesVideoTaskManager();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it("polls on the documented cadence and replaces the original result", async () => {
    const poll = vi.fn(async () =>
      output("completed", {
        urls: ["https://cdn.example.com/video.mp4"],
      }),
    );
    manager.register({
      conversationId: "origin",
      toolCallId: "call-video",
      videoId: "video_1",
      initialOutput: output("queued"),
      poll,
    });

    await vi.advanceTimersByTimeAsync(AGNES_VIDEO_POLLING.delayForElapsed(0));
    expect(poll).toHaveBeenCalledTimes(1);
    expect(currentContent()).toMatchObject({
      operation: "create_video",
      status: "completed",
      urls: ["https://cdn.example.com/video.mp4"],
    });
    expect(
      useConversationStore.getState().conversations.origin.messages,
    ).toHaveLength(2);
  });

  it("pauses off-screen, resumes immediately, and stops without a final poll at ten minutes", async () => {
    const poll = vi.fn(async () => output("in_progress"));
    manager.register({
      conversationId: "origin",
      toolCallId: "call-video",
      videoId: "video_1",
      initialOutput: output("queued"),
      poll,
    });

    useConversationStore.getState().switchConversation("other");
    expect(currentContent()).toMatchObject({ pollingState: "paused" });
    await vi.advanceTimersByTimeAsync(AGNES_VIDEO_POLLING.limitMs);
    expect(poll).not.toHaveBeenCalled();

    useConversationStore.getState().switchConversation("origin");
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).not.toHaveBeenCalled();
    expect(currentContent()).toMatchObject({ pollingState: "timed_out" });
  });

  it("preserves the last remote status when an automatic query fails", async () => {
    const poll = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    manager.register({
      conversationId: "origin",
      toolCallId: "call-video",
      videoId: "video_1",
      initialOutput: output("queued"),
      poll,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(currentContent()).toMatchObject({
      status: "queued",
      pollingState: "error",
      error: "Automatic status query failed.",
    });
    const toolMessage = useConversationStore
      .getState()
      .conversations.origin.messages.find(
        (candidate) => candidate.role === "tool",
      );
    expect(toolMessage?.toolOutput?.isError).toBe(false);
  });

  it("drops a paused task when its originating conversation is deleted", () => {
    manager.register({
      conversationId: "origin",
      toolCallId: "call-video",
      videoId: "video_1",
      initialOutput: output("queued"),
      poll: vi.fn(async () => output("in_progress")),
    });
    useConversationStore.getState().switchConversation("other");
    useConversationStore.getState().deleteConversation("origin");

    expect(
      manager.applyManualResult("origin", "video_1", output("completed")),
    ).toBeUndefined();
  });

  it("marks the placeholder stopped when runtime permission is revoked", () => {
    manager.register({
      conversationId: "origin",
      toolCallId: "call-video",
      videoId: "video_1",
      initialOutput: output("queued"),
      poll: vi.fn(async () => output("in_progress")),
    });

    manager.stopAll();
    expect(currentContent()).toMatchObject({ pollingState: "stopped" });
  });
});
