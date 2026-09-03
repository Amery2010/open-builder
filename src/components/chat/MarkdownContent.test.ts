import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  MarkdownContent,
  normalizeMarkdownHref,
  normalizeMarkdownImageSrc,
} from "./MarkdownContent";

describe("MarkdownContent URL guards", () => {
  it("allows only explicit safe link targets", () => {
    expect(normalizeMarkdownHref("https://example.com/a b")).toBe(
      "https://example.com/a%20b",
    );
    expect(normalizeMarkdownHref("mailto:hello@example.com")).toBe(
      "mailto:hello@example.com",
    );
    expect(normalizeMarkdownHref("#section")).toBe("#section");
    expect(normalizeMarkdownHref("javascript:alert(1)")).toBeUndefined();
    expect(normalizeMarkdownHref("/settings")).toBeUndefined();
  });

  it("allows http images and bounded raster data URLs only", () => {
    expect(normalizeMarkdownImageSrc("https://example.com/image.png")).toBe(
      "https://example.com/image.png",
    );
    expect(
      normalizeMarkdownImageSrc("data:image/png;base64,aGVsbG8="),
    ).toBe("data:image/png;base64,aGVsbG8=");
    expect(
      normalizeMarkdownImageSrc(
        "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
      ),
    ).toBeUndefined();
    expect(
      normalizeMarkdownImageSrc(
        `data:image/png;base64,${"a".repeat(2 * 1024 * 1024)}`,
      ),
    ).toBeUndefined();
  });

  it("gives code copy controls a name and polite status region", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(MarkdownContent, {
          content: "```ts\nconst answer = 42;\n```",
          variant: "assistant",
        }),
      ),
    );

    expect(markup).toMatch(/aria-label="(?:Copy|复制)"/);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("keeps inline code inline for both message variants", () => {
    for (const variant of ["assistant", "user"] as const) {
      const markup = renderToStaticMarkup(
        createElement(
          TooltipProvider,
          null,
          createElement(MarkdownContent, {
            content: "Run `npm run build` before shipping.",
            variant,
          }),
        ),
      );
      const inlineClass =
        /<code class="([^"]*)"[^>]*>npm run build<\/code>/.exec(markup)?.[1];

      expect(inlineClass?.split(" ")).toEqual(
        expect.arrayContaining([
          "markdown-inline-code",
          "inline",
          "whitespace-normal",
          "align-baseline",
        ]),
      );
      expect(markup).not.toContain("<pre");
    }
  });

  it("keeps fenced code under pre and out of the inline style", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(MarkdownContent, {
          content: "```ts\nconst answer = 42;\n```",
          variant: "assistant",
        }),
      ),
    );

    expect(markup).toMatch(/<pre[^>]*><code class="language-ts"/);
    expect(markup).not.toContain("markdown-inline-code");
  });

  it("keeps an unlabelled fence out of the inline style", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(MarkdownContent, {
          content: "```\nfirst line\nsecond line\n```",
          variant: "assistant",
        }),
      ),
    );

    expect(markup).toMatch(/<pre[^>]*><code>first line\nsecond line\n<\/code>/);
    expect(markup).not.toContain("markdown-inline-code");
  });
});
