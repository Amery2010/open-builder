// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInteractiveStore } from "../store/interactive";
import { useGlobalShortcuts } from "./useGlobalShortcuts";

describe("useGlobalShortcuts questionnaire guard", () => {
  afterEach(() => {
    useInteractiveStore.getState().rejectAllPending("test cleanup");
  });

  it("blocks app shortcuts without blocking text entry", () => {
    void useInteractiveStore
      .getState()
      .askQuestion({
        toolCallId: "question-1",
        questions: [
          {
            header: "Answer",
            question: "What should change?",
            multiSelect: false,
            options: [{ label: "Other", description: "Type an answer" }],
          },
        ],
      })
      .catch(() => undefined);
    const handlers = {
      newConversation: vi.fn(),
      openSettings: vi.fn(),
      focusChatInput: vi.fn(),
      stopGenerating: vi.fn(),
      isGenerating: true,
    };
    renderHook(() => useGlobalShortcuts(handlers));
    const input = document.createElement("input");
    document.body.append(input);

    const textEvent = new KeyboardEvent("keydown", {
      key: "a",
      bubbles: true,
      cancelable: true,
    });
    expect(input.dispatchEvent(textEvent)).toBe(true);
    expect(textEvent.defaultPrevented).toBe(false);

    const shortcutEvent = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(input.dispatchEvent(shortcutEvent)).toBe(false);
    expect(shortcutEvent.defaultPrevented).toBe(true);

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(handlers.stopGenerating).toHaveBeenCalledOnce();
  });
});
