import {
  createSourceFile,
  forEachChild,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node,
} from "typescript";
import captureCanvasAdapterSource from "./capture-canvas-adapter.js?raw";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectDesignReviewCaptures,
  loadDesignCaptureRuntimeSource,
  DESIGN_REVIEW_VIEWPORTS,
  isDesignReviewViewportReady,
  waitForPreviewReadiness,
  waitForPreviewSynchronization,
} from "./preview-capture";
import {
  DESIGN_CAPTURE_RUNTIME_GLOBAL,
  type DesignBridgeCaptureResult,
} from "./preview-bridge";

function capture(name: "desktop" | "tablet" | "mobile") {
  return {
    viewport: { name },
  } as DesignBridgeCaptureResult;
}

describe("Design preview capture sequence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("allows three readiness windows and stops immediately when cancelled or superseded", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const controller = new AbortController();
    let ready = false;
    let current = true;
    let error: unknown;
    const wait = () =>
      waitForPreviewReadiness({
        isReady: () => ready,
        isCurrent: () => current,
        signal: controller.signal,
        timeoutMs: 10,
        pollIntervalMs: 1,
        errorMessage: "not ready",
      });
    const first = wait().catch((cause) => {
      error = cause;
    });
    await vi.advanceTimersByTimeAsync(21);
    expect(error).toBeUndefined();
    ready = true;
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(error).toBeUndefined();

    ready = false;
    const second = wait().catch((cause) => {
      error = cause;
    });
    await vi.advanceTimersByTimeAsync(11);
    current = false;
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(error).toMatchObject({ code: "stale_generation" });

    current = true;
    error = undefined;
    const third = wait().catch((cause) => {
      error = cause;
    });
    controller.abort();
    await third;
    expect(error).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails readiness after the third timeout window", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    let error: unknown;
    const pending = waitForPreviewReadiness({
      isReady: () => false,
      signal: new AbortController().signal,
      timeoutMs: 10,
      pollIntervalMs: 1,
      errorMessage: "not ready",
    }).catch((cause) => {
      error = cause;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(error).toMatchObject({ message: "not ready" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the runtime-capable Bridge at the requested viewport", () => {
    const desktop = DESIGN_REVIEW_VIEWPORTS[0];
    const readiness = {
      bridgeReady: true,
      captureRuntimeReady: false,
      width: desktop.width,
      height: desktop.height,
    };

    expect(isDesignReviewViewportReady(readiness, desktop)).toBe(false);
    expect(
      isDesignReviewViewportReady(
        { ...readiness, captureRuntimeReady: true },
        desktop,
      ),
    ).toBe(true);
    expect(
      isDesignReviewViewportReady(
        { ...readiness, captureRuntimeReady: true, width: 390 },
        desktop,
      ),
    ).toBe(false);
  });

  it("accepts actual sizes within the requested category", () => {
    expect(
      isDesignReviewViewportReady(
        {
          bridgeReady: true,
          captureRuntimeReady: true,
          width: 1280,
          height: 720,
        },
        DESIGN_REVIEW_VIEWPORTS[0],
      ),
    ).toBe(true);
    expect(
      isDesignReviewViewportReady(
        {
          bridgeReady: true,
          captureRuntimeReady: true,
          width: 390,
          height: 844,
        },
        DESIGN_REVIEW_VIEWPORTS[2],
      ),
    ).toBe(true);
  });

  it("captures the fixed viewports sequentially and always restores", async () => {
    const events: string[] = [];
    const restore = vi.fn(() => {
      events.push("restore");
    });
    const result = await collectDesignReviewCaptures({
      prepareViewport: async (viewport) => {
        events.push(`prepare:${viewport.name}`);
      },
      captureViewport: async (viewport) => {
        events.push(`capture:${viewport.name}`);
        return capture(viewport.name);
      },
      restore,
    });

    expect(result.errors).toEqual([]);
    expect(result.captures.map((item) => item.viewport.name)).toEqual(
      DESIGN_REVIEW_VIEWPORTS.map((viewport) => viewport.name),
    );
    expect(events).toEqual([
      "prepare:desktop",
      "capture:desktop",
      "prepare:tablet",
      "capture:tablet",
      "prepare:mobile",
      "capture:mobile",
      "restore",
    ]);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("keeps successful captures when one viewport fails", async () => {
    const restore = vi.fn();
    const result = await collectDesignReviewCaptures({
      prepareViewport: async () => {},
      captureViewport: async (viewport) => {
        if (viewport.name === "tablet") throw new Error("canvas blocked");
        return capture(viewport.name);
      },
      restore,
    });

    expect(result.captures.map((item) => item.viewport.name)).toEqual([
      "desktop",
      "mobile",
    ]);
    expect(result.errors).toEqual(["tablet: canvas blocked"]);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("captures an explicit subset in caller order", async () => {
    const captured: string[] = [];
    const requested = [DESIGN_REVIEW_VIEWPORTS[2], DESIGN_REVIEW_VIEWPORTS[0]];
    const result = await collectDesignReviewCaptures({
      viewports: requested,
      prepareViewport: async () => undefined,
      captureViewport: async (viewport) => {
        captured.push(viewport.name);
        return capture(viewport.name);
      },
      restore: () => undefined,
    });

    expect(captured).toEqual(["mobile", "desktop"]);
    expect(result.captures.map((item) => item.viewport.name)).toEqual([
      "mobile",
      "desktop",
    ]);
  });

  it("restores after cancellation", async () => {
    const controller = new AbortController();
    const restore = vi.fn();
    await expect(
      collectDesignReviewCaptures({
        prepareViewport: async () => controller.abort(),
        captureViewport: async (viewport) => capture(viewport.name),
        restore,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(restore).toHaveBeenCalledOnce();
  });
});

describe("capture synchronization recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function fixture() {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const controller = new AbortController();
    const state = { ready: false, current: true, projectionReady: true };
    const restart = vi.fn(async () => {});
    const wait = () =>
      waitForPreviewSynchronization({
        isReady: () => state.ready,
        canRestart: () => state.projectionReady,
        isCurrent: () => state.current,
        restart,
        signal: controller.signal,
        timeoutMs: 10,
      });
    return { controller, state, restart, wait };
  }

  it("returns without restarting an already synchronized preview", async () => {
    const { state, restart, wait } = fixture();
    state.ready = true;
    await wait();
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts once after the first window and waits for both restart and synchronization", async () => {
    const { state, restart, wait } = fixture();
    let finish!: () => void;
    restart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let completed = false;
    const result = wait().then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(29);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restart).toHaveBeenCalledOnce();
    state.ready = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(completed).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(15);
    await result;
    expect(completed).toBe(true);
    expect(restart).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pending restart", "unsynchronized client"])(
    "bounds a %s without another restart",
    async (mode) => {
      const { restart, wait } = fixture();
      let rejectLate!: (reason: Error) => void;
      if (mode === "pending restart")
        restart.mockImplementation(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectLate = reject;
            }),
        );
      const result = wait().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60);
      expect(await result).toMatchObject({
        message: expect.stringContaining("after restarting"),
      });
      expect(restart).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      if (rejectLate) rejectLate(new Error("late restart rejection"));
      await Promise.resolve();
    },
  );

  it("reports a rejected restart without a second attempt", async () => {
    const { restart, wait } = fixture();
    restart.mockRejectedValue(new Error("client creation failed"));
    const result = wait().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(55);
    expect(await result).toMatchObject({
      message: "Preview client restart failed: client creation failed",
    });
    expect(restart).toHaveBeenCalledOnce();
  });

  it("does not restart an incomplete asset/runtime projection", async () => {
    const { state, restart, wait } = fixture();
    state.projectionReady = false;
    const result = wait().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject({
      message: "Screenshot runtime has not reached the current preview client.",
    });
    expect(restart).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "stops cancellation or supersession with recovery started=%s",
    async (recovering) => {
      for (const action of ["abort", "supersede"] as const) {
        const { controller, state, restart, wait } = fixture();
        let finish!: () => void;
        restart.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
        const handshake = vi.fn();
        const result = wait()
          .then(handshake)
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(recovering ? 30 : 5);
        if (action === "abort") controller.abort();
        else state.current = false;
        await vi.advanceTimersByTimeAsync(25);
        expect(await result).toMatchObject(
          action === "abort"
            ? { name: "AbortError" }
            : { code: "stale_generation" },
        );
        expect(restart).toHaveBeenCalledTimes(recovering ? 1 : 0);
        if (finish) finish();
        state.ready = true;
        await vi.advanceTimersByTimeAsync(100);
        expect(handshake).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );
});

describe("capture runtime script entry", () => {
  it.each(["browser", "bundler"])(
    "publishes the actual UMD exports through the host-owned handle in %s",
    async (environment) => {
      const source = await loadDesignCaptureRuntimeSource();
      expect(captureCanvasAdapterSource).not.toMatch(/\?\.|\?\?/);
      const unsupported: string[] = [];
      function inspect(node: Node): void {
        if (
          node.kind === SyntaxKind.QuestionDotToken ||
          node.kind === SyntaxKind.QuestionQuestionToken
        )
          unsupported.push(node.getText());
        forEachChild(node, inspect);
      }
      inspect(
        createSourceFile(
          "capture-runtime.js",
          source,
          ScriptTarget.ES2017,
          true,
          ScriptKind.JS,
        ),
      );
      expect(unsupported).toEqual([]);
      expect(source).toContain(
        captureCanvasAdapterSource.replace(/^export default /m, ""),
      );
      const outerExports = {};
      const define = Object.assign(vi.fn(), { amd: true });
      const context: Record<string, unknown> =
        environment === "bundler"
          ? { exports: outerExports, module: { exports: outerExports }, define }
          : {};
      runInNewContext(source, context);
      expect(context[DESIGN_CAPTURE_RUNTIME_GLOBAL]).toHaveProperty(
        "toCanvas",
        expect.any(Function),
      );
      expect(context.htmlToImage).toBeUndefined();
      expect(outerExports).toEqual({});
      expect(define).not.toHaveBeenCalled();
    },
  );
});

type ImageBehavior =
  "success" | "load-error" | "decode-error" | "load-timeout" | "decode-timeout";
function canvasRuntime(behaviors: ImageBehavior[]) {
  const events: string[] = [];
  const images: FakeImage[] = [];
  let active = 0;
  let maxActive = 0;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    complete = true;
    naturalWidth = 100;
    naturalHeight = 50;
    crossOrigin = null;
    value = "";
    readonly index = images.length;
    readonly behavior: ImageBehavior;
    constructor() {
      this.behavior = behaviors[this.index] ?? "success";
      images.push(this);
    }
    set src(value: string) {
      this.value = value;
      if (!value) return;
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${this.index}`);
      queueMicrotask(() => {
        if (!this.value || this.behavior === "load-timeout") return;
        if (this.behavior === "load-error") this.onerror?.();
        else this.onload?.();
      });
    }
    get src() {
      return this.value;
    }
    decode() {
      if (this.behavior === "decode-error")
        return Promise.reject(new Error("decode rejected"));
      if (this.behavior === "decode-timeout")
        return new Promise<void>(() => {});
      return Promise.resolve();
    }
    removeAttribute(name: string) {
      if (name === "src" && this.value) {
        this.value = "";
        active -= 1;
        events.push(`clear:${this.index}`);
      }
    }
  }
  const drawImage = vi.fn((image: FakeImage) => {
    expect(image.src).toContain("data:image/svg+xml");
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage, fillRect: vi.fn() }),
  };
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", { createElement: () => canvas });
  const runtime = {
    toSvg: vi.fn(async () => "data:image/svg+xml,<svg></svg>"),
    toCanvas: vi.fn(
      async (
        _node: HTMLElement,
        _options: {
          canvasWidth: number;
          canvasHeight: number;
          pixelRatio: number;
          signal?: AbortSignal;
        },
      ) => canvas as unknown as HTMLCanvasElement,
    ),
  };
  runInNewContext(
    `${captureCanvasAdapterSource.replace(/^export default /m, "")}\ninstallCaptureCanvasAdapter(runtime);`,
    {
      runtime,
      Image: FakeImage,
      document: { createElement: () => canvas },
      setTimeout,
      clearTimeout,
      DOMException,
      Error,
      Promise,
    },
  );
  return {
    runtime,
    canvas,
    images,
    events,
    drawImage,
    maxActive: () => maxActive,
    active: () => active,
  };
}
const captureOptions = { canvasWidth: 100, canvasHeight: 50, pixelRatio: 1 };

describe("controlled SVG image loading", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it.each(["load-error", "decode-error"] as const)(
    "settles %s and clears each failed image before retrying once",
    async (behavior) => {
      const fixture = canvasRuntime([behavior, behavior]);
      await expect(
        fixture.runtime.toCanvas({} as HTMLElement, captureOptions),
      ).rejects.toThrow(
        behavior === "load-error" ? "failed to load" : "decode rejected",
      );
      expect(fixture.events).toEqual([
        "start:0",
        "clear:0",
        "start:1",
        "clear:1",
      ]);
      expect(fixture.maxActive()).toBe(1);
      expect(fixture.drawImage).not.toHaveBeenCalled();
    },
  );
  it("draws only the second successfully decoded image and releases it", async () => {
    const fixture = canvasRuntime(["decode-error", "success"]);
    expect(
      await fixture.runtime.toCanvas({} as HTMLElement, captureOptions),
    ).toBe(fixture.canvas);
    expect(fixture.drawImage).toHaveBeenCalledWith(
      fixture.images[1],
      0,
      0,
      100,
      50,
    );
    expect(fixture.canvas.width).toBe(100);
    expect(fixture.canvas.height).toBe(50);
    expect(fixture.events).toEqual([
      "start:0",
      "clear:0",
      "start:1",
      "clear:1",
    ]);
    expect(fixture.maxActive()).toBe(1);
    expect(fixture.active()).toBe(0);
    expect(
      fixture.images.every(
        (image) =>
          image.onload === null &&
          image.onerror === null &&
          image.crossOrigin === null,
      ),
    ).toBe(true);
  });
  it.each(["load-timeout", "decode-timeout"] as const)(
    "settles %s within two bounded attempts",
    async (behavior) => {
      vi.useFakeTimers();
      const fixture = canvasRuntime([behavior, behavior]);
      const result = fixture.runtime
        .toCanvas({} as HTMLElement, captureOptions)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({
        message: "Screenshot image load/decode timed out.",
      });
      expect(fixture.images).toHaveLength(2);
      expect(fixture.maxActive()).toBe(1);
      expect(fixture.active()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(fixture.drawImage).not.toHaveBeenCalled();
    },
  );
  it("aborts an in-flight decode immediately without a retry", async () => {
    vi.useFakeTimers();
    const fixture = canvasRuntime(["decode-timeout"]);
    const controller = new AbortController();
    const result = fixture.runtime
      .toCanvas({} as HTMLElement, {
        ...captureOptions,
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(fixture.images).toHaveLength(1);
    expect(fixture.active()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
