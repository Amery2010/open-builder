// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    blobs: new Map<string, Map<string, unknown>>(),
    getAttachment: vi.fn(async (): Promise<Blob | null> => null),
  };
});

vi.mock("localforage", () => {
  const instance = (storeName: string) => {
    const store = mocks.blobs.get(storeName) ?? new Map<string, unknown>();
    mocks.blobs.set(storeName, store);
    return {
      getItem: async <T>(key: string) => (store.get(key) as T) ?? null,
      setItem: async (key: string, value: unknown) => {
        store.set(key, value);
        return value;
      },
      removeItem: async (key: string) => store.delete(key),
      clear: async () => store.clear(),
      iterate: async <T>(iterator: (value: T, key: string) => void) => {
        for (const [key, value] of store) iterator(value as T, key);
      },
    };
  };
  const root = instance("root");
  return {
    default: {
      ...root,
      createInstance: ({ storeName = "default" }: { storeName?: string }) =>
        instance(storeName),
    },
  };
});

vi.mock("../attachments/store", () => ({
  getAttachmentBlob: mocks.getAttachment,
  deleteAttachmentsForMessages: vi.fn(async () => undefined),
}));

import { useConversationStore } from "../../store/conversation";
import { useProjectTemplateStore } from "../../store/project-templates";
import { useSnapshotStore } from "../../store/snapshot";
import { importGeneratedImageAsset } from "./import";

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
]);

function imageBlob(): Blob {
  return new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" });
}

describe("importGeneratedImageAsset", () => {
  beforeEach(() => {
    for (const store of mocks.blobs.values()) store.clear();
    mocks.getAttachment.mockReset();
    mocks.getAttachment.mockImplementation(async () => imageBlob());
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: false,
    });
    useSnapshotStore.setState({ snapshots: {}, _hasHydrated: true });
    useProjectTemplateStore.setState({ templates: {}, _hasHydrated: true });
  });

  it("copies an attachment into the asset domain and commits its managed module", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "export default function App() {}" });

    const result = await importGeneratedImageAsset({
      conversationId,
      imageId: "opaque-image-id",
      mimeType: "image/png",
      name: "Hero Image.png",
    });
    const conversation =
      useConversationStore.getState().conversations[conversationId];

    expect(result.publicPath).toBe("/generated/hero-image.png");
    expect(conversation.assets?.[result.asset.path]).toEqual(result.asset);
    expect(conversation.files[result.modulePath]).toContain(
      'export default "/generated/hero-image.png"',
    );
    expect(JSON.stringify(conversation)).not.toContain("data:image");
    expect(
      mocks.blobs.get("project-assets")?.get(result.asset.blobRef),
    ).toBeInstanceOf(Blob);
  });

  it("requires an initialized project and rejects path collisions", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    await expect(
      importGeneratedImageAsset({
        conversationId,
        imageId: "opaque-image-id",
        mimeType: "image/png",
        name: "hero.png",
      }),
    ).rejects.toThrow(/initialize/i);

    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "app", "public/generated/hero.png": "text" });
    await expect(
      importGeneratedImageAsset({
        conversationId,
        imageId: "opaque-image-id",
        mimeType: "image/png",
        name: "hero.png",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("rejects generated-image destinations outside the public tree", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "export default function App() {}" });

    await expect(
      importGeneratedImageAsset({
        conversationId,
        imageId: "opaque-image-id",
        mimeType: "image/png",
        name: "hero.png",
        path: "src/assets/hero.png",
      }),
    ).rejects.toThrow(/below public/i);
  });

  it("does not commit after the Host run is aborted during Blob loading", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "export default function App() {}" });
    let resolveAttachment!: (blob: Blob) => void;
    mocks.getAttachment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAttachment = resolve;
        }),
    );
    const controller = new AbortController();
    const importing = importGeneratedImageAsset({
      conversationId,
      imageId: "opaque-image-id",
      mimeType: "image/png",
      name: "hero.png",
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();
    resolveAttachment(imageBlob());

    await expect(importing).rejects.toMatchObject({ name: "AbortError" });
    expect(
      useConversationStore.getState().conversations[conversationId].assets,
    ).toEqual({});
    expect(mocks.blobs.get("project-assets")).toEqual(new Map());
  });

  it("rejects a stale project revision after asynchronous Blob loading", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({ "src/App.tsx": "before" });
    let resolveAttachment!: (blob: Blob) => void;
    mocks.getAttachment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAttachment = resolve;
        }),
    );
    const importing = importGeneratedImageAsset({
      conversationId,
      imageId: "opaque-image-id",
      mimeType: "image/png",
      name: "hero.png",
    });

    await Promise.resolve();
    useConversationStore.getState().setFiles({ "src/App.tsx": "after" });
    resolveAttachment(imageBlob());

    await expect(importing).rejects.toMatchObject({ name: "AbortError" });
    expect(
      useConversationStore.getState().conversations[conversationId].files,
    ).toEqual({ "src/App.tsx": "after" });
    expect(mocks.blobs.get("project-assets")).toEqual(new Map());
  });

  it("keeps a staged Blob conservatively when the Host guard turns stale", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore
      .getState()
      .setFiles({ "src/App.tsx": "export default function App() {}" });
    const isCurrent = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(
      importGeneratedImageAsset({
        conversationId,
        imageId: "opaque-image-id",
        mimeType: "image/png",
        name: "hero.png",
        isCurrent,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(isCurrent).toHaveBeenCalledTimes(4);
    expect(
      useConversationStore.getState().conversations[conversationId].assets,
    ).toEqual({});
    expect(mocks.blobs.get("project-assets")?.size).toBe(1);
  });
});
