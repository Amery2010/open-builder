import { beforeEach, describe, expect, it } from "vitest";
import { SUBAGENT_LIMITS } from "../lib/ai/subagents/limits";
import { useSubagentStore } from "./subagent";

describe("ephemeral subagent progress", () => {
  beforeEach(() => {
    useSubagentStore.setState({ progress: {} });
  });

  it("keeps receiving long output and tool activity after the persisted limits", () => {
    const store = useSubagentStore.getState();
    store.init("run-1", "code-explorer", "Inspect the project");
    const longOutput = `${"x".repeat(70_000)}LATEST_OUTPUT`;
    store.appendText("run-1", longOutput);

    for (let index = 0; index < 220; index += 1) {
      const id = `tool-${index}`;
      store.addToolCall("run-1", "read_files", id);
      store.setToolResult("run-1", id, `result-${index}`);
    }

    const progress = useSubagentStore.getState().progress["run-1"];
    expect(progress.text).toBe(longOutput);
    expect(progress.events).toHaveLength(220);
    expect(progress.activities.length).toBeGreaterThan(220);
    expect(progress.activities.at(-1)?.text).toContain("result-219");
    expect(progress.lastUpdatedAt).toBeGreaterThanOrEqual(progress.startedAt);
    expect(SUBAGENT_LIMITS.maxEvents).toBeLessThan(progress.events.length);
  });

  it("records public lifecycle details without accepting late events", () => {
    const store = useSubagentStore.getState();
    store.init("run-2", "code-explorer", "Inspect the project");
    store.appendThinking("run-2", "Checking the entrypoint");
    store.recordActivity("run-2", "retry", "Retrying request (1/2)");
    store.recordActivity("run-2", "warning", "The local CLI is still starting");
    store.setFinalText("run-2", "Finished from the final generator result.");
    store.markStatus("run-2", "done");

    const before = useSubagentStore.getState().progress["run-2"];
    store.appendText("run-2", "late");
    store.addToolCall("run-2", "read_files", "late-tool");
    store.recordActivity("run-2", "status", "late status");

    const after = useSubagentStore.getState().progress["run-2"];
    expect(after).toBe(before);
    expect(after.text).toContain("Finished from the final generator result.");
    expect(after.activities.map((activity) => activity.kind)).toEqual([
      "thinking",
      "retry",
      "warning",
      "output",
    ]);
  });

  it("rejects a delayed callback from an old run after the same tool id is reused", () => {
    const store = useSubagentStore.getState();
    const oldRunId = store.init("reused", "code-explorer", "Old run");
    store.markStatus("reused", "done", undefined, oldRunId);
    const newRunId = store.init("reused", "code-explorer", "New run");

    store.appendText("reused", "late old output", oldRunId);
    store.recordActivity(
      "reused",
      "warning",
      "late old warning",
      undefined,
      oldRunId,
    );

    const progress = useSubagentStore.getState().progress.reused;
    expect(progress.runId).toBe(newRunId);
    expect(progress.text).toBe("");
    expect(progress.activities).toEqual([]);
  });
});
