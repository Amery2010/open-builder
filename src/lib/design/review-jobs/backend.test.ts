import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationBackend } from "../../ai/generator-types";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  local: vi.fn(),
  prepareScreenshot: vi.fn(),
}));

vi.mock("../../ai/client", () => ({
  createOpenAIGenerator: mocks.api,
}));

vi.mock("../../local-agent/generator", () => ({
  createLocalAgentGenerator: mocks.local,
}));

vi.mock("../../images/screenshot", () => ({
  prepareScreenshot: mocks.prepareScreenshot,
}));

import { createIsolatedDesignReviewSession } from "./backend";

const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const screenshot = {
  dataUrl: `data:image/png;base64,${btoa(
    Array.from(pngBytes, (byte) => String.fromCharCode(byte)).join(""),
  )}`,
  mimeType: "image/png" as const,
  name: "preview.png",
};
const firstReport = {
  overview: "First accepted report.",
  findings: [],
};
const secondReport = {
  overview: "Second report must be ignored.",
  findings: [],
};

function fakeBackend(files: Record<string, string>): GenerationBackend {
  return {
    getFiles: vi.fn(() => files),
    setFiles: vi.fn(),
    getMessages: vi.fn(() => []),
    resetMessages: vi.fn(),
    syncMessages: vi.fn(),
    setSystemPromptSuffix: vi.fn(),
    setUntrustedReferenceContext: vi.fn(),
    setTools: vi.fn(),
    setReadOnlyMode: vi.fn(),
    setNativeSearchAllowed: vi.fn(),
    setConversationContextAllowed: vi.fn(),
    setExecutionMode: vi.fn(),
    setAllowedMcpAliases: vi.fn(),
    getSkillContext: vi.fn(),
    getRunContext: vi.fn(),
    getCustomToolSet: vi.fn(() => ({})),
    setCustomToolSet: vi.fn(),
    abort: vi.fn(),
    retry: vi.fn(),
    generate: vi.fn(),
  } as unknown as GenerationBackend;
}

function generationResult(files: Record<string, string>, text = "") {
  return {
    files,
    messages: [],
    text,
    aborted: false,
    maxIterationsReached: false,
  };
}

