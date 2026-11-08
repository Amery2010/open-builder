import { describe, expect, it, vi } from "vitest";
import {
  cancelPreviewCapture,
  captureRegisteredPreview,
  computePreviewGeneration,
  isPreviewCaptureBusy,
  PreviewRuntimeError,
  registerPreviewRuntime,
  sanitizePrototypePreviewTarget,
  type PrototypePreviewTarget,
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

  it.each(["tool", "manual-review", "automatic-review", "annotation"] as const)(
    "%s preempts a canvas capture only after its cleanup finishes",
    async (owner) => {
      const conversationId = `canvas-preempt-${owner}`;
      const unregister = registerPreviewRuntime(conversationId, adapter());
      const cleanup = deferred<void>();
      const events: string[] = [];
      const background = withPreviewCaptureLock({
        conversationId,
        owner: "canvas",
        run: async (_runtime, signal) => {
          try {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  events.push("abort");
                  reject(signal.reason);
                },
                { once: true },
              );
            });
          } finally {
            await cleanup.promise;
            events.push("cleanup");
          }
        },
      });
      const backgroundResult = expect(background).rejects.toMatchObject({
        name: "AbortError",
      });
      const foreground = withPreviewCaptureLock({
        conversationId,
        owner,
        run: async () => {
          events.push("foreground");
        },
      });
      expect(events).toEqual(["abort"]);
      expect(isPreviewCaptureBusy(conversationId)).toBe(true);
      cleanup.resolve();
      await Promise.all([backgroundResult, foreground]);
      expect(events).toEqual(["abort", "cleanup", "foreground"]);
      expect(isPreviewCaptureBusy(conversationId)).toBe(false);
      unregister();
    },
  );

  it("never lets canvas work interrupt foreground work", async () => {
    const conversationId = "foreground-priority";
    const unregister = registerPreviewRuntime(conversationId, adapter());
    const gate = deferred<void>();
    let foregroundSignal!: AbortSignal;
    const foreground = withPreviewCaptureLock({
      conversationId,
      owner: "annotation",
      run: async (_runtime, signal) => {
        foregroundSignal = signal;
        await gate.promise;
      },
    });
    const capture = vi.fn(async () => undefined);
    await expect(
      withPreviewCaptureLock({ conversationId, owner: "canvas", run: capture }),
    ).rejects.toMatchObject({ code: "capture_busy" });
    expect(foregroundSignal.aborted).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    gate.resolve();
    await foreground;
    unregister();
  });

  it("keeps automatic review waiting for a foreground capture without interrupting it", async () => {
    const conversationId = "automatic-waits-for-tool";
    const unregister = registerPreviewRuntime(conversationId, adapter());
    const gate = deferred<void>();
    let foregroundSignal!: AbortSignal;
    const foreground = withPreviewCaptureLock({
      conversationId,
      owner: "tool",
      run: async (_runtime, signal) => {
        foregroundSignal = signal;
        await gate.promise;
      },
    });
    const run = vi.fn(async () => "review");
    const automatic = withPreviewCaptureLock({
      conversationId,
      owner: "automatic-review",
      run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(foregroundSignal.aborted).toBe(false);
    gate.resolve();
    await expect(automatic).resolves.toBe("review");
    await foreground;
    expect(run).toHaveBeenCalledOnce();
    unregister();
  });

  it.each(["cancel", "replace"])(
    "never runs automatic review after its waiting context is %s",
    async (action) => {
      const conversationId = `automatic-wait-${action}`;
      const unregister = registerPreviewRuntime(conversationId, adapter());
      const gate = deferred<void>();
      const foreground = withPreviewCaptureLock({
        conversationId,
        owner: "annotation",
        run: async () => gate.promise,
      });
      const foregroundResult = foreground.catch((error: unknown) => error);
      const controller = new AbortController();
      const run = vi.fn(async () => undefined);
      const automatic = withPreviewCaptureLock({
        conversationId,
        owner: "automatic-review",
        signal: controller.signal,
        run,
      });
      const rejected = expect(automatic).rejects.toMatchObject({
        name: "AbortError",
      });
      let unregisterReplacement: (() => void) | undefined;
      if (action === "cancel") controller.abort();
      else
        unregisterReplacement = registerPreviewRuntime(
          conversationId,
          adapter(),
        );
      gate.resolve();
      await Promise.all([rejected, foregroundResult]);
      expect(run).not.toHaveBeenCalled();
      unregister();
      unregisterReplacement?.();
    },
  );

  it("permits only one competing foreground waiter to take the released lock", async () => {
    const conversationId = "canvas-waiter-race";
    const unregister = registerPreviewRuntime(conversationId, adapter());
    const backgroundGate = deferred<void>();
    const foregroundGate = deferred<void>();
    const background = withPreviewCaptureLock({
      conversationId,
      owner: "canvas",
      run: async () => backgroundGate.promise,
    });
    const backgroundResult = expect(background).rejects.toMatchObject({
      name: "AbortError",
    });
    const first = withPreviewCaptureLock({
      conversationId,
      owner: "annotation",
      run: async () => foregroundGate.promise,
    });
    const secondRun = vi.fn(async () => undefined);
    const second = withPreviewCaptureLock({
      conversationId,
      owner: "manual-review",
      run: secondRun,
    });
    const secondResult = expect(second).rejects.toMatchObject({
      code: "capture_busy",
    });
    backgroundGate.resolve();
    await Promise.all([backgroundResult, secondResult]);
    expect(secondRun).not.toHaveBeenCalled();
    foregroundGate.resolve();
    await first;
    unregister();
  });

  it("rejects a foreground waiter when the runtime is replaced during cleanup", async () => {
    const conversationId = "canvas-runtime-replacement";
    const unregister = registerPreviewRuntime(conversationId, adapter());
    const gate = deferred<void>();
    const background = withPreviewCaptureLock({
      conversationId,
      owner: "canvas",
      run: async () => gate.promise,
    });
    const backgroundResult = expect(background).rejects.toMatchObject({
      name: "AbortError",
    });
    const run = vi.fn(async () => undefined);
    const foreground = withPreviewCaptureLock({
      conversationId,
      owner: "tool",
      run,
    });
    const foregroundResult = expect(foreground).rejects.toMatchObject({
      name: "AbortError",
    });
    const unregisterReplacement = registerPreviewRuntime(
      conversationId,
      adapter("generation-b"),
    );
    unregister();
    gate.resolve();
    await Promise.all([backgroundResult, foregroundResult]);
    expect(run).not.toHaveBeenCalled();
    await expect(
      withPreviewCaptureLock({
        conversationId,
        owner: "tool",
        run: async (runtime) => runtime.getGeneration(),
      }),
    ).resolves.toBe("generation-b");
    unregisterReplacement();
  });

  it("cancels a waiting foreground request without waiting for canvas cleanup", async () => {
    const conversationId = "canvas-wait-cancel";
    const unregister = registerPreviewRuntime(conversationId, adapter());
    const gate = deferred<void>();
    const background = withPreviewCaptureLock({
      conversationId,
      owner: "canvas",
      run: async () => gate.promise,
    });
    const backgroundResult = expect(background).rejects.toMatchObject({
      name: "AbortError",
    });
    const controller = new AbortController();
    const run = vi.fn(async () => undefined);
    const foreground = withPreviewCaptureLock({
      conversationId,
      owner: "annotation",
      signal: controller.signal,
      run,
    });
    controller.abort();
    await expect(foreground).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
    expect(isPreviewCaptureBusy(conversationId)).toBe(true);
    gate.resolve();
    await backgroundResult;
    unregister();
  });

  it("rejects legacy scenario identity while retaining ordinary query parameters", () => {
    const target = {
      pageId: "dashboard",
      route: "#/dashboard?scenario=empty&tab=history",
    };
    expect(sanitizePrototypePreviewTarget(target)).toEqual(target);
    expect(
      sanitizePrototypePreviewTarget({ ...target, scenarioId: "empty" }),
    ).toBeNull();
  });

  it("keeps a target capture bound to page and route identity", async () => {
    const target: PrototypePreviewTarget = {
      pageId: "dashboard",
      route: "#/dashboard",
    };
    const wrongTarget: PrototypePreviewTarget = {
      ...target,
      route: "#/other-page",
    };
    const capture = vi.fn(async () => ({
      generation: "generation-a",
      target,
      captures: [],
      errors: [],
    }));
    const prepareTarget = vi.fn(
      async (requested: PrototypePreviewTarget) => requested,
    );
    const unregister = registerPreviewRuntime("conversation-target", {
      ...adapter(),
      prepareTarget,
      capture,
    });

    await expect(
      captureRegisteredPreview({
        conversationId: "conversation-target",
        generation: "generation-a",
        target,
        viewports: ["desktop"],
      }),
    ).resolves.toMatchObject({ generation: "generation-a", target });
    expect(prepareTarget).toHaveBeenCalledWith(
      target,
      "generation-a",
      expect.any(AbortSignal),
    );
    expect(capture).toHaveBeenCalledWith(
      ["desktop"],
      "generation-a",
      expect.any(AbortSignal),
      target,
    );

    capture.mockResolvedValueOnce({
      generation: "generation-a",
      target: wrongTarget,
      captures: [],
      errors: [],
    });
    await expect(
      captureRegisteredPreview({
        conversationId: "conversation-target",
        generation: "generation-a",
        target,
        viewports: ["desktop"],
      }),
    ).rejects.toMatchObject({ code: "target_identity_mismatch" });
    unregister();
  });

  it("rejects unsafe prototype target routes before invoking the adapter", async () => {
    const runtime = adapter();
    const unregister = registerPreviewRuntime("conversation-unsafe", runtime);
    expect(
      sanitizePrototypePreviewTarget({
        pageId: "home",
        route: "javascript:alert(1)",
      }),
    ).toBeNull();
    await expect(
      captureRegisteredPreview({
        conversationId: "conversation-unsafe",
        generation: "generation-a",
        target: {
          pageId: "home",
          route: "#/" + "a".repeat(2048),
        },
        viewports: ["desktop"],
      }),
    ).rejects.toMatchObject({ code: "invalid_target" });
    expect(runtime.prepare).not.toHaveBeenCalled();
    unregister();
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
