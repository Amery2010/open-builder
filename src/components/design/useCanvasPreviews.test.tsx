// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useCanvasPreviews } from "./useCanvasPreviews";
import type { CanvasPreviewRequest } from "../../lib/design/canvas-preview";
import type { DesignBridgeCaptureResult } from "../../lib/design/preview-bridge";

function request(
  pageId: string,
  source = "a",
  device: "desktop" | "mobile" = "desktop",
  generation = "runtime-a",
): CanvasPreviewRequest {
  return {
    key: `${pageId}:${source}:${device}`,
    generation,
    pageId,
    viewport: {
      name: device,
      width: device === "desktop" ? 1440 : 375,
      height: device === "desktop" ? 900 : 667,
    },
  };
}
function result(request: CanvasPreviewRequest): DesignBridgeCaptureResult {
  return {
    generation: request.generation,
    dataUrl: `data:image/png;base64,${request.key}`,
  } as DesignBridgeCaptureResult;
}

it("keeps the same image through focused/code mode and viewport round trips", async () => {
  const capture = vi.fn(async (request: CanvasPreviewRequest) =>
    result(request),
  );
  const home = request("home");
  const initial = {
    scopeKey: "workspace:environment-1",
    requests: [home],
    paused: false,
    capture,
  };
  const hook = renderHook((props) => useCanvasPreviews(props), {
    initialProps: initial,
  });
  await waitFor(() =>
    expect(hook.result.current.previews[home.key]?.status).toBe("ready"),
  );
  const image = hook.result.current.previews[home.key];
  hook.rerender({ ...initial, paused: true });
  hook.rerender({ ...initial, requests: [], paused: true });
  hook.rerender(initial);
  expect(hook.result.current.previews[home.key]).toBe(image);
  expect(capture).toHaveBeenCalledOnce();
  const mobile = request("home", "a", "mobile");
  hook.rerender({ ...initial, requests: [mobile] });
  await waitFor(() =>
    expect(hook.result.current.previews[mobile.key]?.status).toBe("ready"),
  );
  hook.rerender(initial);
  expect(hook.result.current.previews[home.key]).toBe(image);
  expect(capture).toHaveBeenCalledTimes(2);
  hook.unmount();
});

it("refreshes changed sources only, while an environment restart refreshes all images", async () => {
  const capture = vi.fn(async (request: CanvasPreviewRequest) =>
    result(request),
  );
  const home = request("home");
  const about = request("about");
  const initial = {
    scopeKey: "environment-1",
    requests: [home, about],
    paused: false,
    capture,
  };
  const hook = renderHook((props) => useCanvasPreviews(props), {
    initialProps: initial,
  });
  await waitFor(() =>
    expect(hook.result.current.previews[about.key]?.status).toBe("ready"),
  );
  const cachedAbout = hook.result.current.previews[about.key];
  const next = {
    ...initial,
    requests: [
      request("home", "b", "desktop", "runtime-b"),
      { ...about, generation: "runtime-b" },
    ],
  };
  hook.rerender(next);
  await waitFor(() =>
    expect(hook.result.current.previews[next.requests[0].key]?.status).toBe(
      "ready",
    ),
  );
  expect(capture).toHaveBeenCalledTimes(3);
  expect(hook.result.current.previews[about.key]).toBe(cachedAbout);
  expect(cachedAbout.result?.generation).toBe("runtime-a");
  hook.rerender({ ...next, scopeKey: "environment-2" });
  await waitFor(() =>
    expect(hook.result.current.previews[about.key]?.result?.generation).toBe(
      "runtime-b",
    ),
  );
  expect(capture).toHaveBeenCalledTimes(5);
  hook.unmount();
});

it("retries a single cached image explicitly without invalidating another page", async () => {
  const capture = vi.fn(async (request: CanvasPreviewRequest) =>
    result(request),
  );
  const requests = [request("home"), request("about")];
  const hook = renderHook(() =>
    useCanvasPreviews({
      scopeKey: "environment",
      requests,
      paused: false,
      capture,
    }),
  );
  await waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
  await act(async () => hook.result.current.retry(requests[0].key));
  expect(capture.mock.calls.map(([r]) => r.pageId)).toEqual([
    "home",
    "about",
    "home",
  ]);
  hook.unmount();
});

it("never caches an image that completes after its runtime was replaced", async () => {
  let resolveOld!: (value: DesignBridgeCaptureResult) => void;
  const capture = vi
    .fn(async (request: CanvasPreviewRequest, _signal: AbortSignal) =>
      result(request),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
  const home = request("home");
  const initial = { scopeKey: "old", requests: [home], paused: false, capture };
  const hook = renderHook((props) => useCanvasPreviews(props), {
    initialProps: initial,
  });
  await waitFor(() => expect(capture).toHaveBeenCalledOnce());
  const updated = { ...home, generation: "runtime-b" };
  hook.rerender({ ...initial, scopeKey: "new", requests: [updated] });
  expect(capture.mock.calls[0][1].aborted).toBe(true);
  await waitFor(() =>
    expect(hook.result.current.previews[home.key]?.result?.generation).toBe(
      "runtime-b",
    ),
  );
  await act(async () => resolveOld(result(home)));
  expect(hook.result.current.previews[home.key]?.result?.generation).toBe(
    "runtime-b",
  );
  hook.unmount();
});
