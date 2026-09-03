import { describe, expect, it } from "vitest";
import type {
  DesignTokenChange,
  DesignTokenMutationAdapters,
  DesignTokenProjectState,
  DesignTokenSnapshotRequest,
} from "./token-mutation";
import { mutateDesignTokens } from "./token-mutation";

const digest = "a".repeat(64);
const css = `/* package sha256 ${digest} */
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

const projectState: DesignTokenProjectState = {
  conversationId: "conversation-1",
  files: {
    "tokens.css": css,
    "src/App.tsx": "export default function App() {}",
  },
  revision: 7,
  designState: {
    selectedSystem: {
      id: "stripe",
      name: "Stripe",
      source: "builtin",
      version: "2.0.0",
      digest,
    },
    appliedSystem: {
      id: "stripe",
      name: "Stripe",
      source: "builtin",
      version: "2.0.0",
      digest,
    },
  },
};

const acceptedContract = {
  surface_mode: "persuade" as const,
  change_mode: "extend" as const,
  target: "the landing page",
  audience: "new customers",
  primary_goal: "explain the product",
  concept: "quiet confidence",
  system_id: "stripe",
  translation: {
    foundations: "semantic color and type tokens",
    composition: "clear editorial hierarchy",
    components: "focused calls to action",
  },
  preserve: ["working navigation"],
  acceptance: ["responsive layout"],
};

interface AdapterHarness {
  state: DesignTokenProjectState;
  calls: string[];
  reviewInvalidated: boolean;
  snapshots: string[];
  adapters: DesignTokenMutationAdapters;
}

function createHarness(
  overrides: Partial<DesignTokenMutationAdapters> = {},
): AdapterHarness {
  const harness: AdapterHarness = {
    state: {
      ...projectState,
      files: { ...projectState.files },
      designState: projectState.designState
        ? {
            ...projectState.designState,
            selectedSystem: { ...projectState.designState.selectedSystem! },
            appliedSystem: { ...projectState.designState.appliedSystem! },
          }
        : undefined,
    },
    calls: [],
    reviewInvalidated: false,
    snapshots: [],
    adapters: {} as DesignTokenMutationAdapters,
  };

  harness.adapters = {
    readProject: () => {
      harness.calls.push("read");
      return {
        ...harness.state,
        files: { ...harness.state.files },
      };
    },
    prepareSnapshot: (request) => {
      harness.calls.push("prepare");
      expect(request.previousFiles["tokens.css"]).toBe(css);
      return {
        reservationId: "reservation-1",
        discard: () => {
          harness.calls.push("discard");
        },
      };
    },
    commitProject: (request) => {
      harness.calls.push("commit");
      if (request.currentRevision !== harness.state.revision) {
        throw new Error("revision changed");
      }
      const previousFiles = { ...harness.state.files };
      const previousRevision = harness.state.revision;
      harness.state.files = { ...request.nextFiles };
      harness.state.revision = Number(previousRevision) + 1;
      return {
        committedRevision: harness.state.revision,
        rollback: () => {
          harness.calls.push("rollback-project");
          harness.state.files = previousFiles;
          harness.state.revision = previousRevision;
        },
      };
    },
    invalidateReview: () => {
      harness.calls.push("invalidate-review");
      harness.reviewInvalidated = true;
      return {
        rollback: () => {
          harness.calls.push("rollback-review");
          harness.reviewInvalidated = false;
        },
      };
    },
    finalizeSnapshot: () => {
      harness.calls.push("finalize");
      harness.snapshots.push("snapshot-1");
      return "snapshot-1";
    },
    ...overrides,
  };
  return harness;
}

function mutation(
  changes: readonly DesignTokenChange[] = [
    { token: "--accent", value: "#111111" },
  ],
  expectedRevision = 7,
) {
  return {
    conversationId: "conversation-1",
    expectedRevision,
    changes,
    acceptedDesignContract: acceptedContract,
  };
}

describe("Design Token Mutation", () => {
  it("validates the full batch, commits once, invalidates Review, and finalizes one snapshot", async () => {
    const harness = createHarness();

    const result = await mutateDesignTokens(mutation(), harness.adapters);

    expect(result).toMatchObject({
      ok: true,
      status: "updated",
      snapshotId: "snapshot-1",
      revision: 8,
      changedTokens: ["--accent"],
    });
    expect(harness.state.files["tokens.css"]).toContain("--accent: #111111;");
    expect(harness.reviewInvalidated).toBe(true);
    expect(harness.snapshots).toEqual(["snapshot-1"]);
    expect(harness.calls).toEqual([
      "read",
      "prepare",
      "commit",
      "invalidate-review",
      "finalize",
    ]);
  });

  it("accepts the maximum 16-token batch as one transaction", async () => {
    const harness = createHarness();
    const changes = [
      { token: "--bg" as const, value: "#fafafa" },
      { token: "--surface" as const, value: "#f5f5f5" },
      { token: "--fg" as const, value: "#171717" },
      { token: "--muted" as const, value: "#737373" },
      { token: "--border" as const, value: "#d4d4d4" },
      { token: "--accent" as const, value: "#0f766e" },
      { token: "--accent-on" as const, value: "#f0fdfa" },
      { token: "--success" as const, value: "#15803d" },
      { token: "--warn" as const, value: "#a16207" },
      { token: "--danger" as const, value: "#b91c1c" },
      { token: "--font-display" as const, value: "ui-sans-serif" },
      { token: "--font-body" as const, value: "ui-serif" },
      { token: "--radius-md" as const, value: "10px" },
      { token: "--section-y-desktop" as const, value: "88px" },
      { token: "--container-max" as const, value: "1180px" },
      { token: "--motion-base" as const, value: "200ms" },
    ];

    const result = await mutateDesignTokens(
      mutation(changes),
      harness.adapters,
    );

    expect(result).toMatchObject({ ok: true, status: "updated" });
    expect(harness.calls.filter((call) => call === "commit")).toHaveLength(1);
    expect(harness.calls.filter((call) => call === "finalize")).toHaveLength(1);
    expect(harness.state.files["tokens.css"]).toContain(
      "--motion-base: 200ms;",
    );
  });

  it("treats the same normalized values as a no-op with no persistence calls", async () => {
    const harness = createHarness();

    const result = await mutateDesignTokens(
      mutation([{ token: "--accent", value: "  #6541f5  " }]),
      harness.adapters,
    );

    expect(result).toMatchObject({ ok: true, status: "no-op", revision: 7 });
    expect(harness.calls).toEqual(["read"]);
    expect(harness.snapshots).toEqual([]);
  });

  it("rejects invalid, duplicate, and over-sized batches before reading or writing", async () => {
    const harness = createHarness();

    const invalid = await mutateDesignTokens(
      mutation([{ token: "--accent", value: "url(https://evil.test)" }]),
      harness.adapters,
    );
    expect(invalid).toMatchObject({ ok: false, code: "invalid_input" });
    expect(harness.calls).toEqual(["read"]);

    const duplicate = await mutateDesignTokens(
      mutation([
        { token: "--accent", value: "#111111" },
        { token: "--accent", value: "#222222" },
      ]),
      harness.adapters,
    );
    expect(duplicate).toMatchObject({ ok: false, code: "invalid_input" });
    expect(harness.calls).toEqual(["read"]);

    const tooMany = await mutateDesignTokens(
      mutation(
        Array.from({ length: 17 }, (_, index) => ({
          token: (index === 16
            ? "--accent"
            : `--unknown-${index}`) as "--accent",
          value: "#111111",
        })),
      ),
      harness.adapters,
    );
    expect(tooMany).toMatchObject({ ok: false, code: "invalid_input" });
    expect(harness.calls).toEqual(["read"]);
  });

  it("requires an accepted Design contract and a ready token contract", async () => {
    const harness = createHarness();

    const missingContract = await mutateDesignTokens(
      { ...mutation(), acceptedDesignContract: undefined },
      harness.adapters,
    );
    expect(missingContract).toMatchObject({
      ok: false,
      code: "design_contract_required",
    });
    expect(harness.calls).toEqual([]);

    const selectedUnapplied = createHarness();
    selectedUnapplied.state.designState = {
      selectedSystem: selectedUnapplied.state.designState?.selectedSystem,
    };
    const notReady = await mutateDesignTokens(
      mutation(),
      selectedUnapplied.adapters,
    );
    expect(notReady).toMatchObject({
      ok: false,
      code: "token_contract_not_ready",
    });
    expect(selectedUnapplied.calls).toEqual(["read"]);
  });

  it("rejects mismatched contracts and missing, invalid, or legacy token contracts", async () => {
    const mismatched = createHarness();
    const mismatchResult = await mutateDesignTokens(
      {
        ...mutation(),
        acceptedDesignContract: { ...acceptedContract, system_id: "other" },
      },
      mismatched.adapters,
    );
    expect(mismatchResult).toMatchObject({
      ok: false,
      code: "design_contract_mismatch",
    });
    expect(mismatched.calls).toEqual(["read"]);

    const missing = createHarness();
    missing.state.files = { "src/App.tsx": "export default 1" };
    const missingResult = await mutateDesignTokens(
      mutation(),
      missing.adapters,
    );
    expect(missingResult).toMatchObject({
      ok: false,
      code: "token_contract_not_ready",
    });
    expect(missing.calls).toEqual(["read"]);

    const invalid = createHarness();
    invalid.state.files["tokens.css"] = ":root { --bg: #fff; }";
    const invalidResult = await mutateDesignTokens(
      mutation(),
      invalid.adapters,
    );
    expect(invalidResult).toMatchObject({
      ok: false,
      code: "token_contract_not_ready",
    });
    expect(invalid.calls).toEqual(["read"]);

    const legacy = createHarness();
    legacy.state.designState = {
      selectedSystem: {
        id: "legacy",
        name: "Legacy",
        source: "legacy",
        version: "legacy",
      },
      appliedSystem: {
        id: "legacy",
        name: "Legacy",
        source: "legacy",
        version: "legacy",
      },
    };
    const legacyResult = await mutateDesignTokens(mutation(), legacy.adapters);
    expect(legacyResult).toMatchObject({
      ok: false,
      code: "token_contract_not_ready",
    });
    expect(legacy.calls).toEqual(["read"]);
  });

  it("uses the same atomic mutation seam for a direct user edit", async () => {
    const harness = createHarness();
    const result = await mutateDesignTokens(
      {
        ...mutation(),
        principal: "user",
        acceptedDesignContract: undefined,
      },
      harness.adapters,
    );

    expect(result).toMatchObject({ ok: true, status: "updated" });
    expect(harness.calls).toEqual([
      "read",
      "prepare",
      "commit",
      "invalidate-review",
      "finalize",
    ]);
  });

  it("rejects stale revisions without preparing a snapshot", async () => {
    const harness = createHarness();

    const result = await mutateDesignTokens(
      mutation([{ token: "--accent", value: "#111111" }], 6),
      harness.adapters,
    );

    expect(result).toMatchObject({ ok: false, code: "stale_revision" });
    expect(harness.calls).toEqual(["read"]);
    expect(harness.state.files["tokens.css"]).toBe(css);
  });

  it("guarantees zero project writes when snapshot preparation fails", async () => {
    const harness = createHarness({
      prepareSnapshot: () => {
        harness.calls.push("prepare");
        throw new Error("storage unavailable");
      },
    });

    const result = await mutateDesignTokens(mutation(), harness.adapters);

    expect(result).toMatchObject({
      ok: false,
      code: "snapshot_prepare_failed",
    });
    expect(harness.calls).toEqual(["read", "prepare"]);
    expect(harness.state.files["tokens.css"]).toBe(css);
  });

  it("compensates project and Review writes if snapshot finalization fails", async () => {
    const harness = createHarness({
      finalizeSnapshot: () => {
        harness.calls.push("finalize");
        throw new Error("snapshot storage full");
      },
    });

    const result = await mutateDesignTokens(mutation(), harness.adapters);

    expect(result).toMatchObject({
      ok: false,
      code: "snapshot_finalize_failed",
    });
    expect(harness.state.files["tokens.css"]).toBe(css);
    expect(harness.state.revision).toBe(7);
    expect(harness.reviewInvalidated).toBe(false);
    expect(harness.calls).toEqual([
      "read",
      "prepare",
      "commit",
      "invalidate-review",
      "finalize",
      "rollback-review",
      "rollback-project",
      "discard",
    ]);
  });

  it("does not invalidate Review or finalize a snapshot after project commit fails", async () => {
    const harness = createHarness({
      commitProject: () => {
        harness.calls.push("commit");
        throw new Error("concurrent write");
      },
    });

    const result = await mutateDesignTokens(mutation(), harness.adapters);

    expect(result).toMatchObject({ ok: false, code: "project_commit_failed" });
    expect(harness.calls).toEqual(["read", "prepare", "commit", "discard"]);
    expect(harness.reviewInvalidated).toBe(false);
    expect(harness.snapshots).toEqual([]);
  });

  it("passes an immutable file snapshot to the preparation seam", async () => {
    const harness = createHarness();
    let preparedRequest: DesignTokenSnapshotRequest | undefined;
    harness.adapters.prepareSnapshot = (request) => {
      preparedRequest = request;
      return { reservationId: "reservation-1" };
    };

    const result = await mutateDesignTokens(mutation(), harness.adapters);
    expect(result.ok).toBe(true);
    expect(preparedRequest?.previousFiles).not.toBe(harness.state.files);
    expect(preparedRequest?.nextFiles).not.toBe(harness.state.files);
    expect(preparedRequest?.nextFiles["tokens.css"]).toContain(
      "--accent: #111111;",
    );
  });
});
