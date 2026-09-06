import * as tauri from "./tauri";
import type { LocalGeneratedImage, LocalImageGenerationRequest } from "./types";

function abortError(): Error {
  const error = new Error("The local image generation task was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * Runs one isolated local-CLI image task. The caller owns the opaque task id;
 * use the parent run id and tool-call id so Host cancellation has one stable
 * target across the TypeScript and Rust boundaries.
 */
export async function generateLocalImage(
  input: LocalImageGenerationRequest,
  signal?: AbortSignal,
): Promise<LocalGeneratedImage> {
  if (signal?.aborted) throw abortError();

  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void tauri.cancelLocalAgentImage(input.taskId).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const image = await tauri.generateLocalAgentImage(input);
    if (cancelled || signal?.aborted) throw abortError();
    return image;
  } catch (cause) {
    if (cancelled || signal?.aborted) throw abortError();
    throw cause;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
