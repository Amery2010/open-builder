import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectDesignReviewCaptures,
  DESIGN_REVIEW_VIEWPORTS,
  isDesignReviewViewportReady,
  waitForPreviewReadiness,
} from "./preview-capture";
import type { DesignBridgeCaptureResult } from "./preview-bridge";

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
        { ...readiness, captureRuntimeReady: true, width: desktop.width - 5 },
        desktop,
      ),
    ).toBe(false);
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
