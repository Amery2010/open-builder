import type { DesignSelectionContext, ProjectFiles } from "../../types";
import { EDITABLE_DESIGN_TOKENS } from "./tokens";
export { formatDesignSelectionForModel } from "./selection-context";

export const DESIGN_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const DESIGN_BRIDGE_PAYLOAD_MAX_BYTES = 8 * 1024;
export const DESIGN_BRIDGE_SEMANTIC_MAX_BYTES = 64 * 1024;
export const DESIGN_BRIDGE_CAPTURE_MAX_BYTES = 1_500 * 1024;
export const DESIGN_BRIDGE_CAPTURE_MESSAGE_MAX_BYTES =
  Math.ceil((DESIGN_BRIDGE_CAPTURE_MAX_BYTES * 4) / 3) +
  DESIGN_BRIDGE_SEMANTIC_MAX_BYTES +
  4_096;
export const DESIGN_BRIDGE_CAPTURE_MAX_HEIGHT = 4_096;
export const DESIGN_BRIDGE_CAPTURE_MAX_PIXELS = 6_000_000;
export const DESIGN_BRIDGE_CAPTURE_TIMEOUT_MS = 20_000;
export const DESIGN_BRIDGE_VIRTUAL_PATH = "__open_builder_design_bridge__.js";
export const DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH =
  "__open_builder_html_to_image__.js";
export const DESIGN_BRIDGE_MARKER = "open-builder-design-bridge";
export const DESIGN_RUNTIME_TOKEN_NAMES = EDITABLE_DESIGN_TOKENS.map(
  (token) => token.property,
);

export const SUPPORTED_DESIGN_BRIDGE_TEMPLATES = new Set([
  "static",
  "vite",
  "vite-react",
  "vite-react-ts",
]);

const BRIDGE_TAG = `<!-- ${DESIGN_BRIDGE_MARKER}:start -->\n<script src="/${DESIGN_BRIDGE_VIRTUAL_PATH}" data-ob-design-bridge></script>\n<!-- ${DESIGN_BRIDGE_MARKER}:end -->`;
const BRIDGE_TAG_PATTERN = new RegExp(
  `\\s*<!-- ${DESIGN_BRIDGE_MARKER}:start -->[\\s\\S]*?<!-- ${DESIGN_BRIDGE_MARKER}:end -->\\s*`,
  "g",
);

export interface DesignBridgeInjectionResult {
  supported: boolean;
  files: ProjectFiles;
  indexPath?: string;
  reason?:
    "code-only" | "unsupported-template" | "missing-index" | "reserved-path";
}

export type DesignReviewViewportName = "desktop" | "tablet" | "mobile";

export interface DesignPreviewSemanticElement {
  tagName: string;
  role?: string;
  name?: string;
  text?: string;
  elementId?: string;
  bounds: { x: number; y: number; width: number; height: number };
  styles?: {
    color?: string;
    backgroundColor?: string;
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
  };
}

export interface DesignPreviewSemanticSnapshot {
  route: string;
  title?: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  document: {
    scrollWidth: number;
    scrollHeight: number;
    horizontalOverflow: boolean;
    fonts: "ready" | "loading" | "unsupported";
  };
  designTokens?: {
    computed: Record<string, string>;
    inline: Record<string, string>;
  };
  elements: DesignPreviewSemanticElement[];
}

export interface DesignBridgeCaptureResult {
  dataUrl: string;
  mimeType: "image/webp";
  viewport: {
    name: DesignReviewViewportName;
    width: number;
    height: number;
    capturedHeight: number;
    fullHeight: number;
    truncated: boolean;
  };
  semanticSnapshot: DesignPreviewSemanticSnapshot;
}

export interface DesignBridgeCaptureExpectation {
  nonce: string;
  requestId: string;
  viewportName: DesignReviewViewportName;
  viewportWidth: number;
  viewportHeight: number;
}

export type DesignBridgeCaptureResponse =
  | { ok: true; result: DesignBridgeCaptureResult }
  | { ok: false; error: string };

export type DesignBridgeParentMessage =
  | {
      type: "open-builder:design-bridge-ready";
      version: number;
      captureRuntimeAvailable: boolean;
    }
  | {
      type: "open-builder:design-bridge-selection";
      version: number;
      nonce: string;
      payload: unknown;
    }
  | {
      type: "open-builder:design-bridge-exit";
      version: number;
      nonce: string;
    }
  | {
      type: "open-builder:design-bridge-capture-result";
      version: number;
      nonce: string;
      requestId: string;
      payload: unknown;
    }
  | {
      type: "open-builder:design-bridge-capture-error";
      version: number;
      nonce: string;
      requestId: string;
      error: unknown;
    };

