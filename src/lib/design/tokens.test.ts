import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSnapshotStore } from "../../store/snapshot";
import {
  createDesignTokenSnapshot,
  inspectDesignTokenContract,
  readEditableTokenValues,
  sameDesignSystemReference,
  writeEditableTokenValues,
} from "./tokens";

const localforageMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  const adapter = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
  return { ...adapter, createInstance: () => adapter };
});

vi.mock("localforage", () => ({ default: localforageMock }));

const css = `/* keep this source note */
:root {
  --bg: #ffffff;
  --surface: #f8f8f8;
  --fg: #111111;
  --muted: #666666;
  --border: #dddddd;
  --accent: #6541f5;
  --accent-on: #ffffff;
  --success: #188038;
  --warn: #9a6700;
  --danger: #d1242f;
  --font-display: "Inter", system-ui;
  --font-body: system-ui;
  --radius-md: 8px;
  --section-y-desktop: 96px;
  --container-max: 1200px;
  --motion-base: 180ms;
}`;

const stripe = {
  id: "stripe",
  name: "Stripe",
  source: "builtin" as const,
  version: "2.0.0",
  digest: "a".repeat(64),
};

describe("Design token editing", () => {
  beforeEach(() => {
    useSnapshotStore.setState({ snapshots: {}, _hasHydrated: true });
  });

  it("replaces only whitelisted declarations and preserves the rest", () => {
    const values = readEditableTokenValues(css);
    expect(values["--accent"]).toBe("#6541f5");
    const updated = writeEditableTokenValues(css, {
      "--accent": "oklch(62% 0.2 290)",
      "--radius-md": "12px",
    });
    expect(updated).toContain("/* keep this source note */");
    expect(updated).toContain("--accent: oklch(62% 0.2 290);");
    expect(updated).toContain("--radius-md: 12px;");
    expect(updated).toContain("--bg: #ffffff;");
  });

  it("rejects arbitrary properties and executable CSS values", () => {
    expect(() =>
      writeEditableTokenValues(css, { "--not-allowed": "10px" }),
    ).toThrow(/not editable/i);
    expect(() =>
      writeEditableTokenValues(css, { "--accent": "url(https://bad.test)" }),
    ).toThrow(/unsupported/i);
  });

  it("derives token-contract status from selection, application, and files", () => {
    expect(
      inspectDesignTokenContract(
        { "tokens.css": css },
        { selectedSystem: stripe, appliedSystem: stripe },
      ),
    ).toMatchObject({ status: "ready", path: "tokens.css" });
    expect(
      inspectDesignTokenContract(
        { "tokens.css": css },
        { selectedSystem: stripe },
      ),
    ).toMatchObject({ status: "selected-unapplied" });
    expect(
      inspectDesignTokenContract({}, { appliedSystem: stripe }),
    ).toMatchObject({ status: "missing" });
    expect(
      inspectDesignTokenContract(
        { "tokens.css": ":root { --bg: #fff; }" },
        { appliedSystem: stripe },
      ),
    ).toMatchObject({ status: "invalid" });
    expect(
      inspectDesignTokenContract(
        { "DESIGN.md": "# Legacy" },
        {
          selectedSystem: {
            id: "legacy-design-md",
            name: "DESIGN.md",
            source: "legacy",
            version: "legacy",
          },
        },
      ),
    ).toMatchObject({ status: "legacy" });
    expect(sameDesignSystemReference(stripe, { ...stripe })).toBe(true);
    expect(
      sameDesignSystemReference(stripe, { ...stripe, digest: "b".repeat(64) }),
    ).toBe(false);
  });

  it("creates one named snapshot after many draft calculations", () => {
    const conversationId = "tokens-conversation";
    const baseFiles = { "tokens.css": css, "src/App.tsx": "app" };
    useSnapshotStore
      .getState()
      .createSnapshot(conversationId, "initial", baseFiles);

    const firstDraft = writeEditableTokenValues(css, {
      "--accent": "#111111",
    });
    const finalDraft = writeEditableTokenValues(firstDraft, {
      "--accent": "#222222",
      "--radius-md": "14px",
    });
    expect(useSnapshotStore.getState().snapshots[conversationId]).toHaveLength(
      1,
    );

    createDesignTokenSnapshot(
      conversationId,
      { ...baseFiles, "tokens.css": finalDraft },
      "Design token update",
    );

    const chain = useSnapshotStore.getState().snapshots[conversationId];
    expect(chain).toHaveLength(2);
    expect(chain[1].label).toBe("Design token update");
  });
});
