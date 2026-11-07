import { designContractSchema, type DesignContract } from "./run-contract";
import {
  EDITABLE_DESIGN_TOKENS,
  inspectDesignTokenContract,
  readEditableTokenValues,
  writeEditableTokenValues,
} from "./tokens";
import type { ConversationDesignState, ProjectFiles } from "../../types";

/** The revision primitive used by the host to prevent stale Design writes. */
export type DesignTokenRevision = string | number;

/** The only token names that the Design Token tool is allowed to mutate. */
export type EditableTokenName =
  (typeof EDITABLE_DESIGN_TOKENS)[number]["property"];

export interface DesignTokenChange {
  token: EditableTokenName;
  value: string;
}

export interface DesignTokenMutationInput {
  conversationId: string;
  expectedRevision: DesignTokenRevision;
  changes: readonly DesignTokenChange[];
  /** Model calls require the run-local contract accepted by submit_design_contract. */
  acceptedDesignContract?: DesignContract | unknown;
  /** Direct user edits use the same mutation transaction without model authority. */
  principal?: "model" | "user";
}

export interface DesignTokenProjectState {
  conversationId: string;
  files: ProjectFiles;
  revision: DesignTokenRevision;
  designState?: ConversationDesignState;
}

export interface DesignTokenSnapshotReservation {
  /** An opaque id used only to correlate prepare/finalize/discard calls. */
  reservationId: string;
  /** Preparation is intentionally non-persistent; discard releases any reservation. */
  discard?: () => void | Promise<void>;
}

export interface DesignTokenSnapshotRequest {
  conversationId: string;
  previousFiles: ProjectFiles;
  nextFiles: ProjectFiles;
  changes: readonly DesignTokenChange[];
  expectedRevision: DesignTokenRevision;
  label: string;
}

export interface DesignTokenCommitRequest extends DesignTokenSnapshotRequest {
  /** The adapter must re-check this revision as part of its atomic commit. */
  currentRevision: DesignTokenRevision;
}

export interface DesignTokenCommitReceipt {
  committedRevision: DesignTokenRevision;
  /** Required for compensating rollback when a post-commit stage fails. */
  rollback?: () => void | Promise<void>;
}

export interface DesignTokenReviewInvalidationReceipt {
  /** Restores the previous Review freshness when a later stage fails. */
  rollback?: () => void | Promise<void>;
}

/**
 * Persistence seams for Design Token Mutation.
 *
 * `prepareSnapshot` must not persist files, Review state, or snapshot history.
 * `commitProject` must perform one atomic expected-revision-checked project
 * commit. The optional rollback callbacks make the two-phase boundary explicit
 * for adapters backed by stores that cannot transact all three domains at once.
 */
export interface DesignTokenMutationAdapters {
  readProject: (
    conversationId: string,
  ) => DesignTokenProjectState | Promise<DesignTokenProjectState>;
  prepareSnapshot: (
    request: DesignTokenSnapshotRequest,
  ) => DesignTokenSnapshotReservation | Promise<DesignTokenSnapshotReservation>;
  commitProject: (
    request: DesignTokenCommitRequest,
  ) => DesignTokenCommitReceipt | Promise<DesignTokenCommitReceipt>;
  invalidateReview: (
    request: DesignTokenSnapshotRequest & {
      committedRevision: DesignTokenRevision;
    },
  ) =>
    | void
    | DesignTokenReviewInvalidationReceipt
    | Promise<void | DesignTokenReviewInvalidationReceipt>;
  finalizeSnapshot: (
    reservation: DesignTokenSnapshotReservation,
    request: DesignTokenSnapshotRequest & {
      committedRevision: DesignTokenRevision;
    },
  ) => string | Promise<string>;
}

export type DesignTokenMutationErrorCode =
  | "invalid_input"
  | "design_contract_required"
  | "design_contract_mismatch"
  | "token_contract_not_ready"
  | "stale_revision"
  | "snapshot_prepare_failed"
  | "project_commit_failed"
  | "review_invalidation_failed"
  | "snapshot_finalize_failed"
  | "rollback_failed";

export type DesignTokenMutationResult =
  | {
      ok: true;
      status: "updated" | "no-op";
      conversationId: string;
      files: ProjectFiles;
      revision: DesignTokenRevision;
      snapshotId?: string;
      changedTokens: readonly EditableTokenName[];
    }
  | {
      ok: false;
      code: DesignTokenMutationErrorCode;
      error: string;
      conversationId: string;
    };

const MAX_TOKEN_CHANGES = 16;
const TOKEN_SNAPSHOT_LABEL = "Design token update";

function failure(
  conversationId: string,
  code: DesignTokenMutationErrorCode,
  error: string,
): Extract<DesignTokenMutationResult, { ok: false }> {
  return { ok: false, code, error, conversationId };
}

