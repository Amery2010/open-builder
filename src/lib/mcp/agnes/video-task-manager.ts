import type { Message, ToolExecutionOutput } from "../../ai/generator-types";
import { normalizeToolExecutionOutput } from "../../utils/tool-result";
import { sanitizeToolExecutionOutputForHistory } from "../../utils/message-security";
import { useConversationStore } from "../../../store/conversation";
import { AGNES_TOOL_ALIASES } from "./aliases";
import {
  AGNES_MCP_SERVER_ID,
  AGNES_MCP_SERVER_NAME,
  isAgnesMediaToolContent,
  type AgnesMediaToolContent,
} from "./types";
import { AGNES_POLLING_SESSION_ID } from "./session";

const POLLING_LIMIT_MS = 10 * 60 * 1_000;

interface AgnesVideoPollingTask {
  key: string;
  conversationId: string;
  toolCallId: string;
  videoId: string;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  lastOutput: ToolExecutionOutput;
  poll: (signal: AbortSignal) => Promise<ToolExecutionOutput>;
}

function mediaContent(
  output: ToolExecutionOutput,
): AgnesMediaToolContent | undefined {
  return isAgnesMediaToolContent(output.structuredContent)
    ? output.structuredContent
    : undefined;
}

function replaceToolOutput(
  messages: Message[],
  toolCallId: string,
  output: ToolExecutionOutput,
): Message[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "tool" || message.tool_call_id !== toolCallId) {
      return message;
    }
    changed = true;
    return {
      ...message,
      content: output.text,
      toolOutput: normalizeToolExecutionOutput(output),
    } satisfies Message;
  });
  return changed ? next : messages;
}

export function updateAgnesToolOutput(
  conversationId: string,
  toolCallId: string,
  output: ToolExecutionOutput,
): void {
  const normalized = normalizeToolExecutionOutput(output);
  const safeOutput =
    sanitizeToolExecutionOutputForHistory(
      normalized.source?.alias ?? AGNES_TOOL_ALIASES.create_video,
      {},
      normalized,
    ) ?? normalized;
  useConversationStore
    .getState()
    .setMessagesForConversation(conversationId, (messages) =>
      replaceToolOutput(messages, toolCallId, safeOutput),
    );
}

export function findAgnesVideoOriginToolCall(
  conversationId: string,
  videoId: string,
): string | undefined {
  const conversation =
    useConversationStore.getState().conversations[conversationId];
  for (const message of conversation?.messages ?? []) {
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const content = message.toolOutput
      ? mediaContent(message.toolOutput)
      : undefined;
    if (content?.operation === "create_video" && content.videoId === videoId) {
      return message.tool_call_id;
    }
  }
  return undefined;
}

function withPollingState(
  output: ToolExecutionOutput,
  pollingState: AgnesMediaToolContent["pollingState"],
): ToolExecutionOutput {
  const content = mediaContent(output);
  if (!content) return output;
  const suffix =
    pollingState === "timed_out"
      ? " Automatic polling stopped after 10 minutes; query the video ID again to refresh it."
      : "";
  return {
    ...output,
    text: `${output.text}${suffix}`,
    structuredContent: {
      ...content,
      pollingState,
      pollingSessionId: AGNES_POLLING_SESSION_ID,
    },
  };
}

