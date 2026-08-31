import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesignReviewStore } from "../../../store/design-review";
import type { DesignReviewReport } from "../review";
import type { createIsolatedDesignReviewSession } from "./backend";
import { DesignReviewJobRunner } from "./runner";
import type { DesignReviewJobInput } from "./types";

const localforageMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  const instance = {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
  return { instance, createInstance: vi.fn(() => instance) };
});

vi.mock("localforage", () => ({
  default: { createInstance: localforageMock.createInstance },
}));

const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const screenshot = {
  dataUrl: `data:image/png;base64,${btoa(
    Array.from(pngBytes, (byte) => String.fromCharCode(byte)).join(""),
  )}`,
  mimeType: "image/png" as const,
  name: "preview.png",
};
const report: DesignReviewReport = {
  overview: "No material issues.",
  findings: [],
};

function input(conversationId: string): DesignReviewJobInput {
  return {
    conversationId,
    kind: "manual",
    locale: "en",
    sourceDigest: "a".repeat(64),
    files: { "src/App.tsx": "export default function App() {}" },
    screenshots: [screenshot],
    provider: {
      runtime: "api",
      config: { apiKey: "test", model: "model" },
    },
  };
}

function deferredSessionFactory() {
  const sessions: Array<{
    abort: ReturnType<typeof vi.fn>;
    resolve: (value: DesignReviewReport) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const factory = vi.fn(
    (_options: Parameters<typeof createIsolatedDesignReviewSession>[0]) => {
      let resolve!: (value: DesignReviewReport) => void;
      let reject!: (reason: unknown) => void;
      const run = new Promise<DesignReviewReport>(
        (resolveValue, rejectValue) => {
          resolve = resolveValue;
          reject = rejectValue;
        },
      );
      const abort = vi.fn(() =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
      sessions.push({ abort, resolve, reject });
      return {
        backend: { abort },
        run: () => run,
      } as unknown as ReturnType<typeof createIsolatedDesignReviewSession>;
    },
  );
  return { factory, sessions };
}

describe("DesignReviewJobRunner", () => {
  beforeEach(() => {
    useDesignReviewStore.getState().reset();
    useDesignReviewStore.getState().clearRuns();
  });

  it("runs jobs from different conversations in one FIFO", async () => {
    const fake = deferredSessionFactory();
    const runner = new DesignReviewJobRunner(fake.factory);
    const first = runner.start(input("conversation-1"));
    const secondInput = input("conversation-2");
    const second = runner.start(secondInput);
    secondInput.files["src/App.tsx"] = "mutated after enqueue";

    expect(runner.getActiveRunId()).toBe(first.id);
    expect(runner.getQueuedRunIds()).toEqual([second.id]);
    expect(fake.factory).toHaveBeenCalledTimes(1);

    fake.sessions[0].resolve(report);
    await vi.waitFor(() => expect(runner.getActiveRunId()).toBe(second.id));
    expect(fake.factory).toHaveBeenCalledTimes(2);
    expect(fake.factory.mock.calls[1][0].files["src/App.tsx"]).not.toContain(
      "mutated",
    );
    expect(
      useDesignReviewStore.getState().runsByConversation["conversation-1"][0]
        .status,
    ).toBe("succeeded");

    fake.sessions[1].resolve(report);
    await vi.waitFor(() => expect(runner.getActiveRunId()).toBeNull());
  });

  it("rejects a second nonterminal run for the same conversation", () => {
    const fake = deferredSessionFactory();
    const runner = new DesignReviewJobRunner(fake.factory);
    runner.start(input("conversation"));

    expect(() => runner.start(input("conversation"))).toThrow(
      "already has an unfinished Design Review",
    );
    runner.cancel(runner.getActiveRunId()!);
  });

  it("cancels only its isolated backend and advances the queue", async () => {
    const fake = deferredSessionFactory();
    const runner = new DesignReviewJobRunner(fake.factory);
    const first = runner.start(input("conversation-1"));
    const second = runner.start(input("conversation-2"));

    expect(runner.cancel(first.id)).toBe(true);
    expect(fake.sessions[0].abort).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(runner.getActiveRunId()).toBe(second.id));
    expect(
      useDesignReviewStore.getState().runsByConversation["conversation-1"][0]
        .status,
    ).toBe("cancelled");
    fake.sessions[1].resolve(report);
    await vi.waitFor(() => expect(runner.getActiveRunId()).toBeNull());
  });

  it("requires fresh volatile evidence when retrying", () => {
    const fake = deferredSessionFactory();
    const runner = new DesignReviewJobRunner(fake.factory);
    const first = runner.start(input("conversation"));
    runner.cancel(first.id);

    const retry = runner.retry(first.id, input("conversation"));
    expect(retry.retryOf).toBe(first.id);
    expect(retry.logs.some((entry) => entry.event === "retry")).toBe(true);
    runner.cancel(retry.id);
  });

  it("does not persist raw provider failure bodies", async () => {
    const fake = deferredSessionFactory();
    const runner = new DesignReviewJobRunner(fake.factory);
    const run = runner.start(input("conversation"));

    fake.sessions[0].reject(
      new Error(
        'provider body: {"apiKey":"sk-secret","prompt":"private-project-payload"}',
      ),
    );

    await vi.waitFor(() =>
      expect(
        useDesignReviewStore.getState().runsByConversation.conversation[0]
          .status,
      ).toBe("failed"),
    );
    const persisted = JSON.stringify(
      useDesignReviewStore.getState().runsByConversation.conversation[0],
    );
    expect(persisted).not.toContain("sk-secret");
    expect(persisted).not.toContain("private-project-payload");
    expect(persisted).toContain("failed in the isolated runtime");
    expect(run.id).toBeTruthy();
  });

  it("cancels and removes all runs when their conversation is deleted", async () => {
    const fake = deferredSessionFactory();
    const runner = new DesignReviewJobRunner(fake.factory);
    runner.start(input("conversation"));

    runner.removeConversation("conversation");

    expect(fake.sessions[0].abort).toHaveBeenCalledOnce();
    expect(
      useDesignReviewStore.getState().runsByConversation.conversation,
    ).toBeUndefined();
    await vi.waitFor(() => expect(runner.getActiveRunId()).toBeNull());
  });
});
