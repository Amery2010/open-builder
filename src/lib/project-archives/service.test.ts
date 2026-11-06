import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
  ProjectArchiveManager,
  projectArchiveFileName,
  type ArchiveSource,
} from "./service";
import type { ArchiveStorage, ArchiveTicket } from "./opfs";
import {
  archiveRecordKey,
  type ProjectArchiveRecord,
  type ProjectArchiveCleanupTask,
} from "../../store/project-archives";
import { buildProjectZip } from "../project-assets/archive";

vi.mock("localforage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
    createInstance: () => ({
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async () => undefined),
      removeItem: vi.fn(async () => undefined),
    }),
  },
}));
const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
vi.mock("../project-assets/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project-assets/core")>()),
  readProjectAssetBytes: vi.fn(async () => image),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class MemoryStorage implements ArchiveStorage {
  blobs = new Map<string, Blob>();
  refs = new Map<string, string>();
  deleted = new Set<string>();
  revoked = new Set<string>();
  generation = "0";
  async capture(id: string, snapshot: string) {
    if (this.deleted.has(id) || this.revoked.has(`${id}/${snapshot}`))
      throw new Error("removed");
    return { generation: this.generation, epoch: id };
  }
  async write(
    id: string,
    snapshot: string,
    digest: string,
    blob: Blob,
    ticket: ArchiveTicket,
  ) {
    await this.capture(id, snapshot);
    if (ticket.generation !== this.generation)
      throw new Error("storage changed");
    this.blobs.set(`${id}/${digest}`, blob);
    this.refs.set(`${id}/${snapshot}`, digest);
    return blob;
  }
  async read(id: string, snapshot: string, digest: string) {
    const blob = this.blobs.get(`${id}/${digest}`);
    if (this.refs.get(`${id}/${snapshot}`) !== digest || !blob)
      throw new Error("missing archive");
    return blob;
  }
  async release(id: string, snapshot: string) {
    this.revoked.add(`${id}/${snapshot}`);
    const digest = this.refs.get(`${id}/${snapshot}`);
    this.refs.delete(`${id}/${snapshot}`);
    if (
      ![...this.refs].some(
        ([key, value]) => key.startsWith(`${id}/`) && value === digest,
      )
    )
      this.blobs.delete(`${id}/${digest}`);
  }
  async deleteProject(id: string) {
    this.deleted.add(id);
    for (const key of this.blobs.keys())
      if (key.startsWith(`${id}/`)) this.blobs.delete(key);
  }
  async clear() {
    this.generation = String(Number(this.generation) + 1);
    this.blobs.clear();
    this.refs.clear();
  }
  async estimate() {
    return {
      items: this.blobs.size,
      bytes: [...this.blobs.values()].reduce((n, b) => n + b.size, 0),
    };
  }
}
function source(
  id = "s1",
  files = { "src/App.tsx": "version one", "package.json": "{}" },
): ArchiveSource {
  return {
    title: "项目 / Test",
    snapshot: {
      id,
      conversationId: "p",
      messageId: "m",
      patches: {},
      addedFiles: {},
      deletedFiles: [],
      createdAt: 1700000000000,
      kind: "checkpoint",
      branchId: "main",
    },
    files,
    assets: {},
  };
}
let records: Record<string, ProjectArchiveRecord>;
let cleanupTasks: Record<string, ProjectArchiveCleanupTask>;
let sources: Map<string, ArchiveSource>;
let storage: MemoryStorage;
function manager(build = buildProjectZip) {
  return new ProjectArchiveManager({
    storage,
    source: (p, s) => sources.get(`${p}/${s}`),
    records: () => records,
    put: (record) => {
      records[archiveRecordKey(record.conversationId, record.snapshotId)] =
        record;
    },
    remove: (keys) => {
      for (const key of keys) delete records[key];
    },
    cleanupTasks: () => cleanupTasks,
    putCleanup: (task) => {
      cleanupTasks[task.id] = task;
    },
    removeCleanup: (ids) => {
      for (const id of ids) delete cleanupTasks[id];
    },
    build,
  });
}
beforeEach(() => {
  records = {};
  cleanupTasks = {};
  sources = new Map([["p/s1", source()]]);
  storage = new MemoryStorage();
});

