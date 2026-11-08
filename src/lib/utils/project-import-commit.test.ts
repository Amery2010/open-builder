import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { useSnapshotStore } from "../../store/snapshot";
import { digestProjectSnapshot } from "../project-runtime/snapshot";
import { assessProjectRuntime } from "../project-runtime/capabilities";
import { stageProjectAsset } from "../project-assets/core";
import { commitImportedProject } from "./project-import-commit";
import type { StagedProjectImport } from "./project-import";

const mocks = vi.hoisted(() => ({ materialize: vi.fn(), release: vi.fn() }));
vi.mock("../project-assets/import", () => ({
  materializeStagedProjectAssets: mocks.materialize,
  releaseMaterializedProjectAssets: mocks.release,
}));
vi.mock("localforage", () => {
  const values = new Map();
  const adapter = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: unknown) => values.set(key, value),
    removeItem: async (key: string) => values.delete(key),
    iterate: async () => undefined,
  };
  return { default: { ...adapter, createInstance: () => adapter } };
});

async function fixture(): Promise<StagedProjectImport> {
  const files = { "index.html": "<h1>Imported</h1>" };
  return {
    name: "Imported project",
    files,
    template: "static",
    previewMode: "sandpack",
    activeFile: "index.html",
    report: {
      importedFiles: 1,
      totalBytes: 17,
      redactedFiles: 0,
      skipped: { ignored: 0, sensitive: 0, binary: 0, symlink: 0 },
    },
    preflight: {
      digest: await digestProjectSnapshot(files),
      capabilities: assessProjectRuntime(files),
    },
  };
}

describe("locally checked project import commit", () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
    });
    useSnapshotStore.setState({ snapshots: {}, _hasHydrated: true });
    mocks.materialize.mockReset();
    mocks.materialize.mockImplementation(async (_assets, files) => ({
      assets: {},
      files,
    }));
    mocks.release.mockReset();
  });

  it("creates a separate conversation and preserves the original project and messages", async () => {
    const sourceId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({ "original.js": "original" });
    useConversationStore
      .getState()
      .setMessages([{ role: "user", content: "keep this history" }]);
    const original = useConversationStore.getState().conversations[sourceId];
    const snapshots = useSnapshotStore.getState().snapshots;
    const project = await fixture();
    expect(
      await commitImportedProject(project, { isCurrent: () => true }),
    ).toEqual({ ok: true });
    const state = useConversationStore.getState();
    expect(state.activeId).not.toBe(sourceId);
    expect(state.conversations[sourceId]).toBe(original);
    expect(useSnapshotStore.getState().snapshots).toBe(snapshots);
    expect(state.conversations[state.activeId!]).toMatchObject({
      title: project.name,
      files: project.files,
      messages: [],
      previewMode: "sandpack",
    });
  });

  it("rejects missing or stale local checks before materializing assets", async () => {
    const project = await fixture();
    expect(
      await commitImportedProject(
        { ...project, preflight: undefined! },
        { isCurrent: () => true },
      ),
    ).toMatchObject({ ok: false });
    expect(
      await commitImportedProject(
        { ...project, files: { "index.html": "changed after checking" } },
        { isCurrent: () => true },
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed after checking"),
    });
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(useConversationStore.getState().conversations).toEqual({});
  });

  it("imports unsupported source in code-only mode and recomputes untrusted preview metadata", async () => {
    const project = await fixture();
    project.files["package.json"] = JSON.stringify({
      devDependencies: { vite: "8.2.2" },
      scripts: { dev: "vite" },
    });
    project.template = "react";
    project.preflight.digest = await digestProjectSnapshot(project.files);
    expect(
      await commitImportedProject(project, { isCurrent: () => true }),
    ).toEqual({ ok: true });
    const state = useConversationStore.getState();
    expect(state.conversations[state.activeId!]).toMatchObject({
      files: project.files,
      template: "vite",
      previewMode: "code-only",
    });
  });

  it("validates unsafe paths and resource bytes even with a matching snapshot digest", async () => {
    const project = await fixture();
    project.files = { "../escape.js": "unsafe" };
    project.preflight.digest = await digestProjectSnapshot(project.files);
    expect(
      await commitImportedProject(project, { isCurrent: () => true }),
    ).toMatchObject({ ok: false });

    project.files = { "index.html": "<h1>Imported</h1>" };
    const asset = await stageProjectAsset(
      "pixel.gif",
      new Blob(["GIF89a-original"]),
    );
    project.assets = [{ ...asset, blob: new Blob(["GIF89a-modified"]) }];
    project.preflight.digest = await digestProjectSnapshot(
      project.files,
      project.assets,
    );
    expect(
      await commitImportedProject(project, { isCurrent: () => true }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed after checking"),
    });
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(useConversationStore.getState().conversations).toEqual({});
  });

  it("does not create an empty conversation on cancellation or storage failure", async () => {
    const project = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await commitImportedProject(project, {
        signal: controller.signal,
        isCurrent: () => true,
      }),
    ).toMatchObject({ ok: false });
    expect(mocks.materialize).not.toHaveBeenCalled();
    mocks.materialize.mockRejectedValueOnce(new Error("Storage unavailable"));
    expect(
      await commitImportedProject(project, { isCurrent: () => true }),
    ).toMatchObject({ ok: false, error: "Storage unavailable" });
    expect(useConversationStore.getState().activeId).toBeNull();
    expect(useConversationStore.getState().conversations).toEqual({});
  });

  it("rechecks cancellation after asynchronous materialization", async () => {
    const project = await fixture();
    let current = true;
    mocks.materialize.mockImplementationOnce(async (_assets, files) => {
      current = false;
      return { assets: {}, files };
    });
    expect(
      await commitImportedProject(project, { isCurrent: () => current }),
    ).toMatchObject({ ok: false });
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(useConversationStore.getState().conversations).toEqual({});
  });
});
