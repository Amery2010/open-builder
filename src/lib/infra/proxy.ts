// ============================================================================
//  proxy.ts
//  Global fetch & XMLHttpRequest interceptor for Tauri custom protocol proxy.
//  Rewrites external HTTP(S) requests to an explicit proxy-http(s) protocol so
//  Rust backend can forward them via reqwest, bypassing CORS restrictions.
//
//  Streaming requests (SSE) are routed through the Tauri invoke + Events
//  bridge instead of the custom protocol, enabling real-time token streaming.
// ============================================================================

import { createSseResponse } from "./sse-bridge";
import { invoke } from "@tauri-apps/api/core";

const PROXY_SCHEMES = new Set(["proxy-http:", "proxy-https:"]);
const SETTINGS_STORAGE_KEY = "open-builder-settings";
const MAX_PROXY_ALLOWED_HOSTS = 64;
const MAX_PROXY_HOST_CHARS = 253;
const HOSTNAME_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// ─── State ───────────────────────────────────────────────────────────────────

let proxyEnabled = false;
let proxyAllowedHosts: string[] = [];
let proxyLog: ProxyLogEntry[] = [];
let installed = false;
let proxyPolicySync: Promise<void> = Promise.resolve();

export interface ProxyLogEntry {
  timestamp: number;
  kind: "fetch" | "xhr" | "sse";
  method: string;
  host: string;
  path: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Dynamically enable or disable the proxy at runtime.
 * Called by the settings panel when the user toggles the switch.
 */
export async function revokeNativeProxyPolicy(): Promise<void> {
  proxyEnabled = false;
  proxyAllowedHosts = [];
  if (!isTauri()) return;
  await enqueueProxyPolicyWrite({ enabled: false, allowed_hosts: [] });
}

export function parseProxyAllowedHosts(value: string): string[] {
  const out = new Set<string>();
  for (const item of value.split(/[\n,]/)) {
    const normalized = normalizeProxyHostRule(item);
    if (!normalized) continue;
    out.add(normalized);
    if (out.size >= MAX_PROXY_ALLOWED_HOSTS) break;
  }
  return Array.from(out);
}

export function applyProxyPolicy(
  enabled: boolean,
  hosts: string[] | string,
): void {
  proxyEnabled = enabled;
  proxyAllowedHosts = Array.isArray(hosts)
    ? hosts
        .map(normalizeProxyHostRule)
        .filter((host): host is string => Boolean(host))
        .slice(0, MAX_PROXY_ALLOWED_HOSTS)
    : parseProxyAllowedHosts(hosts);
  syncProxyPolicy();
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

export function isProxyUrlAllowed(
  rawUrl: string,
  allowedOrigins: string[],
): boolean {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  const targetHost = normalizeHostName(target.hostname);
  if (!targetHost || allowedOrigins.length === 0) return false;

  return allowedOrigins.some((rawAllowed) => {
    const allowed = normalizeProxyHostRule(rawAllowed);
    if (!allowed) return false;
    const wildcard = allowed.match(/^(https?):\/\/\*\.([^/:?#]+)(?::(\d+))?$/);
    if (wildcard) {
      const [, scheme, suffix, configuredPort] = wildcard;
      const port = configuredPort || (scheme === "https" ? "443" : "80");
      return (
        target.protocol === `${scheme}:` &&
        effectivePort(target) === port &&
        targetHost.endsWith(`.${suffix}`) &&
        targetHost.length > suffix.length + 1
      );
    }
    try {
      const approved = new URL(allowed);
      return (
        target.protocol === approved.protocol &&
        targetHost === normalizeHostName(approved.hostname) &&
        effectivePort(target) === effectivePort(approved)
      );
    } catch {
      return false;
    }
  });
}

function addHostFromUrl(out: Set<string>, rawUrl: unknown): void {
  if (typeof rawUrl !== "string" || !rawUrl) return;
  try {
    const parsed = new URL(rawUrl);
    const origin = normalizeProxyHostRule(parsed.origin);
    if (origin) out.add(origin);
  } catch {
    // Ignore incomplete settings while the user is typing.
  }
}

function normalizeHostName(hostname: string): string | null {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host || host.length > MAX_PROXY_HOST_CHARS) return null;
  return host;
}

export function normalizeProxyHostRule(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw || raw.length > MAX_PROXY_HOST_CHARS + 24) return null;

  const wildcard = raw.match(
    /^(?:(https?):\/\/)?\*\.([^/:?#]+)(?::(\d+))?\/?$/,
  );
  if (wildcard) {
    const scheme = wildcard[1] ?? "https";
    const suffix = wildcard[2];
    const port = wildcard[3];
    if (
      !HOSTNAME_RE.test(suffix) ||
      (port !== undefined && Number(port) > 65_535)
    ) {
      return null;
    }
    const defaultPort = scheme === "https" ? "443" : "80";
    return `${scheme}://*.${suffix}${port && port !== defaultPort ? `:${port}` : ""}`;
  }

  let candidate = raw;
  if (!/^https?:\/\//.test(candidate)) {
    const bracketed = candidate.match(/^\[([^\]]+)](?::(\d+))?$/);
    const hostWithPort = candidate.match(/^([^:]+):(\d+)$/);
    const host = bracketed?.[1] ?? hostWithPort?.[1] ?? candidate;
    const loopback =
      host === "localhost" ||
      host === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(host);
    candidate = `${loopback ? "http" : "https"}://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    const host = normalizeHostName(parsed.hostname);
    if (!host) return null;
    if (
      host !== "localhost" &&
      !HOSTNAME_RE.test(host) &&
      !host.includes(":")
    ) {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function readConfiguredApiHosts(): string[] {
  const hosts = new Set<string>();
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    addHostFromUrl(hosts, data?.state?.ai?.apiBaseUrl);
  } catch {
    // Ignore malformed local settings.
  }
  return [...hosts];
}

function effectiveAllowedHosts(): string[] {
  return [...new Set([...proxyAllowedHosts, ...readConfiguredApiHosts()])];
}

function syncProxyPolicy(): void {
  if (!isTauri()) return;
  void enqueueProxyPolicyWrite({
    enabled: proxyEnabled,
    allowed_hosts: proxyEnabled ? effectiveAllowedHosts() : [],
  });
}

function enqueueProxyPolicyWrite(policy: {
  enabled: boolean;
  allowed_hosts: string[];
}): Promise<void> {
  const operation = proxyPolicySync
    .catch(() => {})
    .then(() => invoke("set_proxy_policy", { policy }))
    .then(() => {});
  proxyPolicySync = operation.catch((err) => {
    console.warn("[proxy] Failed to sync proxy policy:", err);
  });
  return operation;
}

export function getProxyLog(): ProxyLogEntry[] {
  return [...proxyLog];
}

export function clearProxyLog(): void {
  proxyLog = [];
}

/**
 * Check if the proxy is currently enabled.
 */
export function isProxyEnabled(): boolean {
  return proxyEnabled;
}

/**
 * Detect whether running inside a Tauri WebView.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Install the global proxy interceptor.
 * Must be called once, early in the application lifecycle (before any API calls).
 * Only activates when running inside Tauri.
 */
export function installProxy(): void {
  if (installed) return;

  if (!isTauri()) {
    return;
  }

  // Read the saved policy atomically so enabling never reuses a stale allowlist.
  applyProxyPolicy(readProxySetting(), readProxyAllowedHosts());

  hijackFetch();
  hijackXHR();

  installed = true;
  console.log("[proxy] Interceptor installed (enabled:", proxyEnabled, ")");
}

// ─── URL Helpers ─────────────────────────────────────────────────────────────

/**
 * Determine if a URL should be proxied.
 */
function shouldProxy(url: string): boolean {
  if (!proxyEnabled) return false;

  // Already proxied
  try {
    if (PROXY_SCHEMES.has(new URL(url).protocol)) return false;
  } catch {
    // Relative URLs are resolved below.
  }

  // Skip non-HTTP(S) protocols
  if (url.startsWith("data:") || url.startsWith("blob:")) return false;

  try {
    const parsed = new URL(url, window.location.href);

    // Only proxy http and https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return false;

    // Don't proxy same-origin requests (dev server, tauri app, etc.)
    if (parsed.origin === window.location.origin) return false;

    if (!isProxyUrlAllowed(parsed.href, effectiveAllowedHosts())) return false;

    return true;
  } catch {
    return false;
  }
}

function recordProxyRequest(
  kind: ProxyLogEntry["kind"],
  method: string,
  rawUrl: string,
): void {
  try {
    const parsed = new URL(
      rawUrl,
      typeof window === "undefined" ? "http://localhost" : window.location.href,
    );
    proxyLog = [
      ...proxyLog.slice(-99),
      {
        timestamp: Date.now(),
        kind,
        method,
        host: parsed.host,
        path: parsed.pathname === "/" ? "/" : "/…",
      },
    ];
  } catch {
    // Ignore malformed URLs; shouldProxy already rejects them.
  }
}

export function redactProxyTargetForLog(rawUrl: string): string {
  try {
    const parsed = new URL(
      rawUrl,
      typeof window === "undefined" ? "http://localhost" : window.location.href,
    );
    return `${parsed.origin}${parsed.pathname === "/" ? "/" : "/…"}`;
  } catch {
    return "invalid target";
  }
}

/**
 * Rewrite an external URL while preserving its original HTTP(S) scheme.
 *
 * https://api.openai.com/v1/chat/completions?stream=true
 *   → proxy-https://api.openai.com/v1/chat/completions?stream=true
 *
 * http://localhost:11434/v1/chat/completions
 *   → proxy-http://localhost:11434/v1/chat/completions
 */
export function toProxyUrl(originalUrl: string): string {
  const parsed = new URL(originalUrl);
  const proxyScheme =
    parsed.protocol === "https:" ? "proxy-https" : "proxy-http";
  return `${proxyScheme}://${parsed.host}${parsed.pathname}${parsed.search}`;
}

/**
 * Extract URL string from various fetch input types.
 */
function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}

// ─── Read initial setting ────────────────────────────────────────────────────

function readProxySetting(): boolean {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    return data?.state?.system?.reverseProxy === true;
  } catch {
    return false;
  }
}

function readProxyAllowedHosts(): string {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return "";
    const data = JSON.parse(raw);
    return data?.state?.system?.reverseProxyAllowedHosts ?? "";
  } catch {
    return "";
  }
}

// ─── Streaming Detection ─────────────────────────────────────────────────────

/**
 * Detect if a fetch request is a streaming SSE request.
 *
 * - OpenAI / Anthropic / Compatible: JSON body contains "stream":true
 * - Google Gemini: URL path contains ":streamGenerateContent"
 */
function isStreamingRequest(url: string, body?: string): boolean {
  if (url.includes(":streamGenerateContent")) return true;
  return body !== undefined && /"stream"\s*:\s*true/.test(body);
}

// ─── Fetch Hijack ────────────────────────────────────────────────────────────

function hijackFetch(): void {
  const originalFetch = window.fetch;

  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const rawUrl = extractUrl(input);

    if (!shouldProxy(rawUrl)) {
      return originalFetch.call(window, input, init);
    }

    // Normalize once using fetch's RequestInit precedence. Inspect a clone so
    // Request-only streaming calls preserve their body and cancellation signal.
    const request = new Request(
      input instanceof Request
        ? input.clone()
        : new URL(rawUrl, window.location.href),
      init,
    );
    request.signal.throwIfAborted();
    const body = request.body ? await request.clone().text() : undefined;
    request.signal.throwIfAborted();

    // Streaming requests → SSE bridge (Tauri invoke + Events)
    if (isStreamingRequest(rawUrl, body)) {
      const method = request.method;
      console.debug(
        `[proxy] ${method} ${redactProxyTargetForLog(rawUrl)} [sse]`,
      );
      recordProxyRequest("sse", method, rawUrl);
      return createSseResponse({
        url: rawUrl,
        method,
        headers: Object.fromEntries(request.headers),
        body,
        signal: request.signal,
      });
    }

    // Non-streaming requests → proxy:// custom protocol
    const proxiedUrl = toProxyUrl(rawUrl);
    const method = request.method;
    console.debug(
      `[proxy] ${method} ${redactProxyTargetForLog(rawUrl)} [fetch]`,
    );
    recordProxyRequest("fetch", method, rawUrl);

    return originalFetch.call(window, new Request(proxiedUrl, request));
  };
}

// ─── XHR Hijack ──────────────────────────────────────────────────────────────

function hijackXHR(): void {
  const originalOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async_?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    const rawUrl = typeof url === "string" ? url : url.href;

    if (shouldProxy(rawUrl)) {
      const proxiedUrl = toProxyUrl(rawUrl);
      console.debug(
        `[proxy] ${method} ${redactProxyTargetForLog(rawUrl)} [xhr]`,
      );
      recordProxyRequest("xhr", method, rawUrl);
      return originalOpen.call(
        this,
        method,
        proxiedUrl,
        async_ ?? true,
        username,
        password,
      );
    }

    return originalOpen.call(
      this,
      method,
      url as string,
      async_ ?? true,
      username,
      password,
    );
  };
}