function previewBridgeClientSource(captureRuntimeAvailable: boolean): string {
  return `(function () {
  "use strict";
  var VERSION = ${DESIGN_BRIDGE_PROTOCOL_VERSION};
  var CAPTURE_RUNTIME_AVAILABLE = ${JSON.stringify(captureRuntimeAvailable)};
  var MAX_BYTES = ${DESIGN_BRIDGE_PAYLOAD_MAX_BYTES};
  var SEMANTIC_MAX_BYTES = ${DESIGN_BRIDGE_SEMANTIC_MAX_BYTES};
  var IMAGE_MAX_BYTES = ${DESIGN_BRIDGE_CAPTURE_MAX_BYTES};
  var CAPTURE_MAX_HEIGHT = ${DESIGN_BRIDGE_CAPTURE_MAX_HEIGHT};
  var CAPTURE_MAX_PIXELS = ${DESIGN_BRIDGE_CAPTURE_MAX_PIXELS};
  var CAPTURE_PATH = ${JSON.stringify(DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH)};
  var DESIGN_TOKEN_NAMES = ${JSON.stringify(DESIGN_RUNTIME_TOKEN_NAMES)};
  var CAPTURE_MESSAGE_MAX_BYTES = Math.ceil(IMAGE_MAX_BYTES * 4 / 3) + SEMANTIC_MAX_BYTES + 4096;
  var installedKey = "__OPEN_BUILDER_DESIGN_BRIDGE_V1__";
  if (window[installedKey]) return;
  window[installedKey] = true;
  var nonce = null;
  var active = false;
  var parentOrigin = "*";
  var captureInFlight = false;
  var captureLibraryPromise = null;
  var overlay = document.createElement("div");
  overlay.setAttribute("data-ob-design-overlay", "");
  overlay.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #7c3aed;background:rgba(124,58,237,.08);border-radius:4px;box-shadow:0 0 0 1px rgba(255,255,255,.8);display:none;transition:all 60ms linear";
  document.documentElement.appendChild(overlay);

  function byteLength(value) {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
    catch (_) { return MAX_BYTES + 1; }
  }
  function clean(value, max) {
    if (typeof value !== "string") return "";
    return value.replace(/[\\u0000-\\u001f\\u007f<>]/g, " ").replace(/\\s+/g, " ").trim().slice(0, max);
  }
  function validId(value) {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
  }
  function finite(value, fallback) {
    return typeof value === "number" && isFinite(value) ? value : fallback;
  }
  function round(value) {
    return Math.round(finite(value, 0) * 100) / 100;
  }
  function imageBytes(dataUrl) {
    var comma = dataUrl.indexOf(",");
    if (comma < 0) return 0;
    var encoded = dataUrl.slice(comma + 1);
    var padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    return Math.floor(encoded.length * 3 / 4) - padding;
  }
  function isWebp(dataUrl) {
    if (typeof dataUrl !== "string" || dataUrl.indexOf("data:image/webp;base64,") !== 0) return false;
    try {
      var header = atob(dataUrl.slice(dataUrl.indexOf(",") + 1, dataUrl.indexOf(",") + 33));
      return header.slice(0, 4) === "RIFF" && header.slice(8, 12) === "WEBP";
    } catch (_) { return false; }
  }
  function targetFromEvent(event) {
    var element = event.target && event.target.closest ? event.target.closest("[data-ob-id]") : null;
    return element instanceof HTMLElement || element instanceof SVGElement ? element : null;
  }
  function show(element) {
    if (!element) { overlay.style.display = "none"; return; }
    var rect = element.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";
    overlay.style.width = Math.max(0, rect.width) + "px";
    overlay.style.height = Math.max(0, rect.height) + "px";
  }
  function send(type, payload) {
    var message = { type: type, version: VERSION, nonce: nonce };
    if (payload !== undefined) message.payload = payload;
    if (byteLength(message) <= MAX_BYTES) window.parent.postMessage(message, parentOrigin);
  }
  function sendCapture(message, origin) {
    if (byteLength(message) <= CAPTURE_MESSAGE_MAX_BYTES) {
      window.parent.postMessage(message, origin);
      return true;
    }
    return false;
  }
  function selection(element) {
    var aria = {};
    var ariaMap = {
      "aria-label": "label", "aria-labelledby": "labelledby",
      "aria-describedby": "describedby", "aria-pressed": "pressed",
      "aria-expanded": "expanded", "aria-selected": "selected", "aria-current": "current"
    };
    Object.keys(ariaMap).forEach(function (name) {
      var value = clean(element.getAttribute(name), 160);
      if (value) aria[ariaMap[name]] = value;
    });
    var attributes = {};
    ["role", "type", "name", "placeholder"].forEach(function (name) {
      var value = clean(element.getAttribute(name), 120);
      if (value) attributes[name] = value;
    });
    var text = clean(element.innerText || element.textContent || "", 240);
    var id = element.getAttribute("data-ob-id");
    if (!validId(id)) return null;
    return {
      protocolVersion: VERSION,
      elementId: id,
      label: aria.label || text || id,
      tagName: element.tagName.toLowerCase(),
      text: text || undefined,
      aria: Object.keys(aria).length ? aria : undefined,
      route: clean(window.location.pathname || "/", 256) || "/",
      attributes: Object.keys(attributes).length ? attributes : undefined
    };
  }
  function onMove(event) { if (active) show(targetFromEvent(event)); }
  function onClick(event) {
    if (!active) return;
    var target = targetFromEvent(event);
    if (!target) return;
    var payload = selection(target);
    if (!payload) return;
    event.preventDefault();
    event.stopPropagation();
    send("open-builder:design-bridge-selection", payload);
    active = false;
    show(null);
  }
  function onKey(event) {
    if (!active || event.key !== "Escape") return;
    event.preventDefault();
    send("open-builder:design-bridge-exit");
    active = false;
    show(null);
  }
  function nextPaint() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(resolve); });
    });
  }
  function waitForFonts() {
    if (!document.fonts || !document.fonts.ready) return Promise.resolve();
    return Promise.race([
      document.fonts.ready,
      new Promise(function (resolve) { setTimeout(resolve, 3000); })
    ]).then(function () {});
  }
  function loadCaptureLibrary(requestId) {
    if (window.htmlToImage && typeof window.htmlToImage.toCanvas === "function") {
      return Promise.resolve(window.htmlToImage);
    }
    if (captureLibraryPromise) return captureLibraryPromise;
    captureLibraryPromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      var timer = setTimeout(function () {
        script.remove();
        reject(new Error("Screenshot runtime timed out."));
      }, 8000);
      script.src = "/" + CAPTURE_PATH + "?request=" + encodeURIComponent(requestId);
      script.async = true;
      script.setAttribute("data-ob-design-capture-runtime", "");
      script.onload = function () {
        clearTimeout(timer);
        if (window.htmlToImage && typeof window.htmlToImage.toCanvas === "function") {
          resolve(window.htmlToImage);
        } else {
          script.remove();
          reject(new Error("Screenshot runtime did not initialize."));
        }
      };
      script.onerror = function () {
        clearTimeout(timer);
        script.remove();
        reject(new Error("Screenshot runtime could not be loaded."));
      };
      document.head.appendChild(script);
    }).catch(function (error) {
      captureLibraryPromise = null;
      throw error;
    });
    return captureLibraryPromise;
  }
  function accessibleName(element) {
    var labelledBy = clean(element.getAttribute("aria-labelledby"), 160);
    var labelledText = "";
    if (labelledBy) {
      labelledText = labelledBy.split(/\\s+/).map(function (id) {
        var label = document.getElementById(id);
        return label ? clean(label.textContent || "", 80) : "";
      }).filter(Boolean).join(" ");
    }
    return clean(
      element.getAttribute("aria-label") || labelledText ||
      element.getAttribute("alt") || element.getAttribute("placeholder") ||
      element.innerText || element.textContent || "",
      180
    );
  }
  function semanticElement(element) {
    var rect = element.getBoundingClientRect();
    var style = getComputedStyle(element);
    if (rect.width < 1 || rect.height < 1 || style.display === "none" || style.visibility === "hidden") return null;
    var value = {
      tagName: element.tagName.toLowerCase(),
      bounds: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) }
    };
    var role = clean(element.getAttribute("role"), 80);
    var name = accessibleName(element);
    var text = clean(element.innerText || element.textContent || "", 240);
    var elementId = clean(element.getAttribute("data-ob-id"), 128);
    if (role) value.role = role;
    if (name) value.name = name;
    if (text && text !== name) value.text = text;
    if (elementId && validId(elementId)) value.elementId = elementId;
    value.styles = {
      color: clean(style.color, 64),
      backgroundColor: clean(style.backgroundColor, 64),
      fontFamily: clean(style.fontFamily, 120),
      fontSize: clean(style.fontSize, 32),
      fontWeight: clean(style.fontWeight, 32)
    };
    return value;
  }
  function semanticSnapshot() {
    var root = document.documentElement;
    var rootStyle = getComputedStyle(root);
    var designTokens = { computed: {}, inline: {} };
    DESIGN_TOKEN_NAMES.forEach(function (name) {
      var computed = clean(rootStyle.getPropertyValue(name), 240);
      var inline = clean(root.style.getPropertyValue(name), 240);
      if (computed) designTokens.computed[name] = computed;
      if (inline) designTokens.inline[name] = inline;
    });
    var candidates = Array.prototype.slice.call(document.querySelectorAll(
      "main,header,nav,footer,section,h1,h2,h3,h4,h5,h6,button,a,input,select,textarea,[role],[data-ob-id]"
    ), 0, 120);
    var snapshot = {
      route: clean(window.location.pathname || "/", 256) || "/",
      title: clean(document.title || "", 200) || undefined,
      viewport: {
        width: Math.max(1, Math.round(window.innerWidth)),
        height: Math.max(1, Math.round(window.innerHeight)),
        devicePixelRatio: round(window.devicePixelRatio || 1)
      },
      document: {
        scrollWidth: Math.max(1, Math.round(root.scrollWidth)),
        scrollHeight: Math.max(1, Math.round(root.scrollHeight)),
        horizontalOverflow: root.scrollWidth > window.innerWidth + 1,
        fonts: document.fonts ? document.fonts.status === "loaded" ? "ready" : "loading" : "unsupported"
      },
      designTokens: designTokens,
      elements: candidates.map(semanticElement).filter(Boolean)
    };
    while (snapshot.elements.length && byteLength(snapshot) > SEMANTIC_MAX_BYTES) snapshot.elements.pop();
    if (byteLength(snapshot) > SEMANTIC_MAX_BYTES) throw new Error("Semantic preview state exceeded its size limit.");
    return snapshot;
  }
  async function capture(data, origin) {
    var captureNonce = data.nonce;
    var requestId = data.requestId;
    var viewport = data.viewport;
    var base = {
      version: VERSION,
      nonce: captureNonce,
      requestId: requestId
    };
    if (captureInFlight) throw new Error("A preview capture is already running.");
    captureInFlight = true;
    var scrollX = window.scrollX;
    var scrollY = window.scrollY;
    try {
      if (
        Math.abs(window.innerWidth - viewport.width) > 4 ||
        Math.abs(window.innerHeight - viewport.height) > 4
      ) {
        throw new Error("Preview viewport did not reach the requested size.");
      }
      var htmlToImage = await loadCaptureLibrary(requestId);
      await waitForFonts();
      window.scrollTo(0, 0);
      await nextPaint();
      var root = document.documentElement;
      var fullHeight = Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight);
      var captureHeight = Math.max(1, Math.min(
        fullHeight,
        CAPTURE_MAX_HEIGHT,
        Math.floor(CAPTURE_MAX_PIXELS / Math.max(1, window.innerWidth))
      ));
      var snapshot = semanticSnapshot();
      var canvas = await htmlToImage.toCanvas(root, {
        cacheBust: true,
        pixelRatio: 1,
        skipAutoScale: true,
        width: window.innerWidth,
        height: captureHeight,
        canvasWidth: window.innerWidth,
        canvasHeight: captureHeight,
        style: {
          width: window.innerWidth + "px",
          height: captureHeight + "px",
          margin: "0",
          overflow: "hidden"
        },
        filter: function (node) {
          return !(node && node.getAttribute && node.hasAttribute("data-ob-design-overlay"));
        }
      });
      var qualities = [0.82, 0.68, 0.52];
      var dataUrl = "";
      for (var index = 0; index < qualities.length; index += 1) {
        dataUrl = canvas.toDataURL("image/webp", qualities[index]);
        if (isWebp(dataUrl) && imageBytes(dataUrl) <= IMAGE_MAX_BYTES) break;
      }
      if (!isWebp(dataUrl)) throw new Error("This preview cannot encode WebP screenshots.");
      if (imageBytes(dataUrl) <= 0 || imageBytes(dataUrl) > IMAGE_MAX_BYTES) {
        throw new Error("Preview screenshot exceeded its size limit.");
      }
      var resultMessage = {
        type: "open-builder:design-bridge-capture-result",
        version: base.version,
        nonce: base.nonce,
        requestId: base.requestId,
        payload: {
          dataUrl: dataUrl,
          mimeType: "image/webp",
          viewport: {
            name: viewport.name,
            width: window.innerWidth,
            height: window.innerHeight,
            capturedHeight: captureHeight,
            fullHeight: fullHeight,
            truncated: captureHeight < fullHeight
          },
          semanticSnapshot: snapshot
        }
      };
      if (!sendCapture(resultMessage, origin)) throw new Error("Preview capture response exceeded its size limit.");
    } finally {
      window.scrollTo(scrollX, scrollY);
      captureInFlight = false;
    }
  }
  function captureError(data, origin, error) {
    sendCapture({
      type: "open-builder:design-bridge-capture-error",
      version: VERSION,
      nonce: data.nonce,
      requestId: data.requestId,
      error: clean(error && error.message ? error.message : String(error), 400) || "Preview capture failed."
    }, origin);
  }
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.version !== VERSION || byteLength(data) > MAX_BYTES || !validId(data.nonce)) return;
    var eventOrigin = event.origin && event.origin !== "null" ? event.origin : "*";
    if (data.type === "open-builder:design-bridge-capture") {
      if (!validId(data.requestId) || !data.viewport ||
          ["desktop", "tablet", "mobile"].indexOf(data.viewport.name) < 0 ||
          !Number.isInteger(data.viewport.width) || data.viewport.width < 240 || data.viewport.width > 2000) return;
      if (!Number.isInteger(data.viewport.height) || data.viewport.height < 240 || data.viewport.height > 2000) return;
      capture(data, eventOrigin).catch(function (error) { captureError(data, eventOrigin, error); });
      return;
    }
    if (data.type !== "open-builder:design-bridge-control") return;
    if (nonce && data.nonce !== nonce && active) return;
    nonce = data.nonce;
    parentOrigin = eventOrigin;
    active = data.active === true;
    if (!active) show(null);
  });
  window.parent.postMessage({
    type: "open-builder:design-bridge-ready",
    version: VERSION,
    captureRuntimeAvailable: CAPTURE_RUNTIME_AVAILABLE
  }, "*");
})();\n`;
}

