import { describe, expect, it } from "vitest";
import { getNewFileInitialContent } from "./new-file-content";

describe("getNewFileInitialContent", () => {
  it("starts package.json with editable valid JSON", () => {
    const content = getNewFileInitialContent("package.json");

    expect(() => JSON.parse(content)).not.toThrow();
    expect(JSON.parse(content)).toEqual({});
  });

  it("uses valid object JSON for other JSON files", () => {
    expect(JSON.parse(getNewFileInitialContent("src/config.json"))).toEqual({});
  });

  it("keeps source file starters useful for their language", () => {
    expect(getNewFileInitialContent("src/NewComponent.tsx")).toContain(
      "return <div />",
    );
    expect(getNewFileInitialContent("src/utils.ts")).toBe("// New file\n");
  });
});
