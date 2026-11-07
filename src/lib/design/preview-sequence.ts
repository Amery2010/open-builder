import type { ToolExecutionOutput } from "../ai/generator-types";
import { mcpToolExecutionOutputToModelOutput } from "../mcp/tool-output";
import { readScreenshotImage } from "../images/screenshot";
import type { DesignBridgeCaptureResult } from "./preview-bridge";
import { summarizeCapture } from "./preview-evidence";
import {
  PreviewRuntimeError,
  withPreviewCaptureLock,
  type PreviewCaptureScope,
} from "./preview-runtime";

export const PREVIEW_SEQUENCE_KIND = "preview_sequence_v1";
export const PREVIEW_SEQUENCE_LIMITS = {
  maxFrames: 5,
  maxOffsetMs: 30_000,
} as const;

export interface PreviewSequenceFrame {
  scheduledAtMs: number;
  startedAtMs: number;
  durationMs: number;
  capture?: DesignBridgeCaptureResult;
  error?: string;
}

export interface PreviewSequenceCollection {
  generation: string;
  frames: PreviewSequenceFrame[];
  errors: string[];
  errorCode?: string;
}

export function validatePreviewSequenceTimes(value: unknown): number[] {
  const values = value === undefined ? [0] : value;
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > PREVIEW_SEQUENCE_LIMITS.maxFrames ||
    values.some(
      (time, index) =>
        !Number.isInteger(time) ||
        time < 0 ||
        time > PREVIEW_SEQUENCE_LIMITS.maxOffsetMs ||
        (index > 0 && time <= values[index - 1]),
    )
  ) {
    throw new Error(
      "atMs must contain 1–5 strictly increasing integer offsets from 0 to 30000 milliseconds.",
    );
  }
  return [...values];
}

function waitUntil(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 400);
}

export async function capturePreviewSequence(input: {
  conversationId: string;
  atMs?: readonly number[];
  scope?: PreviewCaptureScope;
  expectedGeneration?: string;
  signal?: AbortSignal;
}): Promise<PreviewSequenceCollection> {
  const result: PreviewSequenceCollection = {
    generation: input.expectedGeneration ?? "",
    frames: [],
    errors: [],
  };
  try {
    const times = validatePreviewSequenceTimes(input.atMs);
    await withPreviewCaptureLock({
      conversationId: input.conversationId,
      owner: "tool",
      signal: input.signal,
      run: async (adapter, signal) => {
        const generation = input.expectedGeneration ?? adapter.getGeneration();
        if (!generation || !adapter.prepareCurrent || !adapter.captureCurrent) {
          throw new PreviewRuntimeError(
            "preview_unavailable",
            "Live preview capture is unavailable. Open a supported project preview first.",
          );
        }
        result.generation = generation;
        const assertCurrent = () => {
          signal.throwIfAborted();
          if (adapter.getGeneration() !== generation) {
            throw new PreviewRuntimeError(
              "stale_generation",
              "The project changed during preview capture.",
            );
          }
        };
        assertCurrent();
        await adapter.prepareCurrent(generation, signal);
        assertCurrent();
        const started = performance.now();
        for (const scheduledAtMs of times) {
          await waitUntil(started + scheduledAtMs - performance.now(), signal);
          assertCurrent();
          const startedAtMs = Math.max(0, performance.now() - started);
          try {
            const capture = await adapter.captureCurrent(generation, signal, {
              scope: input.scope ?? "viewport",
            });
            assertCurrent();
            if (capture.generation !== generation)
              throw new PreviewRuntimeError(
                "stale_generation",
                "The captured page belongs to an older project generation.",
              );
            result.frames.push({
              scheduledAtMs,
              startedAtMs,
              durationMs: performance.now() - started - startedAtMs,
              capture,
            });
          } catch (error) {
            result.frames.push({
              scheduledAtMs,
              startedAtMs,
              durationMs: Math.max(
                0,
                performance.now() - started - startedAtMs,
              ),
              error: errorMessage(error),
            });
            throw error;
          }
        }
      },
    });
  } catch (error) {
    result.errors.push(errorMessage(error));
    result.errorCode = "capture_failed";
    if (error instanceof PreviewRuntimeError) result.errorCode = error.code;
    else if ((error as { name?: string })?.name === "AbortError")
      result.errorCode = "aborted";
  }
  return result;
}

export async function createPreviewSequenceToolOutput(
  collection: PreviewSequenceCollection,
): Promise<ToolExecutionOutput> {
  const successful = collection.frames.filter((frame) => frame.capture);
  const frames = await Promise.all(
    collection.frames.map(async (frame) => ({
      scheduledAtMs: frame.scheduledAtMs,
      startedAtMs: Math.round(frame.startedAtMs),
      durationMs: Math.round(frame.durationMs),
      ...(frame.capture
        ? { evidence: await summarizeCapture(frame.capture) }
        : {}),
      ...(frame.error ? { error: frame.error } : {}),
    })),
  );
  let status = "complete";
  if (successful.length === 0) status = "error";
  else if (collection.errors.length) status = "partial";
  const summary = {
    kind: PREVIEW_SEQUENCE_KIND,
    generation: collection.generation,
    status,
    frames,
    errors: collection.errors,
    errorCode: collection.errorCode,
    placeholder:
      "Screenshot bytes and full semantic element text were retained for this run only.",
  };
  const text = JSON.stringify(summary);
  const output: ToolExecutionOutput = {
    text,
    structuredContent: summary,
    isError: successful.length === 0,
    content: [
      { type: "text", text },
      ...successful.map(({ capture }) => ({
        type: "image" as const,
        data: readScreenshotImage(capture!.dataUrl).base64,
        mimeType: capture!.mimeType,
      })),
    ],
  };
  output.modelOutput = mcpToolExecutionOutputToModelOutput(output);
  return output;
}