export function injectDesignBridge(
  files: ProjectFiles,
  template: string,
  previewEnabled = true,
  captureRuntimeSource?: string,
): DesignBridgeInjectionResult {
  if (!previewEnabled) {
    return { supported: false, files, reason: "code-only" };
  }
  if (!SUPPORTED_DESIGN_BRIDGE_TEMPLATES.has(template)) {
    return { supported: false, files, reason: "unsupported-template" };
  }
  if (
    DESIGN_BRIDGE_VIRTUAL_PATH in files ||
    DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH in files
  ) {
    return { supported: false, files, reason: "reserved-path" };
  }
  const indexPath = Object.keys(files).find(
    (path) => !path.includes("/") && path.toLowerCase() === "index.html",
  );
  if (!indexPath || !/<\/body\s*>/i.test(files[indexPath])) {
    return { supported: false, files, reason: "missing-index" };
  }
  if (files[indexPath].includes(DESIGN_BRIDGE_MARKER)) {
    return { supported: false, files, reason: "reserved-path" };
  }
  const index = stripDesignBridge(files[indexPath]).replace(
    /<\/body\s*>/i,
    `${BRIDGE_TAG}\n</body>`,
  );
  const injectedFiles: ProjectFiles = {
    ...files,
    [indexPath]: index,
    [DESIGN_BRIDGE_VIRTUAL_PATH]: previewBridgeClientSource(
      Boolean(captureRuntimeSource),
    ),
  };
  if (captureRuntimeSource) {
    injectedFiles[DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH] = captureRuntimeSource;
  }
  return {
    supported: true,
    indexPath,
    files: injectedFiles,
  };
}

