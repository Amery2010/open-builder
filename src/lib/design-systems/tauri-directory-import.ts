import { DESIGN_SYSTEM_LIMITS } from "./validation";
import {
  stageDesignSystemFiles,
  type StagedDesignSystemImport,
} from "./importer";

export async function stageDesignSystemTauriDirectory(): Promise<StagedDesignSystemImport | null> {
  const [dialog, fs, pathModule] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ]);
  const selected = await dialog.open({ directory: true, multiple: false });
  if (typeof selected !== "string") return null;

  const files: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  async function walk(absolute: string, prefix: string): Promise<void> {
    for (const entry of await fs.readDir(absolute)) {
      if (entry.isSymlink) {
        throw new Error(
          "Design-system directories cannot contain symbolic links.",
        );
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = await pathModule.join(absolute, entry.name);
      if (entry.isDirectory) {
        await walk(child, relative);
        continue;
      }
      if (!entry.isFile) continue;
      if (files.length >= DESIGN_SYSTEM_LIMITS.maxEntries) {
        throw new Error("Design-system directory contains too many files.");
      }
      const stat = await fs.stat(child);
      totalBytes += stat.size;
      if (totalBytes > DESIGN_SYSTEM_LIMITS.maxPackageBytes) {
        throw new Error("Design-system directory exceeds the 2 MB limit.");
      }
      const bytes: Uint8Array = await fs.readFile(child);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(
          `Design-system file "${relative}" is not valid UTF-8 text.`,
        );
      }
      files.push({ path: relative, content });
    }
  }
  await walk(selected, "");
  return stageDesignSystemFiles(files);
}
