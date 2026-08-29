import type { DesignSystemStorageAdapter } from "./registry";
import { assertDesignSystemId, type DesignSystemInputFile } from "./validation";

const ROOT = "design-systems";
const FS_MODULE_ID = "@tauri-apps/plugin-fs";

interface PluginFsModule {
  BaseDirectory: { AppData: number };
  exists: (path: string, options: { baseDir: number }) => Promise<boolean>;
  mkdir: (
    path: string,
    options: { baseDir: number; recursive?: boolean },
  ) => Promise<void>;
  readDir: (
    path: string,
    options: { baseDir: number },
  ) => Promise<
    Array<{
      name: string;
      isDirectory: boolean;
      isFile: boolean;
      isSymlink: boolean;
    }>
  >;
  readTextFile: (path: string, options: { baseDir: number }) => Promise<string>;
  writeTextFile: (
    path: string,
    content: string,
    options: { baseDir: number },
  ) => Promise<void>;
  remove: (
    path: string,
    options: { baseDir: number; recursive?: boolean },
  ) => Promise<void>;
}

let fsPromise: Promise<PluginFsModule> | undefined;

function loadFs(): Promise<PluginFsModule> {
  fsPromise ??= import(/* @vite-ignore */ FS_MODULE_ID);
  return fsPromise;
}

function packagePath(id: string, file?: string): string {
  assertDesignSystemId(id);
  return file ? `${ROOT}/${id}/${file}` : `${ROOT}/${id}`;
}

export class TauriDesignSystemStorage implements DesignSystemStorageAdapter {
  async listIds(): Promise<string[]> {
    const fs = await loadFs();
    if (!(await fs.exists(ROOT, { baseDir: fs.BaseDirectory.AppData }))) {
      return [];
    }
    return (await fs.readDir(ROOT, { baseDir: fs.BaseDirectory.AppData }))
      .filter((entry) => entry.isDirectory && !entry.isSymlink)
      .map((entry) => entry.name)
      .sort();
  }

  async read(id: string): Promise<DesignSystemInputFile[]> {
    const fs = await loadFs();
    return Promise.all(
      ["manifest.json", "DESIGN.md", "tokens.css"].map(async (path) => ({
        path,
        content: await fs.readTextFile(packagePath(id, path), {
          baseDir: fs.BaseDirectory.AppData,
        }),
      })),
    );
  }

  async write(
    id: string,
    files: readonly DesignSystemInputFile[],
  ): Promise<void> {
    const fs = await loadFs();
    const destination = packagePath(id);
    if (await fs.exists(destination, { baseDir: fs.BaseDirectory.AppData })) {
      throw new Error(`Imported design system "${id}" already exists.`);
    }
    if (!(await fs.exists(ROOT, { baseDir: fs.BaseDirectory.AppData }))) {
      await fs.mkdir(ROOT, {
        baseDir: fs.BaseDirectory.AppData,
        recursive: true,
      });
    }
    await fs.mkdir(destination, {
      baseDir: fs.BaseDirectory.AppData,
      recursive: false,
    });
    try {
      for (const file of files) {
        await fs.writeTextFile(packagePath(id, file.path), file.content, {
          baseDir: fs.BaseDirectory.AppData,
        });
      }
    } catch (error) {
      await fs.remove(destination, {
        baseDir: fs.BaseDirectory.AppData,
        recursive: true,
      });
      throw error;
    }
  }
}