describe("isolated Design Review backend", () => {
  beforeEach(() => {
    mocks.api.mockReset();
    mocks.local.mockReset();
    mocks.prepareScreenshot
      .mockReset()
      .mockImplementation(async (dataUrl, name) => ({
        dataUrl,
        name,
        mimeType: "image/png",
      }));
  });

  it.each(["api", "local"] as const)(
    "compresses manual and automatic screenshots before %s submission",
    async (runtime) => {
      const files = { "index.html": "page" };
      const backend = fakeBackend(files);
      vi.mocked(backend.generate).mockResolvedValue(
        generationResult(
          files,
          `<design_review_report>${JSON.stringify(firstReport)}</design_review_report>`,
        ),
      );
      mocks[runtime].mockReturnValue(backend);
      const compressed = {
        dataUrl: "data:image/jpeg;base64,/9j/",
        mimeType: "image/jpeg",
        name: "preview.jpg",
      };
      mocks.prepareScreenshot.mockResolvedValue(compressed);
      const session = createIsolatedDesignReviewSession({
        conversationId: "compression",
        locale: "en",
        files,
        screenshots: [
          { ...screenshot, source: "manual" },
          { ...screenshot, source: "automatic" },
        ],
        provider:
          runtime === "api"
            ? { runtime, config: { apiKey: "key", model: "review" } }
            : { runtime, config: { provider: "codex" } },
      });
      await session.run();
      expect(mocks.prepareScreenshot).toHaveBeenCalledTimes(2);
      expect(backend.generate).toHaveBeenCalledWith(expect.any(String), [
        expect.objectContaining({
          content: compressed.dataUrl,
          mimeType: "image/jpeg",
          name: "preview.jpg",
          size: 3,
        }),
        expect.objectContaining({
          content: compressed.dataUrl,
          mimeType: "image/jpeg",
        }),
      ]);
    },
  );

  it("does not start the model when cancelled during screenshot compression", async () => {
    const files = { "index.html": "page" };
    const backend = fakeBackend(files);
    const abort = backend.abort;
    mocks.api.mockReturnValue(backend);
    let finish!: (image: typeof screenshot) => void;
    mocks.prepareScreenshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const session = createIsolatedDesignReviewSession({
      conversationId: "cancel",
      locale: "en",
      files,
      screenshots: [screenshot],
      provider: { runtime: "api", config: { apiKey: "key", model: "review" } },
    });
    const pending = session.run();
    session.backend.abort();
    finish(screenshot);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(abort).toHaveBeenCalledOnce();
    expect(backend.generate).not.toHaveBeenCalled();
  });

  it("creates a fresh API backend with exactly the read-only review tools", async () => {
    const files = { "src/App.tsx": "export default function App() {}" };
    const backend = fakeBackend(files);
    let executionMode: "chat" | "plan" = "chat";
    vi.mocked(backend.setReadOnlyMode).mockImplementation((readOnly) => {
      executionMode = readOnly ? "plan" : "chat";
    });
    vi.mocked(backend.setExecutionMode).mockImplementation((mode) => {
      executionMode = mode === "plan" ? "plan" : "chat";
    });
    mocks.api.mockImplementation(
      (_config, _events, _files, _customTools, customHandler) => {
        vi.mocked(backend.generate).mockImplementation(async () => {
          expect(executionMode).toBe("chat");
          await customHandler("submit_design_review", firstReport);
          await customHandler("submit_design_review", secondReport);
          return {} as never;
        });
        return backend;
      },
    );
    const onReport = vi.fn();

    const session = createIsolatedDesignReviewSession({
      conversationId: "conversation",
      locale: "zh",
      files,
      screenshots: [screenshot],
      provider: {
        runtime: "api",
        config: { apiKey: "secret", model: "gpt-review" },
      },
      events: { onReport },
    });
    await expect(session.run()).resolves.toEqual(firstReport);

    const extras = mocks.api.mock.calls[0][5];
    expect(extras.maxIterations).toBeUndefined();
    expect(Object.keys(extras.tools).sort()).toEqual([
      "list_files",
      "read_files",
      "search_in_files",
      "submit_design_review",
    ]);
    expect(backend.syncMessages).toHaveBeenCalledWith([]);
    expect(backend.setReadOnlyMode).not.toHaveBeenCalled();
    expect(backend.setExecutionMode).toHaveBeenCalledWith("chat");
    expect(backend.setAllowedMcpAliases).toHaveBeenCalledWith(new Set());
    expect(backend.setNativeSearchAllowed).toHaveBeenCalledWith(false);
    expect(backend.setConversationContextAllowed).toHaveBeenCalledWith(false);
    expect(backend.setSystemPromptSuffix).toHaveBeenCalledWith(
      expect.stringContaining("Simplified Chinese"),
    );
    expect(onReport).toHaveBeenCalledOnce();
  });

  it("creates a new non-resumable local CLI backend for every session", () => {
    mocks.local.mockImplementation((_config, _events, files) =>
      fakeBackend(files),
    );
    const options = {
      conversationId: "conversation",
      locale: "en" as const,
      files: { "src/App.tsx": "app" },
      screenshots: [screenshot],
      provider: {
        runtime: "local" as const,
        config: { provider: "codex" as const, model: "review-model" },
      },
    };

    createIsolatedDesignReviewSession(options);
    createIsolatedDesignReviewSession(options);

    expect(mocks.local).toHaveBeenCalledTimes(2);
    expect(mocks.local.mock.calls[0][0]).toMatchObject({
      nativeSearch: false,
      conversationId: "conversation",
    });
    expect(mocks.local.mock.calls[0][0]).not.toHaveProperty("getConversation");
    expect(mocks.local.mock.calls[0][0]).not.toHaveProperty("saveSession");
    expect(mocks.local.mock.calls[0][5].maxIterations).toBeUndefined();
  });

  it("accepts a schema-valid tagged JSON report when a compatible model skips the submit tool", async () => {
    const files = { "src/App.tsx": "export default function App() {}" };
    const backend = fakeBackend(files);
    vi.mocked(backend.generate).mockResolvedValue(
      generationResult(
        files,
        `<design_review_report>${JSON.stringify(firstReport)}</design_review_report>`,
      ),
    );
    mocks.api.mockReturnValue(backend);
    const onReport = vi.fn();

    const session = createIsolatedDesignReviewSession({
      conversationId: "conversation",
      locale: "en",
      files,
      screenshots: [screenshot],
      provider: {
        runtime: "api",
        config: { apiKey: "secret", model: "compatible-review" },
      },
      events: { onReport },
    });

    await expect(session.run()).resolves.toEqual(firstReport);
    expect(onReport).toHaveBeenCalledWith(firstReport);
    expect(backend.generate).toHaveBeenCalledOnce();
  });

  it("uses the same schema-validated text fallback for a local CLI", async () => {
    const files = { "src/App.tsx": "export default function App() {}" };
    const backend = fakeBackend(files);
    vi.mocked(backend.generate).mockResolvedValue(
      generationResult(
        files,
        `<design_review_report>${JSON.stringify(firstReport)}</design_review_report>`,
      ),
    );
    mocks.local.mockReturnValue(backend);

    const session = createIsolatedDesignReviewSession({
      conversationId: "conversation",
      locale: "en",
      files,
      screenshots: [screenshot],
      provider: {
        runtime: "local",
        config: { provider: "codex", model: "review-model" },
      },
    });

    await expect(session.run()).resolves.toEqual(firstReport);
    expect(backend.generate).toHaveBeenCalledOnce();
  });

  it("makes one schema-only repair turn after an unstructured response", async () => {
    const files = { "src/App.tsx": "export default function App() {}" };
    const backend = fakeBackend(files);
    mocks.api.mockImplementation(
      (_config, _events, _files, _customTools, customHandler) => {
        vi.mocked(backend.generate)
          .mockResolvedValueOnce(
            generationResult(files, "The interface looks consistent."),
          )
          .mockImplementationOnce(async () => {
            await customHandler("submit_design_review", firstReport);
            return generationResult(files);
          });
        return backend;
      },
    );

    const session = createIsolatedDesignReviewSession({
      conversationId: "conversation",
      locale: "en",
      files,
      screenshots: [screenshot],
      provider: {
        runtime: "api",
        config: { apiKey: "secret", model: "compatible-review" },
      },
    });

    await expect(session.run()).resolves.toEqual(firstReport);
    expect(backend.generate).toHaveBeenCalledTimes(2);
    expect(
      Object.keys(vi.mocked(backend.setTools).mock.calls.at(-1)![0]),
    ).toEqual(["submit_design_review"]);
  });

  it("fails honestly after one bounded repair when neither response is valid", async () => {
    const files = { "src/App.tsx": "export default function App() {}" };
    const backend = fakeBackend(files);
    vi.mocked(backend.generate).mockResolvedValue(
      generationResult(files, "An unstructured visual review."),
    );
    mocks.api.mockReturnValue(backend);

    const session = createIsolatedDesignReviewSession({
      conversationId: "conversation",
      locale: "en",
      files,
      screenshots: [screenshot],
      provider: {
        runtime: "api",
        config: { apiKey: "secret", model: "compatible-review" },
      },
    });

    await expect(session.run()).rejects.toThrow(
      "The openai-compatible model did not submit a structured Design Review report.",
    );
    expect(backend.generate).toHaveBeenCalledTimes(2);
  });
});
