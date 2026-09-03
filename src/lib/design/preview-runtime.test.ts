import { describe, expect, it, vi } from "vitest";
import {
  cancelPreviewCapture,
  captureRegisteredPreview,
  computePreviewGeneration,
  isPreviewCaptureBusy,
  PreviewRuntimeError,
  registerPreviewRuntime,
  withPreviewCaptureLock,
  type PreviewRuntimeAdapter,
} from "./preview-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function adapter(
  generation = "generation-a",
  capture = vi.fn(async () => ({
    generation,
    captures: [],
    errors: [],
  })),
): PreviewRuntimeAdapter {
  return {
    getGeneration: () => generation,
    prepare: vi.fn(async () => undefined),
    capture,
  };
}

describe("preview runtime registry", () => {
  it("captures the requested viewports against one immutable generation", async () => {
    const runtime = adapter();
    const unregister = registerPreviewRuntime("conversation-a", runtime);

    await expect(
      captureRegisteredPreview({
        conversationId: "conversation-a",
        generation: "generation-a",
        viewports: ["mobile", "desktop"],
      }),
    ).resolves.toEqual({
      generation: "generation-a",
      captures: [],
      errors: [],
    });
    expect(runtime.prepare).toHaveBeenCalledWith(
      "generation-a",
      expect.any(AbortSignal),
    );
    expect(runtime.capture).toHaveBeenCalledWith(
      ["mobile", "desktop"],
      "generation-a",
      expect.any(AbortSignal),
    );
    unregister();
  });

  it("fails closed for missing, busy, and stale runtimes", async () => {
    await expect(
      captureRegisteredPreview({
        conversationId: "missing",
        generation: "generation-a",
        viewports: ["desktop"],
      }),
    ).rejects.toMatchObject({ code: "preview_unavailable" });

    const gate = deferred<void>();
    const unregister = registerPreviewRuntime("conversation-b", adapter());
    const active = withPreviewCaptureLock({
      conversationId: "conversation-b",
      owner: "manual-review",
      run: async () => gate.promise,
    });
    expect(isPreviewCaptureBusy("conversation-b")).toBe(true);
    await expect(
      captureRegisteredPreview({
        conversationId: "conversation-b",
        generation: "generation-a",
        viewports: ["desktop"],
      }),
    ).rejects.toMatchObject({ code: "capture_busy" });
    gate.resolve();
    await active;
    unregister();

    const unregisterStale = registerPreviewRuntime(
      "conversation-c",
      adapter("new-generation"),
    );
    await expect(
      captureRegisteredPreview({
        conversationId: "conversation-c",
        generation: "old-generation",
        viewports: ["desktop"],
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PreviewRuntimeError>>({
        code: "stale_generation",
      }),
    );
    unregisterStale();
  });

  it("cancels work when explicitly stopped or unregistered", async () => {
    const observed: string[] = [];
    const unregister = registerPreviewRuntime("conversation-d", adapter());
    const active = withPreviewCaptureLock({
      conversationId: "conversation-d",
      owner: "automatic-review",
      run: async (_runtime, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observed.push("aborted");
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    cancelPreviewCapture("conversation-d");
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(observed).toEqual(["aborted"]);
    unregister();

    const unregisterReplacement = registerPreviewRuntime(
      "conversation-e",
      adapter(),
    );
    const replaced = withPreviewCaptureLock({
      conversationId: "conversation-e",
      owner: "manual-review",
      run: async (_runtime, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    unregisterReplacement();
    await expect(replaced).rejects.toMatchObject({ name: "AbortError" });
  });

  it("hashes project source deterministically and includes preview metadata", async () => {
    const first = await computePreviewGeneration({
      files: { "b.ts": "b", "a.ts": "a" },
      template: "vite-react-ts",
      previewMode: "sandpack",
    });
    const reordered = await computePreviewGeneration({
      files: { "a.ts": "a", "b.ts": "b" },
      template: "vite-react-ts",
      previewMode: "sandpack",
    });
    const changed = await computePreviewGeneration({
      files: { "a.ts": "a", "b.ts": "changed" },
      template: "vite-react-ts",
      previewMode: "sandpack",
    });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(changed).not.toBe(first);
  });
});
