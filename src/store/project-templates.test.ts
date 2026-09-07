import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, ProjectTemplate } from "../types";
import {
  addProjectAssetModules,
  createProjectAssetRecord,
  deleteProjectAssetBlob,
  stageProjectAsset,
  storeStagedProjectAsset,
} from "../lib/project-assets/core";
import { prepareProjectTemplateFromConversation } from "../lib/utils/project-templates";
import {
  migrateProjectTemplateState,
  useProjectTemplateStore,
} from "./project-templates";

const localforageMock = vi.hoisted(() => {
  const stores = new Map<string, Map<string, unknown>>();
  let writeError: Error | null = null;
  const setItem = vi.fn(async (_key: string, _value: unknown) => undefined);
  const createInstance = ({
    name = "default",
    storeName = "default",
  }: {
    name?: string;
    storeName?: string;
  } = {}) => {
    const storageKey = `${name}:${storeName}`;
    const values = stores.get(storageKey) ?? new Map<string, unknown>();
    stores.set(storageKey, values);
    return {
      getItem: async <T>(key: string) => (values.get(key) as T) ?? null,
      setItem: async (key: string, value: unknown) => {
        const currentWriteError = writeError;
        await setItem(key, value);
        if (currentWriteError) throw currentWriteError;
        values.set(key, value);
        return value;
      },
      removeItem: async (key: string) => values.delete(key),
      clear: async () => values.clear(),
      iterate: async <T>(iterator: (value: T, key: string) => void) => {
        for (const [key, value] of values) iterator(value as T, key);
      },
    };
  };
  return {
    ...createInstance(),
    createInstance,
    setItem,
    clear() {
      for (const store of stores.values()) store.clear();
    },
    get(name: string, storeName: string, key: string) {
      return stores.get(`${name}:${storeName}`)?.get(key);
    },
    failWrites(error: Error | null) {
      writeError = error;
    },
  };
});

vi.mock("localforage", () => ({ default: localforageMock }));

