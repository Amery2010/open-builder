import {
  AGNES_API_ORIGIN,
  AGNES_IMAGE_MODEL,
  AGNES_VIDEO_MODEL,
  type AgnesMediaStatus,
} from "./types";
import { readResponseTextWithLimit } from "../../tools/network-guard";
import { normalizeAgnesPublicHttpsUrl } from "./public-url";

const RESPONSE_LIMIT_BYTES = 64 * 1024;
const MAX_RETRY_DELAY_MS = 30_000;

export interface AgnesRequestMetadata {
  retried: boolean;
  duplicatePossible: boolean;
}

export interface AgnesImageResult extends AgnesRequestMetadata {
  urls: string[];
}

export interface AgnesVideoResult extends AgnesRequestMetadata {
  id?: string;
  taskId?: string;
  videoId: string;
  status: AgnesMediaStatus;
  progress: number;
  createdAt?: number;
  completedAt?: number | null;
  seconds?: string;
  size?: string;
  url?: string;
  error?: string;
}

export class AgnesApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly duplicatePossible = false,
  ) {
    super(message);
    this.name = "AgnesApiError";
  }
}

interface AgnesClientOptions {
  apiKey: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

interface JsonRequestResult {
  data: unknown;
  retried: boolean;
  duplicatePossible: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, seconds * 1_000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - Date.now()))
    : 1_000;
}

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, ms);
    const abort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function readBoundedText(response: Response): Promise<string> {
  try {
    return await readResponseTextWithLimit(
      response,
      RESPONSE_LIMIT_BYTES,
      "Agnes response",
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new AgnesApiError("Agnes response exceeded the size limit.");
  }
}

async function requestAttempt(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ response: Response; text?: string }> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { response };
    }
    return { response, text: await readBoundedText(response) };
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (timedOut) throw new AgnesApiError("Agnes request timed out.");
    if (error instanceof TypeError) {
      throw new AgnesApiError(
        "Agnes request could not reach the official API. On Web, check browser CORS policy and network access.",
      );
    }
    if (error instanceof AgnesApiError) throw error;
    throw new AgnesApiError("Agnes request failed.");
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function requestJson(
  path: string,
  init: RequestInit,
  options: AgnesClientOptions,
  timeoutMs: number,
): Promise<JsonRequestResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new AgnesApiError("Agnes API key is not configured.");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const method = (init.method ?? "GET").toUpperCase();
  let retried = false;
  let duplicatePossible = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptResult = await requestAttempt(
      fetchImpl,
      `${AGNES_API_ORIGIN}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      },
      options.signal,
      timeoutMs,
    );
    const response = attemptResult.response;
    if (response.ok) {
      const text = attemptResult.text ?? "";
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new AgnesApiError("Agnes returned invalid JSON.");
      }
      return { data, retried, duplicatePossible };
    }

    const retryable =
      method === "POST" && (response.status === 429 || response.status >= 500);
    if (attempt === 0 && retryable) {
      retried = true;
      duplicatePossible ||= method === "POST";
      await waitForRetry(
        parseRetryAfter(response.headers.get("retry-after")),
        options.signal,
      );
      continue;
    }
    throw new AgnesApiError(
      `Agnes request failed (${response.status}).`,
      response.status,
      duplicatePossible,
    );
  }
  throw new AgnesApiError("Agnes request failed.");
}

function requireHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgnesApiError(`Agnes response is missing ${label}.`);
  }
  try {
    return normalizeAgnesPublicHttpsUrl(value, label);
  } catch {
    throw new AgnesApiError(`Agnes returned an unsafe ${label}.`);
  }
}

function mediaStatus(value: unknown): AgnesMediaStatus {
  if (
    value === "queued" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }
  throw new AgnesApiError("Agnes returned an unknown video status.");
}

function boundedString(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

function boundedTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function videoIdentifier(value: unknown): string | undefined {
  const id = boundedString(value);
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
}

function parseVideoResult(
  data: unknown,
  metadata: AgnesRequestMetadata,
  expectedVideoId?: string,
): AgnesVideoResult {
  if (!isRecord(data))
    throw new AgnesApiError("Agnes returned invalid video data.");
  const videoId = videoIdentifier(data.video_id);
  if (!videoId) throw new AgnesApiError("Agnes response is missing video_id.");
  if (expectedVideoId && videoId !== expectedVideoId) {
    throw new AgnesApiError("Agnes returned a different video_id.");
  }
  if (data.model !== AGNES_VIDEO_MODEL) {
    throw new AgnesApiError("Agnes returned an unexpected video model.");
  }
  if (data.size !== "720P") {
    throw new AgnesApiError("Agnes returned an unexpected video size.");
  }
  if (
    typeof data.seconds !== "string" ||
    !/^([4-9]|1[0-2])$/.test(data.seconds)
  ) {
    throw new AgnesApiError("Agnes returned invalid video seconds.");
  }
  const status = mediaStatus(data.status);
  if (
    typeof data.progress !== "number" ||
    !Number.isInteger(data.progress) ||
    data.progress < 0 ||
    data.progress > 100
  ) {
    throw new AgnesApiError("Agnes returned invalid video progress.");
  }
  const rawMetadata = isRecord(data.metadata) ? data.metadata : undefined;
  const url =
    status === "completed"
      ? requireHttpsUrl(rawMetadata?.url, "video URL")
      : undefined;
  const hasProviderError =
    isRecord(data.error) && data.error.message !== undefined;
  return {
    ...metadata,
    id: boundedString(data.id),
    taskId: boundedString(data.task_id),
    videoId,
    status,
    progress: data.progress,
    createdAt: boundedTimestamp(data.created_at),
    completedAt:
      data.completed_at === null ? null : boundedTimestamp(data.completed_at),
    seconds: boundedString(data.seconds, 16),
    size: boundedString(data.size, 32),
    url,
    error: hasProviderError ? "Video generation failed." : undefined,
  };
}

export async function generateAgnesImage(
  input: {
    prompt: string;
    size: string;
    ratio: string;
    images: string[];
  },
  options: AgnesClientOptions,
): Promise<AgnesImageResult> {
  const extraBody: Record<string, unknown> = { response_format: "url" };
  if (input.images.length > 0) extraBody.image = input.images;
  const response = await requestJson(
    "/v1/images/generations",
    {
      method: "POST",
      body: JSON.stringify({
        model: AGNES_IMAGE_MODEL,
        prompt: input.prompt,
        size: input.size,
        ratio: input.ratio,
        extra_body: extraBody,
      }),
    },
    options,
    360_000,
  );
  if (!isRecord(response.data) || !Array.isArray(response.data.data)) {
    throw new AgnesApiError("Agnes returned invalid image data.");
  }
  if (response.data.data.length !== 1) {
    throw new AgnesApiError("Agnes returned an unexpected image count.");
  }
  const urls = response.data.data.map((item, index) => {
    if (!isRecord(item))
      throw new AgnesApiError("Agnes returned invalid image data.");
    return requireHttpsUrl(item.url, `image URL ${index + 1}`);
  });
  if (urls.length === 0) throw new AgnesApiError("Agnes returned no images.");
  return {
    urls,
    retried: response.retried,
    duplicatePossible: response.duplicatePossible,
  };
}

export async function createAgnesVideo(
  input: { prompt: string; seconds: number; aspectRatio: string },
  options: AgnesClientOptions,
): Promise<AgnesVideoResult> {
  const response = await requestJson(
    "/v1/videos",
    {
      method: "POST",
      body: JSON.stringify({
        model: AGNES_VIDEO_MODEL,
        prompt: input.prompt,
        seconds: String(input.seconds),
        mode: "text",
        size: "720P",
        aspect_ratio: input.aspectRatio,
        n: 1,
      }),
    },
    options,
    60_000,
  );
  return parseVideoResult(response.data, response);
}

export async function getAgnesVideoStatus(
  videoId: string,
  options: AgnesClientOptions,
): Promise<AgnesVideoResult> {
  const query = new URLSearchParams({
    video_id: videoId,
    model_name: AGNES_VIDEO_MODEL,
  });
  const response = await requestJson(
    `/agnesapi?${query.toString()}`,
    { method: "GET" },
    options,
    30_000,
  );
  return parseVideoResult(response.data, response, videoId);
}
