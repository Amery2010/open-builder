// @vitest-environment jsdom

import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import {
  PROJECT_IMPORT_LIMITS,
  inferProjectPreview,
  stageProjectFromDirectoryHandle,
  stageProjectFromFileList,
  stageProjectFromZip,
} from "./project-import";

const encoder = new TextEncoder();

const compressionMocks = vi.hoisted(() => ({
  compress: vi.fn(),
}));

vi.mock("../images/compress-local-image", () => ({
  compressLocalImage: compressionMocks.compress,
}));

function sourceFile(
  path: string,
  content: string | Uint8Array,
  lastModified = 0,
): File {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  return {
    name: path.split("/").pop() ?? path,
    size: bytes.byteLength,
    lastModified,
    webkitRelativePath: path,
    arrayBuffer: async () => bytes.slice().buffer,
  } as File;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function zipFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  } as File;
}

function replaceUtf8(bytes: Uint8Array, from: string, to: string): Uint8Array {
  expect(to.length).toBe(from.length);
  const needle = encoder.encode(from);
  const replacement = encoder.encode(to);
  const output = bytes.slice();
  for (let index = 0; index <= output.length - needle.length; index += 1) {
    if (needle.every((value, offset) => output[index + offset] === value)) {
      output.set(replacement, index);
    }
  }
  return output;
}

function replaceFirstCentralSizes(
  bytes: Uint8Array,
  declaredBytes: number,
): Uint8Array {
  const output = bytes.slice();
  const view = new DataView(
    output.buffer as ArrayBuffer,
    output.byteOffset,
    output.byteLength,
  );
  for (let offset = 0; offset <= output.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    view.setUint32(offset + 20, declaredBytes, true);
    view.setUint32(offset + 24, declaredBytes, true);
    return output;
  }
  throw new Error("Test ZIP central directory was not found.");
}

