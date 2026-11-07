import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildStaticDeployment, validateDeploymentFiles } from "./index";

describe("static deployment artifact", () => {
  it("packages the site at ZIP root and excludes host-only files", async () => {
    const result = await buildStaticDeployment({
      files: {
        "index.html": "<script src='./app.js'></script>",
        "app.js": "console.log('ready')",
        "__open_builder_design_bridge__.js": "throw new Error()",
      },
      signal: new AbortController().signal,
    });
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(["index.html", "app.js"]);
    expect(await zip.file("app.js")!.async("text")).toBe(
      "console.log('ready')",
    );
  });
  it("rejects unsupported projects and cancelled builds", async () => {
    const signal = AbortSignal.abort();
    await expect(
      buildStaticDeployment({ files: { "index.html": "Hi" }, signal }),
    ).rejects.toThrow();
    await expect(
      buildStaticDeployment({
        files: {
          "package.json": JSON.stringify({
            dependencies: { next: "12.1.6" },
            scripts: { dev: "next dev" },
          }),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/server runtime/);
  });
  it("serves managed public resources at their preview URLs and rejects collisions", async () => {
    const files = {
      "index.html": '<link rel="stylesheet" href="/site.css">',
      "public/site.css": "body { color: red; }",
    };
    const result = await buildStaticDeployment({
      files,
      signal: new AbortController().signal,
    });
    expect(result.files).toContain("site.css");
    await expect(
      buildStaticDeployment({
        files: { ...files, "site.css": "body {color:blue}" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/conflicts/);
  });
  it("does not offer broken, missing, or unsafe output files as a deployment", () => {
    const html = new TextEncoder().encode("Hello");
    expect(() =>
      validateDeploymentFiles({ "index.html": html, "assets/.-abc.": html }),
    ).toThrow(/extension/);
    expect(() =>
      validateDeploymentFiles({ "index.html": html, "../escape.js": html }),
    ).toThrow(/path/);
    expect(() => validateDeploymentFiles({ "entry.js": html })).toThrow(
      /index.html/,
    );
  });
});
