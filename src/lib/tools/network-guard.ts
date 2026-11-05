export const TOOL_FETCH_TIMEOUT_MS = 12_000;
export const TOOL_FETCH_TIMEOUT_ATTEMPTS = 3;
export const TOOL_MAX_CONCURRENCY = 3;
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_READER_MAX_URLS = 5;
export const WEB_PAGE_MAX_CHARS = 12_000;
export const SEARCH_SNIPPET_MAX_CHARS = 1_000;
export const ASSET_SEARCH_MAX_RESULTS = 20;
export const ASSET_DESCRIPTION_MAX_CHARS = 400;
export const NPM_SEARCH_MAX_RESULTS = 10;
export const NPM_README_MAX_CHARS = 2_000;
export const NPM_DEPENDENCY_MAX_KEYS = 50;
export const TOOL_ERROR_MAX_CHARS = 500;
export const TOOL_QUERY_MAX_CHARS = 300;
export const TOOL_URL_MAX_CHARS = 2_048;

function formatByteLimit(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

export class ToolTimeoutError extends Error {
  constructor(
    timeoutMs: number,
    readonly attempts = 1,
  ) {
    super(
      `Request timed out after ${timeoutMs}ms${attempts > 1 ? ` (${attempts} attempts)` : ""}`,
    );
    this.name = "ToolTimeoutError";
  }
}

export function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

export function limitArray<T>(
  items: T[],
  max: number,
): { items: T[]; truncated: boolean; originalCount: number } {
  return {
    items: items.slice(0, max),
    truncated: items.length > max,
    originalCount: items.length,
  };
}

export function limitRecord<T>(
  record: Record<string, T> | undefined,
  maxKeys: number,
): { value: Record<string, T>; truncated: boolean; originalCount: number } {
  const entries = Object.entries(record ?? {});
  return {
    value: Object.fromEntries(entries.slice(0, maxKeys)),
    truncated: entries.length > maxKeys,
    originalCount: entries.length,
  };
}

export function truncateText(
  text: unknown,
  maxChars: number,
): { text: string; truncated: boolean; originalLength: number } {
  const value =
    typeof text === "string" ? text : text == null ? "" : String(text);
  return {
    text: value.length > maxChars ? value.slice(0, maxChars) : value,
    truncated: value.length > maxChars,
    originalLength: value.length,
  };
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof ToolTimeoutError) return error.message;
  let message: string;
  if (error instanceof DOMException && error.name === "AbortError") {
    message = "Request was aborted";
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  const truncated = truncateText(message, TOOL_ERROR_MAX_CHARS);
  return truncated.truncated ? `${truncated.text} [truncated]` : truncated.text;
}

export function formatHttpError(
  label: string,
  status: number,
  body: unknown,
): string {
  const text = truncateText(body, TOOL_ERROR_MAX_CHARS);
  const suffix = text.text
    ? `: ${text.text}${text.truncated ? " [truncated]" : ""}`
    : "";
  return `${label} (${status})${suffix}`;
}

export function normalizeToolQuery(
  value: unknown,
  label = "query",
): { ok: true; query: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: `${label} must be a string` };
  }
  const query = value.trim();
  if (!query) return { ok: false, error: `${label} must not be empty` };
  if (query.length > TOOL_QUERY_MAX_CHARS) {
    return {
      ok: false,
      error: `${label} is too long (max ${TOOL_QUERY_MAX_CHARS} characters)`,
    };
  }
  return { ok: true, query };
}

export function normalizeHttpUrl(
  value: unknown,
  label = "url",
): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: `${label} must be a string` };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: `${label} must not be empty` };
  if (trimmed.length > TOOL_URL_MAX_CHARS) {
    return {
      ok: false,
      error: `${label} is too long (max ${TOOL_URL_MAX_CHARS} characters)`,
    };
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: `${label} must use http(s)` };
    }
    url.hash = "";
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, error: `${label} must be a valid URL` };
  }
}

export function normalizeHttpUrlList(
  value: unknown,
  maxUrls: number,
):
  | { ok: true; urls: string[]; truncated: boolean }
  | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "urls must be a non-empty array" };
  }
  const limited = limitArray(value, maxUrls);
  const urls: string[] = [];
  for (let i = 0; i < limited.items.length; i++) {
    const checked = normalizeHttpUrl(limited.items[i], `urls[${i}]`);
    if (!checked.ok) return checked;
    urls.push(checked.url);
  }
  return { ok: true, urls, truncated: limited.truncated };
}

export function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Response>;
export function fetchWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number | undefined,
  readResponse: (response: Response) => Promise<T>,
): Promise<T>;
/** Read-only tool requests may be retried when our own deadline expires. A
 * response reader includes its body in the same attempt without buffering an
 * unbounded response before the caller can enforce its normal size limit. */
export async function fetchWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = TOOL_FETCH_TIMEOUT_MS,
  readResponse?: (response: Response) => Promise<T>,
): Promise<Response | T> {
  const inputRequest =
    typeof Request !== "undefined" && input instanceof Request
      ? input
      : undefined;
  const signal = init.signal ?? inputRequest?.signal;
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    let retryableResponse = true;
    let rejectInterrupted!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterrupted = reject;
    });
    const onAbort = () => {
      const reason =
        signal?.reason ?? new DOMException("Request was aborted", "AbortError");
      controller.abort(reason);
      rejectInterrupted(reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      const error = new ToolTimeoutError(timeoutMs, attempt);
      controller.abort(error);
      rejectInterrupted(error);
    }, timeoutMs);
    try {
      const request = fetch(inputRequest?.clone() ?? input, {
        ...init,
        signal: controller.signal,
      }).then<Response | T>((response) => {
        controller.signal.throwIfAborted();
        retryableResponse = response.ok;
        return readResponse ? readResponse(response) : response;
      });
      return await Promise.race([request, interrupted]);
    } catch (error) {
      signal?.throwIfAborted();
      if (
        !timedOut ||
        !retryableResponse ||
        attempt >= TOOL_FETCH_TIMEOUT_ATTEMPTS
      )
        throw error;
    } finally {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function fetchTextWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = TOOL_FETCH_TIMEOUT_MS,
): Promise<{ response: Response; text: string }> {
  return fetchWithTimeout(input, init, timeoutMs, async (response) => ({
    response,
    text: await response.text(),
  }));
}

export async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${label} exceeds ${formatByteLimit(maxBytes)} limit.`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${label} exceeds ${formatByteLimit(maxBytes)} limit.`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds ${formatByteLimit(maxBytes)} limit.`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  return new TextDecoder("utf-8", { fatal: false }).decode(
    await readResponseBytesWithLimit(response, maxBytes, label),
  );
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const concurrency = clampInt(
    limit,
    TOOL_MAX_CONCURRENCY,
    1,
    items.length || 1,
  );
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}
