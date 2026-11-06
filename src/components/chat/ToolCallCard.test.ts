import { describe, expect, it } from "vitest";
import {
  countSearchResults,
  countWebReaderUrls,
  classifyToolCardStatus,
  parseConsoleIssues,
  parseNpmSearchResult,
  safeExternalResourceUrl,
  TOOL_CARD_LIMITS,
} from "./ToolCallCard";

describe("ToolCallCard result guards", () => {
  it("extracts only valid npm packages and ignores invalid optional fields", () => {
    const parsed = parseNpmSearchResult(
      JSON.stringify({
        success: true,
        data: [
          null,
          "not a package object",
          { name: { invalid: true } },
          { name: "" },
          {
            name: "@scope/package",
            version: "1.0.0",
            description: "A package",
          },
          { name: "zod", version: {}, description: [] },
        ],
      }),
    );

    expect(parsed).toMatchObject({
      success: true,
      count: 2,
      packages: [
        { name: "@scope/package", version: "1.0.0", description: "A package" },
        { name: "zod" },
      ],
    });
  });

  it.each([
    "not JSON",
    "null",
    "42",
    '{"success":true,"data":{}}',
    '{"success":false,"error":{"message":"invalid field"}}',
  ])("handles malformed npm search payloads without throwing: %s", (result) => {
    expect(parseNpmSearchResult(result)).toMatchObject({
      success: false,
      count: 0,
      packages: [],
      error: expect.any(String),
    });
  });

  it("does not parse oversized JSON payloads", () => {
    const huge = JSON.stringify({
      success: true,
      data: ["pkg"],
      padding: "x".repeat(TOOL_CARD_LIMITS.maxJsonParseChars),
    });

    const parsed = parseNpmSearchResult(huge);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("[truncated in UI");
    expect(parsed.error!.length).toBeLessThan(
      TOOL_CARD_LIMITS.maxResultDisplayChars + 100,
    );
  });

  it("caps console issue extraction", () => {
    const result = Array.from(
      { length: TOOL_CARD_LIMITS.maxConsoleIssues + 20 },
      (_, i) => `[ERROR] issue ${i}`,
    ).join("\n");

    expect(parseConsoleIssues(result)).toHaveLength(
      TOOL_CARD_LIMITS.maxConsoleIssues,
    );
  });

  it("caps web reader URL summaries", () => {
    const result = JSON.stringify({
      pages: Array.from(
        { length: TOOL_CARD_LIMITS.maxReaderUrls + 5 },
        (_, i) => ({
          url: `https://example.com/${i}`,
          ok: true,
        }),
      ),
    });

    expect(countWebReaderUrls(result)).toHaveLength(
      TOOL_CARD_LIMITS.maxReaderUrls,
    );
  });

  it("keeps normal small tool summaries working", () => {
    expect(
      countSearchResults(JSON.stringify({ ok: true, results: [{}, {}] })),
    ).toMatchObject({ ok: true, count: 2 });
  });

  it("reads persisted Codex search arrays and preserves safe sources", () => {
    expect(
      countSearchResults(
        JSON.stringify([
          {
            type: "text_result",
            title: "Codex",
            url: "https://openai.com/codex",
            snippet: "Official documentation",
          },
          { title: "Unsafe", url: "javascript:alert(1)" },
          { title: "Private file", url: "file:///tmp/private" },
          { title: "Duplicate", url: "https://openai.com/codex" },
          null,
        ]),
      ),
    ).toMatchObject({
      ok: true,
      count: 5,
      sources: [
        {
          title: "Codex",
          url: "https://openai.com/codex",
          snippet: "Official documentation",
        },
      ],
    });
  });

  it.each([
    JSON.stringify({ ok: true, results: null }),
    JSON.stringify({ ok: true, results: [] }),
    "[]",
    "web_search completed without structured results.",
  ])(
    "distinguishes unavailable search results from zero results: %s",
    (result) => {
      expect(countSearchResults(result)).toMatchObject({
        ok: true,
        count: null,
      });
      expect(
        countSearchResults(
          '{"ok":true,"results":[],"meta":{"engine":"tavily"}}',
        ),
      ).toMatchObject({
        ok: true,
        count: 0,
      });
      expect(
        countSearchResults('{"ok":false,"error":"Search failed"}'),
      ).toMatchObject({ ok: false, error: "Search failed" });
    },
  );

  it.each(["tavily", "firecrawl", "exa"])(
    "keeps confirmed empty %s Host results distinct from missing source details",
    (engine) => {
      expect(
        countSearchResults(
          JSON.stringify({ ok: true, results: [], meta: { engine } }),
        ),
      ).toMatchObject({ ok: true, count: 0, sources: [] });
    },
  );

  it("allows only http(s) MCP resource links", () => {
    expect(safeExternalResourceUrl("https://example.com/result")).toBe(
      "https://example.com/result",
    );
    expect(safeExternalResourceUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalResourceUrl("file:///tmp/secret")).toBeNull();
    expect(safeExternalResourceUrl("mcp://resource/1")).toBeNull();
  });

  it("classifies text, structured and diagnostic tool outcomes", () => {
    expect(classifyToolCardStatus("write_file", "")).toBe("running");
    expect(classifyToolCardStatus("write_file", "OK — written")).toBe(
      "completed",
    );
    expect(classifyToolCardStatus("image_search", '{"ok":false}')).toBe(
      "failed",
    );
    expect(
      classifyToolCardStatus("search_npm_packages", '{"success":false}'),
    ).toBe("failed");
    expect(classifyToolCardStatus("project_health_check", '{"ok":false}')).toBe(
      "attention",
    );
    expect(
      classifyToolCardStatus(
        "project_health_check",
        '{"ok":true,"issues":[{"severity":"info"}]}',
      ),
    ).toBe("attention");
    expect(
      classifyToolCardStatus("get_console_logs", "[WARN] deprecated API"),
    ).toBe("attention");
    expect(
      classifyToolCardStatus("get_console_logs", "[ERROR] render failed"),
    ).toBe("attention");
    expect(
      classifyToolCardStatus("mcp_lookup", "done", {
        text: "done",
        isError: true,
      }),
    ).toBe("failed");
  });
});
