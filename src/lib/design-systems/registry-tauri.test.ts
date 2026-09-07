import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => {
  const directories = new Set<string>();
  const files = new Map<string, string>();
  return {
    BaseDirectory: { AppData: 1 },
    exists: vi.fn(
      async (path: string) => directories.has(path) || files.has(path),
    ),
    mkdir: vi.fn(async (path: string) => {
      directories.add(path);
    }),
    writeTextFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
    readTextFile: vi.fn(async (path: string) => files.get(path) ?? ""),
    readDir: vi.fn(async (path: string) => {
      const prefix = `${path}/`;
      return [...directories]
        .filter((entry) => entry.startsWith(prefix))
        .filter((entry) => !entry.slice(prefix.length).includes("/"))
        .map((entry) => ({
          name: entry.slice(prefix.length),
          isDirectory: true,
          isSymlink: false,
        }));
    }),
    remove: vi.fn(async (path: string) => {
      for (const file of [...files.keys()]) {
        if (file === path || file.startsWith(`${path}/`)) files.delete(file);
      }
      for (const directory of [...directories]) {
        if (directory === path || directory.startsWith(`${path}/`)) {
          directories.delete(directory);
        }
      }
    }),
    reset() {
      directories.clear();
      files.clear();
    },
  };
});

vi.mock("@tauri-apps/plugin-fs", () => fsMock);

import { TauriDesignSystemStorage } from "./registry-tauri";

describe("TauriDesignSystemStorage cleanup", () => {
  beforeEach(() => {
    fsMock.reset();
    vi.clearAllMocks();
  });

  it("removes the complete AppData package root and is idempotent", async () => {
    const storage = new TauriDesignSystemStorage();
    await storage.write("custom", [
      { path: "manifest.json", content: "{}" },
      { path: "DESIGN.md", content: "# Custom" },
      { path: "tokens.css", content: ":root {}" },
    ]);

    expect(await storage.listIds()).toEqual(["custom"]);
    await storage.clear();
    expect(fsMock.remove).toHaveBeenCalledWith("design-systems", {
      baseDir: fsMock.BaseDirectory.AppData,
      recursive: true,
    });
    expect(await storage.listIds()).toEqual([]);
    await expect(storage.clear()).resolves.toBeUndefined();
  });
});
