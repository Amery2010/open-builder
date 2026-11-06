import { describe, expect, it, vi } from "vitest";
import type {
  ConversationDesignState,
  DesignSystemRef,
  ProjectFiles,
} from "../../types";
import {
  applyDesignSystemToConversation,
  prepareInitializedDesignSystem,
  type DesignSystemConversationCommit,
  type DesignSystemConversationPort,
  type DesignSystemConversationRestore,
  type DesignSystemConversationSnapshot,
} from "./application";
import type { DesignSystemPackage } from "./validation";

const validTokens = `:root {
  --bg: #ffffff;
  --surface: #f4f4f5;
  --fg: #18181b;
  --muted: #71717a;
  --border: #d4d4d8;
  --accent: #6d28d9;
  --accent-on: #ffffff;
  --success: #188038;
  --warn: #9a6700;
  --danger: #d1242f;
  --font-display: ui-sans-serif;
  --font-body: ui-sans-serif;
  --radius-md: 0.75rem;
  --section-y-desktop: 6rem;
  --container-max: 72rem;
  --motion-base: 180ms;
}`;

function reference(
  id = "stripe",
  source: DesignSystemRef["source"] = "builtin",
  digest = "a".repeat(64),
): DesignSystemRef {
  return {
    id,
    name: id === "stripe" ? "Stripe" : "Quiet Workshop",
    source,
    version: source === "builtin" ? "test-commit" : `${source}-test`,
    digest,
  };
}

function designPackage(
  pkgReference = reference(),
  tokens = validTokens,
): DesignSystemPackage {
  return {
    manifest: {
      schemaVersion: "open-builder-design-system/v1",
      id: pkgReference.id,
      name: pkgReference.name,
      files: { design: "DESIGN.md", tokens: "tokens.css" },
    },
    manifestText: "{}",
    design: `# ${pkgReference.name} reference`,
    tokens,
    digest: pkgReference.digest ?? "",
    reference: pkgReference,
  };
}

function cloneState(
  state: ConversationDesignState | undefined,
): ConversationDesignState | undefined {
  return state
    ? {
        ...state,
        selectedSystem: state.selectedSystem
          ? { ...state.selectedSystem }
          : undefined,
        appliedSystem: state.appliedSystem
          ? { ...state.appliedSystem }
          : undefined,
      }
    : undefined;
}

class MemoryConversationPort implements DesignSystemConversationPort {
  commitCalls: DesignSystemConversationCommit[] = [];
  restoreCalls: DesignSystemConversationRestore[] = [];
  commitTransform?: (mutation: DesignSystemConversationCommit) => {
    files: ProjectFiles;
    designState: ConversationDesignState;
  };

  constructor(public snapshot: DesignSystemConversationSnapshot) {}

  read(conversationId: string): DesignSystemConversationSnapshot | undefined {
    if (conversationId !== this.snapshot.conversationId) return undefined;
    return {
      ...this.snapshot,
      files: { ...this.snapshot.files },
      designState: cloneState(this.snapshot.designState),
    };
  }

  commit(
    mutation: DesignSystemConversationCommit,
  ): DesignSystemConversationSnapshot {
    if (!Object.is(mutation.expectedRevision, this.snapshot.revision)) {
      throw new Error("stale commit");
    }
    this.commitCalls.push(mutation);
    const committed = this.commitTransform?.(mutation) ?? {
      files: mutation.files,
      designState: mutation.designState,
    };
    this.snapshot = {
      ...this.snapshot,
      revision: Number(this.snapshot.revision) + 1,
      files: { ...committed.files },
      designState: cloneState(committed.designState),
    };
    return this.read(mutation.conversationId)!;
  }

