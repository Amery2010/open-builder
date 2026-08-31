import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTemplate } from "../types";
import {
  migrateProjectTemplateState,
  useProjectTemplateStore,
} from "./project-templates";

const localforageMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  let writeError: Error | null = null;
  const adapter = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: vi.fn(async (key: string, value: string) => {
      if (writeError) throw writeError;
      values.set(key, value);
    }),
    removeItem: async (key: string) => values.delete(key),
  };
  return {
    ...adapter,
    createInstance: () => adapter,
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
    contentDigest: "a".repeat(64),
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

describe("project template store", () => {
  beforeEach(() => {
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
