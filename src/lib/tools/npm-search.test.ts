import { afterEach, describe, expect, it, vi } from "vitest";
import { createNpmSearchToolHandler } from "./npm-search";
import { TOOL_FETCH_TIMEOUT_MS } from "./network-guard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("npm request timeout recovery", () => {
  it("retries timed-out response bodies and returns the third result", async () => {
    vi.useFakeTimers();
    const stalledResponse = () => new Response(new ReadableStream());
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(stalledResponse())
      .mockResolvedValueOnce(stalledResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal("fetch", fetchMock);
    let result: unknown;
    const pending = createNpmSearchToolHandler()("search_npm_packages", {
      query: "body timeout recovery regression",
    }).then((text) => {
      result = JSON.parse(text);
    });

    await vi.advanceTimersByTimeAsync(TOOL_FETCH_TIMEOUT_MS * 2 + 1);
    expect(result).toMatchObject({ success: true, data: [] });
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
