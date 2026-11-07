import { describe, expect, it } from "vitest";
import {
  computeDesignReviewSourceDigest,
  serializeDesignReviewSource,
} from "./digest";

describe("Design Review source digest", () => {
  it("retains freshness for progress updates while invalidating changed preview targets", async () => {
    const blueprint = {
      schemaVersion: "open-builder-design-project/v2",
      revision: 1,
      pages: [{ id: "home", route: "/" }],
    };
    const source = (document: object) => ({
      files: {
        "design-project.json": JSON.stringify(document),
        "App.tsx": "page",
      },
    });
    const first = await computeDesignReviewSourceDigest(source(blueprint));
    expect(
      await computeDesignReviewSourceDigest(
        source({
          ...blueprint,
          revision: 2,
          buildProgress: { status: "in-progress", percent: 40 },
        }),
      ),
    ).toBe(first);
    expect(
      await computeDesignReviewSourceDigest(
        source({ ...blueprint, pages: [{ id: "home", route: "/other" }] }),
      ),
    ).not.toBe(first);
    const runtimeSource = {
      ...source(blueprint),
      files: {
        ...source(blueprint).files,
        "App.tsx":
          'import data from "./design-project.json"; export default data;',
      },
    };
    expect(
      await computeDesignReviewSourceDigest({
        ...runtimeSource,
        files: {
          ...runtimeSource.files,
          "design-project.json": JSON.stringify({
            ...blueprint,
            revision: 2,
            buildProgress: { percent: 40 },
          }),
        },
      }),
    ).not.toBe(await computeDesignReviewSourceDigest(runtimeSource));
  });
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
