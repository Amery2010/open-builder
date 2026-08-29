import type { DesignSystemRef } from "../../types";
import { getBundledDesignSystem } from "./catalog";
import { loadBundledDesignSystem } from "./bundled";
import {
  assertDesignSystemId,
  canonicalDesignSystemFiles,
  validateDesignSystemPackage,
  type DesignSystemInputFile,
  type DesignSystemPackage,
} from "./validation";
import { isTauriMcpHost } from "../mcp/tauri-host";

export interface DesignSystemStorageAdapter {
  listIds(): Promise<string[]>;
  read(id: string): Promise<DesignSystemInputFile[]>;
  write(id: string, files: readonly DesignSystemInputFile[]): Promise<void>;
}

export class MemoryDesignSystemStorage implements DesignSystemStorageAdapter {
  private readonly packages = new Map<string, DesignSystemInputFile[]>();

  async listIds(): Promise<string[]> {
    return [...this.packages.keys()];
  }

  async read(id: string): Promise<DesignSystemInputFile[]> {
    const files = this.packages.get(id);
    if (!files)
      throw new Error(`Imported design system "${id}" was not found.`);
    return files.map((file) => ({ ...file }));
  }

  async write(
    id: string,
    files: readonly DesignSystemInputFile[],
  ): Promise<void> {
    if (this.packages.has(id)) {
      throw new Error(`Imported design system "${id}" already exists.`);
    }
    this.packages.set(
      id,
      files.map((file) => ({ ...file })),
    );
  }
}

export class OpfsDesignSystemStorage implements DesignSystemStorageAdapter {
  private async root(create = true): Promise<FileSystemDirectoryHandle> {
    if (!navigator.storage?.getDirectory) {
      throw new Error("Browser directory storage is unavailable.");
    }
    const originRoot = await navigator.storage.getDirectory();
    return originRoot.getDirectoryHandle("open-builder-design-systems", {
      create,
    });
  }

  async listIds(): Promise<string[]> {
    let root: FileSystemDirectoryHandle;
    try {
      root = await this.root(false);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError")
        return [];
      throw error;
    }
    const ids: string[] = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === "directory") ids.push(name);
    }
    return ids.sort();
  }

  async read(id: string): Promise<DesignSystemInputFile[]> {
    assertDesignSystemId(id);
    const directory = await (await this.root(false)).getDirectoryHandle(id);
    const files: DesignSystemInputFile[] = [];
    for (const path of ["manifest.json", "DESIGN.md", "tokens.css"]) {
      const handle = await directory.getFileHandle(path);
      files.push({ path, content: await (await handle.getFile()).text() });
    }
    return files;
  }

  async write(
    id: string,
    files: readonly DesignSystemInputFile[],
  ): Promise<void> {
    assertDesignSystemId(id);
    const root = await this.root();
    try {
      await root.getDirectoryHandle(id);
      throw new Error(`Imported design system "${id}" already exists.`);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
        throw error;
      }
    }
    const directory = await root.getDirectoryHandle(id, { create: true });
    try {
      for (const file of files) {
        const handle = await directory.getFileHandle(file.path, {
          create: true,
        });
        const writable = await handle.createWritable();
        await writable.write(file.content);
        await writable.close();
      }
    } catch (error) {
      await root.removeEntry(id, { recursive: true }).catch(() => undefined);
      throw error;
    }
  }
}

class PlatformDesignSystemStorage implements DesignSystemStorageAdapter {
  private adapterPromise: Promise<DesignSystemStorageAdapter> | undefined;

  private adapter(): Promise<DesignSystemStorageAdapter> {
    this.adapterPromise ??= isTauriMcpHost()
      ? import("./registry-tauri").then(
          ({ TauriDesignSystemStorage }) => new TauriDesignSystemStorage(),
        )
      : Promise.resolve(new OpfsDesignSystemStorage());
    return this.adapterPromise;
  }

  async listIds(): Promise<string[]> {
    return (await this.adapter()).listIds();
  }

  async read(id: string): Promise<DesignSystemInputFile[]> {
    return (await this.adapter()).read(id);
  }

  async write(
    id: string,
    files: readonly DesignSystemInputFile[],
  ): Promise<void> {
    return (await this.adapter()).write(id, files);
  }
}

export class DesignSystemRegistry {
  private importTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: DesignSystemStorageAdapter = new PlatformDesignSystemStorage(),
  ) {}

  async listImported(): Promise<DesignSystemRef[]> {
    const ids = await this.storage.listIds();
    const references: DesignSystemRef[] = [];
    for (const id of ids) {
      try {
        references.push((await this.loadImported(id)).reference);
      } catch (error) {
        console.warn(`Ignoring invalid imported design system "${id}":`, error);
      }
    }
    return references;
  }

  async loadImported(id: string): Promise<DesignSystemPackage> {
    assertDesignSystemId(id);
    const files = await this.storage.read(id);
    const manifestFile = files.find((file) => file.path === "manifest.json");
    let source: "imported" | "custom" = "imported";
    try {
      const manifest = JSON.parse(manifestFile?.content ?? "null") as {
        source?: { kind?: unknown };
      } | null;
      if (manifest?.source?.kind === "custom") source = "custom";
    } catch {
      // The package validator below provides the canonical JSON error.
    }
    const pkg = await validateDesignSystemPackage(files, {
      source,
      version: source,
    });
    return {
      ...pkg,
      reference: {
        ...pkg.reference,
        id,
        version: `${source}-${pkg.digest.slice(0, 12)}`,
      },
    };
  }

  async load(id: string): Promise<DesignSystemPackage> {
    return getBundledDesignSystem(id)
      ? loadBundledDesignSystem(id)
      : this.loadImported(id);
  }

  /** Persist only after the caller has displayed and confirmed the staged
   * package summary. Existing ids are never overwritten. */
  confirmImport(pkg: DesignSystemPackage): Promise<DesignSystemRef> {
    const operation = this.importTail.then(() =>
      this.withCrossContextImportLock(() => this.persistImport(pkg)),
    );
    this.importTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private withCrossContextImportLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      return navigator.locks.request(
        "open-builder-design-system-import",
        operation,
      );
    }
    return operation();
  }

  private async persistImport(
    pkg: DesignSystemPackage,
  ): Promise<DesignSystemRef> {
    const existing = new Set([
      ...Array.from(await this.storage.listIds()),
      ...(getBundledDesignSystem(pkg.manifest.id) ? [pkg.manifest.id] : []),
    ]);
    const baseId =
      pkg.reference.source === "custom"
        ? pkg.manifest.id
        : `${pkg.manifest.id}-imported`;
    let id = baseId;
    let suffix = 2;
    while (existing.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const files = canonicalDesignSystemFiles(pkg);
    await this.storage.write(id, files);
    const stored = await this.loadImported(id);
    return stored.reference;
  }
}

let registry: DesignSystemRegistry | undefined;

export function getDesignSystemRegistry(): DesignSystemRegistry {
  registry ??= new DesignSystemRegistry();
  return registry;
}

export function setDesignSystemRegistryForTests(
  next: DesignSystemRegistry | undefined,
): void {
  registry = next;
}
