// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const stores = vi.hoisted(() => new Map<string, Map<string, unknown>>());

vi.mock("localforage", () => ({
  default: {
    createInstance: ({ storeName = "default" }: { storeName?: string }) => {
      const store = stores.get(storeName) ?? new Map<string, unknown>();
      stores.set(storeName, store);
      return {
        getItem: async <T>(key: string) => (store.get(key) as T) ?? null,
        setItem: async (key: string, value: unknown) => {
          store.set(key, value);
          return value;
        },
        removeItem: async (key: string) => {
          store.delete(key);
        },
        clear: async () => store.clear(),
        iterate: async <T, U>(iterator: (value: T, key: string) => U) => {
          for (const [key, value] of store) iterator(value as T, key);
        },
      };
    },
  },
}));

import {
  addProjectAssetModules,
  clearProjectAssetStorage,
  createProjectAssetRecord,
  createProjectAssetModule,
  detectProjectAssetMimeType,
  getProjectAssetBlob,
  normalizeProjectAssets,
  projectFilesForSandpack,
  readProjectAssetBytes,
  releaseUnreferencedProjectAssetBlobs,
  stageProjectAsset,
  storeStagedProjectAsset,
  validateProjectAssets,
} from "./core";
import { buildProjectZip } from "./archive";

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

