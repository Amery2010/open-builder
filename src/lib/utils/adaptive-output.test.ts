import { describe, expect, it } from "vitest";
import { createAdaptiveOutputScheduler } from "./adaptive-output";
import type { BufferedAssistantOutput } from "./stream-output";

function harness() {
  let time = 0;
  let id = 0;
  let current = true;
  const frames = new Map<number, FrameRequestCallback>();
  const output: BufferedAssistantOutput[] = [];
  const scheduler = createAdaptiveOutputScheduler({
    append: (value) => output.push(value),
    isCurrent: () => current,
    now: () => time,
    requestFrame: (callback) => {
      frames.set(++id, callback);
      return id;
    },
    cancelFrame: (frame) => {
      frames.delete(frame);
    },
  });
  return {
    scheduler,
    output,
    stale: () => {
      current = false;
    },
    frame: (milliseconds = 16) => {
      time += milliseconds;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(time);
    },
    pending: () => frames.size,
  };
}

describe("adaptive assistant output", () => {
  it("keeps short text gradual and emits complete graphemes", () => {
    const h = harness();
    h.scheduler.push("text", "中👨‍👩‍👧‍👦e\u0301文");
    h.frame();
    h.frame(20);
    h.frame(20);
    expect(h.output).toEqual([
      { text: "中" },
      { text: "👨‍👩‍👧‍👦" },
      { text: "e\u0301" },
    ]);
    h.scheduler.flush();
    expect(h.output.at(-1)).toEqual({ text: "文" });
  });

  it("renders a burst in one frame and stays live for the segment", () => {
    const h = harness();
    const text = "长文本".repeat(1000);
    h.scheduler.push("text", text);
    h.frame();
    expect(h.output).toEqual([{ text }]);
    h.scheduler.push("text", "继续输出");
    h.frame();
    expect(h.output.at(-1)).toEqual({ text: "继续输出" });
    expect(h.pending()).toBe(0);
  });

  it("catches up a small queue that has waited 120ms", () => {
    const h = harness();
    h.scheduler.push("thinking", "Thinking about the implementation");
    h.frame(120);
    expect(h.output).toEqual([
      { thinking: "Thinking about the implementation" },
    ]);
  });

  it("flushes thinking before text and preserves output when completion beats a frame", () => {
    const h = harness();
    h.scheduler.push("thinking", "plan");
    h.scheduler.push("text", "answer");
    expect(h.output).toEqual([{ thinking: "plan" }]);
    h.scheduler.flush();
    h.frame();
    expect(h.output).toEqual([{ thinking: "plan" }, { text: "answer" }]);
  });

  it("does not emit stale or cleared output", () => {
    const h = harness();
    h.scheduler.push("text", "previous run");
    h.stale();
    h.frame();
    h.scheduler.flush();
    expect(h.output).toEqual([]);
    expect(h.pending()).toBe(0);
    const next = harness();
    next.scheduler.push("text", "retry");
    next.scheduler.clear();
    next.frame();
    expect(next.output).toEqual([]);
  });

  it("holds a network-split surrogate until its second half arrives", () => {
    const h = harness();
    h.scheduler.push("text", "\ud83d");
    h.frame();
    expect(h.output).toEqual([]);
    h.scheduler.push("text", "\ude00");
    h.frame(20);
    expect(h.output).toEqual([{ text: "😀" }]);
  });
});
