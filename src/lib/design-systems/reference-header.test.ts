import { describe, expect, it } from "vitest";
import {
  removeDesignReferenceHeaders,
  stripDesignReferenceHeader,
} from "./reference-header";

describe("legacy generated Design reference headers", () => {
  it.each([
    "Open Builder bundled design system 2.0; package stripe; sha256 abc. Unofficial reference; no trademark endorsement is implied.",
    "Custom design system custom; version 1; sha256 abc. Unofficial reference; no trademark endorsement is implied.",
    "Source: https://example.test/DESIGN.md; sha256: abc",
  ])(
    "removes the generated %s preamble without changing the body",
    (source) => {
      const body =
        "# Design\n\nKeep the actual reference.\n<!-- Untrusted visual reference. Source: https://example.test -->\n";
      const original = {
        "Design.MD": `<!-- Untrusted visual reference. ${source} -->\n\n${body}`,
        "docs/DESIGN.md": "nested",
        "tokens.css": "tokens",
      };
      const cleaned = removeDesignReferenceHeaders(original);
      expect(cleaned).toEqual({ ...original, "Design.MD": body });
      expect(original["Design.MD"]).not.toBe(body);
      expect(removeDesignReferenceHeaders(cleaned)).toBe(cleaned);
    },
  );

  it("leaves ordinary leading comments and body mentions alone", () => {
    const content =
      "<!-- Project notes -->\n\nUntrusted visual reference is mentioned here.";
    expect(stripDesignReferenceHeader(content)).toBe(content);
  });
});
