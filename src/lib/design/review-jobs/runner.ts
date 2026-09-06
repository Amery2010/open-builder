import {
  getDesignReviewRun,
  useDesignReviewStore,
} from "../../../store/design-review";
import { validateDesignReviewScreenshots } from "../review";
import { createIsolatedDesignReviewSession } from "./backend";
import { createDesignReviewLogEntry } from "./logs";
import type {
  DesignReviewJobInput,
  DesignReviewProviderRef,
  DesignReviewRun,
} from "./types";

type ReviewSession = ReturnType<typeof createIsolatedDesignReviewSession>;
type ReviewSessionFactory = typeof createIsolatedDesignReviewSession;

interface QueuedDesignReviewJob {
  runId: string;
  input: DesignReviewJobInput;
}

function providerRef(input: DesignReviewJobInput): DesignReviewProviderRef {
  if (input.provider.runtime === "local") {
    return {
      runtime: "local",
      provider: input.provider.config.provider,
      model:
        input.provider.config.model || `${input.provider.config.provider}-cli`,
    };
  }
  return {
    runtime: "api",
    provider: input.provider.config.apiType ?? "openai-compatible",
    model: input.provider.config.model ?? "",
  };
}

function cloneJobInput(input: DesignReviewJobInput): DesignReviewJobInput {
  const clone = <T>(value: T): T => {
    if (typeof globalThis.structuredClone === "function") {
      return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value)) as T;
  };
  return {
    ...input,
    files: { ...input.files },
    screenshots: clone(input.screenshots),
    expectedCoverage: input.expectedCoverage
      ? clone(input.expectedCoverage)
      : undefined,
    requirementsMessages: input.requirementsMessages
      ? clone(input.requirementsMessages)
      : undefined,
    automaticEvidence: input.automaticEvidence
      ? clone(input.automaticEvidence)
      : undefined,
    captureErrors: input.captureErrors ? [...input.captureErrors] : undefined,
  };
}

function safeFailureMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (
    message === "Design Review tool isolation could not be established." ||
    message.startsWith("Design Review attempted to change project files;") ||
    /^The [A-Za-z0-9._-]+ model did not submit a structured Design Review report\.$/.test(
      message,
    )
  ) {
    return message;
  }
  return "Design Review failed in the isolated runtime.";
}

/**
 * One renderer-wide FIFO. Queue payloads are deliberately in-memory so a
 * reload can retain audit history without retaining screenshots or source.
 */
export class DesignReviewJobRunner {
  private readonly queue: QueuedDesignReviewJob[] = [];
  private readonly cancelled = new Set<string>();
  private active: { runId: string; session: ReviewSession } | null = null;
  private draining = false;

  constructor(
    private readonly createSession: ReviewSessionFactory = createIsolatedDesignReviewSession,
  ) {}

  start(input: DesignReviewJobInput): DesignReviewRun {
    validateDesignReviewScreenshots(input.screenshots);
    if (!input.conversationId.trim()) {
      throw new Error("Design Review requires a conversation id.");
    }
    if (!/^[a-f0-9]{64}$/i.test(input.sourceDigest)) {
      throw new Error("Design Review requires a SHA-256 source digest.");
    }
    const frozen = cloneJobInput(input);
    const run = useDesignReviewStore.getState().createRun({
      conversationId: input.conversationId,
      kind: input.kind,
      phase: input.phase,
      sourceDigest: input.sourceDigest,
      sourceProjectDigest: input.sourceProjectDigest,
      blueprintRevision: input.blueprintRevision,
      provider: providerRef(input),
      captureErrors: input.captureErrors,
      capturedCount: input.screenshots.length,
      expectedCoverage: input.expectedCoverage,
      capturedCoverage: input.screenshots.flatMap((screenshot) =>
        screenshot.target && screenshot.viewport
          ? [
              {
                ...screenshot.target,
                viewport: screenshot.viewport.name,
              },
            ]
          : [],
      ),
      retryOf: input.retryOf,
      status: "capturing",
    });
    if (!run) {
      throw new Error(
        "This conversation already has an unfinished Design Review.",
      );
    }
    useDesignReviewStore.getState().updateRunStatus(run.id, "queued");
    useDesignReviewStore
      .getState()
      .appendRunLog(
        run.id,
        createDesignReviewLogEntry(
          input.retryOf ? "retry" : "queued",
          input.retryOf
            ? "Review recaptured and queued for retry."
            : "Review queued for background execution.",
          { level: "info" },
        ),
      );
    this.queue.push({ runId: run.id, input: frozen });
    void this.drain();
    return getDesignReviewRun(run.id) ?? run;
  }

  retry(previousRunId: string, input: DesignReviewJobInput): DesignReviewRun {
    const previous = getDesignReviewRun(previousRunId);
    if (!previous || previous.conversationId !== input.conversationId) {
      throw new Error("The Design Review retry target is unavailable.");
    }
    return this.start({ ...input, retryOf: previousRunId });
  }

