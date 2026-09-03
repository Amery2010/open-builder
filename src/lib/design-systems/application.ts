import type {
  ConversationDesignState,
  DesignRecommendation,
  DesignSystemRef,
  FileChange,
  ProjectFiles,
} from "../../types";
import {
  inspectDesignTokenContract,
  sameDesignSystemReference,
} from "../design/tokens";
import {
  validateProjectFiles,
  type ProjectFilesStats,
} from "../utils/project-files";
import { applyDesignSystemPackage, loadDesignSystemPackage } from "./apply";
import type { DesignSystemPackage } from "./validation";

export type DesignSystemApplicationErrorCode =
  | "conversation_unavailable"
  | "conversation_stale"
  | "selection_changed"
  | "package_changed"
  | "invalid_project"
  | "invalid_token_contract"
  | "commit_validation_failed";

export class DesignSystemApplicationError extends Error {
  constructor(
    readonly code: DesignSystemApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesignSystemApplicationError";
  }
}

/**
 * An opaque compare-and-set token supplied by the Conversation adapter. It may
 * be a monotonically increasing number or the immutable Conversation object
 * captured by the adapter.
 */
export type DesignSystemConversationRevision = unknown;

export interface DesignSystemConversationSnapshot {
  conversationId: string;
  revision: DesignSystemConversationRevision;
  isCurrent: boolean;
  files: ProjectFiles;
  designState?: ConversationDesignState;
}

export interface DesignSystemConversationCommit {
  conversationId: string;
  expectedRevision: DesignSystemConversationRevision;
  files: ProjectFiles;
  designState: ConversationDesignState;
  changes: readonly FileChange[];
}

export interface DesignSystemConversationRestore {
  conversationId: string;
  expectedRevision: DesignSystemConversationRevision;
  files: ProjectFiles;
  designState?: ConversationDesignState;
}

/**
 * The production adapter must implement commit and restore as compare-and-set
 * operations. A rejected commit must not partially mutate the Conversation.
 */
export interface DesignSystemConversationPort {
  read(
    conversationId: string,
  ):
    | DesignSystemConversationSnapshot
    | undefined
    | Promise<DesignSystemConversationSnapshot | undefined>;
  commit(
    mutation: DesignSystemConversationCommit,
  ):
    | DesignSystemConversationSnapshot
    | Promise<DesignSystemConversationSnapshot>;
  restore(
    mutation: DesignSystemConversationRestore,
  ):
    | DesignSystemConversationSnapshot
    | Promise<DesignSystemConversationSnapshot>;
}

type ProjectFilesValidation =
  | { ok: true; stats: ProjectFilesStats }
  | { ok: false; error: string; stats: ProjectFilesStats };

export interface DesignSystemApplicationDependencies {
  conversation: Pick<DesignSystemConversationPort, "read"> &
    Partial<Pick<DesignSystemConversationPort, "commit" | "restore">>;
  loadPackage?: (id: string) => Promise<DesignSystemPackage>;
  validateFiles?: (files: ProjectFiles) => ProjectFilesValidation;
}

export interface ApplyDesignSystemToConversationInput {
  conversationId: string;
  expectedReference: DesignSystemRef;
  recommendation?: DesignRecommendation;
  /** Require a matching current selection. A different existing selection is
   * always rejected so an automatic decision cannot override a user choice. */
  requireSelected?: boolean;
  signal?: AbortSignal;
}

export interface AppliedDesignSystemResult {
  changed: boolean;
  stateChanged: boolean;
  reference: DesignSystemRef;
  changes: readonly FileChange[];
}

export interface PrepareInitializedDesignSystemInput {
  conversationId: string;
  initializedFiles: ProjectFiles;
  expectedReference: DesignSystemRef;
  recommendation?: DesignRecommendation;
  requireSelected?: boolean;
  signal?: AbortSignal;
}

export interface PreparedInitializedDesignSystem {
  files: ProjectFiles;
  changes: readonly FileChange[];
  reference: DesignSystemRef;
  designState: ConversationDesignState;
  /** The caller should recheck this opaque revision when committing the
   * initialized project and designState together. */
  expectedRevision: DesignSystemConversationRevision;
  resultNote: string;
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Design system application aborted.", "AbortError");
  }
}

function cloneDesignState(
  state: ConversationDesignState | undefined,
): ConversationDesignState | undefined {
  if (!state) return undefined;
  return {
    ...state,
    selectedSystem: state.selectedSystem
      ? { ...state.selectedSystem }
      : undefined,
    appliedSystem: state.appliedSystem ? { ...state.appliedSystem } : undefined,
    recommendation: state.recommendation
      ? { ...state.recommendation }
      : undefined,
  };
}

function sameRecommendation(
  first: DesignRecommendation | undefined,
  second: DesignRecommendation | undefined,
): boolean {
  return (
    first === second ||
    (!!first &&
      !!second &&
      first.systemId === second.systemId &&
      first.reason === second.reason &&
      first.createdAt === second.createdAt)
  );
}

