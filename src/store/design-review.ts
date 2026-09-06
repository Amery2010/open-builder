import localforage from "localforage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  coverageTargetKey,
  designReviewReportSchema,
  type DesignReviewCoverageTarget,
  type DesignReviewReport,
  type DesignReviewScreenshot,
} from "../lib/design/review";
import { isSafePrototypePreviewRoute } from "../lib/design/preview-runtime";
import type {
  AutomaticDesignReviewEvidence,
  AutomaticDesignReviewStage,
} from "../lib/design/automatic-review";
import {
  isDesignReviewRunActive,
  isDesignReviewTerminalStatus,
  type DesignReviewLogEntry,
  type DesignReviewProviderRef,
  type DesignReviewRun,
  type DesignReviewCoverageEntry,
  type DesignReviewRunKind,
  type DesignReviewRunStatus,
} from "../lib/design/review-jobs/types";
import {
  createDesignReviewLogEntry,
  sanitizeDesignReviewLogText,
} from "../lib/design/review-jobs/logs";
import { createLocalforageStorage } from "./utils/localforage-storage";

export const DESIGN_REVIEW_HISTORY_LIMIT = 20;
const DESIGN_REVIEW_STORE_VERSION = 1;
const DESIGN_REVIEW_MAX_LOGS = 200;

export type DesignReviewStatus =
  "idle" | "capturing" | "reviewing" | "complete" | "error";

export interface DesignReviewCaptureProgress {
  completed: number;
  total: number;
  viewport?: string;
}

export interface CreateDesignReviewRunInput {
  id?: string;
  conversationId: string;
  kind: DesignReviewRunKind;
  phase?: "initial" | "verify";
  status?: Extract<DesignReviewRunStatus, "capturing" | "queued">;
  sourceDigest: string;
  sourceProjectDigest?: string;
  blueprintRevision?: string | number;
  provider: DesignReviewProviderRef;
  captureErrors?: readonly string[];
  capturedCount?: number;
  expectedCoverage?: readonly DesignReviewCoverageTarget[];
  capturedCoverage?: readonly DesignReviewCoverageTarget[];
  retryOf?: string;
  now?: number;
}

interface DesignReviewState {
  // Volatile capture/dialog compatibility state. Excluded from persistence.
  status: DesignReviewStatus;
  screenshots: DesignReviewScreenshot[];
  report?: DesignReviewReport;
  error?: string;
  captureErrors: string[];
  captureProgress?: DesignReviewCaptureProgress;
  selectedFindingIds: string[];
  automatic?: {
    evidence: AutomaticDesignReviewEvidence;
    stage: AutomaticDesignReviewStage;
    captureRequestId: number;
  };
  dialogRequestId: number;

  // Persistable review history. It contains no screenshots or project files.
  runsByConversation: Record<string, DesignReviewRun[]>;
  selectedRunIdByConversation: Record<string, string | undefined>;
  _hasHydratedRuns: boolean;

  setStatus: (status: DesignReviewStatus) => void;
  beginCapture: (total: number) => void;
  updateCaptureProgress: (progress: DesignReviewCaptureProgress) => void;
  setScreenshots: (
    screenshots: DesignReviewScreenshot[],
    captureErrors?: string[],
  ) => void;
  complete: (report: DesignReviewReport) => void;
  fail: (message: string) => void;
  toggleFinding: (id: string) => void;
  setSelectedFindingIds: (ids: readonly string[]) => void;
  requestAutomaticCapture: (evidence: AutomaticDesignReviewEvidence) => void;
  setAutomaticStage: (stage: AutomaticDesignReviewStage) => void;
  finishAutomatic: (openDialog: boolean) => void;
  failAutomatic: (message: string) => void;
  clearAutomatic: () => void;
  reset: () => void;

