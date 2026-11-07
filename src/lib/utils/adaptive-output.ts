import type { BufferedAssistantOutput } from "./stream-output";

type OutputKind = "text" | "thinking";

export interface AdaptiveOutputScheduler {
  push(kind: OutputKind, delta: string): void;
  flush(kind?: OutputKind): void;
  clear(): void;
}

interface SchedulerOptions {
  append: (output: BufferedAssistantOutput) => void;
  isCurrent: () => boolean;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Short output keeps its cadence; a growing queue switches this segment to live output. */
export function createAdaptiveOutputScheduler({
  append,
  isCurrent,
  now = () => performance.now(),
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
}: SchedulerOptions): AdaptiveOutputScheduler {
  let frame: number | undefined;
  let kind: OutputKind = "text";
  let buffer = "";
  let queuedAt = 0;
  let lastRevealAt = 0;
  let live = false;

  function clear(): void {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    buffer = "";
    live = false;
  }

  function emit(value: string): void {
    if (value && isCurrent()) append({ [kind]: value });
  }

  function flush(onlyKind?: OutputKind): void {
    if (onlyKind && onlyKind !== kind) return;
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    const remaining = buffer;
    buffer = "";
    emit(remaining);
    live = false;
  }

  function reveal(): void {
    frame = undefined;
    if (!isCurrent()) {
      clear();
      return;
    }
    const timestamp = now();
    // A split surrogate can arrive in two network chunks. Keep it until the
    // next chunk (or an explicit final flush) instead of rendering half an emoji.
    const hasTrailingSurrogate = /[\uD800-\uDBFF]$/.test(buffer);
    const complete = hasTrailingSurrogate ? buffer.slice(0, -1) : buffer;
    live ||= Array.from(complete).length >= 64 || timestamp - queuedAt >= 120;
    let length = 0;
    if (live) {
      length = complete.length;
    } else {
      let count = Math.floor((timestamp - lastRevealAt) / 20);
      for (const item of segmenter.segment(complete)) {
        if (count <= 0) break;
        length = item.index + item.segment.length;
        count -= 1;
        lastRevealAt += 20;
      }
    }
    if (length > 0) {
      const value = buffer.slice(0, length);
      buffer = buffer.slice(length);
      emit(value);
    }
    if (buffer) frame = requestFrame(reveal);
  }

  function push(nextKind: OutputKind, delta: string): void {
    if (!delta || !isCurrent()) return;
    if (kind !== nextKind) {
      flush();
      kind = nextKind;
    }
    if (!buffer) {
      queuedAt = now();
      lastRevealAt = queuedAt - 20;
    }
    buffer += delta;
    if (frame === undefined) frame = requestFrame(reveal);
  }

  return { push, flush, clear };
}