function sameDesignState(
  first: ConversationDesignState | undefined,
  second: ConversationDesignState,
): boolean {
  return (
    sameDesignSystemReference(first?.selectedSystem, second.selectedSystem) &&
    sameDesignSystemReference(first?.appliedSystem, second.appliedSystem) &&
    sameRecommendation(first?.recommendation, second.recommendation) &&
    first?.autoSelectionError === second.autoSelectionError
  );
}

function referenceMatches(
  current: DesignSystemRef | undefined,
  expected: DesignSystemRef,
): boolean {
  return (
    !!current &&
    current.id === expected.id &&
    current.source === expected.source &&
    current.digest === expected.digest
  );
}

function assertPackageMatchesReference(
  pkg: DesignSystemPackage,
  expected: DesignSystemRef,
): void {
  if (
    pkg.reference.id !== expected.id ||
    pkg.reference.source !== expected.source ||
    (expected.digest !== undefined && pkg.reference.digest !== expected.digest)
  ) {
    throw new DesignSystemApplicationError(
      "package_changed",
      "The selected Design system package changed. Select it again before retrying.",
    );
  }
}

function assertUsableSnapshot(
  snapshot: DesignSystemConversationSnapshot | undefined,
  input: {
    conversationId: string;
    expectedReference: DesignSystemRef;
    requireSelected?: boolean;
  },
): asserts snapshot is DesignSystemConversationSnapshot {
  if (
    !snapshot ||
    snapshot.conversationId !== input.conversationId ||
    !snapshot.isCurrent
  ) {
    throw new DesignSystemApplicationError(
      "conversation_unavailable",
      "The active Conversation changed before the Design system could be applied.",
    );
  }
  const selected = snapshot.designState?.selectedSystem;
  if (selected && !referenceMatches(selected, input.expectedReference)) {
    throw new DesignSystemApplicationError(
      "selection_changed",
      "The selected Design system changed before it could be applied.",
    );
  }
  if (input.requireSelected && !selected) {
    throw new DesignSystemApplicationError(
      "selection_changed",
      "The selected Design system changed before it could be applied.",
    );
  }
}

function assertStableSnapshot(
  before: DesignSystemConversationSnapshot,
  current: DesignSystemConversationSnapshot | undefined,
  input: {
    conversationId: string;
    expectedReference: DesignSystemRef;
    requireSelected?: boolean;
  },
): asserts current is DesignSystemConversationSnapshot {
  assertUsableSnapshot(current, input);
  if (!Object.is(before.revision, current.revision)) {
    throw new DesignSystemApplicationError(
      "conversation_stale",
      "The Conversation changed before the Design system could be applied. Retry the request.",
    );
  }
}

function nextDesignState(
  current: ConversationDesignState | undefined,
  reference: DesignSystemRef,
  recommendation: DesignRecommendation | undefined,
): ConversationDesignState {
  return {
    ...current,
    selectedSystem: reference,
    appliedSystem: reference,
    ...(recommendation ? { recommendation } : {}),
    autoSelectionError: false,
  };
}

function validateApplication(
  files: ProjectFiles,
  designState: ConversationDesignState,
  validateFiles: (files: ProjectFiles) => ProjectFilesValidation,
): void {
  const validation = validateFiles(files);
  if (!validation.ok) {
    throw new DesignSystemApplicationError("invalid_project", validation.error);
  }
  if (inspectDesignTokenContract(files, designState).status !== "ready") {
    throw new DesignSystemApplicationError(
      "invalid_token_contract",
      "Applied Design system did not produce a ready token contract.",
    );
  }
}

function validateCommittedSnapshot(
  committed: DesignSystemConversationSnapshot,
  input: ApplyDesignSystemToConversationInput,
  reference: DesignSystemRef,
  expectedFiles: ProjectFiles,
  changes: readonly FileChange[],
  validateFiles: (files: ProjectFiles) => ProjectFilesValidation,
): void {
  const committedDesignState = committed.designState;
  if (
    committed.conversationId !== input.conversationId ||
    !committed.isCurrent ||
    !sameDesignSystemReference(
      committedDesignState?.selectedSystem,
      reference,
    ) ||
    !sameDesignSystemReference(committedDesignState?.appliedSystem, reference)
  ) {
    throw new DesignSystemApplicationError(
      "commit_validation_failed",
      "The applied Design system state was not saved to the active Conversation.",
    );
  }
  validateApplication(committed.files, committedDesignState!, validateFiles);
  const committedPaths = Object.keys(committed.files).sort();
  const expectedPaths = Object.keys(expectedFiles).sort();
  if (
    committedPaths.length !== expectedPaths.length ||
    expectedPaths.some(
      (path, index) =>
        committedPaths[index] !== path ||
        committed.files[path] !== expectedFiles[path],
    ) ||
    changes.some(({ path }) => committed.files[path] !== expectedFiles[path])
  ) {
    throw new DesignSystemApplicationError(
      "commit_validation_failed",
      "The applied Design system files were not saved to the project.",
    );
  }
}

