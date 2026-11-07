import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesignBridgeCaptureResult } from "./preview-bridge";
import { PreviewRuntimeError } from "./preview-runtime";
import {
  createCanvasPreviewQueue,
  type CanvasPreviewRequest,
  type CanvasPreviewSnapshot,
} from "./canvas-preview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function request(pageId: string, generation = "a"): CanvasPreviewRequest {
  return {
    key: `${generation}:${pageId}:desktop`,
    pageId,
    target: { pageId, route: `#/${pageId}` },
    viewport: { name: "desktop", width: 1440, height: 900 },
  };
}

function result(generation = "a"): DesignBridgeCaptureResult {
  return {
    generation,
    dataUrl: "data:image/png;base64,image",
    mimeType: "image/png",
    capture: {
      scope: "full-page",
      region: { x: 0, y: 0, width: 1440, height: 5000 },
      scale: 0.5,
    },
    viewport: {
      name: "desktop",
      width: 1440,
      height: 900,
      capturedHeight: 5000,
      fullHeight: 5000,
      truncated: false,
    },
    semanticSnapshot: {
      route: "#/home",
      viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
      document: {
        scrollWidth: 1440,
        scrollHeight: 5000,
        horizontalOverflow: false,
        fonts: "ready",
      },
      elements: [],
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("canvas preview queue", () => {
  it("serializes captures, prioritizes visible pages, and keeps CSS geometry", async () => {
    const gates = [
      deferred<DesignBridgeCaptureResult>(),
      deferred<DesignBridgeCaptureResult>(),
    ];
    const capture =
      vi.fn<
        (
          request: CanvasPreviewRequest,
          signal: AbortSignal,
        ) => Promise<DesignBridgeCaptureResult>
      >();
    capture.mockImplementationOnce(() => gates[0].promise);
    capture.mockImplementationOnce(() => gates[1].promise);
    const onChange = vi.fn<(snapshot: CanvasPreviewSnapshot) => void>();
    const queue = createCanvasPreviewQueue({ capture, onChange });
    const home = request("home");
    const detail = request("detail");
    queue.setRequests([home, detail], ["detail"]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0]).toEqual(detail);
    gates[0].resolve(result());
    await settle();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1][0]).toEqual(home);
    gates[1].resolve(result());
    await settle();
    expect(onChange.mock.lastCall?.[0][detail.key]).toMatchObject({
      status: "ready",
      result: {
        capture: { region: { width: 1440, height: 5000 }, scale: 0.5 },
      },
    });
    queue.dispose();
  });

  it("changes pending priority without interrupting the current capture", async () => {
    const gate = deferred<DesignBridgeCaptureResult>();
    const capture = vi
      .fn<
        (
          request: CanvasPreviewRequest,
          signal: AbortSignal,
        ) => Promise<DesignBridgeCaptureResult>
      >(async () => result())
      .mockImplementationOnce(() => gate.promise);
    const queue = createCanvasPreviewQueue({ capture, onChange: vi.fn() });
    queue.setRequests([request("first"), request("second"), request("third")]);
    queue.setPriorityPages(["third"]);
    expect(capture).toHaveBeenCalledTimes(1);
    gate.resolve(result());
    await settle();
    expect(
      capture.mock.calls.map(
        (args) => (args[0] as CanvasPreviewRequest).pageId,
      ),
    ).toEqual(["first", "third", "second"]);
    queue.dispose();
  });

  it("keeps in-flight work and cached images across equivalent request updates", async () => {
    const gate = deferred<DesignBridgeCaptureResult>();
    const capture = vi.fn(async () => gate.promise);
    const onChange = vi.fn();
    const queue = createCanvasPreviewQueue({ capture, onChange });
    queue.setRequests([request("home")]);
    queue.setRequests([request("home")]);
    gate.resolve(result());
    await settle();
    queue.setRequests([request("home")]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(onChange.mock.lastCall?.[0][request("home").key].status).toBe(
      "ready",
    );
    queue.dispose();
  });

  it("rejects late old-generation images and waits for cancellation cleanup", async () => {
    const old = deferred<DesignBridgeCaptureResult>();
    let signal!: AbortSignal;
    const capture = vi
      .fn(async (_request: CanvasPreviewRequest, nextSignal: AbortSignal) => {
        signal = nextSignal;
        return old.promise;
      })
      .mockImplementationOnce(async (_request, nextSignal) => {
        signal = nextSignal;
        return old.promise;
      })
      .mockImplementationOnce(async () => result("b"));
    const onChange = vi.fn();
    const queue = createCanvasPreviewQueue({ capture, onChange });
    queue.setRequests([request("home")]);
    queue.setRequests([request("home", "b")]);
    expect(signal.aborted).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    old.resolve(result());
    await settle();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(onChange.mock.lastCall?.[0]).toEqual({
      [request("home", "b").key]: { status: "ready", result: result("b") },
    });
    queue.dispose();
  });

  it("does not revive a removed and re-added key with an old result", async () => {
    const gate = deferred<DesignBridgeCaptureResult>();
    const capture = vi
      .fn(async () => result("new"))
      .mockImplementationOnce(() => gate.promise);
    const onChange = vi.fn();
    const queue = createCanvasPreviewQueue({ capture, onChange });
    queue.setRequests([request("home")]);
    queue.setRequests([]);
    queue.setRequests([request("home")]);
    gate.resolve(result("old"));
    await settle();
    expect(
      onChange.mock.lastCall?.[0][request("home").key].result.generation,
    ).toBe("new");
    queue.dispose();
  });

  it.each([
    new PreviewRuntimeError("capture_busy", "Foreground capture is active"),
    new DOMException("Canvas yielded to annotation", "AbortError"),
  ])(
    "defers a busy or preempted capture until a later attempt",
    async (error) => {
      vi.useFakeTimers();
      const capture = vi.fn(async () => result()).mockRejectedValueOnce(error);
      const onChange = vi.fn();
      const queue = createCanvasPreviewQueue({ capture, onChange });
      queue.setRequests([request("home")]);
      await settle();
      expect(capture).toHaveBeenCalledTimes(1);
      expect(onChange.mock.lastCall?.[0][request("home").key].status).toBe(
        "queued",
      );
      await vi.advanceTimersByTimeAsync(150);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(onChange.mock.lastCall?.[0][request("home").key].status).toBe(
        "ready",
      );
      queue.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reports failures once and retries only when requested", async () => {
    vi.useFakeTimers();
    const capture = vi
      .fn(async () => result())
      .mockRejectedValueOnce(new Error("Image could not be captured"));
    const onChange = vi.fn();
    const queue = createCanvasPreviewQueue({ capture, onChange });
    const home = request("home");
    queue.setRequests([home]);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(onChange.mock.lastCall?.[0][home.key]).toEqual({
      status: "error",
      error: "Image could not be captured",
    });
    queue.retry(home.key);
    await settle();
    expect(onChange.mock.lastCall?.[0][home.key].status).toBe("ready");
    queue.dispose();
  });

  it("pauses capture and resumes queued work without discarding ready images", async () => {
    const gate = deferred<DesignBridgeCaptureResult>();
    const capture = vi
      .fn(async (_request: CanvasPreviewRequest, _signal: AbortSignal) =>
        result(),
      )
      .mockImplementationOnce(async () => result())
      .mockImplementationOnce(() => gate.promise);
    const onChange = vi.fn();
    const queue = createCanvasPreviewQueue({ capture, onChange });
    queue.setRequests([request("home"), request("detail")]);
    await settle();
    queue.setPaused(true);
    expect(capture.mock.calls[1][1].aborted).toBe(true);
    gate.resolve(result());
    await settle();
    expect(onChange.mock.lastCall?.[0][request("home").key].status).toBe(
      "ready",
    );
    expect(onChange.mock.lastCall?.[0][request("detail").key].status).toBe(
      "queued",
    );
    queue.setPaused(false);
    await settle();
    expect(capture).toHaveBeenCalledTimes(3);
    queue.dispose();
  });

  it("disposes pending captures and retry timers without publishing later results", async () => {
    vi.useFakeTimers();
    const gate = deferred<DesignBridgeCaptureResult>();
    const capture = vi.fn(
      async (_request: CanvasPreviewRequest, _signal: AbortSignal) =>
        gate.promise,
    );
    const onChange = vi.fn();
    const queue = createCanvasPreviewQueue({ capture, onChange });
    queue.setRequests([request("home"), request("detail")]);
    queue.dispose();
    expect(capture.mock.calls[0][1].aborted).toBe(true);
    const published = onChange.mock.calls.length;
    gate.resolve(result());
    await settle();
    queue.setRequests([request("another")]);
    queue.retry(request("home").key);
    expect(onChange).toHaveBeenCalledTimes(published);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const busyQueue = createCanvasPreviewQueue({
      capture: vi.fn(async () => {
        throw new PreviewRuntimeError("capture_busy", "busy");
      }),
      onChange: vi.fn(),
    });
    busyQueue.setRequests([request("home")]);
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    busyQueue.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
