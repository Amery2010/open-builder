// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIsolatedPreviewSession,
  type IsolatedPreviewBootstrap,
} from "./prototype-preview-session";
import { DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS } from "./preview-bridge";

const controllers: AbortController[] = [];

function setupSession(
  bootstrap?: IsolatedPreviewBootstrap,
  sourceUrl = "about:blank",
) {
  const source = document.createElement("iframe");
  source.src = sourceUrl;
  const controller = new AbortController();
  controllers.push(controller);
  const session = createIsolatedPreviewSession(
    source,
    "generation-1",
    controller.signal,
    bootstrap,
  );
  const frame = Array.from(
    document.querySelectorAll<HTMLIFrameElement>(
      'iframe[title="Temporary prototype review preview"]',
    ),
  ).at(-1)!;
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
      version: 2,
      generation,
      captureRuntimeAvailable: true,
      route: "#/dashboard",
    });
  return { source, session, frame, controller, post, reply, ready };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("isolated prototype preview session", () => {
  it("uses a fresh Nodebox document URL for each capture without changing the active preview", async () => {
    const url =
      "https://abc123-5173.nodebox.codesandbox.io/start?lang=zh&tag=a&tag=b#/home?tab=one";
    const first = setupSession(undefined, url);
    const second = setupSession(undefined, url);
    const settled = [first.session, second.session].map((session) =>
      session.catch(() => undefined),
    );
    try {
      const capturedUrl = new URL(first.frame.src);
      expect(capturedUrl.origin).toBe(new URL(url).origin);
      expect(capturedUrl.pathname).toBe("/start");
      expect(capturedUrl.searchParams.get("lang")).toBe("zh");
      expect(capturedUrl.searchParams.getAll("tag")).toEqual(["a", "b"]);
      expect(capturedUrl.hash).toBe("#/home?tab=one");
      expect(capturedUrl.searchParams.get("__ob_capture")).toBeTruthy();
      expect(first.frame.src).not.toBe(second.frame.src);
      expect(first.source.src).toBe(url);
      expect(second.source.src).toBe(url);
    } finally {
      first.controller.abort();
      second.controller.abort();
      await Promise.all(settled);
    }
    expect(first.frame.isConnected).toBe(false);
    expect(second.frame.isConnected).toBe(false);
  });

  it.each([
    "https://example.test/page?lang=zh#/home",
    "https://preview.sandpack-static-server.codesandbox.io/",
    "https://abc123-5173.nodebox.codesandbox.io.example.test/",
    "http://abc123-5173.nodebox.codesandbox.io/",
  ])("preserves non-Nodebox document URL %s", async (url) => {
    const setup = setupSession(undefined, url);
    const settled = setup.session.catch(() => undefined);
    try {
      expect(setup.frame.src).toBe(url);
    } finally {
      setup.controller.abort();
      await settled;
    }
  });

  it("installs readiness listeners before bootstrapping and releases the compiled client", async () => {
    const release = vi.fn();
    const bootstrap = vi.fn(async (frame: HTMLIFrameElement) => {
      expect(frame.isConnected).toBe(true);
      expect(frame.hasAttribute("data-ob-isolated-preview")).toBe(true);
      expect(frame.classList.contains("sp-preview-iframe")).toBe(false);
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "null",
          data: {
            type: "open-builder:design-bridge-ready",
            version: 2,
            generation: "generation-1",
            captureRuntimeAvailable: true,
          },
        }),
      );
      return release;
    });
    const setup = setupSession(bootstrap);
    const active = await setup.session;
    expect(bootstrap).toHaveBeenCalledOnce();
    active.dispose();
    active.dispose();
    expect(release).toHaveBeenCalledOnce();
    expect(setup.frame.isConnected).toBe(false);
  });

  it.each(["abort", "timeout"])(
    "releases a client arriving after bootstrap %s",
    async (reason) => {
      vi.useFakeTimers();
      const release = vi.fn();
      let finish!: (release: () => void) => void;
      let bootstrapSignal!: AbortSignal;
      const setup = setupSession(async (_frame, signal) => {
        bootstrapSignal = signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const rejected = expect(setup.session).rejects.toMatchObject(
        reason === "abort"
          ? { name: "AbortError" }
          : { message: "Temporary prototype preview did not become ready." },
      );
      await vi.advanceTimersByTimeAsync(0);
      if (reason === "abort") setup.controller.abort();
      else
        await vi.advanceTimersByTimeAsync(DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS * 3);
      await rejected;
      expect(bootstrapSignal.aborted).toBe(true);
      expect(setup.frame.isConnected).toBe(false);
      finish(release);
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects bootstrap failures even when readiness arrived first", async () => {
    let fail!: (error: Error) => void;
    const setup = setupSession(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const rejected = expect(setup.session).rejects.toThrow("Compiler failed");
    setup.ready();
    await Promise.resolve();
    fail(new Error("Compiler failed"));
    await rejected;
    expect(setup.frame.isConnected).toBe(false);
  });

  it("uses the bootstrapped iframe origin for requests and rejects replies from the old origin", async () => {
    const release = vi.fn();
    const setup = setupSession(async (frame) => {
      frame.src = "https://compiled-preview.example.test/";
      return release;
    });
    await Promise.resolve();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: setup.frame.contentWindow,
        origin: "https://compiled-preview.example.test",
        data: {
          type: "open-builder:design-bridge-ready",
          version: 2,
          generation: "generation-1",
          captureRuntimeAvailable: true,
        },
      }),
    );
    const active = await setup.session;
    const post = vi
      .spyOn(setup.frame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    const target = { pageId: "home", route: "#/home" };
    const pending = active.navigate(target);
    const message = post.mock.calls[0][0];
    expect(post.mock.calls[0][1]).toBe("https://compiled-preview.example.test");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    setup.reply({
      ...message,
      type: "open-builder:design-bridge-navigation-result",
      payload: { target, route: target.route },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: setup.frame.contentWindow,
        origin: "https://compiled-preview.example.test",
        data: {
          ...message,
          type: "open-builder:design-bridge-navigation-result",
          payload: { target, route: target.route },
        },
      }),
    );
    await expect(pending).resolves.toEqual(target);
    active.dispose();
    expect(release).toHaveBeenCalledOnce();
  });

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
