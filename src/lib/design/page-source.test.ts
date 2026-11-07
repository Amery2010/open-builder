import { describe, expect, it } from "vitest";
import { resolvePageSource } from "./page-source";

describe("page source selection", () => {
  const files = {
    "pages/b.tsx": "b",
    "pages/a.tsx": "a",
    "secret.ts": "private",
    "empty/": "",
  };
  const editable = { "pages/b.tsx": "b", "pages/a.tsx": "a" };
  it("retains a file already belonging to the page", () => {
    expect(
      resolvePageSource(
        ["pages/a.tsx", "pages/b.tsx"],
        files,
        editable,
        "/pages/b.tsx",
      ),
    ).toBe("pages/b.tsx");
  });
  it("chooses a stable real key and excludes unavailable files", () => {
    expect(
      resolvePageSource(
        ["secret.ts", "pages/b.tsx", "/pages/a.tsx", "missing.ts"],
        files,
        editable,
        "other.ts",
      ),
    ).toBe("pages/a.tsx");
    expect(
      resolvePageSource(
        ["secret.ts", "empty/", "missing.ts"],
        files,
        editable,
        "pages/a.tsx",
      ),
    ).toBeUndefined();
  });
  it("preserves case sensitivity and canonical leading slashes", () => {
    expect(
      resolvePageSource(["Pages/A.tsx"], files, editable, "pages/a.tsx"),
    ).toBeUndefined();
    expect(
      resolvePageSource(["pages/a.tsx"], { "/pages/a.tsx": "a" }, editable, ""),
    ).toBe("/pages/a.tsx");
  });
});