async function loadCheckedPackage(
  expectedReference: DesignSystemRef,
  dependencies: DesignSystemApplicationDependencies,
  signal: AbortSignal | undefined,
): Promise<DesignSystemPackage> {
  if (expectedReference.source === "legacy") {
    throw new DesignSystemApplicationError(
      "package_changed",
      "Legacy DESIGN.md references cannot be applied as registered Design systems.",
    );
  }
  const pkg = await (dependencies.loadPackage ?? loadDesignSystemPackage)(
    expectedReference.id,
  );
  abortIfNeeded(signal);
  assertPackageMatchesReference(pkg, expectedReference);
  return pkg;
}

/**
 * Apply a registered package to an existing project with one compare-and-set
 * commit. Post-commit validation failures are compensated through restore.
 */
export async function applyDesignSystemToConversation(
  input: ApplyDesignSystemToConversationInput,
  dependencies: DesignSystemApplicationDependencies,
): Promise<AppliedDesignSystemResult> {
  if (!dependencies.conversation.commit || !dependencies.conversation.restore) {
    throw new Error(
      "DesignSystemConversationPort.commit and restore are required for existing-project application.",
    );
  }
  abortIfNeeded(input.signal);
  const before = await dependencies.conversation.read(input.conversationId);
  assertUsableSnapshot(before, input);
  const rollbackFiles = { ...before.files };
  const rollbackDesignState = cloneDesignState(before.designState);

  const pkg = await loadCheckedPackage(
    input.expectedReference,
    dependencies,
    input.signal,
  );
  const afterLoad = await dependencies.conversation.read(input.conversationId);
  assertStableSnapshot(before, afterLoad, input);
  abortIfNeeded(input.signal);

  const designState = nextDesignState(
    afterLoad.designState,
    pkg.reference,
    input.recommendation,
  );
  const contractReady =
    sameDesignSystemReference(
      afterLoad.designState?.appliedSystem,
      pkg.reference,
    ) &&
    inspectDesignTokenContract(afterLoad.files, designState).status === "ready";
  const stateChanged = !sameDesignState(afterLoad.designState, designState);
  if (contractReady && !stateChanged) {
    return {
      changed: false,
      stateChanged: false,
      reference: pkg.reference,
      changes: [],
    };
  }

  const applied = contractReady
    ? { files: afterLoad.files, changes: [] }
    : applyDesignSystemPackage(afterLoad.files, pkg);
  const validateFiles = dependencies.validateFiles ?? validateProjectFiles;
  validateApplication(applied.files, designState, validateFiles);

  const beforeCommit = await dependencies.conversation.read(
    input.conversationId,
  );
  assertStableSnapshot(before, beforeCommit, input);
  abortIfNeeded(input.signal);

  const committed = await dependencies.conversation.commit({
    conversationId: input.conversationId,
    expectedRevision: before.revision,
    files: applied.files,
    designState,
    changes: applied.changes,
  });
  try {
    validateCommittedSnapshot(
      committed,
      input,
      pkg.reference,
      applied.files,
      applied.changes,
      validateFiles,
    );
  } catch (error) {
    try {
      await dependencies.conversation.restore({
        conversationId: input.conversationId,
        expectedRevision: committed.revision,
        files: rollbackFiles,
        designState: rollbackDesignState,
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Design system application failed and its compensation rollback also failed.",
        { cause: rollbackError },
      );
    }
    throw error;
  }

  return {
    changed: applied.changes.length > 0,
    stateChanged,
    reference: pkg.reference,
    changes: applied.changes,
  };
}

/**
 * Prepare canonical Design-system files before init_project is committed. This
 * entrypoint is side-effect free; the caller commits the returned files and
 * designState together after comparing expectedRevision.
 */
export async function prepareInitializedDesignSystem(
  input: PrepareInitializedDesignSystemInput,
  dependencies: DesignSystemApplicationDependencies,
): Promise<PreparedInitializedDesignSystem> {
  abortIfNeeded(input.signal);
  const before = await dependencies.conversation.read(input.conversationId);
  assertUsableSnapshot(before, input);
  const pkg = await loadCheckedPackage(
    input.expectedReference,
    dependencies,
    input.signal,
  );
  const afterLoad = await dependencies.conversation.read(input.conversationId);
  assertStableSnapshot(before, afterLoad, input);
  abortIfNeeded(input.signal);

  const designState = nextDesignState(
    afterLoad.designState,
    pkg.reference,
    input.recommendation,
  );
  const applied = applyDesignSystemPackage(input.initializedFiles, pkg);
  validateApplication(
    applied.files,
    designState,
    dependencies.validateFiles ?? validateProjectFiles,
  );

  const beforeReturn = await dependencies.conversation.read(
    input.conversationId,
  );
  assertStableSnapshot(before, beforeReturn, input);
  abortIfNeeded(input.signal);

  return {
    files: applied.files,
    changes: applied.changes,
    reference: pkg.reference,
    designState,
    expectedRevision: before.revision,
    resultNote: `applied selected design system "${pkg.reference.id}" and wrote root DESIGN.md and tokens.css`,
  };
}