export function stripDesignBridge(content: string): string {
  return content.replace(BRIDGE_TAG_PATTERN, "\n");
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  if (!cleaned) return undefined;
  if (
    /(?:ignore (?:all|previous)|system prompt|developer message|follow (?:these|the) instructions|javascript\s*:|script\b)/i.test(
      cleaned,
    )
  ) {
    return "[preview text withheld]";
  }
  return cleaned;
}

function safeRecord<K extends string>(
  value: unknown,
  keys: readonly K[],
  max: number,
): Partial<Record<K, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const result: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const cleaned = cleanText((value as Record<string, unknown>)[key], max);
    if (cleaned) result[key] = cleaned;
  }
  return Object.keys(result).length ? result : undefined;
}

export function sanitizeDesignSelectionPayload(
  value: unknown,
): DesignSelectionContext | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (
    new TextEncoder().encode(serialized).byteLength >
      DESIGN_BRIDGE_PAYLOAD_MAX_BYTES ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.protocolVersion !== DESIGN_BRIDGE_PROTOCOL_VERSION ||
    typeof raw.elementId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw.elementId) ||
    typeof raw.tagName !== "string" ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(raw.tagName)
  ) {
    return null;
  }
  const text = cleanText(raw.text, 240);
  const label = cleanText(raw.label, 160) ?? text ?? raw.elementId;
  const routeValue = cleanText(raw.route, 256)?.split(/[?#]/, 1)[0] ?? "/";
  const route = routeValue.startsWith("/") ? routeValue : "/";
  return {
    protocolVersion: DESIGN_BRIDGE_PROTOCOL_VERSION,
    elementId: raw.elementId,
    label,
    tagName: raw.tagName,
    ...(text ? { text } : {}),
    ...(safeRecord(
      raw.aria,
      [
        "label",
        "labelledby",
        "describedby",
        "pressed",
        "expanded",
        "selected",
        "current",
      ] as const,
      160,
    )
      ? {
          aria: safeRecord(
            raw.aria,
            [
              "label",
              "labelledby",
              "describedby",
              "pressed",
              "expanded",
              "selected",
              "current",
            ] as const,
            160,
          ),
        }
      : {}),
    route,
    ...(safeRecord(
      raw.attributes,
      ["role", "type", "name", "placeholder"] as const,
      120,
    )
      ? {
          attributes: safeRecord(
            raw.attributes,
            ["role", "type", "name", "placeholder"] as const,
            120,
          ),
        }
      : {}),
  };
}

function jsonByteLength(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function safeFiniteNumber(
  value: unknown,
  min: number,
  max: number,
  integer = false,
): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    return null;
  }
  return integer ? Math.round(value) : Math.round(value * 100) / 100;
}

