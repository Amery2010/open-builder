// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../store/settings";
import { useProjectTemplateLibraryUi } from "./useProjectTemplateController";
import { useCommandPaletteActions } from "./useCommandPaletteActions";

vi.mock("localforage", () => ({
  default: {
    createInstance: () => ({
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    }),
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

describe("command palette project starters", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useProjectTemplateLibraryUi.setState({
      open: false,
      sourceConversationId: null,
    });
  });

  it("keeps New conversation blank and opens starters with a separate action", () => {
    const createConversation = vi.fn();
    const { result } = renderHook(() =>
      useCommandPaletteActions({
        createConversation,
        openSettings: vi.fn(),
        isGenerating: false,
        stop: vi.fn(),
        compressContext: vi.fn(),
        messagesEmpty: true,
      }),
    );

    act(() =>
      result.current.find((action) => action.id === "new-conversation")!.run(),
    );
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(useProjectTemplateLibraryUi.getState().open).toBe(false);

    act(() =>
      result.current.find((action) => action.id === "open-templates")!.run(),
    );
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(useProjectTemplateLibraryUi.getState().open).toBe(true);
  });
});