  createRun: (input: CreateDesignReviewRunInput) => DesignReviewRun | null;
  updateRunStatus: (
    runId: string,
    status: DesignReviewRunStatus,
    error?: string,
  ) => void;
  appendRunLog: (runId: string, entry: DesignReviewLogEntry) => void;
  completeRun: (runId: string, report: DesignReviewReport) => void;
  selectRun: (conversationId: string, runId?: string) => void;
  openRun: (conversationId: string, runId: string) => void;
  /** Remove a terminal history run, returning false when it is active/missing. */
  removeRun: (runId: string) => boolean;
  markConversationFreshness: (
    conversationId: string,
    sourceDigest: string,
  ) => void;
  markRunFreshness: (runId: string, sourceDigest: string) => void;
  markRunProjectFreshness: (runId: string, sourceProjectDigest: string) => void;
  removeConversationRuns: (conversationId: string) => void;
  clearRuns: () => void;
}

const volatileInitialState = {
  status: "idle" as const,
  screenshots: [] as DesignReviewScreenshot[],
  report: undefined,
  error: undefined,
  captureErrors: [] as string[],
  captureProgress: undefined,
  selectedFindingIds: [] as string[],
  automatic: undefined,
  dialogRequestId: 0,
};

let nextAutomaticCaptureRequestId = 0;
let nextDialogRequestId = 0;

