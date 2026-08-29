import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import localforage from "localforage";
import type { SkillEntry } from "../lib/skills/types";
import { createLocalforageStorage } from "./utils/localforage-storage";
import { runMigrations, type MigrationStep } from "./utils/migrate";
import {
  migrateBuiltinSkillIds,
  migrateSkillsState,
  SKILLS_STORE_VERSION,
} from "./skills-migrations";

const skillsMigrations: MigrationStep[] = [
  (state) => state,
  migrateSkillsState,
  migrateBuiltinSkillIds,
];

const skillsStorage = createLocalforageStorage(
  localforage.createInstance({ name: "open-builder-skills" }),
);

interface SkillsState {
  skills: Record<string, SkillEntry>;
  _hasHydrated: boolean;

  registerSkill: (entry: SkillEntry) => void;
  unregisterSkill: (id: string) => void;
  setSkillAutoEnabled: (id: string, enabled: boolean) => void;

  getSkill: (id: string) => SkillEntry | undefined;
  listAll: () => SkillEntry[];
  getAutoEnabledSkills: () => SkillEntry[];
}

export const useSkillsStore = create<SkillsState>()(
  persist(
    (set, get) => ({
      skills: {},
      _hasHydrated: false,

      registerSkill: (entry) =>
        set((s) => ({ skills: { ...s.skills, [entry.id]: entry } })),

      unregisterSkill: (id) =>
        set((s) => {
          if (!(id in s.skills)) return s;
          const { [id]: _removed, ...rest } = s.skills;
          return { skills: rest };
        }),

      setSkillAutoEnabled: (id, autoEnabled) =>
        set((s) => {
          const existing = s.skills[id];
          if (!existing) return s;
          return {
            skills: { ...s.skills, [id]: { ...existing, autoEnabled } },
          };
        }),

      getSkill: (id) => get().skills[id],
      listAll: () => Object.values(get().skills),
      getAutoEnabledSkills: () =>
        Object.values(get().skills).filter((s) => s.autoEnabled),
    }),
    {
      name: "open-builder-skills",
      version: SKILLS_STORE_VERSION,
      storage: createJSONStorage(() => skillsStorage),
      partialize: (state) => ({
        skills: state.skills,
      }),
      migrate: (persisted, version) =>
        runMigrations(
          skillsMigrations,
          persisted,
          version,
          SKILLS_STORE_VERSION,
        ),
      onRehydrateStorage: () => () => {
        useSkillsStore.setState({ _hasHydrated: true });
      },
    },
  ),
);