function isValidRevision(value: unknown): value is DesignTokenRevision {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function cloneFiles(files: ProjectFiles): ProjectFiles {
  return { ...files };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedChanges(
  changes: readonly DesignTokenChange[],
): { ok: true; changes: DesignTokenChange[] } | { ok: false; error: string } {
  if (!Array.isArray(changes)) {
    return { ok: false, error: "changes must be an array." };
  }
  if (changes.length < 1 || changes.length > MAX_TOKEN_CHANGES) {
    return {
      ok: false,
      error: `Design Token Mutation accepts 1-${MAX_TOKEN_CHANGES} changes per call.`,
    };
  }

  const allowed = new Set<EditableTokenName>(
    EDITABLE_DESIGN_TOKENS.map(({ property }) => property),
  );
  const seen = new Set<string>();
  const normalized: DesignTokenChange[] = [];
  for (const change of changes) {
    if (!change || typeof change !== "object") {
      return { ok: false, error: "Each token change must be an object." };
    }
    const token = (change as { token?: unknown }).token;
    const value = (change as { value?: unknown }).value;
    if (typeof token !== "string" || !allowed.has(token as EditableTokenName)) {
      return {
        ok: false,
        error: `Token ${typeof token === "string" ? token : "<unknown>"} is not editable.`,
      };
    }
    if (seen.has(token)) {
      return { ok: false, error: `Token ${token} appears more than once.` };
    }
    if (typeof value !== "string") {
      return { ok: false, error: `Token ${token} value must be a string.` };
    }
    seen.add(token);
    normalized.push({ token: token as EditableTokenName, value });
  }
  return { ok: true, changes: normalized };
}

async function discardSnapshot(
  reservation: DesignTokenSnapshotReservation | undefined,
): Promise<void> {
  if (!reservation?.discard) return;
  await reservation.discard();
}

async function rollbackMutation(
  receipt: DesignTokenCommitReceipt,
  reviewReceipt: DesignTokenReviewInvalidationReceipt | undefined,
  reservation: DesignTokenSnapshotReservation,
): Promise<void> {
  const rollbackErrors: unknown[] = [];
  try {
    await reviewReceipt?.rollback?.();
  } catch (error) {
    rollbackErrors.push(error);
  }
  try {
    await receipt.rollback?.();
  } catch (error) {
    rollbackErrors.push(error);
  }
  try {
    await discardSnapshot(reservation);
  } catch (error) {
    rollbackErrors.push(error);
  }
  if (rollbackErrors.length > 0) {
    throw new Error(
      `Design Token Mutation rollback failed: ${rollbackErrors
        .map(describeError)
        .join("; ")}`,
    );
  }
}

/**
 * Apply one atomic Design Token update through host-owned persistence seams.
 *
 * Every validation and stale check happens before snapshot preparation. A
 * no-op never allocates a snapshot or calls a persistence adapter. Once the
 * project commit succeeds, Review invalidation and snapshot finalization are
 * treated as one compensating transaction when the adapter supplies rollback
 * callbacks.
 */
export async function mutateDesignTokens(
  input: DesignTokenMutationInput,
  adapters: DesignTokenMutationAdapters,
  options: { snapshotLabel?: string } = {},
): Promise<DesignTokenMutationResult> {
  const conversationId = input?.conversationId ?? "";
  if (!conversationId.trim()) {
    return failure(
      conversationId,
      "invalid_input",
      "Design Token Mutation requires a conversation id.",
    );
  }
  if (!isValidRevision(input.expectedRevision)) {
    return failure(
      conversationId,
      "invalid_input",
      "Design Token Mutation requires a finite expected revision.",
    );
  }

  const parsedChanges = normalizedChanges(input.changes);
  if (!parsedChanges.ok) {
    return failure(conversationId, "invalid_input", parsedChanges.error);
  }

  const principal = input.principal ?? "model";
  const contract = designContractSchema.safeParse(input.acceptedDesignContract);
  if (principal === "model" && !contract.success) {
    return failure(
      conversationId,
      "design_contract_required",
      "The dedicated update_design_tokens tool requires an accepted Design contract. Load the required Design Skill and call submit_design_contract first.",
    );
  }

  let project: DesignTokenProjectState;
  try {
    project = await adapters.readProject(conversationId);
  } catch (error) {
    return failure(
      conversationId,
      "stale_revision",
      `Unable to read the current project revision: ${describeError(error)}`,
    );
  }
  if (project.conversationId !== conversationId) {
    return failure(
      conversationId,
      "stale_revision",
      "The Design Token project identity changed while the run was active.",
    );
  }
  if (!isValidRevision(project.revision)) {
    return failure(
      conversationId,
      "stale_revision",
      "The current project revision is unavailable.",
    );
  }
  if (!Object.is(project.revision, input.expectedRevision)) {
    return failure(
      conversationId,
      "stale_revision",
      "The project changed while Design Tokens were being prepared. Refresh and try again.",
    );
  }

  const inspection = inspectDesignTokenContract(
    project.files,
    project.designState,
  );
  if (inspection.status !== "ready") {
    return failure(
      conversationId,
      "token_contract_not_ready",
      inspection.status === "selected-unapplied"
        ? "Apply the selected Design system before updating Design Tokens."
        : inspection.status === "legacy"
          ? "Upgrade the legacy Design contract before updating Design Tokens."
          : inspection.status === "invalid"
            ? `The Design Token contract is invalid: ${inspection.error}`
            : "A ready Design Token contract is required before updating Design Tokens.",
    );
  }
  if (
    principal === "model" &&
    contract.success &&
    contract.data.system_id !== inspection.appliedSystem.id
  ) {
    return failure(
      conversationId,
      "design_contract_mismatch",
      "The accepted Design contract no longer matches the applied Design system.",
    );
  }

  const changes = parsedChanges.changes;
  const changesByToken = Object.fromEntries(
    changes.map(({ token, value }) => [token, value]),
  );
  let nextTokens: string;
  try {
    // This performs per-value filtering and a complete CSS contract check in
    // one pass, ensuring a mixed valid/invalid batch never partially applies.
    nextTokens = writeEditableTokenValues(inspection.source, changesByToken);
  } catch (error) {
    return failure(conversationId, "invalid_input", describeError(error));
  }

  const changedTokens = changes
    .filter(
      ({ token, value }) =>
        readEditableTokenValues(inspection.source)[token] !== value.trim(),
    )
    .map(({ token }) => token);
  if (nextTokens === inspection.source || changedTokens.length === 0) {
    return {
      ok: true,
      status: "no-op",
      conversationId,
      files: cloneFiles(project.files),
      revision: project.revision,
      changedTokens: [],
    };
  }

  const nextFiles = cloneFiles(project.files);
  nextFiles[inspection.path] = nextTokens;
  const request: DesignTokenSnapshotRequest = {
    conversationId,
    previousFiles: cloneFiles(project.files),
    nextFiles: cloneFiles(nextFiles),
    changes: changes.map(({ token, value }) => ({ token, value })),
    expectedRevision: input.expectedRevision,
    label: options.snapshotLabel?.trim() || TOKEN_SNAPSHOT_LABEL,
  };

  let reservation: DesignTokenSnapshotReservation;
  try {
    reservation = await adapters.prepareSnapshot(request);
    if (
      !reservation ||
      typeof reservation.reservationId !== "string" ||
      !reservation.reservationId
    ) {
      throw new Error("Snapshot reservation is invalid.");
    }
  } catch (error) {
    return failure(
      conversationId,
      "snapshot_prepare_failed",
      `Design Token snapshot preparation failed: ${describeError(error)}`,
    );
  }

  let receipt: DesignTokenCommitReceipt;
  try {
    receipt = await adapters.commitProject({
      ...request,
      currentRevision: project.revision,
    });
    if (!receipt || !isValidRevision(receipt.committedRevision)) {
      throw new Error("Project commit returned an invalid revision.");
    }
  } catch (error) {
    try {
      await discardSnapshot(reservation);
    } catch {
      // The project commit did not happen; preserve the original failure code.
    }
    return failure(
      conversationId,
      "project_commit_failed",
      `Design Token project commit failed: ${describeError(error)}`,
    );
  }

  let reviewReceipt: DesignTokenReviewInvalidationReceipt | undefined;
  try {
    const invalidation = await adapters.invalidateReview({
      ...request,
      committedRevision: receipt.committedRevision,
    });
    reviewReceipt = invalidation ?? undefined;
  } catch (error) {
    try {
      await rollbackMutation(receipt, undefined, reservation);
    } catch (rollbackError) {
      return failure(
        conversationId,
        "rollback_failed",
        `${describeError(error)} ${describeError(rollbackError)}`,
      );
    }
    return failure(
      conversationId,
      "review_invalidation_failed",
      `Design Review invalidation failed: ${describeError(error)}`,
    );
  }

  let snapshotId: string;
  try {
    snapshotId = await adapters.finalizeSnapshot(reservation, {
      ...request,
      committedRevision: receipt.committedRevision,
    });
    if (typeof snapshotId !== "string" || !snapshotId.trim()) {
      throw new Error("Snapshot finalization returned no snapshot id.");
    }
  } catch (error) {
    try {
      await rollbackMutation(receipt, reviewReceipt, reservation);
    } catch (rollbackError) {
      return failure(
        conversationId,
        "rollback_failed",
        `${describeError(error)} ${describeError(rollbackError)}`,
      );
    }
    return failure(
      conversationId,
      "snapshot_finalize_failed",
      `Design Token snapshot finalization failed: ${describeError(error)}`,
    );
  }

  return {
    ok: true,
    status: "updated",
    conversationId,
    files: cloneFiles(nextFiles),
    revision: receipt.committedRevision,
    snapshotId,
    changedTokens,
  };
}