function createId(prefix: string, now = Date.now()): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${now}-${Math.random().toString(36).slice(2)}`
  );
}

export function pruneDesignReviewRuns(
  runs: readonly DesignReviewRun[],
): DesignReviewRun[] {
  const nonterminal = runs.filter(isDesignReviewRunActive);
  const terminal = runs
    .filter((run) => isDesignReviewTerminalStatus(run.status))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, DESIGN_REVIEW_HISTORY_LIMIT);
  return [...nonterminal, ...terminal].sort(
    (left, right) => right.createdAt - left.createdAt,
  );
}

function interruptRun(run: DesignReviewRun, now: number): DesignReviewRun {
  if (!isDesignReviewRunActive(run)) return run;
  return {
    ...run,
    status: "interrupted",
    error: "Design Review was interrupted when the application closed.",
    updatedAt: now,
    completedAt: now,
    logs: [
      ...run.logs,
      createDesignReviewLogEntry(
        "interrupted",
        "Review interrupted by application restart; recapture screenshots to retry.",
        { level: "warning", at: now },
      ),
    ].slice(-DESIGN_REVIEW_MAX_LOGS),
  };
}

function normalizePersistedRun(run: DesignReviewRun): DesignReviewRun {
  const parsedReport = designReviewReportSchema.safeParse(run.report);
  const blueprintRevision =
    (typeof run.blueprintRevision === "number" &&
      Number.isSafeInteger(run.blueprintRevision) &&
      run.blueprintRevision >= 0) ||
    (typeof run.blueprintRevision === "string" &&
      run.blueprintRevision.length > 0 &&
      run.blueprintRevision.length <= 128)
      ? run.blueprintRevision
      : undefined;
  return {
    ...run,
    ...(blueprintRevision !== undefined
      ? { blueprintRevision }
      : { blueprintRevision: undefined }),
    provider: {
      runtime: run.provider?.runtime === "local" ? "local" : "api",
      provider: sanitizeDesignReviewLogText(run.provider?.provider),
      model: sanitizeDesignReviewLogText(run.provider?.model),
    },
    logs: run.logs
      .filter(
        (entry) =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.at === "number" &&
          typeof entry.event === "string",
      )
      .map((entry) => ({
        ...entry,
        message: sanitizeDesignReviewLogText(entry.message),
      }))
      .slice(-DESIGN_REVIEW_MAX_LOGS),
    ...(parsedReport.success
      ? { report: parsedReport.data }
      : { report: undefined }),
    coverage: normalizeCoverage(run.coverage),
    ...(run.error
      ? { error: sanitizeDesignReviewLogText(run.error) }
      : { error: undefined }),
  };
}

function normalizeCoverage(
  coverage: readonly DesignReviewCoverageEntry[] | undefined,
): DesignReviewCoverageEntry[] | undefined {
  if (!Array.isArray(coverage)) return undefined;
  const statuses = new Set(["unreviewed", "captured", "passed", "needs-fix"]);
  const seen = new Set<string>();
  const normalized = coverage.flatMap((entry) => {
    if (
      !entry ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.pageId) ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.scenarioId) ||
      !isSafePrototypePreviewRoute(entry.route) ||
      !["desktop", "tablet", "mobile"].includes(entry.viewport) ||
      !statuses.has(entry.status)
    ) {
      return [];
    }
    const key = coverageTargetKey(entry);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...entry }];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function initialCoverage(
  expected: readonly DesignReviewCoverageTarget[] | undefined,
  captured: readonly DesignReviewCoverageTarget[] | undefined,
): DesignReviewCoverageEntry[] | undefined {
  const capturedKeys = new Set((captured ?? []).map(coverageTargetKey));
  const targets = [...(expected ?? []), ...(captured ?? [])];
  const seen = new Set<string>();
  const entries = targets.flatMap((target) => {
    const key = coverageTargetKey(target);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        ...target,
        status: capturedKeys.has(key) ? "captured" : "unreviewed",
      } satisfies DesignReviewCoverageEntry,
    ];
  });
  return normalizeCoverage(entries);
}

function completedCoverage(
  coverage: readonly DesignReviewCoverageEntry[] | undefined,
  report: DesignReviewReport,
): DesignReviewCoverageEntry[] | undefined {
  if (!coverage) return undefined;
  const unattributedFinding = report.findings.some(
    (finding) => !finding.page_id,
  );
  return coverage.map((entry) => {
    if (entry.status === "unreviewed") return entry;
    const hasFinding =
      unattributedFinding ||
      report.findings.some(
        (finding) =>
          finding.page_id === entry.pageId &&
          (!finding.scenario_id || finding.scenario_id === entry.scenarioId),
      );
    return { ...entry, status: hasFinding ? "needs-fix" : "passed" };
  });
}

export function normalizePersistedDesignReviewRuns(
  runsByConversation: Record<string, DesignReviewRun[]> | undefined,
  now = Date.now(),
): Record<string, DesignReviewRun[]> {
  if (!runsByConversation || typeof runsByConversation !== "object") return {};
  return Object.fromEntries(
    Object.entries(runsByConversation).flatMap(([conversationId, runs]) => {
      if (!Array.isArray(runs)) return [];
      return [
        [
          conversationId,
          pruneDesignReviewRuns(
            runs
              .filter((run): run is DesignReviewRun =>
                Boolean(
                  run &&
                  typeof run.id === "string" &&
                  run.conversationId === conversationId &&
                  typeof run.sourceDigest === "string" &&
                  Array.isArray(run.logs),
                ),
              )
              .map(normalizePersistedRun)
              .map((run) => interruptRun(run, now)),
          ),
        ],
      ];
    }),
  );
}

function mapRun(
  state: Pick<DesignReviewState, "runsByConversation">,
  runId: string,
  update: (run: DesignReviewRun) => DesignReviewRun,
): Record<string, DesignReviewRun[]> {
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(state.runsByConversation).map(([conversationId, runs]) => {
      let changedConversation = false;
      const nextRuns = runs.map((run) => {
        if (run.id !== runId) return run;
        changed = true;
        changedConversation = true;
        return update(run);
      });
      return [
        conversationId,
        changedConversation ? pruneDesignReviewRuns(nextRuns) : runs,
      ];
    }),
  );
  return changed ? next : state.runsByConversation;
}

const designReviewStorage = createLocalforageStorage(
  localforage.createInstance({
    name: "open-builder",
    storeName: "design_reviews",
  }),
);

export const useDesignReviewStore = create<DesignReviewState>()(
  persist(
    (set, get) => ({
      ...volatileInitialState,
      runsByConversation: {},
      selectedRunIdByConversation: {},
      _hasHydratedRuns: false,
      setStatus: (status) => set({ status, error: undefined }),
      beginCapture: (total) =>
        set({
          status: "capturing",
          screenshots: [],
          report: undefined,
          error: undefined,
          captureErrors: [],
          captureProgress: { completed: 0, total },
          selectedFindingIds: [],
        }),
      updateCaptureProgress: (captureProgress) => set({ captureProgress }),
      setScreenshots: (screenshots, captureErrors = []) =>
        set({
          status: "idle",
          screenshots: [...screenshots],
          report: undefined,
          error: undefined,
          captureErrors: [...captureErrors],
          captureProgress: undefined,
          selectedFindingIds: [],
        }),
      complete: (report) =>
        set({
          status: "complete",
          report,
          error: undefined,
          captureProgress: undefined,
          selectedFindingIds: [],
        }),
      fail: (error) =>
        set({ status: "error", error, captureProgress: undefined }),
      toggleFinding: (id) =>
        set((state) => ({
          selectedFindingIds: state.selectedFindingIds.includes(id)
            ? state.selectedFindingIds.filter((candidate) => candidate !== id)
            : [...state.selectedFindingIds, id],
        })),
      setSelectedFindingIds: (ids) =>
        set({ selectedFindingIds: Array.from(new Set(ids)) }),
      requestAutomaticCapture: (evidence) =>
        set({
          status: "capturing",
          screenshots: [],
          report: undefined,
          error: undefined,
          captureErrors: [],
          captureProgress: { completed: 0, total: 3 },
          selectedFindingIds: [],
          automatic: {
            evidence,
            stage: evidence.phase === "verify" ? "verifying" : "capturing",
            captureRequestId: ++nextAutomaticCaptureRequestId,
          },
        }),
      setAutomaticStage: (stage) =>
        set((state) =>
          state.automatic
            ? { automatic: { ...state.automatic, stage } }
            : state,
        ),
      finishAutomatic: (openDialog) =>
        set((state) => ({
          automatic: state.automatic
            ? { ...state.automatic, stage: openDialog ? "warning" : "complete" }
            : undefined,
          ...(openDialog ? { dialogRequestId: ++nextDialogRequestId } : {}),
        })),
      failAutomatic: (error) =>
        set((state) => ({
          status: "error",
          error,
          captureProgress: undefined,
          automatic: state.automatic
            ? { ...state.automatic, stage: "warning" }
            : undefined,
          dialogRequestId: ++nextDialogRequestId,
        })),
      clearAutomatic: () => set({ automatic: undefined }),
      // Existing callers use reset for transient dialog/capture cleanup. Runs
      // intentionally survive dialog close, project switches, and generation.
      reset: () => set(volatileInitialState),

      createRun: (input) => {
        const now = input.now ?? Date.now();
        const current = get().runsByConversation[input.conversationId] ?? [];
        if (current.some(isDesignReviewRunActive)) return null;
        const captureErrors = (input.captureErrors ?? [])
          .map(sanitizeDesignReviewLogText)
          .filter(Boolean);
        const run: DesignReviewRun = {
          id: input.id ?? createId("design-review", now),
          conversationId: input.conversationId,
          kind: input.kind,
          phase: input.phase ?? "initial",
          status: input.status ?? "queued",
          freshness: "fresh",
          sourceDigest: input.sourceDigest,
          ...(input.sourceProjectDigest
            ? { sourceProjectDigest: input.sourceProjectDigest }
            : {}),
          ...((typeof input.blueprintRevision === "number" &&
            Number.isSafeInteger(input.blueprintRevision) &&
            input.blueprintRevision >= 0) ||
          (typeof input.blueprintRevision === "string" &&
            input.blueprintRevision.length > 0 &&
            input.blueprintRevision.length <= 128)
            ? { blueprintRevision: input.blueprintRevision }
            : {}),
          provider: {
            runtime: input.provider.runtime,
            provider: sanitizeDesignReviewLogText(input.provider.provider),
            model: sanitizeDesignReviewLogText(input.provider.model),
          },
          logs: [
            createDesignReviewLogEntry(
              "capture_complete",
              `${input.capturedCount ?? 0} screenshot(s) captured${
                captureErrors.length > 0
                  ? ` with ${captureErrors.length} warning(s)`
                  : ""
              }.`,
              {
                level: captureErrors.length > 0 ? "warning" : "info",
                count: input.capturedCount ?? 0,
                at: now,
              },
            ),
            ...captureErrors.slice(0, 3).map((captureError) =>
              createDesignReviewLogEntry("capture_complete", captureError, {
                level: "warning",
                at: now,
              }),
            ),
            ...(input.status === "capturing"
              ? []
              : [
                  createDesignReviewLogEntry(
                    input.retryOf ? "retry" : "queued",
                    input.retryOf
                      ? "Review recaptured and queued for retry."
                      : "Review queued for background execution.",
                    { level: "info" as const, at: now },
                  ),
                ]),
          ],
          coverage: initialCoverage(
            input.expectedCoverage,
            input.capturedCoverage,
          ),
          ...(input.retryOf ? { retryOf: input.retryOf } : {}),
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          runsByConversation: {
            ...state.runsByConversation,
            [input.conversationId]: pruneDesignReviewRuns([run, ...current]),
          },
          selectedRunIdByConversation: {
            ...state.selectedRunIdByConversation,
            [input.conversationId]: run.id,
          },
        }));
        return run;
      },
      updateRunStatus: (runId, status, error) =>
        set((state) => {
          const now = Date.now();
          return {
            runsByConversation: mapRun(state, runId, (run) => ({
              ...run,
              status,
              updatedAt: now,
              ...(isDesignReviewTerminalStatus(status)
                ? { completedAt: now }
                : {}),
              ...(error
                ? { error: sanitizeDesignReviewLogText(error) }
                : { error: undefined }),
            })),
          };
        }),
      appendRunLog: (runId, entry) =>
        set((state) => ({
          runsByConversation: mapRun(state, runId, (run) => ({
            ...run,
            updatedAt: Math.max(run.updatedAt, entry.at),
            logs: [
              ...run.logs,
              {
                ...entry,
                message: sanitizeDesignReviewLogText(entry.message),
              },
            ].slice(-DESIGN_REVIEW_MAX_LOGS),
          })),
        })),
      completeRun: (runId, report) =>
        set((state) => {
          const now = Date.now();
          return {
            runsByConversation: mapRun(state, runId, (run) => ({
              ...run,
              status: "succeeded",
              report,
              coverage: completedCoverage(run.coverage, report),
              error: undefined,
              updatedAt: now,
              completedAt: now,
            })),
          };
        }),
      selectRun: (conversationId, runId) =>
        set((state) => ({
          selectedRunIdByConversation: {
            ...state.selectedRunIdByConversation,
            [conversationId]: runId,
          },
          selectedFindingIds: [],
        })),
      openRun: (conversationId, runId) =>
        set((state) => ({
          selectedRunIdByConversation: {
            ...state.selectedRunIdByConversation,
            [conversationId]: runId,
          },
          selectedFindingIds: [],
          dialogRequestId: ++nextDialogRequestId,
        })),
      removeRun: (runId) => {
        const state = get();
        let conversationId: string | undefined;
        let target: DesignReviewRun | undefined;
        for (const [candidateConversationId, runs] of Object.entries(
          state.runsByConversation,
        )) {
          const candidate = runs.find((run) => run.id === runId);
          if (!candidate) continue;
          conversationId = candidateConversationId;
          target = candidate;
          break;
        }
        if (!conversationId || !target || isDesignReviewRunActive(target)) {
          return false;
        }

        set((current) => {
          const currentRuns = current.runsByConversation[conversationId!] ?? [];
          const nextRuns = currentRuns.filter((run) => run.id !== runId);
          const configuredSelectedRunId =
            current.selectedRunIdByConversation[conversationId!];
          const selectedRunId = currentRuns.some(
            (run) => run.id === configuredSelectedRunId,
          )
            ? configuredSelectedRunId
            : currentRuns[0]?.id;
          const selectedRunWasRemoved = selectedRunId === runId;
          const nextSelectedRunId = selectedRunWasRemoved
            ? nextRuns[0]?.id
            : selectedRunId;
          const selectedRunIdByConversation = {
            ...current.selectedRunIdByConversation,
          };
          if (nextSelectedRunId) {
            selectedRunIdByConversation[conversationId!] = nextSelectedRunId;
          } else {
            delete selectedRunIdByConversation[conversationId!];
          }

          return {
            runsByConversation: {
              ...current.runsByConversation,
              [conversationId!]: nextRuns,
            },
            selectedRunIdByConversation,
            ...(selectedRunWasRemoved ? { selectedFindingIds: [] } : {}),
          };
        });
        return true;
      },
      markConversationFreshness: (conversationId, sourceDigest) =>
        set((state) => {
          const runs = state.runsByConversation[conversationId] ?? [];
          const now = Date.now();
          return {
            runsByConversation: {
              ...state.runsByConversation,
              [conversationId]: runs.map((run) => {
                const freshness =
                  run.sourceDigest === sourceDigest ? "fresh" : "stale";
                if (run.freshness === freshness) return run;
                return {
                  ...run,
                  freshness,
                  updatedAt: now,
                  logs:
                    freshness === "stale"
                      ? [
                          ...run.logs,
                          createDesignReviewLogEntry(
                            "stale",
                            "Project source changed after this review.",
                            { level: "warning", at: now },
                          ),
                        ].slice(-DESIGN_REVIEW_MAX_LOGS)
                      : run.logs,
                };
              }),
            },
          };
        }),
      markRunFreshness: (runId, sourceDigest) =>
        set((state) => {
          const now = Date.now();
          return {
            runsByConversation: mapRun(state, runId, (run) => {
              const freshness =
                run.sourceDigest === sourceDigest ? "fresh" : "stale";
              if (run.freshness === freshness) return run;
              return {
                ...run,
                freshness,
                updatedAt: now,
                logs:
                  freshness === "stale"
                    ? [
                        ...run.logs,
                        createDesignReviewLogEntry(
                          "stale",
                          "Project source changed after this review.",
                          { level: "warning", at: now },
                        ),
                      ].slice(-DESIGN_REVIEW_MAX_LOGS)
                    : run.logs,
              };
            }),
          };
        }),
      markRunProjectFreshness: (runId, sourceProjectDigest) =>
        set((state) => {
          const now = Date.now();
          return {
            runsByConversation: mapRun(state, runId, (run) => {
              if (!run.sourceProjectDigest) return run;
              const freshness =
                run.sourceProjectDigest === sourceProjectDigest
                  ? "fresh"
                  : "stale";
              if (run.freshness === freshness) return run;
              return {
                ...run,
                freshness,
                updatedAt: now,
                logs:
                  freshness === "stale"
                    ? [
                        ...run.logs,
                        createDesignReviewLogEntry(
                          "stale",
                          "Project source changed after this review.",
                          { level: "warning", at: now },
                        ),
                      ].slice(-DESIGN_REVIEW_MAX_LOGS)
                    : run.logs,
              };
            }),
          };
        }),
      removeConversationRuns: (conversationId) =>
        set((state) => {
          const runsByConversation = { ...state.runsByConversation };
          const selectedRunIdByConversation = {
            ...state.selectedRunIdByConversation,
          };
          delete runsByConversation[conversationId];
          delete selectedRunIdByConversation[conversationId];
          return { runsByConversation, selectedRunIdByConversation };
        }),
      clearRuns: () =>
        set({ runsByConversation: {}, selectedRunIdByConversation: {} }),
    }),
    {
      name: "design-review-history",
      version: DESIGN_REVIEW_STORE_VERSION,
      storage: createJSONStorage(() => designReviewStorage),
      partialize: (state) => ({
        runsByConversation: state.runsByConversation,
        selectedRunIdByConversation: state.selectedRunIdByConversation,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<DesignReviewState> | undefined;
        return {
          ...current,
          runsByConversation: normalizePersistedDesignReviewRuns(
            saved?.runsByConversation,
          ),
          selectedRunIdByConversation: saved?.selectedRunIdByConversation ?? {},
        };
      },
      onRehydrateStorage: () => () => {
        useDesignReviewStore.setState({ _hasHydratedRuns: true });
      },
    },
  ),
);

export function getDesignReviewRuns(conversationId: string): DesignReviewRun[] {
  return (
    useDesignReviewStore.getState().runsByConversation[conversationId] ?? []
  );
}

export function getDesignReviewRun(runId: string): DesignReviewRun | undefined {
  return Object.values(useDesignReviewStore.getState().runsByConversation)
    .flat()
    .find((run) => run.id === runId);
}
