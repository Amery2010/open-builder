// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  DESIGN_BRIDGE_VIRTUAL_PATH,
  DESIGN_CAPTURE_RUNTIME_GLOBAL,
  injectDesignBridge,
} from "./preview-bridge";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=";
const cleanups: (() => void)[] = [];

async function preview(
  template = "vite-react-ts",
  body = '<div id="root"></div>',
) {
  const iframe = document.createElement("iframe");
  await new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
    document.body.appendChild(iframe);
  });
  vi.useFakeTimers();
  const frame = iframe.contentWindow as Window & typeof globalThis;
  cleanups.push(() =>
    frame.eval("window.__OPEN_BUILDER_DESIGN_BRIDGE_V1__?.dispose()"),
  );
  frame.document.body.innerHTML = body;
  let readyState = "interactive";
  let domContentLoadedEventStart = 0;
  Object.defineProperty(frame.document, "readyState", {
    configurable: true,
    get: () => readyState,
  });
  Object.defineProperty(frame.performance, "getEntriesByType", {
    configurable: true,
    value: () => [{ domContentLoadedEventStart }],
  });
  Object.defineProperty(frame.document, "fonts", {
    configurable: true,
    value: { status: "loading", ready: new Promise(() => {}) },
  });
  Object.defineProperty(frame, "parent", { configurable: true, value: frame });
  const messages: Record<string, unknown>[] = [];
  frame.postMessage = ((data: Record<string, unknown>) =>
    messages.push(data)) as typeof frame.postMessage;
  const captured: string[] = [];
  const toCanvas = vi.fn(async () => {
    captured.push(
      frame.document.getElementById("root")?.innerHTML ??
        frame.document.body.innerHTML,
    );
    return { toDataURL: () => png };
  });
  Object.defineProperty(frame, DESIGN_CAPTURE_RUNTIME_GLOBAL, {
    value: { toCanvas },
  });
  function install(generation = "readiness") {
    frame.eval(
      injectDesignBridge(
        { "index.html": `<body>${body}</body>` },
        template,
        true,
        "runtime",
        generation,
      ).files[DESIGN_BRIDGE_VIRTUAL_PATH],
    );
  }
  function send(type = "open-builder:design-bridge-capture") {
    frame.dispatchEvent(
      new frame.MessageEvent("message", {
        source: frame,
        origin: "http://localhost:5173",
        data: {
          type,
          version: 2,
          generation: "readiness",
          nonce: "readiness",
          requestId: "readiness",
          currentViewport: true,
          scope: "full-page",
          viewport: { name: "desktop", width: 1024, height: 768 },
        },
      }),
    );
  }
  return {
    frame,
    messages,
    captured,
    toCanvas,
    install,
    send,
    parsed() {
      domContentLoadedEventStart = 1;
      frame.document.dispatchEvent(new frame.Event("DOMContentLoaded"));
    },
    alreadyParsed() {
      domContentLoadedEventStart = 1;
    },
    complete() {
      readyState = "complete";
    },
  };
}

afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  document.body.innerHTML = "";
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("waits for DOMContentLoaded and the subsequent asynchronous React mount", async () => {
  const p = await preview();
  p.install();
  p.send();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.toCanvas).not.toHaveBeenCalled();
  p.parsed();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.toCanvas).not.toHaveBeenCalled();
  p.frame.setTimeout(() => {
    p.frame.document.getElementById("root")!.innerHTML = "<h1>Ready</h1>";
  }, 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(p.captured).toEqual(["<h1>Ready</h1>"]);
  expect(p.messages.at(-1)?.type).toBe(
    "open-builder:design-bridge-capture-result",
  );
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["img", "svg", "canvas"])(
  "captures a mounted %s immediately after DOMContentLoaded without waiting for load or fonts",
  async (tag) => {
    const p = await preview(
      "vite-react-ts",
      `<div id="root"><${tag}></${tag}></div>`,
    );
    p.alreadyParsed();
    p.install();
    p.send();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.toCanvas).toHaveBeenCalledOnce();
    p.send();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.toCanvas).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("allows an intentionally empty static page once its document is parsed", async () => {
  const p = await preview("static", "");
  p.complete();
  p.install();
  p.send();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.toCanvas).toHaveBeenCalledOnce();
});

it("does not mistake an empty auxiliary root for an unmounted application", async () => {
  const p = await preview(
    "vite-react-ts",
    '<div id="root"><canvas></canvas></div><div id="app"></div>',
  );
  p.alreadyParsed();
  p.install();
  p.send();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.toCanvas).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for an asynchronously attached shadow root without waiting for image loading", async () => {
  const p = await preview("vite-react-ts", "<app-root></app-root>");
  p.alreadyParsed();
  p.install();
  p.send();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.toCanvas).not.toHaveBeenCalled();
  p.frame.document
    .querySelector("app-root")!
    .attachShadow({ mode: "open" }).innerHTML = "<img>";
  await vi.advanceTimersByTimeAsync(50);
  expect(p.toCanvas).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects a mount that never renders instead of caching a blank screenshot", async () => {
  const p = await preview();
  p.alreadyParsed();
  p.install();
  p.send();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(p.toCanvas).not.toHaveBeenCalled();
  expect(p.messages.at(-1)).toMatchObject({
    type: "open-builder:design-bridge-capture-error",
    error: expect.stringContaining("content"),
  });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["document", "mount"])(
  "cancels a pending %s wait and disconnects its observer",
  async (stage) => {
    const p = await preview();
    if (stage === "mount") p.alreadyParsed();
    const disconnect = vi.spyOn(
      p.frame.MutationObserver.prototype,
      "disconnect",
    );
    p.install();
    p.send();
    await vi.advanceTimersByTimeAsync(0);
    p.send("open-builder:design-bridge-cancel-capture");
    await vi.advanceTimersByTimeAsync(0);
    expect(p.toCanvas).not.toHaveBeenCalled();
    expect(p.messages.at(-1)).toMatchObject({
      type: "open-builder:design-bridge-capture-error",
      error: expect.stringContaining("cancelled"),
    });
    expect(disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    disconnect.mockRestore();
  },
);

it("does not render or reply for a replaced generation while waiting for its mount", async () => {
  const p = await preview();
  p.alreadyParsed();
  p.install();
  p.send();
  await vi.advanceTimersByTimeAsync(0);
  p.install("replacement");
  p.frame.document.getElementById("root")!.textContent = "New content";
  await vi.advanceTimersByTimeAsync(0);
  expect(p.toCanvas).not.toHaveBeenCalled();
  expect(
    p.messages.some((m) => String(m.type).includes("capture-result")),
  ).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
