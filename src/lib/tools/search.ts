import { tool } from "ai";
import { z } from "zod";
import type { WebSearchSettings } from "../../store/settings";
import {
  WEB_PAGE_MAX_CHARS,
  WEB_READER_MAX_URLS,
  WEB_SEARCH_MAX_RESULTS,
  SEARCH_SNIPPET_MAX_CHARS,
  TOOL_FETCH_TIMEOUT_MS,
  TOOL_MAX_CONCURRENCY,
  ToolTimeoutError,
  clampInt,
  fetchTextWithTimeout,
  formatHttpError,
  limitArray,
  mapWithConcurrency,
  normalizeHttpUrlList,
  normalizeToolQuery,
  safeErrorMessage,
  truncateText,
} from "./network-guard";

const TAVILY_API_URL = "https://api.tavily.com";
const FIRECRAWL_API_URL = "https://api.firecrawl.dev";
const EXA_API_URL = "https://api.exa.ai";

function firecrawlHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = apiKey.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

// ═══════════════════════════════ 工具定义 ═══════════════════════════════════

export const WEB_READER_TOOL = {
  web_reader: tool({
    description:
      "Read and extract the main content from one or more web pages. " +
      "Provide URLs to fetch their full text content.",
    inputSchema: z.object({
      urls: z.array(z.string()).describe("List of URLs to read"),
    }),
  }),
};

export const SEARCH_TOOLS = {
  web_search: tool({
    description:
      "Search the web for information using a query string. " +
      "Returns relevant results with titles, URLs, and content snippets. " +
      "Use this when you need up-to-date information from the internet.",
    inputSchema: z.object({
      query: z.string().describe("The search query"),
      max_results: z
        .number()
        .optional()
        .describe("Maximum number of results to return (default: 5)"),
    }),
  }),
  ...WEB_READER_TOOL,
};

// ═══════════════════════════════ Tavily API ═══════════════════════════════════

async function tavilySearch(
  settings: WebSearchSettings,
  query: string,
  maxResults: number = 5,
  signal?: AbortSignal,
): Promise<string> {
  const checkedQuery = normalizeToolQuery(query);
  if (!checkedQuery.ok) {
    return JSON.stringify({ ok: false, error: checkedQuery.error });
  }
  const size = clampInt(maxResults, 5, 1, WEB_SEARCH_MAX_RESULTS);
  try {
    const { response: res, text: body } = await fetchTextWithTimeout(
      `${TAVILY_API_URL}/search`,
      {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: settings.tavilyApiKey,
          query: checkedQuery.query,
          max_results: size,
          include_answer: true,
        }),
      },
    );
    if (!res.ok) {
      const text = body;
      return JSON.stringify({
        ok: false,
        error: formatHttpError("Tavily search failed", res.status, text),
      });
    }
    const data = JSON.parse(body);
    const limited = limitArray(data.results ?? [], size);
    return JSON.stringify({
      ok: true,
      answer: data.answer ?? null,
      results: limited.items.map((r: any) => {
        const content = truncateText(r.content, SEARCH_SNIPPET_MAX_CHARS);
        return {
          title: r.title,
          url: r.url,
          content: content.text,
          contentTruncated: content.truncated,
        };
      }),
      meta: {
        engine: "tavily",
        maxResults: size,
        truncatedResults: limited.truncated,
      },
    });
  } catch (err) {
    signal?.throwIfAborted();
    return JSON.stringify({ ok: false, error: safeErrorMessage(err) });
  }
}