function sanitizeSemanticSnapshot(
  value: unknown,
): DesignPreviewSemanticSnapshot | null {
  const size = jsonByteLength(value);
  if (
    size === null ||
    size > DESIGN_BRIDGE_SEMANTIC_MAX_BYTES ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    !raw.viewport ||
    typeof raw.viewport !== "object" ||
    Array.isArray(raw.viewport) ||
    !raw.document ||
    typeof raw.document !== "object" ||
    Array.isArray(raw.document) ||
    !Array.isArray(raw.elements) ||
    raw.elements.length > 120
  ) {
    return null;
  }
  const viewport = raw.viewport as Record<string, unknown>;
  const documentState = raw.document as Record<string, unknown>;
  const viewportWidth = safeFiniteNumber(viewport.width, 1, 10_000, true);
  const viewportHeight = safeFiniteNumber(viewport.height, 1, 10_000, true);
  const devicePixelRatio = safeFiniteNumber(viewport.devicePixelRatio, 0.1, 10);
  const scrollWidth = safeFiniteNumber(
    documentState.scrollWidth,
    1,
    1_000_000,
    true,
  );
  const scrollHeight = safeFiniteNumber(
    documentState.scrollHeight,
    1,
    1_000_000,
    true,
  );
  if (
    viewportWidth === null ||
    viewportHeight === null ||
    devicePixelRatio === null ||
    scrollWidth === null ||
    scrollHeight === null ||
    typeof documentState.horizontalOverflow !== "boolean" ||
    !["ready", "loading", "unsupported"].includes(String(documentState.fonts))
  ) {
    return null;
  }

  const elements: DesignPreviewSemanticElement[] = [];
  for (const candidate of raw.elements) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const element = candidate as Record<string, unknown>;
    const tagName = cleanText(element.tagName, 32);
    const boundsValue = element.bounds;
    if (
      !tagName ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(tagName) ||
      !boundsValue ||
      typeof boundsValue !== "object" ||
      Array.isArray(boundsValue)
    ) {
      return null;
    }
    const rawBounds = boundsValue as Record<string, unknown>;
    const x = safeFiniteNumber(rawBounds.x, -1_000_000, 1_000_000);
    const y = safeFiniteNumber(rawBounds.y, -1_000_000, 1_000_000);
    const width = safeFiniteNumber(rawBounds.width, 0, 1_000_000);
    const height = safeFiniteNumber(rawBounds.height, 0, 1_000_000);
    if (x === null || y === null || width === null || height === null) {
      return null;
    }
    const elementId = cleanText(element.elementId, 128);
    const styles = safeRecord(
      element.styles,
      [
        "color",
        "backgroundColor",
        "fontFamily",
        "fontSize",
        "fontWeight",
      ] as const,
      120,
    );
    elements.push({
      tagName,
      ...(cleanText(element.role, 80)
        ? { role: cleanText(element.role, 80) }
        : {}),
      ...(cleanText(element.name, 180)
        ? { name: cleanText(element.name, 180) }
        : {}),
      ...(cleanText(element.text, 240)
        ? { text: cleanText(element.text, 240) }
        : {}),
      ...(elementId && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(elementId)
        ? { elementId }
        : {}),
      bounds: { x, y, width, height },
      ...(styles ? { styles } : {}),
    });
  }

  const routeValue = cleanText(raw.route, 256)?.split(/[?#]/, 1)[0] ?? "/";
  let designTokens: DesignPreviewSemanticSnapshot["designTokens"];
  if (raw.designTokens !== undefined) {
    if (
      !raw.designTokens ||
      typeof raw.designTokens !== "object" ||
      Array.isArray(raw.designTokens)
    ) {
      return null;
    }
    const rawTokens = raw.designTokens as Record<string, unknown>;
    const sanitizeTokenMap = (
      value: unknown,
    ): Record<string, string> | null => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const result: Record<string, string> = {};
      for (const token of DESIGN_RUNTIME_TOKEN_NAMES) {
        const cleaned = cleanText(
          (value as Record<string, unknown>)[token],
          240,
        );
        if (cleaned) result[token] = cleaned;
      }
      return result;
    };
    const computed = sanitizeTokenMap(rawTokens.computed);
    const inline = sanitizeTokenMap(rawTokens.inline);
    if (!computed || !inline) return null;
    designTokens = { computed, inline };
  }
  const snapshot: DesignPreviewSemanticSnapshot = {
    route: routeValue.startsWith("/") ? routeValue : "/",
    ...(cleanText(raw.title, 200) ? { title: cleanText(raw.title, 200) } : {}),
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      devicePixelRatio,
    },
    document: {
      scrollWidth,
      scrollHeight,
      horizontalOverflow: documentState.horizontalOverflow,
      fonts: String(
        documentState.fonts,
      ) as DesignPreviewSemanticSnapshot["document"]["fonts"],
    },
    ...(designTokens ? { designTokens } : {}),
    elements,
  };
  return (jsonByteLength(snapshot) ?? Infinity) <=
    DESIGN_BRIDGE_SEMANTIC_MAX_BYTES
    ? snapshot
    : null;
}