  restore(
    mutation: DesignSystemConversationRestore,
  ): DesignSystemConversationSnapshot {
    if (!Object.is(mutation.expectedRevision, this.snapshot.revision)) {
      throw new Error("stale restore");
    }
    this.restoreCalls.push(mutation);
    this.snapshot = {
      ...this.snapshot,
      revision: Number(this.snapshot.revision) + 1,
      files: { ...mutation.files },
      designState: cloneState(mutation.designState),
    };
    return this.read(mutation.conversationId)!;
  }

  select(next: DesignSystemRef): void {
    this.snapshot = {
      ...this.snapshot,
      revision: Number(this.snapshot.revision) + 1,
      designState: {
        ...this.snapshot.designState,
        selectedSystem: next,
      },
    };
  }
}

function portFor(
  selected = reference(),
  options?: {
    files?: ProjectFiles;
    applied?: DesignSystemRef;
    autoSelectionError?: boolean;
  },
): MemoryConversationPort {
  return new MemoryConversationPort({
    conversationId: "conversation-a",
    revision: 1,
    isCurrent: true,
    files: options?.files ?? { "src/App.tsx": "export default () => null" },
    designState: {
      selectedSystem: selected,
      appliedSystem: options?.applied,
      autoSelectionError: options?.autoSelectionError,
    },
  });
}