  cancel(runId: string): boolean {
    const run = getDesignReviewRun(runId);
    if (
      !run ||
      ["succeeded", "failed", "cancelled", "interrupted"].includes(run.status)
    ) {
      return false;
    }
    this.cancelled.add(runId);
    const queuedIndex = this.queue.findIndex((job) => job.runId === runId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.cancelled.delete(runId);
    }
    if (this.active?.runId === runId) this.active.session.backend.abort();
    const store = useDesignReviewStore.getState();
    store.updateRunStatus(runId, "cancelled");
    store.appendRunLog(
      runId,
      createDesignReviewLogEntry(
        "cancelled",
        "Review cancelled independently of chat generation.",
        { level: "warning" },
      ),
    );
    return true;
  }

  removeConversation(conversationId: string): void {
    const runs =
      useDesignReviewStore.getState().runsByConversation[conversationId] ?? [];
    runs.forEach((run) => {
      if (
        !["succeeded", "failed", "cancelled", "interrupted"].includes(
          run.status,
        )
      ) {
        this.cancel(run.id);
      }
    });
    useDesignReviewStore.getState().removeConversationRuns(conversationId);
  }

  clear(): void {
    for (const job of [...this.queue]) this.cancel(job.runId);
    if (this.active) this.cancel(this.active.runId);
    useDesignReviewStore.getState().clearRuns();
  }

  getActiveRunId(): string | null {
    return this.active?.runId ?? null;
  }

  getQueuedRunIds(): string[] {
    return this.queue.map((job) => job.runId);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job || this.cancelled.delete(job.runId)) continue;
        await this.execute(job);
      }
    } finally {
      this.draining = false;
      // A start() can enqueue between the final length check and this finally.
      if (this.queue.length > 0) void this.drain();
    }
  }

  private async execute(job: QueuedDesignReviewJob): Promise<void> {
    const store = useDesignReviewStore.getState();
    const toolCounts = new Map<string, number>();
    let reportLogged = false;
    let session: ReviewSession;
    try {
      session = this.createSession({
        conversationId: job.input.conversationId,
        locale: job.input.locale,
        files: job.input.files,
        screenshots: job.input.screenshots,
        provider: job.input.provider,
        requirementsMessages: job.input.requirementsMessages,
        automaticEvidence: job.input.automaticEvidence,
        expectedCoverage: job.input.expectedCoverage,
        events: {
          onRetry: (attempt, maxAttempts) => {
            if (this.cancelled.has(job.runId)) return;
            useDesignReviewStore
              .getState()
              .appendRunLog(
                job.runId,
                createDesignReviewLogEntry(
                  "retry",
                  `Provider request retry ${attempt} of ${maxAttempts}.`,
                  { level: "warning", count: attempt },
                ),
              );
          },
          onToolCall: (name) => {
            if (this.cancelled.has(job.runId)) return;
            if (
              name !== "list_files" &&
              name !== "read_files" &&
              name !== "search_in_files"
            ) {
              return;
            }
            const count = (toolCounts.get(name) ?? 0) + 1;
            toolCounts.set(name, count);
            useDesignReviewStore
              .getState()
              .appendRunLog(
                job.runId,
                createDesignReviewLogEntry(
                  "tool_call",
                  `${name} invoked (${count}).`,
                  { level: "info", toolName: name, count },
                ),
              );
          },
          onReport: (report) => {
            if (reportLogged || this.cancelled.has(job.runId)) return;
            reportLogged = true;
            useDesignReviewStore.getState().appendRunLog(
              job.runId,
              createDesignReviewLogEntry(
                "report_received",
                `Structured report received with ${report.findings.length} finding(s).`,
                {
                  level: "info",
                  count: report.findings.length,
                },
              ),
            );
          },
        },
      });
    } catch (error) {
      this.fail(job.runId, error);
      return;
    }

    this.active = { runId: job.runId, session };
    store.updateRunStatus(
      job.runId,
      job.input.phase === "verify" ? "verifying" : "running",
    );
    store.appendRunLog(
      job.runId,
      createDesignReviewLogEntry(
        "runtime_started",
        `Isolated ${job.input.provider.runtime} review runtime started.`,
        { level: "info" },
      ),
    );
    if (job.input.phase === "verify") {
      store.appendRunLog(
        job.runId,
        createDesignReviewLogEntry(
          "verifying",
          "Verification review started with freshly captured evidence.",
          { level: "info" },
        ),
      );
    }

    try {
      const report = await session.run();
      if (this.cancelled.has(job.runId)) return;
      const latest = getDesignReviewRun(job.runId);
      if (!latest || latest.status === "cancelled") return;
      useDesignReviewStore.getState().completeRun(job.runId, report);
      useDesignReviewStore.getState().appendRunLog(
        job.runId,
        createDesignReviewLogEntry("completed", "Design Review completed.", {
          level: "info",
          count: report.findings.length,
        }),
      );
    } catch (error) {
      if (!this.cancelled.has(job.runId)) this.fail(job.runId, error);
    } finally {
      this.cancelled.delete(job.runId);
      if (this.active?.runId === job.runId) this.active = null;
    }
  }

  private fail(runId: string, reason: unknown): void {
    const message = safeFailureMessage(reason);
    const store = useDesignReviewStore.getState();
    store.updateRunStatus(runId, "failed", message);
    store.appendRunLog(
      runId,
      createDesignReviewLogEntry("failed", message, { level: "error" }),
    );
  }
}

export const designReviewJobRunner = new DesignReviewJobRunner();