async function tavilyExtract(
  settings: WebSearchSettings,
  urls: string[],
  signal?: AbortSignal,
): Promise<string> {
  const checkedUrls = normalizeHttpUrlList(urls, WEB_READER_MAX_URLS);
  if (!checkedUrls.ok) {
    return JSON.stringify({ ok: false, error: checkedUrls.error });
  }
  try {
    const { response: res, text: body } = await fetchTextWithTimeout(
      `${TAVILY_API_URL}/extract`,
      {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: settings.tavilyApiKey,
          urls: checkedUrls.urls,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(
        formatHttpError("Tavily extract failed", res.status, body),
      );
    }
    const data = JSON.parse(body);
    const results = (data.results ?? []) as {
      url: string;
      raw_content: string;
    }[];
    if (results.length === 0) throw new Error("Tavily returned empty results");
    return JSON.stringify({
      ok: true,
      pages: results.map((r) => ({
        url: r.url,
        ok: true,
        ...formatPageContent(r.raw_content),
      })),
      meta: {
        engine: "tavily",
        urlLimit: WEB_READER_MAX_URLS,
        truncatedUrls: checkedUrls.truncated,
      },
    });
  } catch (err: any) {
    signal?.throwIfAborted();
    if (err instanceof ToolTimeoutError) {
      return JSON.stringify({ ok: false, error: safeErrorMessage(err) });
    }
    console.warn("Tavily extract failed, falling back to Jina:", err.message);
    return jinaFallback(urls, signal);
  }
}

async function fetchSinglePageViaJina(
  url: string,
  signal?: AbortSignal,
): Promise<{
  url: string;
  ok: boolean;
  content?: string;
  error?: string;
}> {
  try {
    const { response: res, text: body } = await fetchTextWithTimeout(
      `https://r.jina.ai/${url}`,
      {
        signal,
        headers: { Accept: "text/plain" },
      },
    );
    if (!res.ok) {
      return {
        url,
        ok: false,
        error: `Jina fetch failed (${res.status})`,
      };
    }
    return { url, ok: true, ...formatPageContent(body) };
  } catch (err: any) {
    signal?.throwIfAborted();
    return {
      url,
      ok: false,
      error: safeErrorMessage(err),
    };
  }
}

async function jinaFallback(
  urls: string[],
  signal?: AbortSignal,
): Promise<string> {
  const checkedUrls = normalizeHttpUrlList(urls, WEB_READER_MAX_URLS);
  if (!checkedUrls.ok) {
    return JSON.stringify({ ok: false, error: checkedUrls.error, pages: [] });
  }
  const pages = await mapWithConcurrency(
    checkedUrls.urls,
    TOOL_MAX_CONCURRENCY,
    (url) => fetchSinglePageViaJina(url, signal),
  );
  return JSON.stringify({
    ok: pages.some((p) => p.ok),
    pages,
    meta: {
      engine: "jina",
      timeoutMs: TOOL_FETCH_TIMEOUT_MS,
      concurrency: TOOL_MAX_CONCURRENCY,
      urlLimit: WEB_READER_MAX_URLS,
      truncatedUrls: checkedUrls.truncated,
    },
  });
}

// ═══════════════════════════════ Firecrawl API ═══════════════════════════════════

async function firecrawlSearch(
  settings: WebSearchSettings,
  query: string,
  maxResults: number = 5,
  signal?: AbortSignal,
): Promise<string> {
  const checkedQuery = normalizeToolQuery(query);
  if (!checkedQuery.ok) {
    return JSON.stringify({ ok: false, error: checkedQuery.error });
  }
  const size = clampInt(maxResults, 5, 1, WEB_SEARCH_MAX_RESULTS);
  try {
    const { response: res, text: body } = await fetchTextWithTimeout(
      `${FIRECRAWL_API_URL}/v2/search`,
      {
        signal,
        method: "POST",
        headers: firecrawlHeaders(settings.firecrawlApiKey),
        body: JSON.stringify({
          query: checkedQuery.query,
          limit: size,
          sources: ["web"],
        }),
      },
    );

    if (!res.ok) {
      const text = body;
      return JSON.stringify({
        ok: false,
        error: formatHttpError("Firecrawl search failed", res.status, text),
      });
    }

    const data = JSON.parse(body);
    const searchData = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.data?.web)
        ? data.data.web
        : [];
    const limited = limitArray(searchData, size);
    return JSON.stringify({
      ok: true,
      answer: null,
      results: limited.items.map((r: any) => {
        const content = truncateText(
          r.description || r.markdown || r.content || "",
          SEARCH_SNIPPET_MAX_CHARS,
        );
        return {
          title: r.title || r.url,
          url: r.url,
          content: content.text,
          contentTruncated: content.truncated,
        };
      }),
      meta: {
        engine: "firecrawl",
        maxResults: size,
        truncatedResults: limited.truncated,
      },
    });
  } catch (err) {
    signal?.throwIfAborted();
    return JSON.stringify({ ok: false, error: safeErrorMessage(err) });
  }
}