describe("project import staging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    compressionMocks.compress.mockImplementation(async (file: File) => file);
    useSettingsStore.setState((state) => ({
      system: {
        ...state.system,
        imageCompressionEnabled: true,
        imageCompressionQuality: 0.85,
      },
    }));
  });

  it("filters dependencies, secrets and binaries while preserving safe dotfiles", async () => {
    const staged = await stageProjectFromFileList([
      sourceFile(
        "demo/src/App.tsx",
        'export const api_key = "secret-sentinel-123";',
      ),
      sourceFile(
        "demo/package.json",
        JSON.stringify({
          dependencies: { react: "19.0.0" },
          devDependencies: { vite: "4.2.0", typescript: "5.0.0" },
        }),
      ),
      sourceFile("demo/.gitignore", "node_modules\n"),
      sourceFile("demo/.env", "API_KEY=secret-sentinel-456"),
      sourceFile("demo/.env.example", "API_KEY="),
      sourceFile("demo/node_modules/pkg/index.js", "module.exports = {}"),
      sourceFile("demo/dist/app.js", "compiled"),
      sourceFile(
        "demo/public/logo.png",
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
      ),
    ]);

    expect(staged.name).toBe("demo");
    expect(staged.template).toBe("vite-react-ts");
    expect(staged.previewMode).toBe("sandpack");
    expect(Object.keys(staged.files).sort()).toEqual([
      ".env.example",
      ".gitignore",
      "package.json",
      "src/App.tsx",
    ]);
    expect(staged.files["src/App.tsx"]).not.toContain("secret-sentinel-123");
    expect(staged.files["src/App.tsx"]).toContain("[REDACTED]");
    expect(staged.report).toMatchObject({
      redactedFiles: 1,
      importedFiles: 5,
      skipped: { ignored: 2, sensitive: 1, binary: 0, symlink: 0 },
    });
    expect(staged.assets).toHaveLength(1);
    expect(staged.assets?.[0]).toMatchObject({
      path: "public/logo.png",
      mimeType: "image/png",
    });
  });

  it("imports a directory handle without descending into ignored directories", async () => {
    const dependencyGetFile = vi.fn();
    const fileHandle = (name: string, content: string | Uint8Array) => ({
      kind: "file" as const,
      name,
      getFile: async () => sourceFile(name, content),
    });
    const ignoredDirectory = {
      kind: "directory" as const,
      name: "node_modules",
      entries: async function* () {
        yield [
          "pkg.js",
          { kind: "file", name: "pkg.js", getFile: dependencyGetFile },
        ] as unknown as [string, FileSystemHandle];
      },
    };
    const root = {
      kind: "directory" as const,
      name: "folder-project",
      entries: async function* () {
        yield [
          "index.html",
          fileHandle("index.html", "<main />"),
        ] as unknown as [string, FileSystemHandle];
        yield [
          "logo.png",
          fileHandle(
            "logo.png",
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
          ),
        ] as unknown as [string, FileSystemHandle];
        yield ["node_modules", ignoredDirectory] as unknown as [
          string,
          FileSystemHandle,
        ];
      },
    } as unknown as FileSystemDirectoryHandle;

    const staged = await stageProjectFromDirectoryHandle(root);

    expect(staged.files).toEqual({ "index.html": "<main />" });
    expect(staged.template).toBe("static");
    expect(staged.assets).toHaveLength(1);
    expect(staged.report.skipped.ignored).toBe(1);
    expect(dependencyGetFile).not.toHaveBeenCalled();
  });

  it("stages compressed project asset bytes and their final digest", async () => {
    const sourceBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
    ]);
    const compressedBytes = sourceBytes.subarray(0, 8);
    useSettingsStore.setState((state) => ({
      system: {
        ...state.system,
        imageCompressionQuality: 0.42,
      },
    }));
    compressionMocks.compress.mockImplementation(
      async (file: File) =>
        new File([compressedBytes], file.name, {
          type: file.type,
          lastModified: file.lastModified,
        }),
    );

    const staged = await stageProjectFromFileList([
      sourceFile("demo/index.html", "<main />"),
      sourceFile("demo/public/hero.png", sourceBytes, 123),
    ]);

    expect(compressionMocks.compress).toHaveBeenCalledOnce();
    expect(compressionMocks.compress).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "hero.png",
        type: "image/png",
        size: sourceBytes.byteLength,
        lastModified: 123,
      }),
      { enabled: true, quality: 0.42 },
    );
    expect(staged.assets?.[0]).toMatchObject({
      path: "public/hero.png",
      mimeType: "image/png",
      size: compressedBytes.byteLength,
      digest: await sha256(compressedBytes),
    });
    expect(staged.report.totalBytes).toBe(
      encoder.encode("<main />").byteLength + compressedBytes.byteLength,
    );
  });

  it("passes disabled compression settings while preserving project asset bytes", async () => {
    const sourceBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
    ]);
    useSettingsStore.setState((state) => ({
      system: {
        ...state.system,
        imageCompressionEnabled: false,
        imageCompressionQuality: 0.37,
      },
    }));

    const staged = await stageProjectFromFileList([
      sourceFile("demo/index.html", "<main />"),
      sourceFile("demo/public/logo.png", sourceBytes),
    ]);

    expect(compressionMocks.compress).toHaveBeenCalledWith(
      expect.objectContaining({ size: sourceBytes.byteLength }),
      { enabled: false, quality: 0.37 },
    );
    expect(staged.assets?.[0]).toMatchObject({
      size: sourceBytes.byteLength,
      digest: await sha256(sourceBytes),
    });
  });

  it("strips a ZIP root folder and rejects unsafe paths and compression bombs", async () => {
    const valid = new JSZip();
    valid.file("demo/package.json", '{"devDependencies":{"vite":"4.2.0"}}');
    valid.file("demo/src/main.ts", "console.log('ok')");
    valid.file(
      "demo/public/generated/hero.webp",
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]),
    );
    valid.file("__MACOSX/demo/._main.ts", "metadata");
    const validBytes = await valid.generateAsync({ type: "uint8array" });

    const staged = await stageProjectFromZip(zipFile("demo.zip", validBytes));
    expect(staged.name).toBe("demo");
    expect(Object.keys(staged.files).sort()).toEqual([
      "package.json",
      "src/main.ts",
    ]);
    expect(staged.report.skipped.ignored).toBe(1);
    expect(staged.assets).toHaveLength(1);
    expect(staged.assets?.[0]).toMatchObject({
      path: "public/generated/hero.webp",
      mimeType: "image/webp",
    });

    const unsafe = new JSZip();
    unsafe.file("root/safe.ts", "safe");
    const unsafeBytes = replaceUtf8(
      await unsafe.generateAsync({ type: "uint8array" }),
      "root/safe.ts",
      "root/../x.ts",
    );
    await expect(
      stageProjectFromZip(zipFile("unsafe.zip", unsafeBytes)),
    ).rejects.toThrow(/unsafe project path/i);

    const bomb = new JSZip();
    bomb.file("root/large.txt", "a".repeat(512 * 1024));
    const bombBytes = await bomb.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    await expect(
      stageProjectFromZip(zipFile("bomb.zip", bombBytes)),
    ).rejects.toThrow(/compression ratio/i);
  });

  it("skips ZIP symlinks that can be identified from Unix attributes", async () => {
    const zip = new JSZip();
    zip.file("root/index.html", "<main />");
    zip.file("root/current", "index.html", { unixPermissions: 0o120777 });
    const bytes = await zip.generateAsync({
      type: "uint8array",
      platform: "UNIX",
    });

    const staged = await stageProjectFromZip(zipFile("links.zip", bytes));

    expect(staged.files).toEqual({ "index.html": "<main />" });
    expect(staged.report.skipped.symlink).toBe(1);
  });

  it("does not treat an ignored directory as a removable ZIP root", async () => {
    const zip = new JSZip();
    zip.file("node_modules/pkg/index.js", "module.exports = true");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(
      stageProjectFromZip(zipFile("dependencies.zip", bytes)),
    ).rejects.toThrow(/no importable text files/i);
  });

  it("rejects invalid and oversized archives before changing any project state", async () => {
    await expect(
      stageProjectFromZip(zipFile("broken.zip", new Uint8Array([1, 2, 3]))),
    ).rejects.toThrow(/invalid central directory/i);

    const arrayBuffer = vi.fn();
    await expect(
      stageProjectFromZip({
        name: "large.zip",
        size: PROJECT_IMPORT_LIMITS.maxArchiveBytes + 1,
        arrayBuffer,
      }),
    ).rejects.toThrow(/exceeds/i);
    expect(arrayBuffer).not.toHaveBeenCalled();

    const declared = new JSZip();
    declared.file("index.txt", "small");
    const declaredBytes = replaceFirstCentralSizes(
      await declared.generateAsync({ type: "uint8array" }),
      12 * 1024 * 1024 + 1,
    );
    await expect(
      stageProjectFromZip(zipFile("declared.zip", declaredBytes)),
    ).rejects.toThrow(/declares more than/i);
  });

  it("enforces project file limits before reading oversized input", async () => {
    const arrayBuffer = vi.fn();
    await expect(
      stageProjectFromFileList([
        {
          name: "large.ts",
          webkitRelativePath: "project/large.ts",
          size: 2 * 1024 * 1024 + 1,
          arrayBuffer,
        } as unknown as File,
      ]),
    ).rejects.toThrow(/too large/i);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe("project preview inference", () => {
  it.each([
    [{ dependencies: { next: "15.0.0" } }, {}, "nextjs"],
    [{ dependencies: { astro: "5.0.0" } }, {}, "astro"],
    [{ dependencies: { "@angular/core": "19.0.0" } }, {}, "angular"],
    [{ dependencies: { "solid-js": "1.0.0" } }, {}, "solid"],
    [
      { dependencies: { svelte: "5.0.0" }, devDependencies: { vite: "4.2.0" } },
      { "src/main.ts": "" },
      "vite-svelte-ts",
    ],
    [
      { dependencies: { vue: "3.0.0" }, devDependencies: { vite: "4.2.0" } },
      { "src/main.ts": "" },
      "vite-vue-ts",
    ],
    [
      {
        dependencies: { preact: "10.0.0" },
        devDependencies: { vite: "4.2.0" },
      },
      { "src/main.tsx": "" },
      "vite-preact-ts",
    ],
    [
      { dependencies: { react: "19.0.0" }, devDependencies: { vite: "4.2.0" } },
      { "src/main.tsx": "" },
      "vite-react-ts",
    ],
    [{ devDependencies: { vite: "4.2.0" } }, {}, "vite"],
    [{ main: "index.js" }, { "index.js": "" }, "node"],
  ])(
    "detects a supported Sandpack stack as %s",
    (packageJson, files, template) => {
      expect(
        inferProjectPreview({
          "package.json": JSON.stringify(packageJson),
          ...files,
        }),
      ).toEqual({ template, previewMode: "sandpack" });
    },
  );

  it("detects static projects and falls back to code-only when unknown", () => {
    expect(inferProjectPreview({ "index.html": "<main />" })).toEqual({
      template: "static",
      previewMode: "sandpack",
    });
    expect(inferProjectPreview({ "README.md": "notes" })).toEqual({
      template: "static",
      previewMode: "code-only",
    });
  });
});