describe("Design System Application", () => {
  it("loads and atomically applies a registered package to an existing project", async () => {
    const selected = reference();
    const port = portFor(selected);

    const result = await applyDesignSystemToConversation(
      {
        conversationId: "conversation-a",
        expectedReference: selected,
        requireSelected: true,
      },
      { conversation: port, loadPackage: async () => designPackage(selected) },
    );

    expect(result).toMatchObject({
      changed: true,
      stateChanged: true,
      reference: selected,
    });
    expect(port.commitCalls).toHaveLength(1);
    expect(port.restoreCalls).toHaveLength(0);
    expect(port.snapshot.files["src/App.tsx"]).toContain("export default");
    expect(port.snapshot.files["DESIGN.md"]).toBe("# Stripe reference");
    expect(port.snapshot.files["tokens.css"]).toContain("--accent: #6d28d9");
    expect(port.snapshot.designState?.appliedSystem).toEqual(selected);
  });

  it("does not commit when the same package and ready contract are already applied", async () => {
    const selected = reference();
    const port = portFor(selected, {
      files: {
        "src/App.tsx": "export default () => null",
        "tokens.css": validTokens,
      },
      applied: selected,
      autoSelectionError: false,
    });

    const result = await applyDesignSystemToConversation(
      {
        conversationId: "conversation-a",
        expectedReference: selected,
        requireSelected: true,
      },
      { conversation: port, loadPackage: async () => designPackage(selected) },
    );

    expect(result).toMatchObject({ changed: false, stateChanged: false });
    expect(port.commitCalls).toHaveLength(0);
  });

  it("preserves a newer user selection while a package is loading", async () => {
    const selected = reference();
    const port = portFor(selected);
    const loadPackage = vi.fn(async () => {
      port.select(reference("quiet-workshop", "custom", "b".repeat(64)));
      return designPackage(selected);
    });

    await expect(
      applyDesignSystemToConversation(
        {
          conversationId: "conversation-a",
          expectedReference: selected,
          requireSelected: true,
        },
        { conversation: port, loadPackage },
      ),
    ).rejects.toMatchObject({
      code: "selection_changed",
    });
    expect(port.commitCalls).toHaveLength(0);
    expect(port.restoreCalls).toHaveLength(0);
  });

  it("rejects package drift and an invalid token contract before any write", async () => {
    const selected = reference();
    const drifted = reference("stripe", "builtin", "b".repeat(64));
    const driftPort = portFor(selected);

    await expect(
      applyDesignSystemToConversation(
        {
          conversationId: "conversation-a",
          expectedReference: selected,
          requireSelected: true,
        },
        {
          conversation: driftPort,
          loadPackage: async () => designPackage(drifted),
        },
      ),
    ).rejects.toMatchObject({
      code: "package_changed",
    });
    expect(driftPort.commitCalls).toHaveLength(0);

    const invalidPort = portFor(selected);
    await expect(
      applyDesignSystemToConversation(
        {
          conversationId: "conversation-a",
          expectedReference: selected,
          requireSelected: true,
        },
        {
          conversation: invalidPort,
          loadPackage: async () =>
            designPackage(selected, ":root { --bg: #fff; }"),
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_token_contract",
    });
    expect(invalidPort.commitCalls).toHaveLength(0);
  });

  it("compensates when post-commit validation detects an incomplete save", async () => {
    const selected = reference();
    const originalFiles = { "src/App.tsx": "original" };
    const port = portFor(selected, { files: originalFiles });
    port.commitTransform = (mutation) => ({
      files: { "src/App.tsx": mutation.files["src/App.tsx"] },
      designState: mutation.designState,
    });

    await expect(
      applyDesignSystemToConversation(
        {
          conversationId: "conversation-a",
          expectedReference: selected,
          requireSelected: true,
        },
        {
          conversation: port,
          loadPackage: async () => designPackage(selected),
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_token_contract",
    });
    expect(port.commitCalls).toHaveLength(1);
    expect(port.restoreCalls).toHaveLength(1);
    expect(port.snapshot.files).toEqual(originalFiles);
    expect(port.snapshot.designState?.appliedSystem).toBeUndefined();
  });

  it("compensates when a commit drops an unrelated project file", async () => {
    const selected = reference();
    const originalFiles = {
      "src/App.tsx": "original",
      "src/keep.ts": "preserve me",
    };
    const port = portFor(selected, { files: originalFiles });
    port.commitTransform = (mutation) => {
      const { ["src/keep.ts"]: _dropped, ...incompleteFiles } = mutation.files;
      return {
        files: incompleteFiles,
        designState: mutation.designState,
      };
    };

    await expect(
      applyDesignSystemToConversation(
        {
          conversationId: "conversation-a",
          expectedReference: selected,
          requireSelected: true,
        },
        {
          conversation: port,
          loadPackage: async () => designPackage(selected),
        },
      ),
    ).rejects.toMatchObject({
      code: "commit_validation_failed",
    });
    expect(port.restoreCalls).toHaveLength(1);
    expect(port.snapshot.files).toEqual(originalFiles);
  });

  it("prepares initialization files for custom registry packages without side effects", async () => {
    const selected = reference("quiet-workshop", "custom", "c".repeat(64));
    const port = portFor(selected, { files: {} });

    const prepared = await prepareInitializedDesignSystem(
      {
        conversationId: "conversation-a",
        initializedFiles: {
          "src/App.tsx": "export default () => null",
        },
        expectedReference: selected,
        requireSelected: true,
      },
      { conversation: port, loadPackage: async () => designPackage(selected) },
    );

    expect(prepared.reference).toEqual(selected);
    expect(prepared.expectedRevision).toBe(1);
    expect(prepared.files["DESIGN.md"]).toBe("# Quiet Workshop reference");
    expect(prepared.files["tokens.css"]).toContain("--motion-base: 180ms");
    expect(prepared.designState.appliedSystem).toEqual(selected);
    expect(port.commitCalls).toHaveLength(0);
    expect(port.snapshot.files).toEqual({});
  });

  it("rejects initialization output when the selected system changes during loading", async () => {
    const selected = reference();
    const port = portFor(selected, { files: {} });

    await expect(
      prepareInitializedDesignSystem(
        {
          conversationId: "conversation-a",
          initializedFiles: {
            "src/App.tsx": "export default () => null",
          },
          expectedReference: selected,
          requireSelected: true,
        },
        {
          conversation: port,
          loadPackage: async () => {
            port.select(
              reference("quiet-workshop", "imported", "d".repeat(64)),
            );
            return designPackage(selected);
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "selection_changed",
    });
    expect(port.commitCalls).toHaveLength(0);
  });
});