async function fetchSinglePageViaFirecrawl(
  settings: WebSearchSettings,
  url: string,
  signal?: AbortSignal,
): Promise<{
  url: string;
  ok: boolean;
  content?: string;
  contentTruncated?: boolean;
  originalLength?: number;
  error?: string;
}> {
  try {
    const { response: res, text: body } = await fetchTextWithTimeout(
      `${FIRECRAWL_API_URL}/v2/scrape`,
      {
        signal,
        method: "POST",
        headers: firecrawlHeaders(settings.firecrawlApiKey),
        body: JSON.stringify({
          url,
          formats: ["markdown"],
          onlyMainContent: true,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(
        formatHttpError("Firecrawl scrape failed", res.status, body),
      );
    }
    const payload = JSON.parse(body);
    const document = payload.data ?? payload;
    const content = document.markdown ?? document.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Firecrawl returned empty page content");
    }
    return {
      url: document.metadata?.sourceURL || document.url || url,
      ok: true,
      ...formatPageContent(content),
    };
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof ToolTimeoutError) {
      return { url, ok: false, error: safeErrorMessage(err) };
    }
    console.warn(
      "Firecrawl scrape failed, falling back to Jina:",
      safeErrorMessage(err),
    );
    return fetchSinglePageViaJina(url, signal);
  }
}

async function firecrawlScrape(
  settings: WebSearchSettings,
  urls: string[],
  signal?: AbortSignal,
): Promise<string> {
  const checkedUrls = normalizeHttpUrlList(urls, WEB_READER_MAX_URLS);
  if (!checkedUrls.ok) {
    return JSON.stringify({ ok: false, error: checkedUrls.error });
  }
  const pages = await mapWithConcurrency(
    checkedUrls.urls,
    TOOL_MAX_CONCURRENCY,
    (url) => fetchSinglePageViaFirecrawl(settings, url, signal),
  );
  return JSON.stringify({
    ok: pages.some((page) => page.ok),
    pages,
    meta: {
      engine: "firecrawl",
      timeoutMs: TOOL_FETCH_TIMEOUT_MS,
      concurrency: TOOL_MAX_CONCURRENCY,
      urlLimit: WEB_READER_MAX_URLS,
      truncatedUrls: checkedUrls.truncated,
    },
  });
}

// ═══════════════════════════════ Exa API ═════════════════════════════════════

async function exaSearch(
  settings: WebSearchSettings,
  query: string,
  maxResults: number = 5,
  signal?: AbortSignal,
): Promise<string> {
  const checkedQuery = normalizeToolQuery(query);
  if (!checkedQuery.ok) {
    return JSON.stringify({ ok: false, error: checkedQuery.error });
  }
  const size = clampInt(maxResults, 5, 1, WEB_SEARCH_MAX_RESULTS);
  try {
    const { response: res, text: body } = await fetchTextWithTimeout(
      `${EXA_API_URL}/search`,
      {
        signal,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.exaApiKey.trim(),
        },
        body: JSON.stringify({
          query: checkedQuery.query,
          type: "auto",
          numResults: size,
          contents: {
            text: { maxCharacters: SEARCH_SNIPPET_MAX_CHARS },
          },
        }),
      },
    );
    if (!res.ok) {
      return JSON.stringify({
        ok: false,
        error: formatHttpError("Exa search failed", res.status, body),
      });
    }
    const data = JSON.parse(body);
    const limited = limitArray(
      Array.isArray(data.results) ? data.results : [],
      size,
    );
    return JSON.stringify({
      ok: true,
      answer: null,
      results: limited.items.map((result: any) => {
        const content = truncateText(
          result.text || result.highlights?.join("\n") || result.summary || "",
          SEARCH_SNIPPET_MAX_CHARS,
        );
        return {
          title: result.title || result.url,
          url: result.url,
          content: content.text,
          contentTruncated: content.truncated,
        };
      }),
      meta: {
        engine: "exa",
        maxResults: size,
        truncatedResults: limited.truncated,
      },
    });
  } catch (err) {
    signal?.throwIfAborted();
    return JSON.stringify({ ok: false, error: safeErrorMessage(err) });
  }
}

