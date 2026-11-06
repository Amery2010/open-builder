import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opfsArchiveStorage } from "./opfs";
import { writeOpfsFileInWorker } from "./opfs-writer";
vi.mock("./opfs-writer", () => ({ writeOpfsFileInWorker: vi.fn() }));
import JSZip from "jszip";
import { ProjectArchiveManager } from "./service";
import type { ProjectArchiveRecord } from "../../store/project-archives";
vi.mock("localforage", () => {
  const store = () => ({
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  });
  return { default: { ...store(), createInstance: store } };
});

function missing() {
  return new DOMException("Not found", "NotFoundError");
}
class MemoryDirectory {
  kind = "directory";
  directories = new Map<string, MemoryDirectory>();
  files = new Map<string, Blob>();
  failClose = false;
  writableSupported = true;
  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryDirectory> {
    let dir = this.directories.get(name);
    if (!dir && options?.create) {
      dir = new MemoryDirectory();
      this.directories.set(name, dir);
    }
    if (!dir) throw missing();
    return dir;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name) && !options?.create) throw missing();
    if (!this.files.has(name)) this.files.set(name, new Blob());
    return {
      kind: "file",
      getFile: async () => this.files.get(name)!,
      createWritable: !this.writableSupported
        ? undefined
        : async () => {
            let staged: Blob | undefined;
            return {
              write: async (value: Blob | string) => {
                staged = typeof value === "string" ? new Blob([value]) : value;
              },
              close: async () => {
                if (this.failClose)
                  throw new DOMException("Quota full", "QuotaExceededError");
                if (staged) this.files.set(name, staged);
              },
              abort: async () => undefined,
            };
          },
    };
  }
  async removeEntry(name: string) {
    if (!this.files.delete(name) && !this.directories.delete(name))
      throw missing();
  }
  async *entries() {
    for (const [name, dir] of this.directories) yield [name, dir];
    for (const name of this.files.keys()) yield [name, { kind: "file" }];
  }
}
let fs: MemoryDirectory;
beforeEach(() => {
  fs = new MemoryDirectory();
  vi.mocked(writeOpfsFileInWorker).mockReset();
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => fs },
    locks: { request: vi.fn(async (_name, callback) => callback()) },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("OPFS archive commit and ownership", () => {
  it("closes and reads the binary file before exposing a reusable reference", async () => {
    const ticket = await opfsArchiveStorage.capture("project", "s1");
    const original = new Uint8Array([0, 1, 255, 2, 0]);
    const written = await opfsArchiveStorage.write(
      "project",
      "s1",
      "digest",
      new Blob([original]),
      ticket,
    );
    expect(new Uint8Array(await written.arrayBuffer())).toEqual(original);
    expect(written.type).toBe("application/zip");
    expect(
      new Uint8Array(
        await (
          await opfsArchiveStorage.read("project", "s1", "digest")
        ).arrayBuffer(),
      ),
    ).toEqual(original);
    expect(await opfsArchiveStorage.estimate()).toEqual({ items: 1, bytes: 5 });
  });
  it("uses a worker for both manifests and ZIP bytes when createWritable is unavailable", async () => {
    const root = await fs.getDirectoryHandle("project-archives", {
      create: true,
    });
    root.writableSupported = false;
    const project = await root.getDirectoryHandle("project", { create: true });
    project.writableSupported = false;
    vi.mocked(writeOpfsFileInWorker).mockImplementation(async (path, value) => {
      let dir = fs;
      for (const part of path.slice(0, -1))
        dir = await dir.getDirectoryHandle(part, { create: true });
      dir.files.set(
        path.at(-1)!,
        typeof value === "string" ? new Blob([value]) : value,
      );
    });
    const ticket = await opfsArchiveStorage.capture("project", "s1");
    await opfsArchiveStorage.write(
      "project",
      "s1",
      "digest",
      new Blob(["archive bytes"]),
      ticket,
    );
    expect(writeOpfsFileInWorker).toHaveBeenCalledWith(
      ["project-archives", "generation.json"],
      expect.any(String),
    );
    expect(writeOpfsFileInWorker).toHaveBeenCalledWith(
      ["project-archives", "project", "digest.zip"],
      expect.any(Blob),
    );
    expect(
      await (await opfsArchiveStorage.read("project", "s1", "digest")).text(),
    ).toBe("archive bytes");
  });
  it("keeps writer capability errors visible when the worker cannot write OPFS", async () => {
    const root = await fs.getDirectoryHandle("project-archives", {
      create: true,
    });
    root.writableSupported = false;
    vi.mocked(writeOpfsFileInWorker).mockRejectedValue(
      new Error("No synchronous OPFS writer"),
    );
    await expect(opfsArchiveStorage.capture("project", "s1")).rejects.toThrow(
      "No synchronous OPFS writer",
    );
    expect(root.files.size).toBe(0);
  });
  it("removes an empty first manifest after quota failure so capture can be retried", async () => {
    const root = await fs.getDirectoryHandle("project-archives", {
      create: true,
    });
    root.failClose = true;
    await expect(opfsArchiveStorage.capture("project", "s1")).rejects.toThrow(
      "Quota full",
    );
    expect(root.files.size).toBe(0);
    root.failClose = false;
    await expect(
      opfsArchiveStorage.capture("project", "s1"),
    ).resolves.toBeDefined();
  });
  it("does not publish a reference after close fails and permits retry", async () => {
    const ticket = await opfsArchiveStorage.capture("project", "s1");
    const project = await (
      await fs.getDirectoryHandle("project-archives")
    ).getDirectoryHandle("project", { create: true });
    project.failClose = true;
    await expect(
      opfsArchiveStorage.write(
        "project",
        "s1",
        "digest",
        new Blob(["content"]),
        ticket,
      ),
    ).rejects.toThrow("Quota full");
    await expect(
      opfsArchiveStorage.read("project", "s1", "digest"),
    ).rejects.toThrow("missing");
    project.failClose = false;
    await expect(
      opfsArchiveStorage.write(
        "project",
        "s1",
        "digest",
        new Blob(["content"]),
        ticket,
      ),
    ).resolves.toBeDefined();
  });
  it("retains the shared ZIP and rejects a released checkpoint from another client", async () => {
    for (const id of ["s1", "s2"]) {
      const ticket = await opfsArchiveStorage.capture("project", id);
      await opfsArchiveStorage.write(
        "project",
        id,
        "digest",
        new Blob(["content"]),
        ticket,
      );
    }
    const staleTicket = await opfsArchiveStorage.capture("project", "s1");
    await opfsArchiveStorage.release("project", "s1");
    await expect(
      opfsArchiveStorage.write(
        "project",
        "s1",
        "digest",
        new Blob(["content"]),
        staleTicket,
      ),
    ).rejects.toThrow("removed");
    expect(await opfsArchiveStorage.estimate()).toEqual({ items: 1, bytes: 7 });
    await opfsArchiveStorage.release("project", "s2");
    expect(await opfsArchiveStorage.estimate()).toEqual({ items: 0, bytes: 0 });
  });
  it("retries file deletion after the ownership link was already removed", async () => {
    const ticket = await opfsArchiveStorage.capture("project", "s1");
    await opfsArchiveStorage.write(
      "project",
      "s1",
      "digest",
      new Blob(["content"]),
      ticket,
    );
    const dir = await (
      await fs.getDirectoryHandle("project-archives")
    ).getDirectoryHandle("project");
    vi.spyOn(dir, "removeEntry").mockRejectedValueOnce(
      new Error("temporary disk failure"),
    );
    await expect(opfsArchiveStorage.release("project", "s1")).rejects.toThrow(
      "temporary disk failure",
    );
    expect(await opfsArchiveStorage.estimate()).toEqual({ items: 1, bytes: 7 });
    await opfsArchiveStorage.release("project", "s1");
    expect(await opfsArchiveStorage.estimate()).toEqual({ items: 0, bytes: 0 });
  });
  it("persists project deletion and does not erase an independent copy", async () => {
    const staleTicket = await opfsArchiveStorage.capture("original", "s1");
    const copyTicket = await opfsArchiveStorage.capture("copy", "s1");
    await opfsArchiveStorage.write(
      "copy",
      "s1",
      "digest",
      new Blob(["content"]),
      copyTicket,
    );
    await opfsArchiveStorage.deleteProject("original");
    await expect(
      opfsArchiveStorage.write(
        "original",
        "s1",
        "digest",
        new Blob(["late"]),
        staleTicket,
      ),
    ).rejects.toThrow("removed");
    await expect(opfsArchiveStorage.capture("original", "s2")).rejects.toThrow(
      "removed",
    );
    expect((await opfsArchiveStorage.read("copy", "s1", "digest")).size).toBe(
      7,
    );
  });
  it("keeps project bytes when the deletion tombstone cannot be saved and succeeds on retry", async () => {
    const ticket = await opfsArchiveStorage.capture("project", "s1");
    await opfsArchiveStorage.write(
      "project",
      "s1",
      "digest",
      new Blob(["content"]),
      ticket,
    );
    const root = await fs.getDirectoryHandle("project-archives");
    root.failClose = true;
    await expect(opfsArchiveStorage.deleteProject("project")).rejects.toThrow(
      "Quota full",
    );
    expect(
      (await opfsArchiveStorage.read("project", "s1", "digest")).size,
    ).toBe(7);
    root.failClose = false;
    await opfsArchiveStorage.deleteProject("project");
    expect(await opfsArchiveStorage.estimate()).toEqual({ items: 0, bytes: 0 });
  });
  it("uses a durable generation to fence a stale writer after clearing all storage", async () => {
    const old = await opfsArchiveStorage.capture("project", "s1");
    await opfsArchiveStorage.clear();
    await expect(
      opfsArchiveStorage.write(
        "project",
        "s1",
        "digest",
        new Blob(["late"]),
        old,
      ),
    ).rejects.toThrow("changed");
    const fresh = await opfsArchiveStorage.capture("project", "s2");
    await expect(
      opfsArchiveStorage.write(
        "project",
        "s2",
        "new",
        new Blob(["fresh"]),
        fresh,
      ),
    ).resolves.toBeDefined();
  });
  it.each(["different length", "same length"])(
    "rebuilds a %s corrupt ZIP through ensure instead of re-publishing it",
    async (kind) => {
      let record: ProjectArchiveRecord | undefined;
      const source = {
        title: "Project",
        files: { "index.html": "exact checkpoint" },
        assets: {},
        snapshot: {
          id: "s1",
          conversationId: "project",
          messageId: "m1",
          createdAt: 1,
          patches: {},
          addedFiles: {},
          deletedFiles: [],
        },
      };
      const manager = new ProjectArchiveManager({
        storage: opfsArchiveStorage,
        source: () => source,
        records: (): Record<string, ProjectArchiveRecord> =>
          record ? { '["project","s1"]': record } : {},
        put: (value) => {
          record = value;
        },
        remove: () => {
          record = undefined;
        },
      });
      const initial = await manager.ensure("project", "s1");
      const dir = await (
        await fs.getDirectoryHandle("project-archives")
      ).getDirectoryHandle("project");
      dir.files.set(
        `${initial.contentDigest}.zip`,
        new Blob([
          kind === "same length"
            ? new Uint8Array(initial.size).fill(42)
            : "BAD",
        ]),
      );
      const repaired = await manager.read("project", "s1");
      const zip = await JSZip.loadAsync(await repaired.blob.arrayBuffer());
      expect(await zip.file("index.html")!.async("string")).toBe(
        "exact checkpoint",
      );
      expect(repaired.record.contentDigest).toBe(initial.contentDigest);
      expect(repaired.record.status).toBe("ready");
      expect(repaired.record.size).toBe(initial.size);
    },
  );
  it("fails without cross-context Web Locks instead of using a per-tab write lock", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => fs } });
    await expect(opfsArchiveStorage.capture("project", "s1")).rejects.toThrow(
      "Web Locks",
    );
    expect(fs.directories.size).toBe(0);
  });
  it("reports unavailable OPFS without a fallback claiming success", async () => {
    vi.stubGlobal("navigator", {});
    await expect(opfsArchiveStorage.capture("project", "s1")).rejects.toThrow(
      "require OPFS",
    );
    expect(await opfsArchiveStorage.estimate()).toEqual({ items: 0, bytes: 0 });
  });
});
