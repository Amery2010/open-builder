// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedPreviewSession } from "./prototype-preview-session";
import { DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS } from "./preview-bridge";

const controllers: AbortController[] = [];

function setupSession() {
  const source = document.createElement("iframe");
  source.src = "about:blank";
  const controller = new AbortController();
  controllers.push(controller);
  const session = createIsolatedPreviewSession(
    source,
    "generation-1",
    controller.signal,
  );
  const frame = document.querySelector<HTMLIFrameElement>(
    'iframe[title="Temporary prototype review preview"]',
  )!;
  const post = vi
    .spyOn(frame.contentWindow!, "postMessage")
    .mockImplementation(() => {});
  const reply = (data: Record<string, unknown>) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "null",
        data,
      }),
    );
  const ready = (generation = "generation-1") =>
    reply({
      type: "open-builder:design-bridge-ready",
      version: 1,
      generation,
      captureRuntimeAvailable: true,
      route: "#/dashboard",
    });
  return { session, frame, controller, post, reply, ready };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("isolated prototype preview session", () => {
  it("accepts readiness and the original navigation response in later timeout windows", async () => {
    vi.useFakeTimers();
    const { session, frame, ready, post, reply } = setupSession();
    let readyError: unknown;
    void session.catch((error) => {
      readyError = error;
    });
    await vi.advanceTimersByTimeAsync(DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS + 1);
    expect(readyError).toBeUndefined();
    expect(frame.isConnected).toBe(true);
    ready();
    const active = await session;
    const target = {
      pageId: "dashboard",
      route: "#/dashboard",
      scenarioId: "default",
    };
    const navigation = active.navigate(target);
    let navigationError: unknown;
    void navigation.catch((error) => {
      navigationError = error;
    });
    await vi.advanceTimersByTimeAsync(DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS + 1);
    expect(navigationError).toBeUndefined();
    expect(post).toHaveBeenCalledOnce();
    const request = post.mock.calls[0][0];
    reply({
      ...request,
      type: "open-builder:design-bridge-navigation-result",
      payload: { target, route: target.route },
    });
    await expect(navigation).resolves.toEqual(target);
    active.dispose();
  });

  it("waits three windows before failing a single capture request", async () => {
    vi.useFakeTimers();
    const setup = setupSession();
    setup.ready();
    const active = await setup.session;
    let error: unknown;
    const capture = active
      .capture(
        { name: "desktop", width: 1440, height: 900 },
        {
          pageId: "dashboard",
          route: "#/dashboard",
          scenarioId: "default",
        },
      )
      .catch((cause) => {
        error = cause;
      });
    await vi.advanceTimersByTimeAsync(DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS * 2);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS);
    await capture;
    expect(error).toMatchObject({
      message: "Temporary prototype preview request timed out.",
    });
    expect(setup.post).toHaveBeenCalledOnce();
    active.dispose();
  });

  it.each(["abort", "dispose", "generation"])(
    "invalidates a waiting request immediately on %s",
    async (reason) => {
      vi.useFakeTimers();
      const setup = setupSession();
      setup.ready();
      const active = await setup.session;
      let error: unknown;
      const navigation = active
        .navigate({
          pageId: "dashboard",
          route: "#/dashboard",
          scenarioId: "default",
        })
        .catch((cause) => {
          error = cause;
        });
      await vi.advanceTimersByTimeAsync(DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS + 1);
      expect(error).toBeUndefined();
      if (reason === "abort") setup.controller.abort();
      else if (reason === "dispose") active.dispose();
      else setup.ready("generation-2");
      await vi.advanceTimersByTimeAsync(0);
      expect(error).toMatchObject(
        reason === "generation"
          ? { code: "stale_generation" }
          : { name: "AbortError" },
      );
      await navigation;
      expect(setup.post).toHaveBeenCalledOnce();
      expect(setup.frame.isConnected).toBe(false);
    },
  );

  it("does not append a temporary preview when review is already cancelled", async () => {
    const source = document.createElement("iframe");
    source.src = "about:blank";
    const controller = new AbortController();
    controller.abort();

    await expect(
      createIsolatedPreviewSession(source, "generation-1", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(
      document.querySelector(
        'iframe[title="Temporary prototype review preview"]',
      ),
    ).toBeNull();
  });
});
