// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createIsolatedPreviewSession } from "./prototype-preview-session";

describe("isolated prototype preview session", () => {
  it("does not append a temporary preview when review is already cancelled", async () => {
    const source = document.createElement("iframe");
    source.src = "about:blank";
    const controller = new AbortController();
    controller.abort();

    await expect(
      createIsolatedPreviewSession(source, "generation-1", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(
      document.querySelector(
        'iframe[title="Temporary prototype review preview"]',
      ),
    ).toBeNull();
  });
});
