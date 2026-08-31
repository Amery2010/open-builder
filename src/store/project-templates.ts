import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import localforage from "localforage";
import type { ProjectTemplate } from "../types";
import { createLocalforageStorage } from "./utils/localforage-storage";
import { runMigrations, type MigrationStep } from "./utils/migrate";
import {
  isProjectTemplateUsable,
  normalizeTemplateTags,
  sanitizeTemplateName,
} from "../lib/utils/project-templates";

const PROJECT_TEMPLATE_STORE_VERSION = 2;

type PersistedProjectTemplateState = {
  templates?: Record<string, ProjectTemplate>;
  [key: string]: unknown;
};

function markLegacyTemplatesPendingUpgrade<T>(state: T): T {
  if (!state || typeof state !== "object") return state;
  const templates = (state as PersistedProjectTemplateState).templates;
  if (!templates || typeof templates !== "object") return state;
  return {
    ...state,
    templates: Object.fromEntries(
      Object.entries(templates).map(([id, template]) => [
        id,
        template.schemaVersion === 2
          ? template
          : {
              ...template,
              schemaVersion: 1 as const,
              safety: {
                status: "pending-upgrade" as const,
                excludedPaths: [],
                redactedPaths: [],
              },
            },
      ]),
    ),
  } as T;
}

const projectTemplateMigrations: MigrationStep[] = [
  (state) => state,
  markLegacyTemplatesPendingUpgrade,
];

export function migrateProjectTemplateState<T>(
  persisted: T,
  version: number,
): T {
  return runMigrations(
    projectTemplateMigrations,
    persisted,
    version,
    PROJECT_TEMPLATE_STORE_VERSION,
  );
}

const projectTemplateStorage = createLocalforageStorage(
  localforage.createInstance({ name: "open-builder-project-templates" }),
);

type TemplateMetadataUpdate = Partial<
  Pick<ProjectTemplate, "name" | "description" | "tags">
>;

interface ProjectTemplateState {
  templates: Record<string, ProjectTemplate>;
  _hasHydrated: boolean;

  addTemplate: (
    template: ProjectTemplate,
  ) => Promise<{ status: "added" | "noop"; id: string }>;
  updateTemplate: (
    id: string,
    patch: TemplateMetadataUpdate,
  ) => Promise<boolean>;
  replaceTemplate: (
    id: string,
    template: ProjectTemplate,
  ) => Promise<"updated" | "noop">;
  deleteTemplate: (id: string) => Promise<boolean>;
  markTemplateUsed: (id: string, now: number) => Promise<boolean>;
  getTemplate: (id: string) => ProjectTemplate | undefined;
  listTemplates: () => ProjectTemplate[];
}

export const useProjectTemplateStore = create<ProjectTemplateState>()(
  persist(
    (set, get) => ({
      templates: {},
      _hasHydrated: false,

      addTemplate: async (template) => {
        assertHydrated(get());
        if (!isProjectTemplateUsable(template)) {
          throw new Error("Project template has not passed safe preparation.");
        }
        const duplicate = Object.values(get().templates).find(
          (candidate) =>
            candidate.contentDigest === template.contentDigest &&
            candidate.schemaVersion === 2,
        );
        if (duplicate) return { status: "noop", id: duplicate.id };
        const templates = { ...get().templates, [template.id]: template };
        await persistTemplates(templates);
        set((s) => ({
          templates: { ...s.templates, [template.id]: template },
        }));
        return { status: "added", id: template.id };
      },

      updateTemplate: async (id, patch) => {
        assertHydrated(get());
        const existing = get().templates[id];
        if (!existing) return false;
        const next: ProjectTemplate = {
          ...existing,
          ...patch,
          name:
            patch.name === undefined
              ? existing.name
              : sanitizeTemplateName(patch.name),
          description:
            patch.description === undefined
              ? existing.description
              : patch.description.trim() || undefined,
          tags:
            patch.tags === undefined
              ? existing.tags
              : normalizeTemplateTags(patch.tags),
          updatedAt: Date.now(),
        };
        const templates = { ...get().templates, [id]: next };
        await persistTemplates(templates);
        set({ templates });
        return true;
      },

      replaceTemplate: async (id, template) => {
        assertHydrated(get());
        const existing = get().templates[id];
        if (!existing) throw new Error("Project template not found.");
        if (!isProjectTemplateUsable(template)) {
          throw new Error("Project template has not passed safe preparation.");
        }
        if (existing.contentDigest === template.contentDigest) return "noop";
        const next: ProjectTemplate = {
          ...template,
          id,
          name: existing.name,
          description: existing.description,
          tags: existing.tags,
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
          useCount: existing.useCount ?? 0,
          lastUsedAt: existing.lastUsedAt,
        };
        const templates = { ...get().templates, [id]: next };
        await persistTemplates(templates);
        set({ templates });
        return "updated";
      },

      deleteTemplate: async (id) => {
        assertHydrated(get());
        if (!get().templates[id]) return false;
        const { [id]: _deleted, ...templates } = get().templates;
        await persistTemplates(templates);
        set({ templates });
        return true;
      },

      markTemplateUsed: async (id, now) => {
        assertHydrated(get());
        const existing = get().templates[id];
        if (!existing) return false;
        const templates = {
          ...get().templates,
          [id]: {
            ...existing,
            lastUsedAt: now,
            useCount: (existing.useCount ?? 0) + 1,
          },
        };
        await persistTemplates(templates);
        set({ templates });
        return true;
      },

      getTemplate: (id) => get().templates[id],
      listTemplates: () =>
        Object.values(get().templates).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        ),
    }),
    {
      name: "open-builder-project-templates",
      version: PROJECT_TEMPLATE_STORE_VERSION,
      storage: createJSONStorage(() => projectTemplateStorage),
      partialize: (state) => ({
        templates: state.templates,
      }),
      migrate: migrateProjectTemplateState,
      onRehydrateStorage: () => () => {
        useProjectTemplateStore.setState({ _hasHydrated: true });
      },
    },
  ),
);

function assertHydrated(state: Pick<ProjectTemplateState, "_hasHydrated">) {
  if (!state._hasHydrated) {
    throw new Error("Project template library is still loading.");
  }
}

async function persistTemplates(templates: Record<string, ProjectTemplate>) {
  await projectTemplateStorage.setItem(
    "open-builder-project-templates",
    JSON.stringify({
      state: { templates },
      version: PROJECT_TEMPLATE_STORE_VERSION,
    }),
  );
}