function webpMetadata(
  dataUrl: string,
): { bytes: number; width: number; height: number } | null {
  const match = /^data:image\/webp;base64,([A-Za-z0-9+/]*={0,2})$/.exec(
    dataUrl,
  );
  if (!match) return null;
  let header: string;
  try {
    header = atob(match[1].slice(0, 64));
  } catch {
    return null;
  }
  if (
    header.length < 30 ||
    header.slice(0, 4) !== "RIFF" ||
    header.slice(8, 12) !== "WEBP"
  ) {
    return null;
  }
  const byte = (index: number) => header.charCodeAt(index);
  const chunk = header.slice(12, 16);
  let width: number;
  let height: number;
  if (chunk === "VP8X") {
    width = 1 + byte(24) + byte(25) * 256 + byte(26) * 65_536;
    height = 1 + byte(27) + byte(28) * 256 + byte(29) * 65_536;
  } else if (chunk === "VP8L" && byte(20) === 0x2f) {
    width = 1 + byte(21) + ((byte(22) & 0x3f) << 8);
    height = 1 + (byte(22) >> 6) + (byte(23) << 2) + ((byte(24) & 0x0f) << 10);
  } else if (
    chunk === "VP8 " &&
    byte(23) === 0x9d &&
    byte(24) === 0x01 &&
    byte(25) === 0x2a
  ) {
    width = (byte(26) + byte(27) * 256) & 0x3fff;
    height = (byte(28) + byte(29) * 256) & 0x3fff;
  } else {
    return null;
  }
  const padding = match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0;
  return {
    bytes: Math.floor((match[1].length * 3) / 4) - padding,
    width,
    height,
  };
}