describe("checkpoint archives", () => {
  it("packages the exact text tree and binary assets, independent of subsequent edits", async () => {
    const item = sources.get("p/s1")!;
    item.assets = {
      "public/logo.png": {
        path: "public/logo.png",
        blobRef: "image",
        mimeType: "image/png",
        size: image.length,
        digest: "a".repeat(64),
        modulePath: "logo.ts",
        publicPath: "/logo.png",
      },
    };
    const api = manager();
    const { record, blob } = await api.read("p", "s1");
    item.files["src/App.tsx"] = "later version";
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(await zip.file("src/App.tsx")!.async("string")).toBe("version one");
    expect(await zip.file("public/logo.png")!.async("uint8array")).toEqual(
      image,
    );
    expect(record.status).toBe("ready");
    expect(record.fileName).toMatch(/\.zip$/);
    expect(record.fileName).not.toContain("/");
    expect(record.fileName).not.toBe("Unknown");
  });
  it("shares one build for duplicate clicks and reuses equal content across branch checkpoints", async () => {
    const gate = deferred<Blob>();
    const build = vi.fn(() => gate.promise);
    const api = manager(build);
    const a = api.ensure("p", "s1");
    const b = api.ensure("p", "s1");
    expect(a).toBe(b);
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
    gate.resolve(await buildProjectZip(source().files));
    await a;
    sources.set("p/s2", source("s2"));
    const second = await api.ensure("p", "s2");
    expect(build).toHaveBeenCalledOnce();
    expect(storage.blobs.size).toBe(1);
    expect(second.contentDigest).toBe(
      records[archiveRecordKey("p", "s1")].contentDigest,
    );
  });
  it("keeps renamed and historical snapshots immutable and survives a manager restart", async () => {
    const api = manager();
    const first = await api.ensure("p", "s1");
    sources.get("p/s1")!.title = "renamed";
    const restarted = manager(
      vi.fn(() => {
        throw new Error("should reuse OPFS");
      }),
    );
    expect((await restarted.read("p", "s1")).record.fileName).toBe(
      first.fileName,
    );
  });
  it("regenerates evicted bytes from the exact checkpoint", async () => {
    const api = manager();
    await api.ensure("p", "s1");
    storage.blobs.clear();
    const { blob } = await manager().read("p", "s1");
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(await zip.file("src/App.tsx")!.async("string")).toBe("version one");
  });
  it("exposes packaging failure and allows retry", async () => {
    const write = vi
      .spyOn(storage, "write")
      .mockRejectedValueOnce(
        new DOMException("Storage quota exceeded", "QuotaExceededError"),
      );
    const api = manager();
    await expect(api.ensure("p", "s1")).rejects.toThrow("quota");
    expect(records[archiveRecordKey("p", "s1")]).toMatchObject({
      status: "failed",
      error: "Storage quota exceeded",
    });
    await expect(api.ensure("p", "s1")).resolves.toMatchObject({
      status: "ready",
    });
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("rejects corrupt replay instead of packaging another version", async () => {
    const api = new ProjectArchiveManager({
      storage,
      source: () => {
        throw new Error("Patch cannot apply");
      },
      records: () => records,
      put: (r) => {
        records[archiveRecordKey(r.conversationId, r.snapshotId)] = r;
      },
      remove: () => undefined,
    });
    await expect(api.ensure("p", "s1")).rejects.toThrow("Patch cannot apply");
    expect(records[archiveRecordKey("p", "s1")].status).toBe("failed");
    expect(storage.blobs.size).toBe(0);
  });
  it("does not resurrect a removed project when packaging completes later", async () => {
    const gate = deferred<Blob>();
    const api = manager(() => gate.promise);
    const pending = api.ensure("p", "s1");
    await vi.waitFor(() =>
      expect(records[archiveRecordKey("p", "s1")]?.status).toBe("pending"),
    );
    sources.clear();
    await api.deleteProject("p");
    gate.resolve(new Blob(["zip"]));
    await expect(pending).rejects.toThrow("removed");
    expect(records).toEqual({});
    expect(storage.blobs.size).toBe(0);
  });
  it("clearing storage invalidates work even while the source still exists", async () => {
    const gate = deferred<Blob>();
    const api = manager(() => gate.promise);
    const pending = api.ensure("p", "s1");
    await vi.waitFor(() =>
      expect(records[archiveRecordKey("p", "s1")]?.status).toBe("pending"),
    );
    await api.clear();
    gate.resolve(new Blob(["zip"]));
    await expect(pending).rejects.toThrow("removed");
    expect(records).toEqual({});
    expect(storage.blobs.size).toBe(0);
  });
  it("retains shared content until the last checkpoint reference is removed", async () => {
    sources.set("p/s2", source("s2"));
    const api = manager();
    await api.ensure("p", "s1");
    await api.ensure("p", "s2");
    sources.delete("p/s1");
    await api.release("p", "s1");
    expect(storage.blobs.size).toBe(1);
    await expect(api.read("p", "s2")).resolves.toBeDefined();
    sources.delete("p/s2");
    await api.release("p", "s2");
    expect(storage.blobs.size).toBe(0);
  });
  it("gives a copied project its own archive ownership", async () => {
    sources.set("copy/s1", {
      ...source(),
      snapshot: { ...source().snapshot, conversationId: "copy" },
    });
    const api = manager();
    await api.ensure("p", "s1");
    await api.ensure("copy", "s1");
    sources.delete("p/s1");
    await api.deleteProject("p");
    await expect(api.read("copy", "s1")).resolves.toBeDefined();
  });
  it.each(["snapshot", "project", "all"] as const)(
    "persists a failed %s cleanup and retries after manager restart",
    async (kind) => {
      const api = manager();
      await api.ensure("p", "s1");
      sources.clear();
      const operation =
        kind === "snapshot"
          ? "release"
          : kind === "project"
            ? "deleteProject"
            : "clear";
      vi.spyOn(storage, operation).mockRejectedValueOnce(
        new Error("cleanup storage unavailable"),
      );
      const cleanup =
        kind === "snapshot"
          ? api.release("p", "s1")
          : kind === "project"
            ? api.deleteProject("p")
            : api.clear();
      await expect(cleanup).rejects.toThrow("cleanup storage unavailable");
      expect(Object.values(cleanupTasks)).toEqual([
        expect.objectContaining({ kind, error: "cleanup storage unavailable" }),
      ]);
      expect(records[archiveRecordKey("p", "s1")]).toBeDefined();
      await manager().retryCleanup();
      expect(cleanupTasks).toEqual({});
      expect(records).toEqual({});
      expect(storage.blobs.size).toBe(0);
    },
  );
  it("persists cleanup for an in-flight version even if no archive metadata was written", async () => {
    const api = manager();
    sources.clear();
    vi.spyOn(storage, "release").mockRejectedValueOnce(
      new Error("manifest quota full"),
    );
    await expect(api.release("p", "s1")).rejects.toThrow("manifest quota full");
    expect(records).toEqual({});
    expect(Object.values(cleanupTasks)[0]).toMatchObject({
      kind: "snapshot",
      snapshotId: "s1",
      error: "manifest quota full",
    });
    await manager().retryCleanup();
    expect(cleanupTasks).toEqual({});
  });
  it("uses a stable .zip fallback for empty or unsafe names", () => {
    expect(projectArchiveFileName("...", source().snapshot)).toMatch(
      /^project-.*\.zip$/,
    );
  });
});
