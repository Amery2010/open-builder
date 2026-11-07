import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePreviewSequence,
  validatePreviewSequenceTimes,
} from "./preview-sequence";
import {
  isPreviewCaptureBusy,
  registerPreviewRuntime,
  type PreviewRuntimeAdapter,
} from "./preview-runtime";
import type { DesignBridgeCaptureResult } from "./preview-bridge";

const generation = "a".repeat(64);
function capture(): DesignBridgeCaptureResult {
  return {
    generation,
    dataUrl: "data:image/png;base64,AA==",
    mimeType: "image/png",
    viewport: {
      name: "desktop",
      width: 1440,
      height: 900,
      capturedHeight: 900,
      fullHeight: 1800,
      truncated: true,
    },
    semanticSnapshot: {
      viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
      route: "/",
      document: {
        scrollWidth: 1440,
        scrollHeight: 1800,
        horizontalOverflow: false,
        fonts: "ready",
      },
      elements: [],
    },
  };
}
function runtime(): PreviewRuntimeAdapter {
  return {
    getGeneration: () => generation,
    prepare: vi.fn(),
    capture: vi.fn(),
    prepareCurrent: vi.fn(async () => {}),
    captureCurrent: vi.fn(async () => capture()),
  };
}
afterEach(() => vi.useRealTimers());
describe("live preview sequence", () => {
  it("validates the complete schedule before touching the preview", async () => {
    for (const times of [
      [],
      [0, 0],
      [1, 0],
      [-1],
      [30001],
      [0.5],
      [0, 1, 2, 3, 4, 5],
    ])
      expect(() => validatePreviewSequenceTimes(times)).toThrow();
    expect(validatePreviewSequenceTimes(undefined)).toEqual([0]);
    expect(validatePreviewSequenceTimes([0, 500, 30000])).toEqual([
      0, 500, 30000,
    ]);
  });
  it("samples from readiness time without calling the refresh or resize adapter", async () => {
    vi.useFakeTimers();
    const adapter = runtime();
    adapter.prepareCurrent = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const dispose = registerPreviewRuntime("timed", adapter);
    try {
      const pending = capturePreviewSequence({
        conversationId: "timed",
        atMs: [0, 100, 300],
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(adapter.captureCurrent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(401);
      const result = await pending;
      expect(
        result.frames.map((frame) => Math.round(frame.startedAtMs)),
      ).toEqual([0, 100, 300]);
      expect(result.errors).toEqual([]);
      expect(adapter.prepare).not.toHaveBeenCalled();
      expect(adapter.capture).not.toHaveBeenCalled();
      expect(adapter.captureCurrent).toHaveBeenCalledWith(
        generation,
        expect.any(AbortSignal),
        { scope: "viewport" },
      );
      expect(isPreviewCaptureBusy("timed")).toBe(false);
    } finally {
      dispose();
    }
  });
  it("uses the selected full-page scope consistently across frames", async () => {
    vi.useFakeTimers();
    const adapter = runtime();
    const dispose = registerPreviewRuntime("full-page", adapter);
    try {
      const pending = capturePreviewSequence({
        conversationId: "full-page",
        atMs: [0, 100],
        scope: "full-page",
      });
      await vi.advanceTimersByTimeAsync(100);
      expect((await pending).frames).toHaveLength(2);
      expect(adapter.captureCurrent).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(adapter.captureCurrent!).mock.calls)
        expect(call[2]).toEqual({ scope: "full-page" });
    } finally {
      dispose();
    }
  });
  it("retains completed frames and releases the lock on cancellation", async () => {
    vi.useFakeTimers();
    const adapter = runtime();
    const dispose = registerPreviewRuntime("cancel", adapter);
    const controller = new AbortController();
    try {
      const pending = capturePreviewSequence({
        conversationId: "cancel",
        atMs: [0, 1000],
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new DOMException("Stopped", "AbortError"));
      const result = await pending;
      expect(result.frames).toHaveLength(1);
      expect(result.errorCode).toBe("aborted");
      expect(adapter.captureCurrent).toHaveBeenCalledOnce();
      expect(isPreviewCaptureBusy("cancel")).toBe(false);
    } finally {
      dispose();
    }
  });
  it("rejects a stale frame and does not continue after the project changes", async () => {
    const adapter = runtime();
    let current = generation;
    adapter.getGeneration = () => current;
    adapter.captureCurrent = vi.fn(async () => {
      current = "b".repeat(64);
      return capture();
    });
    const dispose = registerPreviewRuntime("stale", adapter);
    try {
      const result = await capturePreviewSequence({
        conversationId: "stale",
        atMs: [0, 1],
      });
      expect(result.errorCode).toBe("stale_generation");
      expect(result.frames[0].capture).toBeUndefined();
      expect(adapter.captureCurrent).toHaveBeenCalledOnce();
    } finally {
      dispose();
    }
  });
  it("keeps real late timestamps when a previous capture overruns the schedule", async () => {
    vi.useFakeTimers();
    const adapter = runtime();
    adapter.captureCurrent = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return capture();
    });
    const dispose = registerPreviewRuntime("late", adapter);
    try {
      const pending = capturePreviewSequence({
        conversationId: "late",
        atMs: [0, 50],
      });
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;
      expect(result.frames[1]).toMatchObject({
        scheduledAtMs: 50,
        startedAtMs: 200,
        durationMs: 200,
      });
    } finally {
      dispose();
    }
  });
});