export function parseDesignBridgeCaptureResponse(
  value: unknown,
  expected: DesignBridgeCaptureExpectation,
): DesignBridgeCaptureResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== DESIGN_BRIDGE_PROTOCOL_VERSION ||
    raw.nonce !== expected.nonce ||
    raw.requestId !== expected.requestId
  ) {
    return null;
  }
  if (raw.type === "open-builder:design-bridge-capture-error") {
    const size = jsonByteLength(raw);
    const error = cleanText(raw.error, 400);
    return size !== null && size <= DESIGN_BRIDGE_PAYLOAD_MAX_BYTES && error
      ? { ok: false, error }
      : null;
  }
  if (raw.type !== "open-builder:design-bridge-capture-result") return null;
  const messageSize = jsonByteLength(raw);
  if (
    messageSize === null ||
    messageSize > DESIGN_BRIDGE_CAPTURE_MESSAGE_MAX_BYTES ||
    !raw.payload ||
    typeof raw.payload !== "object" ||
    Array.isArray(raw.payload)
  ) {
    return null;
  }
  const payload = raw.payload as Record<string, unknown>;
  if (
    typeof payload.dataUrl !== "string" ||
    payload.mimeType !== "image/webp" ||
    !payload.viewport ||
    typeof payload.viewport !== "object" ||
    Array.isArray(payload.viewport)
  ) {
    return null;
  }
  const image = webpMetadata(payload.dataUrl);
  const viewport = payload.viewport as Record<string, unknown>;
  const width = safeFiniteNumber(viewport.width, 1, 10_000, true);
  const height = safeFiniteNumber(viewport.height, 1, 10_000, true);
  const capturedHeight = safeFiniteNumber(
    viewport.capturedHeight,
    1,
    DESIGN_BRIDGE_CAPTURE_MAX_HEIGHT,
    true,
  );
  const fullHeight = safeFiniteNumber(viewport.fullHeight, 1, 1_000_000, true);
  const semanticSnapshot = sanitizeSemanticSnapshot(payload.semanticSnapshot);
  if (
    image === null ||
    image.bytes <= 0 ||
    image.bytes > DESIGN_BRIDGE_CAPTURE_MAX_BYTES ||
    image.width > 2_000 ||
    image.height > DESIGN_BRIDGE_CAPTURE_MAX_HEIGHT ||
    image.width * image.height > DESIGN_BRIDGE_CAPTURE_MAX_PIXELS ||
    viewport.name !== expected.viewportName ||
    width === null ||
    Math.abs(width - expected.viewportWidth) > 4 ||
    height === null ||
    Math.abs(height - expected.viewportHeight) > 4 ||
    capturedHeight === null ||
    fullHeight === null ||
    typeof viewport.truncated !== "boolean" ||
    !semanticSnapshot ||
    Math.abs(image.width - expected.viewportWidth) > 4 ||
    image.width !== width ||
    image.height !== capturedHeight ||
    semanticSnapshot.viewport.width !== width ||
    semanticSnapshot.viewport.height !== height
  ) {
    return null;
  }
  return {
    ok: true,
    result: {
      dataUrl: payload.dataUrl,
      mimeType: "image/webp",
      viewport: {
        name: expected.viewportName,
        width,
        height,
        capturedHeight,
        fullHeight,
        truncated: viewport.truncated,
      },
      semanticSnapshot,
    },
  };
}

export function getDesignBridgeTargetOrigin(
  iframeSource: string,
  parentLocation: string,
): string | null {
  try {
    const origin = new URL(iframeSource, parentLocation).origin;
    return origin && origin !== "null" ? origin : "*";
  } catch {
    return null;
  }
}

export function isDesignBridgeOriginAllowed(
  iframeSource: string,
  parentLocation: string,
  eventOrigin: string,
): boolean {
  const expected = getDesignBridgeTargetOrigin(iframeSource, parentLocation);
  return expected !== null && (expected === "*" || eventOrigin === expected);
}

export function createDesignBridgeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
