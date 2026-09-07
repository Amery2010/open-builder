// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  DesignSystemRegistry,
  MemoryDesignSystemStorage,
  OpfsDesignSystemStorage,
} from "./registry";
import type { DesignSystemInputFile } from "./validation";

const packageFiles: DesignSystemInputFile[] = [
  { path: "manifest.json", content: '{"id":"custom"}' },
  { path: "DESIGN.md", content: "# Custom" },
  { path: "tokens.css", content: ":root {}" },
];

interface FakeFile {
  content: string;
}

function fakeDirectory(): FileSystemDirectoryHandle {
  const directories = new Map<string, FileSystemDirectoryHandle>();
  const files = new Map<string, FakeFile>();
  return {
    kind: "directory",
    name: "fake",
    async getDirectoryHandle(name, options) {
      const existing = directories.get(name);
      if (existing) return existing;
      if (!options?.create) {
        throw new DOMException("Missing", "NotFoundError");
      }
      const created = fakeDirectory();
      directories.set(name, created);
      return created;
    },
    async getFileHandle(name, options) {
      let file = files.get(name);
      if (!file) {
        if (!options?.create) {
          throw new DOMException("Missing", "NotFoundError");
        }
        file = { content: "" };
        files.set(name, file);
      }
      return {
        kind: "file",
        name,
        async getFile() {
          return { text: async () => file?.content ?? "" } as File;
        },
        async createWritable() {
          return {
            async write(content: FileSystemWriteChunkType) {
              file!.content = String(content);
            },
            async close() {},
          } as FileSystemWritableFileStream;
        },
      } as FileSystemFileHandle;
    },
    async removeEntry(name) {
      if (!directories.delete(name) && !files.delete(name)) {
        throw new DOMException("Missing", "NotFoundError");
      }
    },
    async *entries() {
      for (const entry of directories) yield entry;
      for (const [name] of files) {
        yield [name, { kind: "file", name } as FileSystemFileHandle];
      }
    },
  } as FileSystemDirectoryHandle;
}

describe("Design system storage cleanup", () => {
  it("clears every imported and custom package through the registry", async () => {
    const storage = new MemoryDesignSystemStorage();
    await storage.write("imported", packageFiles);
    await storage.write("custom", packageFiles);
    const registry = new DesignSystemRegistry(storage);

    expect(await registry.estimateImportedStorage()).toEqual({
      count: 2,
      bytes:
        2 *
        packageFiles.reduce(
          (total, file) =>
            total + new TextEncoder().encode(file.content).byteLength,
          0,
        ),
      invalid: 0,
    });
    await registry.clearImported();
    expect(await storage.listIds()).toEqual([]);
  });

  it("removes the complete OPFS package root and treats absence as cleared", async () => {
    const origin = fakeDirectory();
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { getDirectory: async () => origin },
    });
    const storage = new OpfsDesignSystemStorage();
    await storage.write("custom", packageFiles);
    await storage.write("imported", packageFiles);

    expect(await storage.listIds()).toEqual(["custom", "imported"]);
    await storage.clear();
    expect(await storage.listIds()).toEqual([]);
    await expect(storage.clear()).resolves.toBeUndefined();
  });
});
