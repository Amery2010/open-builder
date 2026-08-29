import { describe, expect, it } from "vitest";
import {
  migrateBuiltinSkillIds,
  migrateSkillsState,
} from "./skills-migrations";

describe("skills store migration", () => {
  it("maps enabled to autoEnabled and removes the script warning state", () => {
    const migrated = migrateSkillsState({
      skills: {
        demo: {
          id: "demo",
          enabled: false,
          builtinVersion: "1.0.0",
        },
      },
      scriptWarningAcknowledged: true,
    }) as Record<string, any>;

    expect(migrated.skills.demo).toMatchObject({
      id: "demo",
      autoEnabled: false,
      cachedVersion: "1.0.0",
    });
    expect(migrated.skills.demo).not.toHaveProperty("enabled");
    expect(migrated.skills.demo).not.toHaveProperty("builtinVersion");
    expect(migrated).not.toHaveProperty("scriptWarningAcknowledged");
  });

  it("renames built-ins while preserving preferences and imported entries", () => {
    const migrated = migrateBuiltinSkillIds({
      skills: {
        "code-review": {
          id: "code-review",
          name: "code-review",
          source: "builtin",
          autoEnabled: false,
          installedAt: 42,
          cachedVersion: "1.0.0",
          availableVersion: "1.0.0",
        },
        accessibility: {
          id: "accessibility",
          name: "Imported accessibility",
          source: "imported",
          autoEnabled: true,
          installedAt: 7,
        },
      },
    }) as Record<string, any>;

    expect(migrated.skills["review-code"]).toMatchObject({
      id: "review-code",
      name: "review-code",
      source: "builtin",
      autoEnabled: false,
      installedAt: 42,
    });
    expect(migrated.skills["review-code"]).not.toHaveProperty("cachedVersion");
    expect(migrated.skills).not.toHaveProperty("code-review");
    expect(migrated.skills.accessibility).toMatchObject({
      source: "imported",
      name: "Imported accessibility",
    });
  });

  it("prefers an existing current built-in when both ids are present", () => {
    const migrated = migrateBuiltinSkillIds({
      skills: {
        "code-review": {
          id: "code-review",
          source: "builtin",
          autoEnabled: false,
          installedAt: 1,
        },
        "review-code": {
          id: "review-code",
          source: "builtin",
          autoEnabled: true,
          installedAt: 2,
        },
      },
    }) as Record<string, any>;

    expect(migrated.skills).not.toHaveProperty("code-review");
    expect(migrated.skills["review-code"]).toMatchObject({
      autoEnabled: true,
      installedAt: 2,
    });
  });
});
