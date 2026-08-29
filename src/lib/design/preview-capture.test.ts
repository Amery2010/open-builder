import { describe, expect, it, vi } from "vitest";
import {
  collectDesignReviewCaptures,
  DESIGN_REVIEW_VIEWPORTS,
  isDesignReviewViewportReady,
} from "./preview-capture";
import type { DesignBridgeCaptureResult } from "./preview-bridge";

function capture(name: "desktop" | "tablet" | "mobile") {
  return {
    viewport: { name },
  } as DesignBridgeCaptureResult;
}

describe("Design preview capture sequence", () => {
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
