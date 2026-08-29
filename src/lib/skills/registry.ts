import type { SkillFs } from "./fs";
import { isTauri } from "./fs";
import {
  downloadManifestSkillFiles,
  loadSkillManifest,
  type SkillFetch,
} from "./manifest";
import { parseSkillMd } from "./parser";
import { SKILL_IMPORT_LIMITS, assertSafePath, textBytes } from "./paths";
import type { PreparedSkill, SkillEntry, SkillManifestEntry } from "./types";
import {
  BUILTIN_SKILL_ID_ALIASES,
  resolveBuiltinSkillId,
} from "./builtin-aliases";

export const FORCED_SKILLS_MAX_BYTES = 128 * 1024;

export interface SkillsStoreApi {
  getSkill(id: string): SkillEntry | undefined;
  listAll(): SkillEntry[];
  registerSkill(entry: SkillEntry): void;
  unregisterSkill(id: string): void;
  setSkillAutoEnabled(id: string, enabled: boolean): void;
}

export interface SkillRegistryOptions {
  platform?: "web" | "desktop" | "mobile";
  fetcher?: SkillFetch;
}

const REFERENCES_DIR = "references";
const SCRIPTS_DIR = "scripts";

function sameList(a?: string[], b?: string[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

export class SkillRegistry {
  private readonly platform: "web" | "desktop" | "mobile";
  private readonly fetcher: SkillFetch;
  private readonly manifest = new Map<string, SkillManifestEntry>();
  private readonly readyIds = new Set<string>();
  private readonly issues = new Map<string, string>();

  constructor(
    private fs: SkillFs,
    private store: SkillsStoreApi,
    options: SkillRegistryOptions = {},
  ) {
    this.platform = options.platform ?? (isTauri() ? "desktop" : "web");
    this.fetcher = options.fetcher ?? fetch;
  }

  async initialize(): Promise<void> {
    let manifestLoaded = false;
    try {
      const manifest = await loadSkillManifest(this.fetcher);
      manifestLoaded = true;
      await this.reconcileManifest(manifest.skills);
      await this.cleanupLegacyBuiltinDirectories();
      this.issues.delete("manifest");
    } catch (error) {
      this.issues.set("manifest", this.errorMessage(error));
    }

    if (this.platform !== "desktop") {
      await this.cleanupWebSkillDirectories();
    }

    await this.reconcileStoredSkills(manifestLoaded);

    const pending = this.store
      .listAll()
      .filter(
        (skill) =>
          skill.source === "builtin" &&
          skill.autoEnabled &&
          !this.readyIds.has(skill.id),
      );
    await Promise.allSettled(
      pending.map((skill) => this.ensureBuiltinCached(skill.id, false)),
    );
  }

  list(): SkillEntry[] {
    return this.store.listAll();
  }

  getAutoEnabled(): SkillEntry[] {
    return this.store
      .listAll()
      .filter((skill) => skill.autoEnabled && this.readyIds.has(skill.id));
  }

  isReady(id: string): boolean {
    return this.readyIds.has(id);
  }

  getIssues(): Record<string, string> {
    return Object.fromEntries(this.issues);
  }

  async setAutoEnabled(id: string, enabled: boolean): Promise<void> {
    const skill = this.requireSkill(id);
    if (!enabled) {
      this.store.setSkillAutoEnabled(id, false);
      return;
    }

    if (skill.source === "builtin") {
      const available = this.manifest.get(id);
      const needsDownload =
        !this.readyIds.has(id) ||
        (available !== undefined && skill.cachedVersion !== available.version);
      if (needsDownload) {
        await this.ensureBuiltinCached(id, true);
      }
    } else if (!this.readyIds.has(id)) {
      throw new Error(`Skill "${skill.name}" is missing its SKILL.md file.`);
    }

    this.store.setSkillAutoEnabled(id, true);
  }

  async prepareForcedSkills(ids: readonly string[]): Promise<PreparedSkill[]> {
    const prepared: PreparedSkill[] = [];
    let totalBytes = 0;
    const normalizedIds = ids.map((id) => {
      const existing = this.store.getSkill(id);
      return existing?.source === "imported" ? id : resolveBuiltinSkillId(id);
    });
    for (const id of Array.from(new Set(normalizedIds))) {
      const skill = this.requireSkill(id);
      if (!this.readyIds.has(id)) {
        if (skill.source !== "builtin") {
          throw new Error(
            `Skill "${skill.name}" is missing its SKILL.md file.`,
          );
        }
        await this.ensureBuiltinCached(id, false);
      }
      const content = await this.readSkillContent(id);
      totalBytes += textBytes(content);
      if (totalBytes > FORCED_SKILLS_MAX_BYTES) {
        throw new Error(
          `Forced skills exceed the ${FORCED_SKILLS_MAX_BYTES / 1024} KiB prompt limit. Select fewer skills.`,
        );
      }
      prepared.push({ entry: this.requireSkill(id), content });
    }
    return prepared;
  }

  async readSkillContent(id: string): Promise<string> {
    const skill = this.requireSkill(id);
    if (!this.readyIds.has(id)) {
      if (skill.source === "builtin") {
        await this.ensureBuiltinCached(id, false);
      } else {
        throw new Error(`Skill "${skill.name}" is missing its SKILL.md file.`);
      }
    }
    const raw = await this.fs.readFile(`${skill.id}/SKILL.md`);
    return parseSkillMd(raw).body;
  }

  async listReferences(id: string): Promise<string[]> {
    const skill = this.requireSkill(id);
    return this.listFilesIn(`${skill.id}/${REFERENCES_DIR}`);
  }

  async readReference(id: string, refPath: string): Promise<string> {
    const skill = this.requireSkill(id);
    const safe = assertSafePath(refPath);
    return this.fs.readFile(`${skill.id}/${REFERENCES_DIR}/${safe}`);
  }

  async listScripts(id: string): Promise<string[]> {
    const skill = this.requireSkill(id);
    return this.listFilesIn(`${skill.id}/${SCRIPTS_DIR}`);
  }

  async readScript(id: string, scriptPath: string): Promise<string> {
    const skill = this.requireSkill(id);
    const safe = assertSafePath(scriptPath);
    return this.fs.readFile(`${skill.id}/${SCRIPTS_DIR}/${safe}`);
  }

  async deleteSkill(id: string): Promise<void> {
    const skill = this.store.getSkill(id);
    if (!skill) return;
    if (skill.source === "builtin") {
      throw new Error(`Cannot delete built-in skill "${id}"`);
    }
    if (await this.fs.exists(skill.id)) {
      await this.fs.remove(skill.id, { recursive: true });
    }
    this.readyIds.delete(id);
    this.store.unregisterSkill(id);
  }

  async writeSkillDirectory(
    id: string,
    files: Record<string, string>,
  ): Promise<void> {
    this.assertSafeId(id);
    if (await this.fs.exists(id)) {
      await this.fs.remove(id, { recursive: true });
    }
    await this.fs.mkdir(id, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const safe = assertSafePath(relPath);
      await this.fs.writeFile(`${id}/${safe}`, content);
    }
  }

  async registerSkillFromDir(
    id: string,
    source: "builtin" | "imported",
    extras: {
      cachedVersion?: string;
      availableVersion?: string;
      autoEnabled?: boolean;
    } = {},
  ): Promise<SkillEntry> {
    this.assertSafeId(id);
    const raw = await this.fs.readFile(`${id}/SKILL.md`);
    const parsed = parseSkillMd(raw);
    const existing = this.store.getSkill(id);
    const entry: SkillEntry = {
      id,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      version: parsed.frontmatter.version,
      allowedTools: parsed.frontmatter["allowed-tools"],
      tags: parsed.frontmatter.tags,
      autoEnabled:
        extras.autoEnabled ?? existing?.autoEnabled ?? source === "builtin",
      source,
      installedAt: existing?.installedAt ?? Date.now(),
      cachedVersion: extras.cachedVersion,
      availableVersion: extras.availableVersion,
    };
    this.store.registerSkill(entry);
    this.readyIds.add(id);
    this.issues.delete(id);
    return entry;
  }

  private async reconcileManifest(
    entries: SkillManifestEntry[],
  ): Promise<void> {
    const currentIds = new Set(entries.map((entry) => entry.id));
    for (const existing of this.store.listAll()) {
      if (existing.source !== "builtin" || currentIds.has(existing.id))
        continue;
      if (await this.fs.exists(existing.id)) {
        await this.fs.remove(existing.id, { recursive: true });
      }
      this.store.unregisterSkill(existing.id);
      this.readyIds.delete(existing.id);
    }

    for (const manifest of entries) {
      this.manifest.set(manifest.id, manifest);
      const existing = this.store.getSkill(manifest.id);
      if (existing && existing.source !== "builtin") {
        this.issues.set(
          manifest.id,
          `Built-in skill id "${manifest.id}" conflicts with an imported skill.`,
        );
        continue;
      }
      if (existing) {
        this.store.registerSkill({
          ...existing,
          ...(existing.cachedVersion === undefined
            ? {
                name: manifest.name,
                description: manifest.description,
                version: manifest.version,
                allowedTools: manifest.allowedTools,
                tags: manifest.tags,
              }
            : {}),
          availableVersion: manifest.version,
        });
        continue;
      }
      this.store.registerSkill({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        allowedTools: manifest.allowedTools,
        tags: manifest.tags,
        autoEnabled: true,
        source: "builtin",
        installedAt: Date.now(),
        availableVersion: manifest.version,
      });
    }
  }

  private async reconcileStoredSkills(manifestLoaded: boolean): Promise<void> {
    for (const entry of this.store.listAll()) {
      const skillMdExists = await this.fs.exists(`${entry.id}/SKILL.md`);
      if (skillMdExists) {
        this.readyIds.add(entry.id);
        continue;
      }
      this.readyIds.delete(entry.id);
      if (entry.source === "imported") {
        this.store.unregisterSkill(entry.id);
      } else if (!manifestLoaded || !this.manifest.has(entry.id)) {
        this.issues.set(entry.id, `Skill "${entry.name}" is missing SKILL.md.`);
      }
    }
  }

  private async cleanupWebSkillDirectories(): Promise<void> {
    let directories;
    try {
      directories = (await this.fs.readDir("")).filter(
        (entry) => entry.isDirectory,
      );
    } catch {
      return;
    }
    for (const directory of directories) {
      let entries;
      try {
        entries = await this.fs.readDir(directory.name);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile && entry.name === "SKILL.md") continue;
        await this.fs.remove(`${directory.name}/${entry.name}`, {
          recursive: entry.isDirectory,
        });
      }
    }
  }

  private async cleanupLegacyBuiltinDirectories(): Promise<void> {
    for (const legacyId of Object.keys(BUILTIN_SKILL_ID_ALIASES)) {
      if (this.store.getSkill(legacyId)?.source === "imported") continue;
      if (await this.fs.exists(legacyId)) {
        await this.fs.remove(legacyId, { recursive: true });
      }
      this.readyIds.delete(legacyId);
    }
  }

  private async ensureBuiltinCached(
    id: string,
    refresh: boolean,
  ): Promise<SkillEntry> {
    const manifest = this.manifest.get(id);
    if (!manifest) {
      if (this.readyIds.has(id)) return this.requireSkill(id);
      throw new Error(`Built-in skill "${id}" is not present in the manifest.`);
    }
    if (this.readyIds.has(id) && !refresh) return this.requireSkill(id);

    try {
      const files = await downloadManifestSkillFiles(
        manifest,
        this.platform === "desktop" ? "desktop" : "web",
        this.fetcher,
      );
      this.assertManifestMatches(manifest, files["SKILL.md"]);
      await this.writeSkillDirectory(id, files);
      return await this.registerSkillFromDir(id, "builtin", {
        cachedVersion: manifest.version,
        availableVersion: manifest.version,
      });
    } catch (error) {
      this.issues.set(id, this.errorMessage(error));
      throw error;
    }
  }

  private assertManifestMatches(
    manifest: SkillManifestEntry,
    raw: string | undefined,
  ): void {
    if (!raw)
      throw new Error(`Built-in skill "${manifest.id}" has no SKILL.md.`);
    const parsed = parseSkillMd(raw).frontmatter;
    if (
      parsed.name !== manifest.name ||
      parsed.description !== manifest.description ||
      parsed.version !== manifest.version ||
      !sameList(parsed["allowed-tools"], manifest.allowedTools) ||
      !sameList(parsed.tags, manifest.tags)
    ) {
      throw new Error(
        `Built-in skill "${manifest.id}" metadata does not match the manifest.`,
      );
    }
  }

  private requireSkill(id: string): SkillEntry {
    this.assertSafeId(id);
    const skill = this.store.getSkill(id);
    if (!skill) throw new Error(`Skill "${id}" is not registered`);
    this.assertSafeId(skill.id);
    return skill;
  }

  private async listFilesIn(
    dirPath: string,
    relativePrefix = "",
  ): Promise<string[]> {
    if (!(await this.fs.exists(dirPath))) return [];
    const found: string[] = [];
    const entries = await this.fs.readDir(dirPath);
    for (const entry of entries) {
      const relative = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : entry.name;
      if (entry.isFile) {
        found.push(relative);
      } else if (entry.isDirectory) {
        found.push(
          ...(await this.listFilesIn(`${dirPath}/${entry.name}`, relative)),
        );
      }
    }
    return found.sort();
  }

  private assertSafeId(id: string): void {
    if (
      !id ||
      id.length > SKILL_IMPORT_LIMITS.maxIdChars ||
      !/^[a-zA-Z0-9._-]+$/.test(id)
    ) {
      throw new Error(
        `Unsafe skill id "${id}". Must match [a-zA-Z0-9._-]+ and be <= ${SKILL_IMPORT_LIMITS.maxIdChars} characters.`,
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
