import type { SkillRegistry } from "./registry";
import { importFromStaged, type ImportResult } from "./importer";
import { createSkillImportBudget } from "./import-limits";
import { assertSafePath } from "./paths";

async function loadDialog() {
  return import("@tauri-apps/plugin-dialog");
}

async function loadFs() {
  return import("@tauri-apps/plugin-fs");
}

async function loadPath() {
  return import("@tauri-apps/api/path");
}

export async function importFolderViaTauri(
  registry: SkillRegistry,
): Promise<ImportResult | null> {
  const dialog = await loadDialog();
  const selected = await dialog.open({ directory: true, multiple: false });
  if (!selected) return null;

  const fs = await loadFs();
  const pathMod = await loadPath();

  const files: Record<string, string> = {};
  const budget = createSkillImportBudget();

  async function walk(absDir: string, relPrefix: string): Promise<void> {
    const entries = await fs.readDir(absDir);
    for (const entry of entries) {
      const childAbs = await pathMod.join(absDir, entry.name);
      const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walk(childAbs, childRel);
      } else if (entry.isFile) {
        assertSafePath(childRel);
        const stat = await fs.stat(childAbs);
        budget.trackFile(childRel, stat.size);
        files[childRel] = await fs.readTextFile(childAbs);
      }
    }
  }

  await walk(selected, "");
  if (!files["SKILL.md"]) {
    throw new Error("Selected folder is missing SKILL.md at its root.");
  }
  const proposedId = await pathMod.basename(selected);
  return importFromStaged(registry, proposedId, files);
}

async function loadOpener() {
  return import("@tauri-apps/plugin-opener");
}

export async function revealSkillsRoot(): Promise<void> {
  const { getSkillsRootPath } = await import("./fs/tauri");
  const root = await getSkillsRootPath();
  const opener = await loadOpener();
  await opener.openPath(root);
}