async function exaContents(
  settings: WebSearchSettings,
  urls: string[],
  signal?: AbortSignal,
): Promise<string> {
  const checkedUrls = normalizeHttpUrlList(urls, WEB_READER_MAX_URLS);
  if (!checkedUrls.ok) {
    return JSON.stringify({ ok: false, error: checkedUrls.error });
  }
  try {
    const { response: res, text: body } = await fetchTextWithTimeout(
      `${EXA_API_URL}/contents`,
      {
        signal,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.exaApiKey.trim(),
        },
        body: JSON.stringify({
          urls: checkedUrls.urls,
          text: { maxCharacters: WEB_PAGE_MAX_CHARS },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(formatHttpError("Exa contents failed", res.status, body));
    }
    const data = JSON.parse(body);
    const results = Array.isArray(data.results) ? data.results : [];
    if (results.length === 0) throw new Error("Exa returned empty results");
    const pages = await mapWithConcurrency(
      checkedUrls.urls,
      TOOL_MAX_CONCURRENCY,
      async (url) => {
        const result = results.find(
          (item: any) => item?.url === url || item?.id === url,
        );
        if (typeof result?.text === "string" && result.text.trim()) {
          return {
            url: result.url || result.id || url,
            ok: true,
            ...formatPageContent(result.text),
          };
        }
        console.warn(
          "Exa contents did not return this page, falling back to Jina:",
          url,
        );
        return fetchSinglePageViaJina(url, signal);
      },
    );
    return JSON.stringify({
      ok: pages.some((page) => page.ok),
      pages,
      meta: {
        engine: "exa",
        timeoutMs: TOOL_FETCH_TIMEOUT_MS,
        concurrency: TOOL_MAX_CONCURRENCY,
        urlLimit: WEB_READER_MAX_URLS,
        truncatedUrls: checkedUrls.truncated,
      },
    });
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof ToolTimeoutError) {
      return JSON.stringify({ ok: false, error: safeErrorMessage(err) });
    }
    console.warn(
      "Exa contents failed, falling back to Jina:",
      safeErrorMessage(err),
    );
    return jinaFallback(checkedUrls.urls, signal);
  }
}

// ═══════════════════════════════ 工具处理器 ═══════════════════════════════════

export function createSearchToolHandler(
  settings: WebSearchSettings,
): (name: string, args: unknown, signal?: AbortSignal) => Promise<string> {
  return async (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<string> => {
    signal?.throwIfAborted();
    const a = args as Record<string, any>;
    const engine = settings.engine;
    const query =
      name === "web_search" ? normalizeToolQuery(a?.query) : undefined;
    if (query && !query.ok) {
      return JSON.stringify({ ok: false, error: query.error });
    }
    const readerUrls =
      name === "web_reader"
        ? normalizeHttpUrlList(a?.urls, WEB_READER_MAX_URLS)
        : undefined;
    if (readerUrls && !readerUrls.ok) {
      return JSON.stringify({ ok: false, error: readerUrls.error });
    }

    if (engine === "tavily") {
      switch (name) {
        case "web_search":
          return tavilySearch(settings, query!.query, a.max_results, signal);
        case "web_reader":
          return tavilyExtract(settings, readerUrls!.urls, signal);
      }
    } else if (engine === "firecrawl") {
      switch (name) {
        case "web_search":
          return firecrawlSearch(settings, query!.query, a.max_results, signal);
        case "web_reader":
          return firecrawlScrape(settings, readerUrls!.urls, signal);
      }
    } else if (engine === "exa") {
      switch (name) {
        case "web_search":
          return exaSearch(settings, query!.query, a.max_results, signal);
        case "web_reader":
          return exaContents(settings, readerUrls!.urls, signal);
      }
    }

    return `Error: unknown tool "${name}" or engine "${engine}"`;
  };
}

// ═══════════════════════════════ Jina Reader ═══════════════════════════════════

/**
 * Create a handler that only supports web_reader via Jina Reader.
 * Used when engine is "builtin" (model handles search natively, but page reading still uses Jina).
 */
export function createJinaReaderHandler(): (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<string> {
  return async (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<string> => {
    signal?.throwIfAborted();
    if (name === "web_reader") {
      const a = args as { urls: string[] };
      const readerUrls = normalizeHttpUrlList(a?.urls, WEB_READER_MAX_URLS);
      if (!readerUrls.ok) {
        return JSON.stringify({ ok: false, error: readerUrls.error });
      }
      return jinaFallback(readerUrls.urls, signal);
    }
    return `Error: unknown tool "${name}"`;
  };
}

function formatPageContent(content: unknown): {
  content: string;
  contentTruncated: boolean;
  originalLength: number;
} {
  const truncated = truncateText(content, WEB_PAGE_MAX_CHARS);
  return {
    content: truncated.text,
    contentTruncated: truncated.truncated,
    originalLength: truncated.originalLength,
  };
}
