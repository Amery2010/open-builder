// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../store/conversation";
import { useProjectTemplateStore } from "../store/project-templates";
import {
  useProjectTemplateController,
  useProjectTemplateLibraryUi,
} from "./useProjectTemplateController";

const localforageMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  const adapter = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => values.set(key, value),
    removeItem: async (key: string) => values.delete(key),
  };
  return { ...adapter, createInstance: () => adapter };
});

vi.mock("localforage", () => ({ default: localforageMock }));

describe("project template controller", () => {
  beforeEach(() => {
    useConversationStore.setState({
      activeId: "source",
      _hasHydrated: true,
      conversations: {
        source: {
          id: "source",
          title: "Source",
          messages: [{ role: "user", content: "private conversation" }],
          files: {
            "src/App.tsx": "export default function App() {}",
            ".env.local": "API_KEY=do-not-copy",
          },
          activeFile: "src/App.tsx",
          template: "vite-react-ts",
          previewMode: "sandpack",
          isProjectInitialized: true,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    });
    useProjectTemplateStore.setState({
      templates: {},
      _hasHydrated: true,
    });
    useProjectTemplateLibraryUi.setState({
      open: false,
      sourceConversationId: null,
    });
  });

  it("reviews, persists, and uses one safe starter through one controller", async () => {
    const { result } = renderHook(() => useProjectTemplateController());

    act(() => result.current.openLibrary("source"));
    expect(result.current.open).toBe(true);
    expect(result.current.sourceConversation?.id).toBe("source");

    let prepared!: Awaited<ReturnType<typeof result.current.prepareCurrent>>;
    await act(async () => {
      prepared = await result.current.prepareCurrent({
        name: "Safe Starter",
        description: "Reviewed",
        tags: ["react"],
      });
    });
    expect(prepared.report.excludedPaths).toEqual([".env.local"]);

    let saved!: Awaited<ReturnType<typeof result.current.savePrepared>>;
    await act(async () => {
      saved = await result.current.savePrepared(prepared);
    });
    expect(saved.status).toBe("added");

    const templateId = Object.keys(
      useProjectTemplateStore.getState().templates,
    )[0];
    await act(async () => {
      await result.current.useTemplate(templateId);
    });

    const created =
      useConversationStore.getState().conversations[
        useConversationStore.getState().activeId!
      ];
    expect(created).toMatchObject({
      title: "Safe Starter",
      messages: [],
      files: { "src/App.tsx": "export default function App() {}" },
      activeFile: "src/App.tsx",
      templateOrigin: { templateId },
    });
    expect(created.compressedContext).toBeUndefined();
    expect(created).not.toHaveProperty("localAgentSessions");
  });

  it("does not increment usage when materialization rejects a tampered digest", async () => {
    const { result } = renderHook(() => useProjectTemplateController());
    let prepared!: Awaited<ReturnType<typeof result.current.prepareCurrent>>;
    await act(async () => {
      prepared = await result.current.prepareCurrent({
        name: "Tampered",
        tags: [],
      });
      await result.current.savePrepared(prepared);
    });
    const templateId = prepared.template.id;
    useProjectTemplateStore.setState((state) => ({
      templates: {
        ...state.templates,
        [templateId]: {
          ...state.templates[templateId],
          contentDigest: "a".repeat(64),
        },
      },
    }));

    await expect(result.current.useTemplate(templateId)).rejects.toThrow(
      /digest/i,
    );
    expect(
      useProjectTemplateStore.getState().templates[templateId].useCount ?? 0,
    ).toBe(0);
  });
});