describe("project assets", () => {
  beforeEach(() => {
    for (const store of stores.values()) store.clear();
  });

  it.each([
    ["gif", "image/gif", new TextEncoder().encode("GIF89a-content")],
    ["ico", "image/x-icon", new Uint8Array([0, 0, 1, 0, 1, 0, 0, 0])],
    [
      "avif",
      "image/avif",
      new Uint8Array([
        0, 0, 0, 20, 102, 116, 121, 112, 97, 118, 105, 102, 0, 0, 0, 0, 97, 118,
        105, 102,
      ]),
    ],
    [
      "woff",
      "font/woff",
      Uint8Array.from({ length: 44 }, (_, i) => [119, 79, 70, 70][i] ?? 0),
    ],
    [
      "woff2",
      "font/woff2",
      Uint8Array.from({ length: 48 }, (_, i) => [119, 79, 70, 50][i] ?? 0),
    ],
    [
      "ttf",
      "font/ttf",
      Uint8Array.from({ length: 12 }, (_, i) => (i === 1 ? 1 : 0)),
    ],
    [
      "otf",
      "font/otf",
      Uint8Array.from({ length: 12 }, (_, i) => [79, 84, 84, 79][i] ?? 0),
    ],
  ])(
    "round trips %s resources into preview and source ZIP with intact bytes",
    async (extension, mimeType, bytes) => {
      const staged = await stageProjectAsset(
        `public/resource.${extension}`,
        new Blob([Uint8Array.from(bytes).buffer]),
      );
      expect(staged.mimeType).toBe(mimeType);
      const asset = createProjectAssetRecord(
        staged,
        await storeStagedProjectAsset(staged),
      );
      const assets = { [asset.path]: asset };
      const files = addProjectAssetModules(
        { "style.css": `body{background:url(/resource.${extension})}` },
        assets,
      );
      const projected = await projectFilesForSandpack(files, assets);
      expect(projected["style.css"]).toContain(`data:${mimeType};base64,`);
      const zip = await JSZip.loadAsync(
        await (await buildProjectZip(files, assets)).arrayBuffer(),
      );
      expect(
        Array.from(await zip.file(asset.path)!.async("uint8array")),
      ).toEqual(Array.from(bytes));
      expect(Array.from(await readProjectAssetBytes(asset))).toEqual(
        Array.from(bytes),
      );
    },
  );

  it("accepts matching PNG bytes and rejects a misleading extension", async () => {
    expect(detectProjectAssetMimeType(pngBytes)).toBe("image/png");
    await expect(
      stageProjectAsset(
        "public/generated/hero.png",
        new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
        "image/png",
      ),
    ).resolves.toMatchObject({
      path: "public/generated/hero.png",
      mimeType: "image/png",
      size: pngBytes.byteLength,
    });
    await expect(
      stageProjectAsset(
        "public/generated/hero.webp",
        new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/webp" }),
        "image/webp",
      ),
    ).rejects.toThrow(/does not match/i);
  });

  it("stores content-addressed bytes while source keeps only a short module", async () => {
    const staged = await stageProjectAsset(
      "public/generated/hero.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const firstRef = await storeStagedProjectAsset(staged);
    const secondRef = await storeStagedProjectAsset(staged);
    const asset = createProjectAssetRecord(staged, firstRef);
    const files = addProjectAssetModules(
      { "src/App.tsx": "export default function App() {}" },
      { [asset.path]: asset },
    );

    expect(secondRef).toBe(firstRef);
    expect(await getProjectAssetBlob(firstRef)).toBeInstanceOf(Blob);
    expect(files[asset.modulePath]).toContain(
      'export default "/generated/hero.png"',
    );
    expect(files[asset.modulePath]).not.toContain("data:image");
    expect(await readProjectAssetBytes(asset)).toEqual(pngBytes);

    const previewFiles = await projectFilesForSandpack(files, {
      [asset.path]: asset,
    });
    expect(previewFiles[asset.modulePath]).toContain("data:image/png;base64,");
    expect(files[asset.modulePath]).not.toContain("data:image");

    const archive = await buildProjectZip(files, { [asset.path]: asset });
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect(await zip.file(asset.path)?.async("uint8array")).toEqual(pngBytes);
    expect(await zip.file(asset.modulePath)?.async("string")).toBe(
      files[asset.modulePath],
    );
  });

  it("uses the project path when deriving stable modules for duplicate images", async () => {
    const first = await stageProjectAsset(
      "public/a/logo.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const second = await stageProjectAsset(
      "public/b/logo.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const firstAsset = createProjectAssetRecord(
      first,
      await storeStagedProjectAsset(first),
    );
    const secondAsset = createProjectAssetRecord(
      second,
      await storeStagedProjectAsset(second),
    );
    const recreated = createProjectAssetRecord(first, firstAsset.blobRef);
    const assets = {
      [firstAsset.path]: firstAsset,
      [secondAsset.path]: secondAsset,
    };

    expect(firstAsset.blobRef).toBe(secondAsset.blobRef);
    expect(firstAsset.modulePath).not.toBe(secondAsset.modulePath);
    expect(recreated.modulePath).toBe(firstAsset.modulePath);
    expect(validateProjectAssets(assets)).toMatchObject({ ok: true });
    expect(() => addProjectAssetModules({}, assets)).not.toThrow();

    const existing = {
      ...firstAsset,
      modulePath: `src/generated-assets/logo-${firstAsset.digest.slice(0, 8)}.js`,
    };
    expect(normalizeProjectAssets({ [existing.path]: existing })).toEqual({
      [existing.path]: existing,
    });
  });

  it("keeps source assets as relative module imports and reserves absolute URLs for public assets", async () => {
    const sourceStaged = await stageProjectAsset(
      "src/assets/logo.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const publicStaged = await stageProjectAsset(
      "public/src/assets/logo.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const sourceAsset = createProjectAssetRecord(
      sourceStaged,
      await storeStagedProjectAsset(sourceStaged),
    );
    const publicAsset = createProjectAssetRecord(
      publicStaged,
      await storeStagedProjectAsset(publicStaged),
    );

    expect(sourceAsset.publicPath).toBe("");
    expect(createProjectAssetModule(sourceAsset)).toContain(
      'export { default } from "../assets/logo.png"',
    );
    expect(publicAsset.publicPath).toBe("/src/assets/logo.png");
    expect(
      validateProjectAssets({
        [sourceAsset.path]: sourceAsset,
        [publicAsset.path]: publicAsset,
      }),
    ).toMatchObject({ ok: true });
    await expect(
      stageProjectAsset(
        "public/logo.png?raw",
        new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
        "image/png",
      ),
    ).rejects.toThrow(/unsafe/i);
  });

  it("upgrades legacy source URLs without changing their managed module path", async () => {
    const staged = await stageProjectAsset(
      "src/assets/logo.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const current = createProjectAssetRecord(
      staged,
      await storeStagedProjectAsset(staged),
    );
    const legacy = { ...current, publicPath: `/${current.path}` };
    const legacyModule =
      `// Managed by Open Builder for ${legacy.path}.\n` +
      `export default ${JSON.stringify(legacy.publicPath)};\n`;

    const normalized = normalizeProjectAssets({ [legacy.path]: legacy });
    expect(normalized[legacy.path]).toEqual({ ...legacy, publicPath: "" });
    expect(normalized[legacy.path].modulePath).toBe(legacy.modulePath);
    expect(
      addProjectAssetModules({ [legacy.modulePath]: legacyModule }, normalized)[
        legacy.modulePath
      ],
    ).toBe(createProjectAssetModule(normalized[legacy.path]));
  });

  it("projects canonical JS, TS, CSS, and public asset references for preview only", async () => {
    const publicStaged = await stageProjectAsset(
      "public/logo.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const sourceStaged = await stageProjectAsset(
      "src/assets/icon.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const publicAsset = createProjectAssetRecord(
      publicStaged,
      await storeStagedProjectAsset(publicStaged),
    );
    const sourceAsset = createProjectAssetRecord(
      sourceStaged,
      await storeStagedProjectAsset(sourceStaged),
    );
    const canonical = addProjectAssetModules(
      {
        "src/App.tsx": [
          'import icon from "./assets/icon.png";',
          'const logo = "/logo.png";',
          "export default () => <><img src={icon} /><img src={logo} /></>;",
        ].join("\n"),
        "src/legacy.js": [
          'import iconUrl from "./assets/icon.png";',
          'const icon = require("./assets/icon.png");',
          "export { icon, iconUrl };",
        ].join("\n"),
        "src/views/Page.ts": 'export { default } from "../assets/icon.png";',
        "src/styles.css": [
          ".icon { background: url('./assets/icon.png'); }",
          '.logo { mask-image: url("/logo.png"); }',
          '.label::before { content: "url(/logo.png)"; }',
        ].join("\n"),
        "index.html":
          '<p>https://example.com</p><img src="/logo.png" srcset="/logo.png 1x, logo.png 2x"><img src=./logo.png>',
      },
      {
        [publicAsset.path]: publicAsset,
        [sourceAsset.path]: sourceAsset,
      },
    );

    const preview = await projectFilesForSandpack(canonical, {
      [publicAsset.path]: publicAsset,
      [sourceAsset.path]: sourceAsset,
    });

    expect(preview["src/App.tsx"]).toContain(
      `from "./generated-assets/${sourceAsset.modulePath.split("/").pop()}"`,
    );
    expect(preview["src/App.tsx"]).toContain(
      'const logo = "data:image/png;base64,',
    );
    expect(preview["src/legacy.js"]).toContain(
      `from "./generated-assets/${sourceAsset.modulePath.split("/").pop()}"`,
    );
    expect(preview["src/legacy.js"]).toContain(
      `require("./generated-assets/${sourceAsset.modulePath.split("/").pop()}")`,
    );
    expect(preview["src/views/Page.ts"]).toContain(
      `from "../generated-assets/${sourceAsset.modulePath.split("/").pop()}"`,
    );
    expect(preview["src/styles.css"]).toContain(
      "background: url('data:image/png;base64,",
    );
    expect(preview["src/styles.css"]).toContain(
      'mask-image: url("data:image/png;base64,',
    );
    expect(preview["src/styles.css"]).toContain('content: "url(/logo.png)"');
    expect(preview["index.html"]).toContain("https://example.com");
    expect(preview["index.html"]).toContain('src="data:image/png;base64,');
    expect(preview["index.html"]).toContain(" 1x, data:image/png;base64,");
    expect(preview["index.html"]).toContain("src=data:image/png;base64,");
    expect(preview["index.html"]).not.toContain("logo.png");
    expect(preview[sourceAsset.modulePath]).toContain("data:image/png;base64,");
    expect(canonical["src/App.tsx"]).toContain('from "./assets/icon.png"');
    expect(canonical["src/styles.css"]).toContain("./assets/icon.png");
  });

  it("fails the whole preview projection when an asset Blob is missing or corrupt", async () => {
    const staged = await stageProjectAsset(
      "public/logo.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const asset = createProjectAssetRecord(
      staged,
      await storeStagedProjectAsset(staged),
    );
    const files = addProjectAssetModules(
      { "src/App.tsx": 'export const logo = "/logo.png";' },
      { [asset.path]: asset },
    );

    stores.get("project-assets")?.delete(asset.blobRef);
    await expect(
      projectFilesForSandpack(files, { [asset.path]: asset }),
    ).rejects.toThrow(/unavailable locally/i);

    stores.get("project-assets")?.set(
      asset.blobRef,
      new Blob([Uint8Array.from([...pngBytes, 9]).buffer], {
        type: "image/png",
      }),
    );
    await expect(
      projectFilesForSandpack(files, { [asset.path]: asset }),
    ).rejects.toThrow(/integrity checks/i);
  });

  it("retains opportunistic cleanup candidates until explicit clearing", async () => {
    const staged = await stageProjectAsset(
      "public/retained.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const asset = createProjectAssetRecord(
      staged,
      await storeStagedProjectAsset(staged),
    );
    await releaseUnreferencedProjectAssetBlobs([asset.blobRef], () => [
      { [asset.path]: asset },
    ]);
    expect(await getProjectAssetBlob(asset.blobRef)).toBeInstanceOf(Blob);

    await releaseUnreferencedProjectAssetBlobs([asset.blobRef], () => null);
    expect(await getProjectAssetBlob(asset.blobRef)).toBeInstanceOf(Blob);

    await releaseUnreferencedProjectAssetBlobs([asset.blobRef], () => []);
    expect(await getProjectAssetBlob(asset.blobRef)).toBeInstanceOf(Blob);

    await clearProjectAssetStorage();
    expect(await getProjectAssetBlob(asset.blobRef)).toBeNull();
  });
});
