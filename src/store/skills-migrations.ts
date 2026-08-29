import { BUILTIN_SKILL_ID_ALIASES } from "../lib/skills/builtin-aliases";

export const SKILLS_STORE_VERSION = 3;

export function migrateSkillsState(state: unknown): unknown {
  const value = state as Record<string, any>;
  const entries = value.skills as
    Record<string, Record<string, any>> | undefined;
  if (entries) {
    for (const entry of Object.values(entries)) {
      if (entry.autoEnabled === undefined) {
        entry.autoEnabled = entry.enabled ?? true;
      }
      if (
        entry.cachedVersion === undefined &&
        entry.builtinVersion !== undefined
      ) {
        entry.cachedVersion = entry.builtinVersion;
      }
      delete entry.enabled;
      delete entry.builtinVersion;
    }
  }
  delete value.scriptWarningAcknowledged;
  return value;
}

export function migrateBuiltinSkillIds(state: unknown): unknown {
  const value = state as Record<string, any>;
  const entries = value.skills as
    Record<string, Record<string, any>> | undefined;
  if (!entries) return value;

  for (const [legacyId, currentId] of Object.entries(
    BUILTIN_SKILL_ID_ALIASES,
  )) {
    const legacy = entries[legacyId];
    if (!legacy || legacy.source !== "builtin") continue;

    const current = entries[currentId];
    if (!current) {
      const migrated: Record<string, any> = {
        ...legacy,
        id: currentId,
        name: currentId,
      };
      delete migrated.cachedVersion;
      delete migrated.availableVersion;
      entries[currentId] = migrated;
    }
    delete entries[legacyId];
  }

  return value;
}
