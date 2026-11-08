import { describe, expect, it, vi } from "vitest";
import { captureAnnotationPreview, capturePreviewImage } from "./capture";
import {
  isPreviewCaptureBusy,
  registerPreviewRuntime,
  withPreviewCaptureLock,
  type PreviewRuntimeAdapter,
} from "../design/preview-runtime";
import type { DesignBridgeAnnotationCaptureResult } from "../design/preview-bridge";

function fixture() {
  let generation = "first-generation";
  const result = {
    generation,
    blob: new Blob(["image"], { type: "image/png" }),
  } as DesignBridgeAnnotationCaptureResult;
  const runtime: PreviewRuntimeAdapter = {
    getGeneration: () => generation,
    prepare: vi.fn(),
    capture: vi.fn(),
    prepareCurrent: vi.fn(async () => {}),
    captureAnnotation: vi.fn(async () => result),
  };
  return {
    runtime,
    result,
    change: () => {
      generation = "next-generation";
    },
  };
}

describe("annotation capture", () => {
  it("gives screenshot capture its own lock ownership and preserves full-page source pixels", async () => {
    const { runtime, result } = fixture();
    const dispose = registerPreviewRuntime("screenshot", runtime);
    try {
      await expect(
        capturePreviewImage(
          "screenshot",
          new AbortController().signal,
          "full-page",
          "screenshot",
        ),
      ).resolves.toBe(result);
      expect(runtime.captureAnnotation).toHaveBeenCalledWith(
        "first-generation",
        expect.any(AbortSignal),
        "full-page",
      );
      expect(runtime.capture).not.toHaveBeenCalled();
      expect(isPreviewCaptureBusy("screenshot")).toBe(false);
    } finally {
      dispose();
    }
  });
  it("uses only the current viewport and releases the shared lock before editing", async () => {
    const { runtime, result } = fixture();
    const dispose = registerPreviewRuntime("annotation", runtime);
    try {
      await expect(
        captureAnnotationPreview("annotation", new AbortController().signal),
      ).resolves.toBe(result);
      expect(runtime.prepare).not.toHaveBeenCalled();
      expect(runtime.capture).not.toHaveBeenCalled();
      expect(runtime.captureAnnotation).toHaveBeenCalledWith(
        "first-generation",
        expect.any(AbortSignal),
        "viewport",
      );
      expect(isPreviewCaptureBusy("annotation")).toBe(false);
    } finally {
      dispose();
    }
  });

  it("passes full-page scope to the raw annotation capture seam", async () => {
    const { runtime, result } = fixture();
    const dispose = registerPreviewRuntime("annotation-full", runtime);
    try {
      await expect(
        captureAnnotationPreview(
          "annotation-full",
          new AbortController().signal,
          "full-page",
        ),
      ).resolves.toBe(result);
      expect(runtime.captureAnnotation).toHaveBeenCalledWith(
        "first-generation",
        expect.any(AbortSignal),
        "full-page",
      );
    } finally {
      dispose();
    }
  });

  it("rejects capture races without cancelling the other owner", async () => {
    const { runtime } = fixture();
    const dispose = registerPreviewRuntime("busy-annotation", runtime);
    let release!: () => void;
    const active = withPreviewCaptureLock({
      conversationId: "busy-annotation",
      owner: "manual-review",
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    try {
      await expect(
        captureAnnotationPreview(
          "busy-annotation",
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "capture_busy" });
      expect(isPreviewCaptureBusy("busy-annotation")).toBe(true);
      expect(runtime.captureAnnotation).not.toHaveBeenCalled();
    } finally {
      release();
      await active;
      dispose();
    }
  });

  it.each(["prepare", "capture", "result"])(
    "rejects generation changes at %s",
    async (step) => {
      const { runtime, change, result } = fixture();
      if (step === "prepare")
        runtime.prepareCurrent = vi.fn(async () => {
          change();
        });
      if (step === "capture")
        runtime.captureAnnotation = vi.fn(async () => {
          change();
          return result;
        });
      if (step === "result") result.generation = "older-generation";
      const dispose = registerPreviewRuntime("stale-annotation", runtime);
      try {
        await expect(
          captureAnnotationPreview(
            "stale-annotation",
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ code: "stale_generation" });
        expect(isPreviewCaptureBusy("stale-annotation")).toBe(false);
      } finally {
        dispose();
      }
    },
  );

  it("rejects a late capture after its preview unregisters", async () => {
    const { runtime, result } = fixture();
    let release!: (value: DesignBridgeAnnotationCaptureResult) => void;
    runtime.captureAnnotation = vi.fn(
      () =>
        new Promise<DesignBridgeAnnotationCaptureResult>((resolve) => {
          release = resolve;
        }),
    );
    const dispose = registerPreviewRuntime("gone-annotation", runtime);
    const pending = captureAnnotationPreview(
      "gone-annotation",
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(runtime.captureAnnotation).toHaveBeenCalledOnce(),
    );
    dispose();
    release(result);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