function asCreateVideoOutput(output: ToolExecutionOutput): ToolExecutionOutput {
  const content = mediaContent(output);
  return {
    ...output,
    ...(content
      ? {
          structuredContent: {
            ...content,
            operation: "create_video" as const,
          },
        }
      : {}),
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

function pollingDelay(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 2_000;
  if (elapsedMs < 120_000) return 5_000;
  return 10_000;
}

export class AgnesVideoTaskManager {
  private readonly tasks = new Map<string, AgnesVideoPollingTask>();
  private unsubscribe?: () => void;

  constructor() {
    this.unsubscribe = useConversationStore.subscribe((state, previous) => {
      const activeConversationChanged = state.activeId !== previous.activeId;
      for (const task of this.tasks.values()) {
        if (!state.conversations[task.conversationId]) {
          this.stop(task.key);
        } else if (!activeConversationChanged) {
          continue;
        } else if (state.activeId === task.conversationId) {
          task.lastOutput = withPollingState(task.lastOutput, "active");
          updateAgnesToolOutput(
            task.conversationId,
            task.toolCallId,
            task.lastOutput,
          );
          this.schedule(task, 0);
        } else if (previous.activeId === task.conversationId) {
          this.pause(task);
        }
      }
    });
  }

  register(input: {
    conversationId: string;
    toolCallId: string;
    videoId: string;
    initialOutput: ToolExecutionOutput;
    poll: (signal: AbortSignal) => Promise<ToolExecutionOutput>;
  }): void {
    const key = `${input.conversationId}\0${input.videoId}`;
    this.stop(key);
    const active =
      useConversationStore.getState().activeId === input.conversationId;
    const task: AgnesVideoPollingTask = {
      key,
      conversationId: input.conversationId,
      toolCallId: input.toolCallId,
      videoId: input.videoId,
      startedAt: Date.now(),
      lastOutput: withPollingState(
        input.initialOutput,
        active ? "active" : "paused",
      ),
      poll: input.poll,
    };
    this.tasks.set(key, task);
    if (active) this.schedule(task, pollingDelay(0));
  }

  applyManualResult(
    conversationId: string,
    videoId: string,
    output: ToolExecutionOutput,
  ): string | undefined {
    const key = `${conversationId}\0${videoId}`;
    const task = this.tasks.get(key);
    const toolCallId =
      task?.toolCallId ?? findAgnesVideoOriginToolCall(conversationId, videoId);
    if (!toolCallId) return undefined;
    const content = mediaContent(output);
    const originOutput = task
      ? withPollingState(
          asCreateVideoOutput(output),
          useConversationStore.getState().activeId === conversationId
            ? "active"
            : "paused",
        )
      : asCreateVideoOutput(output);
    updateAgnesToolOutput(conversationId, toolCallId, originOutput);
    if (task) {
      task.lastOutput = originOutput;
      if (content?.status === "completed" || content?.status === "failed") {
        this.stop(key);
      }
    }
    return toolCallId;
  }

  stopAll(): void {
    for (const task of [...this.tasks.values()]) {
      task.lastOutput = withPollingState(task.lastOutput, "stopped");
      updateAgnesToolOutput(
        task.conversationId,
        task.toolCallId,
        task.lastOutput,
      );
      this.stop(task.key);
    }
  }

  dispose(): void {
    this.stopAll();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private pause(task: AgnesVideoPollingTask): void {
    if (task.timer) globalThis.clearTimeout(task.timer);
    task.timer = undefined;
    task.controller?.abort();
    task.controller = undefined;
    task.lastOutput = withPollingState(task.lastOutput, "paused");
    updateAgnesToolOutput(
      task.conversationId,
      task.toolCallId,
      task.lastOutput,
    );
  }

  private stop(key: string): void {
    const task = this.tasks.get(key);
    if (!task) return;
    if (task.timer) globalThis.clearTimeout(task.timer);
    task.controller?.abort();
    this.tasks.delete(key);
  }

  private schedule(task: AgnesVideoPollingTask, delayMs: number): void {
    if (!this.tasks.has(task.key)) return;
    if (task.timer) globalThis.clearTimeout(task.timer);
    const remaining = Math.max(
      0,
      POLLING_LIMIT_MS - (Date.now() - task.startedAt),
    );
    task.timer = globalThis.setTimeout(
      () => void this.run(task),
      Math.min(delayMs, remaining),
    );
  }

  private async run(task: AgnesVideoPollingTask): Promise<void> {
    if (!this.tasks.has(task.key)) return;
    const state = useConversationStore.getState();
    if (
      state.activeId !== task.conversationId ||
      !state.conversations[task.conversationId]
    ) {
      this.pause(task);
      return;
    }
    const elapsed = Date.now() - task.startedAt;
    if (elapsed >= POLLING_LIMIT_MS) {
      task.lastOutput = withPollingState(task.lastOutput, "timed_out");
      updateAgnesToolOutput(
        task.conversationId,
        task.toolCallId,
        task.lastOutput,
      );
      this.stop(task.key);
      return;
    }

    const controller = new AbortController();
    task.controller = controller;
    try {
      const output = await task.poll(controller.signal);
      if (!this.tasks.has(task.key) || controller.signal.aborted) return;
      task.lastOutput = withPollingState(asCreateVideoOutput(output), "active");
      updateAgnesToolOutput(
        task.conversationId,
        task.toolCallId,
        task.lastOutput,
      );
      const content = mediaContent(output);
      if (
        output.isError ||
        content?.status === "completed" ||
        content?.status === "failed"
      ) {
        this.stop(task.key);
        return;
      }
      this.schedule(task, pollingDelay(Date.now() - task.startedAt));
    } catch {
      if (controller.signal.aborted) return;
      const previous = mediaContent(task.lastOutput);
      const output = normalizeToolExecutionOutput({
        ...task.lastOutput,
        text:
          "Automatic Agnes video status polling stopped after a query error. " +
          "Use get_video_status to refresh the task.",
        isError: false,
        structuredContent: previous
          ? {
              ...previous,
              pollingState: "error",
              error: "Automatic status query failed.",
            }
          : task.lastOutput.structuredContent,
      });
      task.lastOutput = output;
      updateAgnesToolOutput(task.conversationId, task.toolCallId, output);
      this.stop(task.key);
    } finally {
      if (task.controller === controller) task.controller = undefined;
    }
  }
}

let manager: AgnesVideoTaskManager | undefined;

export function getAgnesVideoTaskManager(): AgnesVideoTaskManager {
  manager ??= new AgnesVideoTaskManager();
  return manager;
}

export function stopAgnesVideoTasks(): void {
  manager?.stopAll();
}

export function resetAgnesVideoTaskManagerForTesting(): void {
  manager?.dispose();
  manager = undefined;
}

export const AGNES_VIDEO_POLLING = {
  limitMs: POLLING_LIMIT_MS,
  delayForElapsed: pollingDelay,
} as const;
