import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { stageDesignSystemDirectory, stageDesignSystemZip } from "./importer";
import { DesignSystemRegistry, MemoryDesignSystemStorage } from "./registry";

const manifest = JSON.stringify({
  schemaVersion: "open-builder-design-system/v1",
  id: "sample",
  name: "Sample",
  files: { design: "DESIGN.md", tokens: "tokens.css" },
});
const tokens = `:root {
  --bg: #fff;
  --surface: #fff;
  --fg: #111;
  --muted: #666;
  --border: #ddd;
  --accent: #6541f5;
  --accent-on: #fff;
  --font-display: system-ui;
  --font-body: system-ui;
  --radius-md: 8px;
  --section-y-desktop: 96px;
  --container-max: 1200px;
  --motion-base: 180ms;
}`;

async function validZip(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("sample/manifest.json", manifest);
  zip.file("sample/DESIGN.md", "# Sample");
  zip.file("sample/tokens.css", tokens);
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("Design system import", () => {
  it("stages a prefixed ZIP before persistence", async () => {
    const staged = await stageDesignSystemZip(await validZip());
    expect(staged.summary).toMatchObject({ id: "sample", name: "Sample" });
    expect(staged.summary.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects excessive archive entries before package validation", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 17; index += 1) {
      zip.file(`sample/file-${index}.txt`, "x");
    }
    await expect(
      stageDesignSystemZip(await zip.generateAsync({ type: "arraybuffer" })),
    ).rejects.toThrow(/too many entries/i);
  });

  it("supports browser directory files and rejects unlisted binary types", async () => {
    const files = [
      new File([manifest], "manifest.json", { type: "application/json" }),
      new File(["# Sample"], "DESIGN.md", { type: "text/markdown" }),
      new File([tokens], "tokens.css", { type: "text/css" }),
      new File(["no"], "run.js", { type: "text/javascript" }),
    ];
    await expect(stageDesignSystemDirectory(files)).rejects.toThrow(
      /scripts or binary/i,
    );
  });

  it("adds source suffixes and never overwrites an imported id", async () => {
    const storage = new MemoryDesignSystemStorage();
    const registry = new DesignSystemRegistry(storage);
    const staged = await stageDesignSystemZip(await validZip());

    const first = await registry.confirmImport(staged.package);
    const second = await registry.confirmImport(staged.package);

    expect(first.id).toBe("sample-imported");
    expect(first.digest).toBe(staged.summary.digest);
    expect(second.id).toBe("sample-imported-2");
    expect(await storage.listIds()).toEqual([
      "sample-imported",
      "sample-imported-2",
    ]);
  });

  it("serializes concurrent imports and rejects registry path traversal", async () => {
    const storage = new MemoryDesignSystemStorage();
    const registry = new DesignSystemRegistry(storage);
    const staged = await stageDesignSystemZip(await validZip());

    const [first, second] = await Promise.all([
      registry.confirmImport(staged.package),
      registry.confirmImport(staged.package),
    ]);
    expect([first.id, second.id]).toEqual([
      "sample-imported",
      "sample-imported-2",
    ]);
    await expect(registry.loadImported("../settings")).rejects.toThrow(
      /invalid design-system registry id/i,
    );
  });
});
