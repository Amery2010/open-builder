import { afterEach, describe, expect, it, vi } from "vitest";
import { webSearchDefaults } from "../../store/settings/web-search";
import { createSearchToolHandler } from "./search";
import { TOOL_FETCH_TIMEOUT_MS } from "./network-guard";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("search tool providers", () => {
  it.each(["firecrawl", "tavily", "exa"] as const)(
    "does not multiply three timed-out %s attempts with a fallback provider",
    async (engine) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const handler = createSearchToolHandler({ ...webSearchDefaults, engine });
      const pending = handler("web_reader", {
        urls: ["https://example.test/article"],
      });
      await vi.advanceTimersByTimeAsync(TOOL_FETCH_TIMEOUT_MS * 3);
      expect(JSON.parse(await pending)).toMatchObject({ ok: false });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("r.jina.ai")),
      ).toBe(false);
    },
  );

  it("uses keyless Firecrawl without an empty Authorization header", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          success: true,
          data: {
            web: [
              {
                title: "Open Builder",
                url: "https://example.com/open-builder",
                description: "A concise result",
              },
            ],
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const handler = createSearchToolHandler(webSearchDefaults);
    const result = JSON.parse(
      await handler("web_search", { query: "Open Builder", max_results: 1 }),
    );

    expect(result).toMatchObject({
      ok: true,
      results: [{ title: "Open Builder", content: "A concise result" }],
      meta: { engine: "firecrawl" },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("scrapeOptions");
  });

  it("adds Firecrawl authentication, supports legacy results, and preserves errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              title: "Legacy",
              url: "https://example.com/legacy",
              content: "Legacy content",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    const handler = createSearchToolHandler({
      ...webSearchDefaults,
      firecrawlApiKey: "fc-test",
    });

    const success = JSON.parse(
      await handler("web_search", { query: "legacy" }),
    );
    const failure = JSON.parse(
      await handler("web_search", { query: "limited" }),
    );
    const forbidden = JSON.parse(
      await handler("web_search", { query: "forbidden" }),
    );

    expect(success.results[0].title).toBe("Legacy");
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization"),
    ).toBe("Bearer fc-test");
    expect(failure).toMatchObject({ ok: false });
    expect(failure.error).toContain("Firecrawl search failed (429)");
    expect(forbidden).toMatchObject({ ok: false });
    expect(forbidden.error).toContain("Firecrawl search failed (403)");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads Firecrawl pages individually and falls back failed pages to Jina", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v2/scrape")) {
          const requested = JSON.parse(String(init?.body)).url;
          if (requested.includes("fallback")) {
            return jsonResponse({ error: "blocked" }, 403);
          }
          return jsonResponse({
            data: {
              markdown: "Firecrawl page",
              metadata: { sourceURL: requested },
            },
          });
        }
        if (url.startsWith("https://r.jina.ai/")) {
          return new Response("Jina page", { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const handler = createSearchToolHandler(webSearchDefaults);
    const result = JSON.parse(
      await handler("web_reader", {
        urls: ["https://example.com/direct", "https://example.com/fallback"],
      }),
    );

    expect(result.ok).toBe(true);
    expect(
      result.pages.map((page: { content: string }) => page.content),
    ).toEqual(["Firecrawl page", "Jina page"]);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("batch")),
    ).toBe(false);
  });

  it("maps Exa search results with the required key and bounded text", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          results: [
            {
              title: "Exa result",
              url: "https://example.com/exa",
              text: "x".repeat(1_200),
            },
          ],
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handler = createSearchToolHandler({
      ...webSearchDefaults,
      engine: "exa",
      exaApiKey: "exa-test",
    });

    const result = JSON.parse(
      await handler("web_search", { query: "Exa", max_results: 1 }),
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));

    expect(new Headers(init?.headers).get("x-api-key")).toBe("exa-test");
    expect(body).toMatchObject({
      query: "Exa",
      type: "auto",
      numResults: 1,
      contents: { text: { maxCharacters: 1_000 } },
    });
    expect(result.results[0].content).toHaveLength(1_000);
    expect(result.results[0].contentTruncated).toBe(true);
    expect(result.meta.engine).toBe("exa");
  });

  it("reads Exa contents and falls back to Jina on provider failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              id: "https://example.com/page",
              url: "https://example.com/page",
              text: "Exa page",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 500))
      .mockResolvedValueOnce(new Response("Jina fallback", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const handler = createSearchToolHandler({
      ...webSearchDefaults,
      engine: "exa",
      exaApiKey: "exa-test",
    });

    const success = JSON.parse(
      await handler("web_reader", { urls: ["https://example.com/page"] }),
    );
    const fallback = JSON.parse(
      await handler("web_reader", { urls: ["https://example.com/fallback"] }),
    );

    expect(success).toMatchObject({
      ok: true,
      pages: [{ content: "Exa page" }],
      meta: { engine: "exa" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      urls: ["https://example.com/page"],
      text: { maxCharacters: 12_000 },
    });
    expect(fallback).toMatchObject({
      ok: true,
      pages: [{ content: "Jina fallback" }],
      meta: { engine: "jina" },
    });
  });

  it("falls back only Exa pages omitted from a successful contents response", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              id: "https://example.com/direct",
              url: "https://example.com/direct",
              text: "Exa direct page",
            },
          ],
          statuses: [
            { id: "https://example.com/direct", status: "success" },
            { id: "https://example.com/fallback", status: "error" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response("Jina partial fallback", { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const handler = createSearchToolHandler({
      ...webSearchDefaults,
      engine: "exa",
      exaApiKey: "exa-test",
    });

    const result = JSON.parse(
      await handler("web_reader", {
        urls: ["https://example.com/direct", "https://example.com/fallback"],
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      pages: [
        { content: "Exa direct page" },
        { content: "Jina partial fallback" },
      ],
      meta: { engine: "exa" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
