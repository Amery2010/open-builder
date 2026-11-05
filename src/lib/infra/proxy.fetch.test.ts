import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: undefined as
    ((event: { payload: Record<string, unknown> }) => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, listener: typeof native.listener) => {
    native.listener = listener;
    return vi.fn();
  }),
}));

beforeEach(async () => {
  vi.resetModules();
  native.listener = undefined;
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "sse_connect") {
      native.listener?.({
        payload: { type: "Connected", status: 200, headers: {} },
      });
    }
  });
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {},
    location: new URL("http://localhost"),
    fetch: vi.fn(async () => new Response("ordinary fetch")),
  });
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      open() {}
    },
  );
  vi.stubGlobal("localStorage", { getItem: () => null });
  const { installProxy, applyProxyPolicy } = await import("./proxy");
  installProxy();
  applyProxyPolicy(true, ["https://api.example.com"]);
});

afterEach(() => {
  native.listener?.({ payload: { type: "Done" } });
  vi.unstubAllGlobals();
});

describe("desktop fetch cancellation", () => {
  it("preserves a Request-only SSE body, headers and abort signal", async () => {
    const controller = new AbortController();
    const body = JSON.stringify({ stream: true, messages: [] });
    const request = new Request("https://api.example.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: "test-only",
        "content-type": "application/json",
      },
      body,
      signal: controller.signal,
    });

    const response = await window.fetch(request);
    expect(native.invoke).toHaveBeenCalledWith("sse_connect", {
      id: expect.any(String),
      url: request.url,
      method: "POST",
      headers: {
        authorization: "test-only",
        "content-type": "application/json",
      },
      body,
    });
    expect(request.bodyUsed).toBe(false);
    controller.abort();
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
    expect(native.invoke).toHaveBeenCalledWith("sse_disconnect", {
      id: expect.any(String),
    });
  });

  it("honors RequestInit overrides including a replacement signal", async () => {
    const original = new AbortController();
    const replacement = new AbortController();
    const request = new Request(
      "https://api.example.com/v1:streamGenerateContent",
      {
        method: "POST",
        headers: { "x-original": "discarded" },
        body: "old-body",
        signal: original.signal,
      },
    );
    const response = await window.fetch(request, {
      method: "PUT",
      headers: { "x-replacement": "kept" },
      body: "new-body",
      signal: replacement.signal,
    });
    expect(native.invoke).toHaveBeenCalledWith("sse_connect", {
      id: expect.any(String),
      url: request.url,
      method: "PUT",
      headers: {
        "x-replacement": "kept",
        "content-type": "text/plain;charset=UTF-8",
      },
      body: "new-body",
    });
    expect(request.bodyUsed).toBe(false);
    original.abort();
    expect(native.invoke).not.toHaveBeenCalledWith(
      "sse_disconnect",
      expect.anything(),
    );
    replacement.abort();
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps a removed streaming flag on the ordinary fetch path", async () => {
    const request = new Request("https://api.example.com/v1/messages", {
      method: "POST",
      body: '{"stream":true}',
    });
    await window.fetch(request, { body: '{"stream":false}' });
    expect(native.invoke).not.toHaveBeenCalledWith(
      "sse_connect",
      expect.anything(),
    );
    expect(request.bodyUsed).toBe(false);
  });
});