function makeTemplate(
  overrides: Partial<ProjectTemplate> = {},
): ProjectTemplate {
  return {
    id: "template-1",
    name: "Starter",
    files: { "src/App.tsx": "app" },
    template: "vite-react-ts",
    tags: [],
    schemaVersion: 2,
    contentDigest:
      "59691933e44302ffe25685c2a1d4a668f89942015f00111b87432938ff9c42c4",
    safety: {
      status: "safe",
      excludedPaths: [],
      redactedPaths: [],
      preparedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
]);

const conversation: Conversation = {
  id: "source",
  title: "Source",
  messages: [],
  files: { "src/App.tsx": "export default function App() {}" },
  template: "vite-react-ts",
  isProjectInitialized: true,
  createdAt: 1,
  updatedAt: 1,
};

describe("project template store", () => {
  beforeEach(() => {
    localforageMock.clear();
    localforageMock.failWrites(null);
    localforageMock.setItem.mockClear();
    useProjectTemplateStore.setState({ templates: {}, _hasHydrated: true });
  });

  it("awaits durable storage and treats an identical digest as a no-op", async () => {
    const first = await useProjectTemplateStore
      .getState()
      .addTemplate(makeTemplate());
    const duplicate = await useProjectTemplateStore
      .getState()
      .addTemplate(makeTemplate({ id: "template-2", name: "Duplicate" }));

    expect(first).toEqual({ status: "added", id: "template-1" });
    expect(duplicate).toEqual({ status: "noop", id: "template-1" });
    expect(Object.keys(useProjectTemplateStore.getState().templates)).toEqual([
      "template-1",
    ]);
    expect(localforageMock.setItem).toHaveBeenCalled();
  });

  it("blocks writes before hydration and does not report or retain failed writes", async () => {
    useProjectTemplateStore.setState({ _hasHydrated: false });
    await expect(
      useProjectTemplateStore.getState().addTemplate(makeTemplate()),
    ).rejects.toThrow(/loading/i);

    useProjectTemplateStore.setState({ _hasHydrated: true });
    localforageMock.failWrites(new Error("quota exceeded"));
    await expect(
      useProjectTemplateStore.getState().addTemplate(makeTemplate()),
    ).rejects.toThrow("quota exceeded");
    expect(useProjectTemplateStore.getState().templates).toEqual({});
  });

  it("rejects digest-tampered Starters before durable storage", async () => {
    localforageMock.setItem.mockClear();
    await expect(
      useProjectTemplateStore
        .getState()
        .addTemplate(makeTemplate({ files: { "src/App.tsx": "tampered" } })),
    ).rejects.toThrow(/digest/i);
    expect(useProjectTemplateStore.getState().templates).toEqual({});
    expect(localforageMock.setItem).not.toHaveBeenCalled();
  });

  it("persists a v3 asset owner only while every referenced Blob is available", async () => {
    const staged = await stageProjectAsset(
      "public/hero.png",
      new Blob([Uint8Array.from(pngBytes).buffer], { type: "image/png" }),
      "image/png",
    );
    const asset = createProjectAssetRecord(
      staged,
      await storeStagedProjectAsset(staged),
    );
    const { template } = await prepareProjectTemplateFromConversation(
      {
        ...conversation,
        files: addProjectAssetModules(conversation.files, {
          [asset.path]: asset,
        }),
        assets: { [asset.path]: asset },
      },
      { id: "asset-template", name: "Asset Starter", now: 2 },
    );

    await deleteProjectAssetBlob(asset.blobRef);
    localforageMock.setItem.mockClear();
    await expect(
      useProjectTemplateStore.getState().addTemplate(template),
    ).rejects.toThrow(/unavailable locally/i);
    expect(useProjectTemplateStore.getState().templates).toEqual({});
    expect(localforageMock.setItem).not.toHaveBeenCalled();

    await storeStagedProjectAsset(staged);
    await useProjectTemplateStore.getState().addTemplate(template);
    const persisted = localforageMock.get(
      "open-builder-project-templates",
      "default",
      "open-builder-project-templates",
    );
    expect(persisted).toEqual(expect.stringContaining('"schemaVersion":3'));
    expect(persisted).toEqual(expect.stringContaining('"assets"'));
  });

  it("keeps the previous durable Starter when replacement asset validation fails", async () => {
    await useProjectTemplateStore.getState().addTemplate(makeTemplate());
    const staged = await stageProjectAsset(
      "public/replacement.png",
      new Blob([Uint8Array.from([...pngBytes, 2]).buffer], {
        type: "image/png",
      }),
      "image/png",
    );
    const asset = createProjectAssetRecord(
      staged,
      await storeStagedProjectAsset(staged),
    );
    const { template } = await prepareProjectTemplateFromConversation(
      {
        ...conversation,
        files: addProjectAssetModules(conversation.files, {
          [asset.path]: asset,
        }),
        assets: { [asset.path]: asset },
      },
      { id: "replacement", name: "Replacement", now: 2 },
    );
    await deleteProjectAssetBlob(asset.blobRef);
    localforageMock.setItem.mockClear();

    await expect(
      useProjectTemplateStore
        .getState()
        .replaceTemplate("template-1", template),
    ).rejects.toThrow(/unavailable locally/i);
    expect(useProjectTemplateStore.getState().templates["template-1"]).toEqual(
      makeTemplate(),
    );
    expect(localforageMock.setItem).not.toHaveBeenCalled();
  });

  it("keeps v1 records in the same database but marks them pending safe upgrade", () => {
    const legacy = makeTemplate({
      schemaVersion: undefined,
      contentDigest: undefined,
      safety: undefined,
      template: "unknown-runtime",
    });
    const migrated = migrateProjectTemplateState(
      { templates: { [legacy.id]: legacy }, untouched: true },
      1,
    );

    expect(migrated.untouched).toBe(true);
    expect(migrated.templates[legacy.id]).toMatchObject({
      id: "template-1",
      files: legacy.files,
      schemaVersion: 1,
      safety: {
        status: "pending-upgrade",
        excludedPaths: [],
        redactedPaths: [],
      },
    });
  });
});
