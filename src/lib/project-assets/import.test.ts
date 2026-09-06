// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  blobs: new Map<string, Map<string, unknown>>(),
  attachment: null as Blob | null,
}));

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
  getAttachmentBlob: async () => mocks.attachment,
  deleteAttachmentsForMessages: vi.fn(async () => undefined),
}));

import { useConversationStore } from "../../store/conversation";
import { importGeneratedImageAsset } from "./import";

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
]);

describe("importGeneratedImageAsset", () => {
  beforeEach(() => {
    for (const store of mocks.blobs.values()) store.clear();
    mocks.attachment = new Blob([Uint8Array.from(pngBytes).buffer], {
      type: "image/png",
    });
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: false,
    });
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
});
