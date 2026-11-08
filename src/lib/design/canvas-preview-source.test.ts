import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { computeCanvasPreviewSources } from "./canvas-preview-source";
import { readProjectDesign } from "./project-design";
import type { ProjectAssets, ProjectFiles } from "../../types";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
const blueprint = {
  schemaVersion: "open-builder-design-project/v3",
  revision: 1,
  pages: [
    { id: "home", route: "/home.html", filePaths: ["home.html"] },
    { id: "about", route: "/about.html", filePaths: ["about.html"] },
  ],
};
function sources(
  files: ProjectFiles,
  design = blueprint,
  assets: ProjectAssets = {},
) {
  const parsed = readProjectDesign({
    "design-project.json": JSON.stringify(design),
  });
  if (parsed.status !== "ready") throw new Error(JSON.stringify(parsed));
  return computeCanvasPreviewSources({
    files,
    assets,
    template: "static",
    previewMode: "sandpack",
    design: parsed.design,
  });
}
const files = {
  "home.html": "<h1>Home</h1>",
  "about.html": "<h1>About</h1>",
  "tokens.css": "body {color:black}",
};

it("invalidates only the independent page whose source changes", async () => {
  const before = await sources(files);
  const after = await sources({ ...files, "home.html": "<h1>New home</h1>" });
  expect(after.home).not.toBe(before.home);
  expect(after.about).toBe(before.about);
  expect(await sources({ ...files })).toEqual(before);
});

it("preserves pictures across blueprint metadata and unused documentation edits", async () => {
  const before = await sources(files);
  expect(
    await sources(
      { ...files, "README.md": "Documentation" },
      {
        ...blueprint,
        revision: 2,
        pages: blueprint.pages.map((page) => ({ ...page, name: "Renamed" })),
      },
    ),
  ).toEqual(before);
});

it("invalidates shared sources and follows cross-page imports transitively", async () => {
  const before = await sources(files);
  const shared = await sources({ ...files, "tokens.css": "body {color:red}" });
  expect(shared.home).not.toBe(before.home);
  expect(shared.about).not.toBe(before.about);
  const design = {
    ...blueprint,
    pages: [
      { id: "home", route: "/home", filePaths: ["Home.tsx"] },
      { id: "about", route: "/about", filePaths: ["About.tsx"] },
    ],
  };
  const source = {
    "Home.tsx": 'export { default } from "./About";',
    "About.tsx": "export default 1;",
  };
  const first = await sources(source, design);
  const next = await sources(
    { ...source, "About.tsx": "export default 2;" },
    design,
  );
  expect(next.home).not.toBe(first.home);
  expect(next.about).not.toBe(first.about);
});

it.each([
  'import page from "@/about.html";',
  "import(path)",
  'import.meta.glob("./*.html")',
  'import // comment\n "./about.html";',
])(
  "invalidates conservatively for unresolved dependencies: %s",
  async (code) => {
    const source = { ...files, "entry.js": code };
    const before = await sources(source);
    const after = await sources({ ...source, "about.html": "Changed" });
    expect(after.home).not.toBe(before.home);
  },
);

it("includes all pages reached from a shared runtime entry", async () => {
  const source = {
    ...files,
    "entry.js": 'import "./home.html"; import "./about.html";',
  };
  const before = await sources(source);
  const after = await sources({ ...source, "about.html": "Changed" });
  expect(after.home).not.toBe(before.home);
  expect(after.about).not.toBe(before.about);
});

it("does not treat links to other pages as dependencies of a screenshot", async () => {
  const source = {
    "home.html": '<a href="about.html">About</a>',
    "about.html": '<a href="home.html">Home</a>',
  };
  const before = await sources(source);
  const after = await sources({ ...source, "about.html": "Changed" });
  expect(after.home).toBe(before.home);
  expect(after.about).not.toBe(before.about);
});

it("tracks uppercase HTML resource references owned by another page", async () => {
  const design = {
    ...blueprint,
    pages: [
      blueprint.pages[0],
      { ...blueprint.pages[1], filePaths: ["about.html", "about.css"] },
    ],
  };
  const source = {
    ...files,
    "home.html": '<LINK HREF="about.css" rel="stylesheet"><h1>Home</h1>',
    "about.css": "h1 { color:red }",
  };
  const before = await sources(source, design);
  const after = await sources(
    { ...source, "about.css": "h1 { color:blue }" },
    design,
  );
  expect(after.home).not.toBe(before.home);
});

it.each(["import", "require", "fetch", "new URL"])(
  "falls back for a nonliteral %s argument even when its prefix resolves",
  async (call) => {
    const design = {
      ...blueprint,
      pages: [
        { id: "home", route: "/home", filePaths: ["Home.tsx"] },
        { id: "about", route: "/about", filePaths: ["About.tsx"] },
        { id: "detail", route: "/detail", filePaths: ["AboutDetail.tsx"] },
      ],
    };
    const source = {
      "Home.tsx": `${call}("./About" + suffix)`,
      "About.tsx": "export default 1;",
      "AboutDetail.tsx": "export default 2;",
    };
    const before = await sources(source, design);
    const after = await sources(
      { ...source, "AboutDetail.tsx": "export default 3;" },
      design,
    );
    expect(after.home).not.toBe(before.home);
  },
);

it("includes asset content and public paths in the cache identity", async () => {
  const asset = {
    path: "public/hero.png",
    blobRef: "hero",
    digest: "a",
    modulePath: "hero.ts",
    publicPath: "/hero.png",
    mimeType: "image/png" as const,
    size: 10,
  };
  const before = await sources(files, blueprint, { hero: asset });
  const after = await sources(files, blueprint, {
    hero: { ...asset, digest: "b" },
  });
  expect(after.home).not.toBe(before.home);
  expect(after.about).not.toBe(before.about);
});

it("ignores standalone documentation in a project without a blueprint", async () => {
  const input = {
    files: { "index.html": "<h1>Hello</h1>" },
    assets: {},
    template: "static",
    previewMode: "sandpack" as const,
    design: null,
  };
  const before = await computeCanvasPreviewSources(input);
  expect(
    await computeCanvasPreviewSources({
      ...input,
      files: { ...input.files, "README.md": "Updated" },
    }),
  ).toEqual(before);
});
