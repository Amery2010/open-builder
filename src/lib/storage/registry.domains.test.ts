// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const designRegistryMocks = vi.hoisted(() => ({
  estimateImportedStorage: vi.fn(async () => ({ count: 2, bytes: 128 })),
  clearImported: vi.fn(async () => undefined),
}));

const revocationMocks = vi.hoisted(() => ({
  beginMcpLifecycleRevocation: vi.fn(() => 1),
  finishMcpLifecycleRevocation: vi.fn(),
  nativeSkillScriptRevocation: {
    begin: vi.fn(() => 2),
    finish: vi.fn(),
  },
  nativeSseRevocation: {
    begin: vi.fn(() => 3),
    finish: vi.fn(),
  },
}));

vi.mock("../design-systems/registry", () => ({
  getDesignSystemRegistry: () => designRegistryMocks,
}));
vi.mock("../mcp/revocation", () => ({
  beginMcpLifecycleRevocation: revocationMocks.beginMcpLifecycleRevocation,
  finishMcpLifecycleRevocation: revocationMocks.finishMcpLifecycleRevocation,
}));
vi.mock("../security/native-execution-revocation", () => ({
  nativeSkillScriptRevocation: revocationMocks.nativeSkillScriptRevocation,
  nativeSseRevocation: revocationMocks.nativeSseRevocation,
}));
vi.mock("../infra/proxy", () => ({
  revokeNativeProxyPolicy: vi.fn(async () => undefined),
}));
vi.mock("../mcp/tauri-host", () => ({
  clearTauriMcpRemotePolicies: vi.fn(async () => undefined),
}));
vi.mock("../skills/script-executor-tauri", () => ({
  cancelAllNativeSkillScripts: vi.fn(async () => undefined),
}));
vi.mock("../infra/sse-bridge", () => ({
  cancelAllNativeSseStreams: vi.fn(async () => undefined),
}));

import {
  STORAGE_DOMAINS,
  StorageClearError,
  clearAllStorageDomains,
} from "./registry";
import { useProjectDesignWorkspaceStore } from "../../store/project-design-workspace";

function stubDomainClears() {
  return Object.fromEntries(
    STORAGE_DOMAINS.map((domain) => [
      domain.id,
      vi.spyOn(domain, "clear").mockResolvedValue(),
    ]),
  ) as Record<
    (typeof STORAGE_DOMAINS)[number]["id"],
    ReturnType<typeof vi.spyOn>
  >;
}

describe("storage domain registry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exports canvas layouts separately and clears their volatile selection too", async () => {
    const layouts = {
      '["conversation","main"]': {
        camera: { x: 10, y: 20, zoom: 0.5 },
        positions: { home: { x: 0, y: 0 } },
      },
    };
    useProjectDesignWorkspaceStore.setState({
      layouts,
      selections: {
        conversation: { pageId: "home", explicit: true },
      },
    });
    const clearDisk = vi
      .spyOn(useProjectDesignWorkspaceStore.persist, "clearStorage")
      .mockResolvedValue();
    const domain = STORAGE_DOMAINS.find(
      (candidate) => candidate.id === "designWorkspace",
    )!;

    await expect(domain.export()).resolves.toEqual(layouts);
    await expect(domain.estimate()).resolves.toMatchObject({ items: 1 });
    await domain.clear();
    expect(clearDisk).toHaveBeenCalledOnce();
    expect(useProjectDesignWorkspaceStore.getState().layouts).toEqual({});
    expect(useProjectDesignWorkspaceStore.getState().selections).toEqual({});
  });

  it("registers imported Design systems for estimation and clearing", async () => {
    const domain = STORAGE_DOMAINS.find(
      (candidate) => candidate.id === "designSystems",
    );

    await expect(domain?.estimate()).resolves.toEqual({
      items: 2,
      bytes: 128,
    });
    await expect(domain?.clear()).resolves.toBeUndefined();
    expect(designRegistryMocks.clearImported).toHaveBeenCalledOnce();
  });

  it("continues independent domains and reports structured partial clearing", async () => {
    const clears = stubDomainClears();
    clears.settings.mockRejectedValue(new Error("quota failure"));

    const error = await clearAllStorageDomains().catch((cause) => cause);

    expect(error).toBeInstanceOf(StorageClearError);
    expect((error as StorageClearError).result).toEqual({
      cleared: STORAGE_DOMAINS.map((domain) => domain.id).filter(
        (id) => id !== "settings",
      ),
      failed: [{ id: "settings", error: "quota failure" }],
      skipped: [],
    });
    expect(clears.projectAssets).toHaveBeenCalledOnce();
    expect(revocationMocks.nativeSseRevocation.finish).toHaveBeenCalledWith(3);
    expect(
      revocationMocks.nativeSkillScriptRevocation.finish,
    ).toHaveBeenCalledWith(2);
    expect(revocationMocks.finishMcpLifecycleRevocation).toHaveBeenCalledWith(
      1,
    );
  });

  it("preserves dependent Blob domains when an owner domain fails", async () => {
    const clears = stubDomainClears();
    clears.conversations.mockRejectedValue(new Error("IndexedDB blocked"));

    const error = await clearAllStorageDomains().catch((cause) => cause);

    expect(error).toBeInstanceOf(StorageClearError);
    expect((error as StorageClearError).result.failed).toEqual([
      { id: "conversations", error: "IndexedDB blocked" },
    ]);
    expect((error as StorageClearError).result.skipped).toEqual([
      {
        id: "attachments",
        reason: "owner domain(s) did not clear: conversations",
      },
      {
        id: "projectAssets",
        reason: "owner domain(s) did not clear: conversations",
      },
      {
        id: "projectArchives",
        reason: "owner domain(s) did not clear: conversations",
      },
    ]);
    expect(clears.snapshots).toHaveBeenCalledOnce();
    expect(clears.templates).toHaveBeenCalledOnce();
    expect(clears.attachments).not.toHaveBeenCalled();
    expect(clears.projectAssets).not.toHaveBeenCalled();
    expect(clears.projectArchives).not.toHaveBeenCalled();
  });
});
