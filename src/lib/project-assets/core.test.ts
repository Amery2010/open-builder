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
  createProjectAssetRecord,
  detectProjectAssetMimeType,
  getProjectAssetBlob,
  projectFilesForSandpack,
  readProjectAssetBytes,
  stageProjectAsset,
  storeStagedProjectAsset,
} from "./core";
import { buildProjectZip } from "./archive";

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

describe("project assets", () => {
  beforeEach(() => stores.clear());

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
});
