// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useMergedMessages } from "./useMergedMessages";
import { useSettingsStore } from "../store/settings";
import type { Message, PendingUserInstruction } from "../types";

const messages: Message[] = [
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "health",
        type: "function",
        function: { name: "project_health_check", arguments: "{}" },
      },
    ],
  },
];

describe("useMergedMessages", () => {
  const originalSystem = useSettingsStore.getState().system;

  afterEach(() => {
    useSettingsStore.getState().setSystem(originalSystem);
  });

  it("keeps an unsent message at its submitted position when later dialogue arrives", () => {
    const history: Message[] = [
      { role: "user", content: "Original task" },
      { role: "assistant", content: "Working" },
    ];
    const pending: PendingUserInstruction[] = [
      {
        id: "update-1",
        conversationId: "conversation",
        runId: "run-1",
        sequence: 1,
        afterMessageIndex: 2,
        content: "Keep the layout",
        attachments: [],
        forcedSkillIds: [],
        status: "cancelled",
      },
    ];
    const { result, rerender } = renderHook(
      ({ history }) => useMergedMessages(history, pending),
      {
        initialProps: { history },
      },
    );
    expect(result.current.map((message) => message.id)).toEqual([
      "user-0",
      "assistant-1",
      "pending-update-1",
    ]);
    const later: Message[] = [
      ...history,
      { role: "user", content: "New task" },
      { role: "assistant", content: "New response" },
    ];
    rerender({ history: later });
    expect(result.current.map((message) => message.id)).toEqual([
      "user-0",
      "assistant-1",
      "pending-update-1",
      "user-2",
      "assistant-3",
    ]);
    expect(history).toHaveLength(2);
    expect(later).toHaveLength(4);
    expect(pending[0].status).toBe("cancelled");
  });

  it("renders submitted attachments as ordinary message blocks with a stable delivery identity", () => {
    const history: Message[] = [{ role: "assistant", content: "Working" }];
    const attachment = {
      id: "file-1",
      type: "file" as const,
      name: "requirements.txt",
      mimeType: "text/plain",
      size: 12,
    };
    const pending: PendingUserInstruction[] = [
      {
        id: "update-1",
        conversationId: "conversation",
        runId: "run-1",
        sequence: 1,
        content: "Read this",
        attachments: [attachment],
        forcedSkillIds: [],
        status: "queued",
      },
    ];
    const { result, rerender } = renderHook(
      ({ history, pending }) => useMergedMessages(history, pending),
      {
        initialProps: { history, pending },
      },
    );
    const projected = result.current.at(-1)!;
    expect(projected).toMatchObject({
      role: "user",
      instructionId: "update-1",
    });
    expect(projected.blocks.map((block) => block.type)).toEqual([
      "text",
      "file",
    ]);
    rerender({
      history: [
        ...history,
        {
          role: "user",
          content: "Read this",
          metadata: { instructionId: "update-1", attachments: [attachment] },
        },
      ],
      pending: [],
    });
    expect(result.current.at(-1)?.instructionId).toBe(projected.instructionId);
    expect(
      result.current.filter((message) => message.instructionId === "update-1"),
    ).toHaveLength(1);
  });

  it("recomputes existing tool titles when the locale changes", () => {
    useSettingsStore.getState().setSystem({
      ...originalSystem,
      language: "zh",
    });
    const { result } = renderHook(() => useMergedMessages(messages));

    expect(result.current[0].blocks[0]).toMatchObject({
      title: "检查项目健康状态",
    });

    act(() => {
      useSettingsStore.getState().setSystem({
        ...originalSystem,
        language: "en",
      });
    });

    expect(result.current[0].blocks[0]).toMatchObject({
      title: "Check Project Health",
    });
  });
});
