import { describe, expect, it } from "vitest";
import {
  computeDesignReviewSourceDigest,
  serializeDesignReviewSource,
} from "./digest";

describe("Design Review source digest", () => {
  it("is stable across record insertion order", async () => {
    const left = {
      files: { "src/b.ts": "b", "src/a.ts": "a" },
      designSystem: { version: "1", id: "system" },
      designContract: { target: "page", acceptance: ["responsive"] },
    };
    const right = {
      files: { "src/a.ts": "a", "src/b.ts": "b" },
      designSystem: { id: "system", version: "1" },
      designContract: { acceptance: ["responsive"], target: "page" },
    };

    expect(serializeDesignReviewSource(left)).toBe(
      serializeDesignReviewSource(right),
    );
    await expect(computeDesignReviewSourceDigest(left)).resolves.toBe(
      await computeDesignReviewSourceDigest(right),
    );
  });

  it("changes when project content changes", async () => {
    const first = await computeDesignReviewSourceDigest({
      files: { "src/App.tsx": "first" },
    });
    const second = await computeDesignReviewSourceDigest({
      files: { "src/App.tsx": "second" },
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });
});
