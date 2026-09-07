// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TITLE, useConversationStore } from "../store/conversation";
import { useInteractiveStore } from "../store/interactive";
import { useSettingsStore } from "../store/settings";
import { useGenerator } from "./useGenerator";

const generateSmartTitle = vi.hoisted(() => vi.fn());

vi.mock("../lib/utils/smart-title", () => ({ generateSmartTitle }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useGenerator optimistic request lifecycle", () => {
  beforeEach(() => {
    generateSmartTitle.mockReset();
    generateSmartTitle.mockResolvedValue("First request title");
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: true,
    });
    useInteractiveStore.setState({ pending: [] });
  });

  function renderGenerator() {
    const settingsState = useSettingsStore.getState();
    const settings = {
      ...settingsState.ai,
      runtime: "api" as const,
      apiKey: "",
      apiBaseUrl: "",
    };
    return renderHook(() => {
      const [isGenerating, setIsGenerating] = useState(false);
      const generator = useGenerator({
        settings,
        webSearchSettings: settingsState.webSearch,
        assetSearchSettings: settingsState.assetSearch,
        setMessages: useConversationStore.getState().setMessages,
        setFiles: useConversationStore.getState().setFiles,
        setIsGenerating,
        setTemplate: useConversationStore.getState().setTemplate,
        restartSandpack: vi.fn(),
      });
      return { ...generator, isGenerating };
    });
  }

  it("shows the user message and loading before request preparation resolves", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    const preparation = deferred();
    const hook = renderGenerator();
    let generation!: Promise<void>;

    await act(async () => {
      generation = hook.result.current.generate("Build it", undefined, {
        forcedSkillIds: ["review-code"],
        designExpectedChangeModes: ["migrate"],
        prepareRun: () => preparation.promise,
      });
      await Promise.resolve();
    });

    expect(hook.result.current.isGenerating).toBe(true);
    expect(
      useConversationStore.getState().conversations[conversationId].messages,
    ).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Build it",
        forcedSkillIds: ["review-code"],
        metadata: { designExpectedChangeModes: ["migrate"] },
      }),
    ]);

    await act(async () => {
      preparation.resolve();
      await generation;
    });

    expect(hook.result.current.isGenerating).toBe(false);
    expect(
      useConversationStore.getState().conversations[conversationId].messages,
    ).toHaveLength(1);
  });

  it("keeps the optimistic message but prevents preparation from continuing after stop", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    const preparation = deferred();
    const prepareRun = vi.fn(() => preparation.promise);
    const hook = renderGenerator();
    let generation!: Promise<void>;

    await act(async () => {
      generation = hook.result.current.generate("Build it", undefined, {
        prepareRun,
      });
      await Promise.resolve();
    });
    expect(prepareRun).toHaveBeenCalledOnce();

    act(() => hook.result.current.stop());
    expect(hook.result.current.isGenerating).toBe(false);

    await act(async () => {
      preparation.resolve();
      await generation;
    });

    expect(
      useConversationStore.getState().conversations[conversationId].messages,
    ).toEqual([expect.objectContaining({ role: "user", content: "Build it" })]);
  });

  it("persists a Design change-mode policy resolved during preparation", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    const hook = renderGenerator();
    const runOptions: NonNullable<
      Parameters<typeof hook.result.current.generate>[2]
    > = {
      prepareRun: async () => {
        runOptions.designExpectedChangeModes = ["migrate"];
      },
    };

    await act(async () => {
      await hook.result.current.generate(
        "Apply the selected system",
        undefined,
        runOptions,
      );
    });

    expect(
      useConversationStore.getState().conversations[conversationId].messages,
    ).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Apply the selected system",
        metadata: { designExpectedChangeModes: ["migrate"] },
      }),
    ]);
  });

  it("withdraws the final visible user message through a hidden assistant tail", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    const preparation = deferred();
    const hook = renderGenerator();
    let generation!: Promise<void>;

    await act(async () => {
      generation = hook.result.current.generate(
        "Refine this card",
        [
          {
            id: "attachment-1",
            type: "image",
            name: "reference.png",
            mimeType: "image/png",
            size: 42,
          },
        ],
        {
          forcedSkillIds: ["art-direct-web"],
          designSelection: {
            protocolVersion: 1,
            elementId: "hero-card",
            label: "Hero card",
            tagName: "section",
            route: "/",
          },
          prepareRun: () => preparation.promise,
        },
      );
      await Promise.resolve();
    });

    act(() => {
      useConversationStore
        .getState()
        .setMessagesForConversation(conversationId, (messages) => [
          ...messages,
          { role: "assistant", content: null },
        ]);
    });

    let draft: ReturnType<typeof hook.result.current.withdrawLastUserMessage> =
      null;
    act(() => {
      draft = hook.result.current.withdrawLastUserMessage();
    });

    expect(draft).toEqual({
      content: "Refine this card",
      attachments: [
        {
          id: "attachment-1",
          type: "image",
          name: "reference.png",
          mimeType: "image/png",
          size: 42,
        },
      ],
      forcedSkillIds: ["art-direct-web"],
      designSelection: expect.objectContaining({ elementId: "hero-card" }),
    });
    expect(hook.result.current.isGenerating).toBe(false);
    expect(
      useConversationStore.getState().conversations[conversationId],
    ).toEqual(expect.objectContaining({ messages: [], title: DEFAULT_TITLE }));

    await act(async () => {
      preparation.resolve();
      await generation;
    });
    expect(
      useConversationStore.getState().conversations[conversationId].messages,
    ).toEqual([]);
  });

  it("starts one smart-title call from the first submitted request", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    const preparation = deferred();
    const hook = renderGenerator();
    let firstGeneration!: Promise<void>;

    await act(async () => {
      firstGeneration = hook.result.current.generate(
        "Build the analytics dashboard",
        undefined,
        { prepareRun: () => preparation.promise },
      );
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(generateSmartTitle).toHaveBeenCalledOnce());
    expect(generateSmartTitle).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          role: "user",
          content: "Build the analytics dashboard",
        }),
      ],
      expect.objectContaining({ model: expect.any(String) }),
      undefined,
    );
    await vi.waitFor(() =>
      expect(
        useConversationStore.getState().conversations[conversationId].title,
      ).toBe("First request title"),
    );

    await act(async () => {
      preparation.resolve();
      await firstGeneration;
      await hook.result.current.generate("Add a revenue chart");
    });

    expect(generateSmartTitle).toHaveBeenCalledOnce();
  });

  it("does not apply a late smart title after withdrawing the first request", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    const preparation = deferred();
    let resolveTitle!: (title: string) => void;
    generateSmartTitle.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveTitle = resolve;
      }),
    );
    const hook = renderGenerator();
    let generation!: Promise<void>;

    await act(async () => {
      generation = hook.result.current.generate(
        "Temporary request",
        undefined,
        {
          prepareRun: () => preparation.promise,
        },
      );
      await Promise.resolve();
    });
    act(() => {
      hook.result.current.withdrawLastUserMessage();
    });
    await act(async () => {
      resolveTitle("Late title");
      await Promise.resolve();
    });

    expect(
      useConversationStore.getState().conversations[conversationId].title,
    ).toBe(DEFAULT_TITLE);
    await act(async () => {
      preparation.resolve();
      await generation;
    });
  });

  it("recovers a default title from the original request on a later turn", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore
      .getState()
      .setMessages([{ role: "user", content: "Original dashboard request" }]);
    const hook = renderGenerator();

    await act(async () => {
      await hook.result.current.generate("Follow-up chart request");
    });

    await vi.waitFor(() => expect(generateSmartTitle).toHaveBeenCalledOnce());
    expect(generateSmartTitle).toHaveBeenCalledWith(
      [{ role: "user", content: "Original dashboard request" }],
      expect.objectContaining({ model: expect.any(String) }),
      undefined,
    );
    await vi.waitFor(() =>
      expect(
        useConversationStore.getState().conversations[conversationId].title,
      ).toBe("First request title"),
    );
  });
});
