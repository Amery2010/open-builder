import { SANDBOX_TEMPLATES } from "@codesandbox/sandpack-react";
import { prototypeHashRoutePolicySource } from "./prototype-route";
import {
  inspectImageBytes,
  type CompressibleImageMimeType,
} from "../images/formats";
import { readScreenshotImage } from "../images/screenshot";
import type { DesignSelectionContext, ProjectFiles } from "../../types";
import { EDITABLE_DESIGN_TOKENS } from "./tokens";
import {
  isSafePrototypePreviewRoute,
  prototypePreviewTargetsEqual,
  sanitizePrototypePreviewTarget,
  sanitizePreviewCaptureGeometry,
  PROTOTYPE_PREVIEW_ROUTE_MAX_LENGTH,
  type PrototypePreviewTarget,
  type PreviewCaptureGeometry,
  type PreviewCaptureOptions,
} from "./preview-runtime";
export type { PrototypePreviewTarget } from "./preview-runtime";
export {
  isSafePrototypePreviewRoute,
  prototypePreviewTargetsEqual,
  sanitizePrototypePreviewTarget,
  PROTOTYPE_PREVIEW_ID_MAX_LENGTH,
  PROTOTYPE_PREVIEW_ROUTE_MAX_LENGTH,
} from "./preview-runtime";
export { formatDesignSelectionForModel } from "./selection-context";

export const DESIGN_BRIDGE_PROTOCOL_VERSION = 2 as const;
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
export const DESIGN_BRIDGE_TIMEOUT_ATTEMPTS = 3;
export const DESIGN_BRIDGE_VIRTUAL_PATH = "__open_builder_design_bridge__.js";
export const DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH =
  "__open_builder_html_to_image__.js";
export const DESIGN_CAPTURE_RUNTIME_GLOBAL =
  "__OPEN_BUILDER_CAPTURE_RUNTIME_V1__";
export const DESIGN_BRIDGE_MARKER = "open-builder-design-bridge";
export const DESIGN_RUNTIME_TOKEN_NAMES = EDITABLE_DESIGN_TOKENS.map(
  (token) => token.property,
);

const SCRIPT_ENTRY_TEMPLATES = new Set([
  "react",
  "react-ts",
  "vue",
  "vue-ts",
  "svelte",
  "solid",
  "angular",
  "vanilla",
  "vanilla-ts",
]);

export const SUPPORTED_DESIGN_BRIDGE_TEMPLATES = new Set([
  "static",
  "vite",
  "vite-react",
  "vite-react-ts",
  "vite-preact",
  "vite-preact-ts",
  "vite-vue",
  "vite-vue-ts",
  "vite-svelte",
  "vite-svelte-ts",
  ...SCRIPT_ENTRY_TEMPLATES,
]);

function bridgeTags(includeCaptureRuntime: boolean): string {
  const runtime = includeCaptureRuntime
    ? `<script src="/${DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH}" data-ob-design-capture-runtime></script>\n`
    : "";
  return `<!-- ${DESIGN_BRIDGE_MARKER}:start -->\n${runtime}<script src="/${DESIGN_BRIDGE_VIRTUAL_PATH}" data-ob-design-bridge></script>\n<!-- ${DESIGN_BRIDGE_MARKER}:end -->`;
}
const BRIDGE_TAG_PATTERN = new RegExp(
  `\\s*<!-- ${DESIGN_BRIDGE_MARKER}:start -->[\\s\\S]*?<!-- ${DESIGN_BRIDGE_MARKER}:end -->\\s*`,
  "g",
);

export interface DesignBridgeInjectionResult {
  supported: boolean;
  files: ProjectFiles;
  indexPath?: string;
  restore: (path: string, content: string) => string | undefined;
  reason?:
    | "code-only"
    | "unsupported-template"
    | "missing-index"
    | "missing-entry"
    | "reserved-path";
}

export type DesignReviewViewportName = "desktop" | "tablet" | "mobile";

export function isPreviewViewportSize(
  name: DesignReviewViewportName,
  width: number,
  height: number,
): boolean {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 240 ||
    width > 2000 ||
    height < 240 ||
    height > 2000
  )
    return false;
  if (name === "mobile") return width < 768;
  if (name === "tablet") return width >= 768 && width < 1024;
  return name === "desktop" && width >= 1024;
}

export function designBridgeRuntimeRevision(
  generation: string,
  captureRuntimeAvailable: boolean,
): string {
  return `${generation}:10:${captureRuntimeAvailable ? "capture" : "selection"}`;
}

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
  accessibility?: {
    interactive: boolean;
    focusable: boolean;
    disabled: boolean;
    tabIndex: number;
    nameSource:
      | "aria-label"
      | "aria-labelledby"
      | "label"
      | "alt"
      | "placeholder"
      | "text"
      | "none";
    imageAlt?: "missing" | "empty" | "named";
  };
}

export interface DesignPreviewSemanticSnapshot {
  route: string;
  /** Identity supplied by the host when a prototype target is captured. */
  prototypeIdentity?: PrototypePreviewTarget;
  /** @deprecated Use prototypeIdentity. Kept for fixture/adaptor compatibility. */
  prototype?: PrototypePreviewTarget;
  title?: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  document: {
    scrollWidth: number;
    scrollHeight: number;
    horizontalOverflow: boolean;
    fonts: "ready" | "loading" | "unsupported";
    language?: string;
  };
  designTokens?: {
    computed: Record<string, string>;
    inline: Record<string, string>;
  };
  elements: DesignPreviewSemanticElement[];
}

export interface DesignBridgeCaptureResult {
  generation: string;
  dataUrl: string;
  capture?: PreviewCaptureGeometry;
  mimeType: CompressibleImageMimeType;
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

export interface DesignBridgeAnnotationCaptureResult extends Omit<
  DesignBridgeCaptureResult,
  "dataUrl" | "capture"
> {
  blob: Blob;
  capture: PreviewCaptureGeometry;
}

export type DesignBridgeAnnotationResponse =
  | { ok: true; result: DesignBridgeAnnotationCaptureResult }
  | { ok: false; error: string };

export interface DesignBridgeCaptureExpectation extends PreviewCaptureOptions {
  generation: string;
  nonce: string;
  requestId: string;
  viewportName: DesignReviewViewportName;
  viewportWidth: number;
  viewportHeight: number;
  target?: PrototypePreviewTarget;
  currentViewport?: boolean;
}

export interface DesignBridgeNavigationExpectation {
  generation: string;
  nonce: string;
  requestId: string;
  target: PrototypePreviewTarget;
}

export interface DesignBridgeNavigationRequest {
  type: "open-builder:design-bridge-navigate";
  version: number;
  generation: string;
  nonce: string;
  requestId: string;
  target: PrototypePreviewTarget;
}

export interface DesignBridgeDataResetRequest {
  type: "open-builder:design-bridge-reset-data";
  version: number;
  generation: string;
  nonce: string;
}

export type DesignBridgeNavigationResponse =
  | {
      ok: true;
      target: PrototypePreviewTarget;
      route: string;
    }
  | { ok: false; error: string };

export type DesignBridgeCaptureResponse =
  | { ok: true; result: DesignBridgeCaptureResult }
  | { ok: false; error: string };

export type DesignBridgeParentMessage =
  | DesignBridgeNavigationRequest
  | DesignBridgeDataResetRequest
  | {
      type: "open-builder:design-bridge-ready";
      version: number;
      generation: string;
      captureRuntimeAvailable: boolean;
      runtimeRevision: string;
      nonce?: string;
      route: string;
    }
  | {
      type: "open-builder:design-bridge-route";
      version: number;
      generation: string;
      route: string;
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
      type:
        | "open-builder:design-bridge-capture-result"
        | "open-builder:design-bridge-annotation-result";
      version: number;
      generation: string;
      nonce: string;
      requestId: string;
      payload: unknown;
    }
  | {
      type: "open-builder:design-bridge-capture-error";
      version: number;
      generation: string;
      nonce: string;
      requestId: string;
      error: unknown;
    }
  | {
      type: "open-builder:design-bridge-navigation-result";
      version: number;
      generation: string;
      nonce: string;
      requestId: string;
      payload: unknown;
    }
  | {
      type: "open-builder:design-bridge-navigation-error";
      version: number;
      generation: string;
      nonce: string;
      requestId: string;
      error: unknown;
    };

function previewBridgeClientSource(
  captureRuntimeAvailable: boolean,
  generation: string,
): string {
  return `(function () {
  "use strict";
  var VERSION = ${DESIGN_BRIDGE_PROTOCOL_VERSION};
  var GENERATION = ${JSON.stringify(generation)};
  var CAPTURE_RUNTIME_AVAILABLE = ${JSON.stringify(captureRuntimeAvailable)};
  var RUNTIME_REVISION = ${JSON.stringify(designBridgeRuntimeRevision(generation, captureRuntimeAvailable))};
  var viewportSizeMatches = ${isPreviewViewportSize.toString()};
  var MAX_BYTES = ${DESIGN_BRIDGE_PAYLOAD_MAX_BYTES};
  var SEMANTIC_MAX_BYTES = ${DESIGN_BRIDGE_SEMANTIC_MAX_BYTES};
  var IMAGE_MAX_BYTES = ${DESIGN_BRIDGE_CAPTURE_MAX_BYTES};
  var CAPTURE_MAX_HEIGHT = ${DESIGN_BRIDGE_CAPTURE_MAX_HEIGHT};
  var CAPTURE_MAX_PIXELS = ${DESIGN_BRIDGE_CAPTURE_MAX_PIXELS};
  var CAPTURE_RUNTIME_KEY = ${JSON.stringify(DESIGN_CAPTURE_RUNTIME_GLOBAL)};
  var DESIGN_TOKEN_NAMES = ${JSON.stringify(DESIGN_RUNTIME_TOKEN_NAMES)};
  var PROTOTYPE_ROUTE_MAX_LENGTH = ${PROTOTYPE_PREVIEW_ROUTE_MAX_LENGTH};
  var CAPTURE_MESSAGE_MAX_BYTES = Math.ceil(IMAGE_MAX_BYTES * 4 / 3) + SEMANTIC_MAX_BYTES + 4096;
  var installedKey = "__OPEN_BUILDER_DESIGN_BRIDGE_V1__";
  var previous = window[installedKey];
  if (previous && previous.revision === RUNTIME_REVISION) { previous.announce(); return; }
  if (previous && typeof previous.dispose === "function") previous.dispose();
  var disposed = false;
  var nonce = null;
  var active = false;
  var parentOrigin = "*";
  var captureInFlight = false;
  var activeCapture = null;
  var navigationInFlight = false;
  var runtimeIds = new WeakMap();
  var runtimeIdCounter = 0;
  var MAX_LOCATOR_DEPTH = 12;
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
  var safeHashRoute = ${prototypeHashRoutePolicySource()};
  function safePrototypeTarget(value) {
    return !!value && typeof value === "object" && validId(value.pageId) && safeHashRoute(value.route) && !("scenarioId" in value);
  }
  function samePrototypeTarget(left, right) {
    return safePrototypeTarget(left) && safePrototypeTarget(right) &&
      left.pageId === right.pageId && left.route === right.route;
  }
  function previewRoute() {
    var hash = typeof window.location.hash === "string" ? window.location.hash : "";
    if (safeHashRoute(hash)) return hash;
    return clean(window.location.pathname || "/", PROTOTYPE_ROUTE_MAX_LENGTH) || "/";
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
  function imageType(dataUrl) {
    if (typeof dataUrl !== "string") return null;
    var match = new RegExp("^data:[^;,]*;base64,", "i").exec(dataUrl);
    if (!match) return null;
    try {
      var header = atob(dataUrl.slice(match[0].length, match[0].length + 32));
      if (header.slice(0, 4) === "RIFF" && header.slice(8, 12) === "WEBP") return "image/webp";
      if (header.charCodeAt(0) === 137 && header.slice(1, 4) === "PNG") return "image/png";
      if (header.charCodeAt(0) === 255 && header.charCodeAt(1) === 216) return "image/jpeg";
    } catch (_) {}
    return null;
  }
  function encodeCapture(canvas) {
    var qualities = [0.82, 0.68, 0.52];
    var candidate = "";
    var png = "";
    for (var index = 0; index < qualities.length; index += 1) {
      candidate = canvas.toDataURL("image/webp", qualities[index]);
      var type = imageType(candidate);
      if (type !== "image/webp") { if (type === "image/png") png = candidate; break; }
      if (imageBytes(candidate) > 0 && imageBytes(candidate) <= IMAGE_MAX_BYTES) return { dataUrl: candidate, mimeType: type };
    }
    png = png || canvas.toDataURL("image/png");
    if (imageType(png) === "image/png" && imageBytes(png) > 0 && imageBytes(png) <= IMAGE_MAX_BYTES) return { dataUrl: png, mimeType: "image/png" };
    for (var index = 0; index < qualities.length; index += 1) {
      candidate = canvas.toDataURL("image/jpeg", qualities[index]);
      if (imageType(candidate) === "image/jpeg" && imageBytes(candidate) > 0 && imageBytes(candidate) <= IMAGE_MAX_BYTES) return { dataUrl: candidate, mimeType: "image/jpeg" };
    }
    throw new Error("Preview screenshot could not be encoded within its size limit.");
  }
  function explicitId(element) {
    var value = element && element.getAttribute ? element.getAttribute("data-ob-id") : null;
    return validId(value) ? value : null;
  }
  function isSelectable(element) {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false;
    if (element === document.documentElement || element === document.body) return false;
    if (element.closest("[data-ob-design-overlay]")) return false;
    if (["script", "style", "template", "meta", "link"].indexOf(element.tagName.toLowerCase()) >= 0) return false;
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
    var rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      style.visibility !== "collapse" && style.pointerEvents !== "none";
  }
  function targetFromEvent(event) {
    var direct = event.target;
    if (!(direct instanceof HTMLElement || direct instanceof SVGElement)) return null;
    if (direct.closest("[data-ob-design-overlay]")) return null;
    if (explicitId(direct) && isSelectable(direct)) return direct;
    var tagName = direct.tagName.toLowerCase();
    if (["svg", "path", "span"].indexOf(tagName) >= 0) {
      var control = direct.closest("button,a[href],input,select,textarea,summary,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='switch'],[role='tab'],[role='menuitem'],[contenteditable='true']");
      if (control && isSelectable(control)) return control;
    }
    return isSelectable(direct) ? direct : null;
  }
  function runtimeId(element) {
    var current = runtimeIds.get(element);
    if (current) return current;
    do {
      runtimeIdCounter += 1;
      current = "runtime-" + runtimeIdCounter.toString(36);
    } while (document.querySelector('[data-ob-id="' + current + '"]'));
    runtimeIds.set(element, current);
    return current;
  }
  function locatorFor(element) {
    var anchor = element.parentElement;
    while (anchor && anchor !== document.body && !explicitId(anchor)) anchor = anchor.parentElement;
    if (!anchor) return null;
    var path = [];
    var current = element;
    while (current && current !== anchor) {
      var tagName = current.tagName.toLowerCase();
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(tagName) || path.length >= MAX_LOCATOR_DEPTH) return null;
      var nthOfType = 1;
      var sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) nthOfType += 1;
        sibling = sibling.previousElementSibling;
      }
      path.unshift({ tagName: tagName, nthOfType: nthOfType });
      current = current.parentElement;
    }
    if (!path.length || current !== anchor) return null;
    return {
      anchorElementId: anchor === document.body ? undefined : explicitId(anchor) || undefined,
      sourceLocator: { path: path }
    };
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
    if (!disposed && byteLength(message) <= MAX_BYTES) window.parent.postMessage(message, parentOrigin);
  }
  function sendCapture(message, origin) {
    if (!disposed && byteLength(message) <= CAPTURE_MESSAGE_MAX_BYTES) {
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
    var explicit = explicitId(element);
    var id = explicit || runtimeId(element);
    var locator = explicit ? null : locatorFor(element);
    if (!validId(id) || (!explicit && !locator)) return null;
    return {
      protocolVersion: VERSION,
      elementId: id,
      idSource: explicit ? "explicit" : "runtime",
      anchorElementId: locator ? locator.anchorElementId : undefined,
      sourceLocator: locator ? locator.sourceLocator : undefined,
      label: aria.label || accessibleName(element) || text || id,
      tagName: element.tagName.toLowerCase(),
      text: text || undefined,
      aria: Object.keys(aria).length ? aria : undefined,
      route: previewRoute(),
      attributes: Object.keys(attributes).length ? attributes : undefined
    };
  }
  function selectionFromEvent(event) {
    var element = targetFromEvent(event);
    if (!element) return null;
    var payload = selection(element);
    return payload ? { element: element, payload: payload } : null;
  }
  function onMove(event) {
    if (!active) return;
    var resolved = selectionFromEvent(event);
    show(resolved ? resolved.element : null);
  }
  function onClick(event) {
    if (!active) return;
    var resolved = selectionFromEvent(event);
    if (!resolved) return;
    event.preventDefault();
    event.stopPropagation();
    send("open-builder:design-bridge-selection", resolved.payload);
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
      var settled = false;
      var frameId = 0;
      // Browsers may suspend animation frames in an offscreen preview iframe.
      var timer = setTimeout(finish, 100);
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelAnimationFrame(frameId);
        resolve();
      }
      frameId = requestAnimationFrame(function () {
        frameId = requestAnimationFrame(finish);
      });
    });
  }
  function stableViewport(name, signal) {
    return new Promise(function (resolve, reject) {
      var previous = null;
      var frameId = 0;
      var sampleTimer = 0;
      var settled = false;
      var timer = setTimeout(function () { finish(new Error("Preview viewport did not stabilize: " + window.innerWidth + "x" + window.innerHeight + ".")); }, 5000);
      function finish(error, size) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(sampleTimer);
        cancelAnimationFrame(frameId);
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(size);
      }
      function abort() { finish(signal.reason); }
      function check() {
        if (settled) return;
        clearTimeout(sampleTimer);
        cancelAnimationFrame(frameId);
        if (signal.aborted) { abort(); return; }
        var size = { width: window.innerWidth, height: window.innerHeight };
        if (viewportSizeMatches(name, size.width, size.height) && previous && previous.width === size.width && previous.height === size.height) {
          finish(null, size);
          return;
        }
        previous = size;
        schedule();
      }
      function schedule() {
        sampleTimer = setTimeout(check, 50);
        frameId = requestAnimationFrame(check);
      }
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      schedule();
    });
  }
  function waitForFonts() {
    if (!document.fonts || !document.fonts.ready) return Promise.resolve();
    return Promise.race([
      document.fonts.ready,
      new Promise(function (resolve) { setTimeout(resolve, 3000); })
    ]).then(function () {});
  }
  function captureRuntime() {
    var runtime = window[CAPTURE_RUNTIME_KEY];
    return CAPTURE_RUNTIME_AVAILABLE && runtime && typeof runtime.toCanvas === "function" ? runtime : null;
  }
  function loadCaptureLibrary() {
    var runtime = captureRuntime();
    return runtime ? Promise.resolve(runtime) : Promise.reject(new Error("Screenshot runtime is unavailable in this preview."));
  }
  function accessibleNameInfo(element) {
    var labelledBy = clean(element.getAttribute("aria-labelledby"), 160);
    var labelledText = "";
    if (labelledBy) {
      labelledText = labelledBy.split(/\\s+/).map(function (id) {
        var label = document.getElementById(id);
        return label ? clean(label.textContent || "", 80) : "";
      }).filter(Boolean).join(" ");
    }
    var associatedLabel = element.labels ? Array.prototype.map.call(element.labels, function (label) {
      return clean(label.textContent || "", 80);
    }).filter(Boolean).join(" ") : "";
    var candidates = [
      ["aria-label", element.getAttribute("aria-label")],
      ["aria-labelledby", labelledText],
      ["label", associatedLabel],
      ["alt", element.getAttribute("alt")],
      ["placeholder", element.getAttribute("placeholder")],
      ["text", element.innerText || element.textContent || ""]
    ];
    for (var index = 0; index < candidates.length; index += 1) {
      var value = clean(candidates[index][1], 180);
      if (value) return { name: value, source: candidates[index][0] };
    }
    return { name: "", source: "none" };
  }
  function accessibleName(element) {
    return accessibleNameInfo(element).name;
  }
  function accessibilityInfo(element) {
    var tagName = element.tagName.toLowerCase();
    var role = clean(element.getAttribute("role"), 80).toLowerCase();
    var inputType = clean(element.getAttribute("type"), 40).toLowerCase();
    var nativeInteractive =
      tagName === "button" || tagName === "select" || tagName === "textarea" ||
      tagName === "summary" || (tagName === "input" && inputType !== "hidden") ||
      ((tagName === "a" || tagName === "area") && element.hasAttribute("href"));
    var interactiveRoles = [
      "button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
      "option", "slider", "spinbutton", "textbox", "combobox"
    ];
    var contentEditable = element.getAttribute("contenteditable") === "true";
    var interactive = nativeInteractive || contentEditable || interactiveRoles.indexOf(role) >= 0;
    var disabled = element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
    var tabIndex = typeof element.tabIndex === "number" ? element.tabIndex : -1;
    var explicitTabIndex = element.hasAttribute("tabindex");
    var focusable = !disabled && (tabIndex >= 0 || (!explicitTabIndex && (nativeInteractive || contentEditable)));
    var nameInfo = accessibleNameInfo(element);
    var imageAlt;
    if (tagName === "img") {
      imageAlt = !element.hasAttribute("alt") ? "missing" : clean(element.getAttribute("alt"), 180) ? "named" : "empty";
    }
    return {
      interactive: interactive,
      focusable: focusable,
      disabled: disabled,
      tabIndex: tabIndex,
      nameSource: nameInfo.source,
      imageAlt: imageAlt
    };
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
    value.accessibility = accessibilityInfo(element);
    return value;
  }
  function semanticSnapshot(prototypeIdentity, actualWidth, actualHeight) {
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
      "main,header,nav,footer,section,h1,h2,h3,h4,h5,h6,button,a,area,input,select,textarea,summary,img,[role],[tabindex],[contenteditable='true'],[data-ob-id]"
    ), 0, 120);
    var snapshot = {
      route: previewRoute(),
      title: clean(document.title || "", 200) || undefined,
      viewport: {
        width: actualWidth,
        height: actualHeight,
        devicePixelRatio: round(window.devicePixelRatio || 1)
      },
      document: {
        scrollWidth: Math.max(1, Math.round(root.scrollWidth)),
        scrollHeight: Math.max(1, Math.round(root.scrollHeight)),
        horizontalOverflow: root.scrollWidth > actualWidth + 1,
        fonts: document.fonts ? document.fonts.status === "loaded" ? "ready" : "loading" : "unsupported",
        language: clean(root.getAttribute("lang"), 35) || undefined
      },
      designTokens: designTokens,
      prototypeIdentity: safePrototypeTarget(prototypeIdentity) ? {
        pageId: prototypeIdentity.pageId,
        route: prototypeIdentity.route
      } : undefined,
      elements: candidates.map(semanticElement).filter(Boolean)
    };
    while (snapshot.elements.length && byteLength(snapshot) > SEMANTIC_MAX_BYTES) snapshot.elements.pop();
    if (byteLength(snapshot) > SEMANTIC_MAX_BYTES) throw new Error("Semantic preview state exceeded its size limit.");
    return snapshot;
  }
  function sendNavigationResult(data, origin, route) {
    var message = {
      type: "open-builder:design-bridge-navigation-result",
      version: VERSION,
      generation: GENERATION,
      nonce: data.nonce,
      requestId: data.requestId,
      payload: {
        target: {
          pageId: data.target.pageId,
          route: data.target.route
        },
        route: route
      }
    };
    if (!disposed && byteLength(message) <= MAX_BYTES) window.parent.postMessage(message, origin);
  }
  function sendNavigationError(data, origin, error) {
    var message = {
      type: "open-builder:design-bridge-navigation-error",
      version: VERSION,
      generation: GENERATION,
      nonce: data.nonce,
      requestId: data.requestId,
      error: clean(error && error.message ? error.message : String(error), 400) || "Preview navigation failed."
    };
    if (!disposed && byteLength(message) <= MAX_BYTES) window.parent.postMessage(message, origin);
  }
  function navigate(data, origin) {
    if (navigationInFlight) {
      sendNavigationError(data, origin, new Error("A preview navigation request is already running."));
      return;
    }
    navigationInFlight = true;
    var targetRoute = data.target.route;
    var finish = function () {
      navigationInFlight = false;
      if (disposed) return;
      var actualRoute = previewRoute();
      if (actualRoute !== targetRoute) {
        sendNavigationError(data, origin, new Error("Preview router did not reach the requested route."));
        return;
      }
      sendNavigationResult(data, origin, actualRoute);
    };
    try {
      if (window.location.hash !== targetRoute) window.location.hash = targetRoute.slice(1);
      nextPaint().then(finish, function (error) {
        navigationInFlight = false;
        sendNavigationError(data, origin, error);
      });
    } catch (error) {
      navigationInFlight = false;
      sendNavigationError(data, origin, error);
    }
  }
  function announceRoute() {
    if (disposed) return;
    var route = previewRoute();
    if (!safeHashRoute(route)) return;
    var message = {
      type: "open-builder:design-bridge-route",
      version: VERSION,
      generation: GENERATION,
      route: route
    };
    if (!disposed && byteLength(message) <= MAX_BYTES) window.parent.postMessage(message, "*");
  }
  async function capture(data, origin) {
    var captureNonce = data.nonce;
    var requestId = data.requestId;
    var viewport = data.viewport;
    var currentViewport = data.currentViewport === true;
    var base = {
      version: VERSION,
      generation: GENERATION,
      nonce: captureNonce,
      requestId: requestId
    };
    if (captureInFlight) throw new Error("A preview capture is already running.");
    captureInFlight = true;
    var controller = new AbortController();
    activeCapture = { nonce: captureNonce, requestId: requestId, controller: controller };
    var canvas;
    try {
      var renderer = await loadCaptureLibrary();
      if (disposed || controller.signal.aborted) throw controller.signal.reason || new Error("Preview runtime was replaced.");
      if (!currentViewport) await waitForFonts();
      if (disposed || controller.signal.aborted) throw controller.signal.reason || new Error("Preview runtime was replaced.");
      var size = currentViewport ? { width: window.innerWidth, height: window.innerHeight } : await stableViewport(viewport.name, controller.signal);
      if (currentViewport && (size.width !== viewport.width || size.height !== viewport.height)) throw new Error("Preview viewport changed before capture.");
      if (disposed || controller.signal.aborted) throw controller.signal.reason || new Error("Preview runtime was replaced.");
      var actualWidth = size.width;
      var actualHeight = size.height;
      var root = document.documentElement;
      var fullHeight = Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0, actualHeight);
      var fullWidth = Math.max(root.scrollWidth, document.body ? document.body.scrollWidth : 0, actualWidth);
      var scope = data.scope || (currentViewport ? "viewport" : "full-page");
      var annotation = data.output === "annotation";
      var region = scope === "viewport"
        ? { x: Math.max(0, window.scrollX), y: Math.max(0, window.scrollY), width: actualWidth, height: actualHeight }
        : { x: 0, y: 0, width: fullWidth, height: fullHeight };
      var scale = annotation ? 1 : Math.min(1, 2000 / region.width, CAPTURE_MAX_HEIGHT / region.height, Math.sqrt(CAPTURE_MAX_PIXELS / (region.width * region.height)));
      var snapshot = semanticSnapshot(data.target, actualWidth, actualHeight);
      snapshot.document.scrollWidth = fullWidth;
      snapshot.document.scrollHeight = fullHeight;
      canvas = await renderer.toCanvas(root, {
        signal: controller.signal,
        output: annotation ? "annotation" : "evidence",
        region: region,
        scale: scale,
        windowWidth: actualWidth,
        windowHeight: actualHeight,
        cacheBust: true,
        pixelRatio: 1,
        skipAutoScale: true,
        width: region.width,
        height: region.height,
        canvasWidth: Math.max(1, Math.floor(region.width * scale)),
        canvasHeight: Math.max(1, Math.floor(region.height * scale)),
        style: {
          width: actualWidth + "px",
          height: fullHeight + "px",
          margin: "0",
          overflow: "visible",
          position: "relative",
          top: -region.y + "px",
          left: -region.x + "px"
        },
        filter: function (node) {
          return !(node && node.getAttribute && node.hasAttribute("data-ob-design-overlay"));
        }
      });
      if (disposed || controller.signal.aborted) throw controller.signal.reason || new Error("Preview runtime was replaced.");
      if (actualWidth !== window.innerWidth || actualHeight !== window.innerHeight) {
        throw new Error("Preview viewport changed during capture from " + actualWidth + "x" + actualHeight + " to " + window.innerWidth + "x" + window.innerHeight + ". Please retry.");
      }
      var encoded;
      if (annotation) {
        var blob = await new Promise(function (resolve, reject) {
          canvas.toBlob(function (value) { if (value && value.size) resolve(value); else reject(new Error("Screenshot PNG encoding failed.")); }, "image/png");
        });
        encoded = { blob: blob, mimeType: "image/png" };
      } else {
        for (;;) {
          try { encoded = encodeCapture(canvas); break; }
          catch (error) {
            if (canvas.width <= 1 && canvas.height <= 1) throw error;
            scale *= 0.75;
            var smaller = document.createElement("canvas");
            smaller.width = Math.max(1, Math.floor(region.width * scale));
            smaller.height = Math.max(1, Math.floor(region.height * scale));
            var context = smaller.getContext("2d");
            if (!context) throw new Error("Screenshot canvas context is unavailable.");
            context.drawImage(canvas, 0, 0, smaller.width, smaller.height);
            canvas.width = 0; canvas.height = 0;
            canvas = smaller;
          }
        }
      }
      if (disposed || controller.signal.aborted) throw controller.signal.reason || new Error("Preview runtime was replaced.");
      var resultMessage = {
        type: annotation ? "open-builder:design-bridge-annotation-result" : "open-builder:design-bridge-capture-result",
        version: base.version,
        generation: base.generation,
        nonce: base.nonce,
        requestId: base.requestId,
        payload: Object.assign({}, encoded, {
          capture: { scope: scope, region: region, scale: scale },
          viewport: {
            name: viewport.name,
            width: actualWidth,
            height: actualHeight,
            capturedHeight: region.height,
            fullHeight: fullHeight,
            truncated: scope === "viewport" && (region.y !== 0 || region.x !== 0 || region.height < fullHeight || region.width < fullWidth)
          },
          semanticSnapshot: snapshot
        })
      };
      if (!sendCapture(resultMessage, origin)) throw new Error("Preview capture response exceeded its size limit.");
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      captureInFlight = false;
      activeCapture = null;
    }
  }
  function captureError(data, origin, error) {
    sendCapture({
      type: "open-builder:design-bridge-capture-error",
      version: VERSION,
      generation: GENERATION,
      nonce: data.nonce,
      requestId: data.requestId,
      error: clean(error && error.message ? error.message : String(error), 400) || "Preview capture failed."
    }, origin);
  }
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  function onHashChange() { nextPaint().then(announceRoute); }
  window.addEventListener("hashchange", onHashChange);
  function onMessage(event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.version !== VERSION || byteLength(data) > MAX_BYTES || !validId(data.nonce)) return;
    var eventOrigin = event.origin && event.origin !== "null" ? event.origin : "*";
    if (data.type === "open-builder:design-bridge-readiness") {
      if (data.generation === GENERATION && data.runtimeRevision === RUNTIME_REVISION) announceReady(data.nonce, eventOrigin);
      return;
    }
    if (data.type === "open-builder:design-bridge-cancel-capture") {
      if (data.generation === GENERATION && activeCapture && data.nonce === activeCapture.nonce && data.requestId === activeCapture.requestId) {
        activeCapture.controller.abort(new DOMException("Screenshot capture was cancelled.", "AbortError"));
      }
      return;
    }
    if (data.type === "open-builder:design-bridge-reset-data") {
      if (data.generation !== GENERATION) return;
      window.dispatchEvent(new Event("open-builder:prototype-reset-data"));
      return;
    }
    if (data.type === "open-builder:design-bridge-navigate") {
      if (data.generation !== GENERATION || !validId(data.requestId) || !safePrototypeTarget(data.target)) return;
      navigate(data, eventOrigin);
      return;
    }
    if (data.type === "open-builder:design-bridge-capture") {
      if (data.generation !== GENERATION || !validId(data.requestId) || !data.viewport ||
          ["desktop", "tablet", "mobile"].indexOf(data.viewport.name) < 0 ||
          !Number.isInteger(data.viewport.width) || data.viewport.width < 240 || data.viewport.width > 2000) return;
      if (!Number.isInteger(data.viewport.height) || data.viewport.height < 240 || data.viewport.height > 2000) return;
      if (data.target !== undefined && !safePrototypeTarget(data.target)) return;
      if (data.scope !== undefined && data.scope !== "viewport" && data.scope !== "full-page") return;
      if (data.output !== undefined && data.output !== "evidence" && data.output !== "annotation") return;
      capture(data, eventOrigin).catch(function (error) { captureError(data, eventOrigin, error); });
      return;
    }
    if (data.type !== "open-builder:design-bridge-control") return;
    if (nonce && data.nonce !== nonce && active) return;
    nonce = data.nonce;
    parentOrigin = eventOrigin;
    active = data.active === true;
    if (!active) show(null);
  }
  window.addEventListener("message", onMessage);
  function announceReady(requestNonce, origin) {
    if (disposed) return;
    window.parent.postMessage({
      type: "open-builder:design-bridge-ready",
      version: VERSION,
      generation: GENERATION,
      runtimeRevision: RUNTIME_REVISION,
      nonce: requestNonce,
      captureRuntimeAvailable: Boolean(captureRuntime()),
      route: previewRoute()
    }, origin || "*");
  }
  function onCaptureRuntimeReady() { announceReady(); }
  window.addEventListener("open-builder:capture-runtime-ready", onCaptureRuntimeReady);
  window[installedKey] = {
    revision: RUNTIME_REVISION,
    announce: announceReady,
    dispose: function () {
      disposed = true;
      active = false;
      if (activeCapture) activeCapture.controller.abort(new DOMException("Preview runtime was replaced.", "AbortError"));
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("open-builder:capture-runtime-ready", onCaptureRuntimeReady);
      overlay.remove();
    }
  };
  announceReady();
})();\n`;
}

export function injectDesignBridge(
  files: ProjectFiles,
  template: string,
  previewEnabled = true,
  captureRuntimeSource?: string,
  generation = "unversioned",
): DesignBridgeInjectionResult {
  const identity = {
    files,
    restore: (_path: string, content: string) => content,
  };
  if (!previewEnabled) {
    return { ...identity, supported: false, reason: "code-only" };
  }
  if (!SUPPORTED_DESIGN_BRIDGE_TEMPLATES.has(template)) {
    return { ...identity, supported: false, reason: "unsupported-template" };
  }
  if (
    DESIGN_BRIDGE_VIRTUAL_PATH in files ||
    DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH in files
  ) {
    return { ...identity, supported: false, reason: "reserved-path" };
  }

  let entryPath: string | undefined;
  let source: string | undefined;
  let scriptEntry = SCRIPT_ENTRY_TEMPLATES.has(template);
  if (scriptEntry) {
    // Sandpack merges template files into partial projects. Its `main` field
    // selects the editor tab; package.json.main selects the executable module.
    const defaults = SANDBOX_TEMPLATES[
      template as keyof typeof SANDBOX_TEMPLATES
    ].files as Record<string, string | { code: string }>;
    const defaultSource = (path: string) => {
      const file = defaults[`/${path}`] ?? defaults[path];
      return typeof file === "string" ? file : file?.code;
    };
    try {
      const pkg = JSON.parse(
        files["package.json"] ?? defaultSource("package.json") ?? "{}",
      );
      const main = Array.isArray(pkg.main) ? pkg.main[0] : pkg.main;
      if (typeof main === "string") {
        const path = main.replace(/^\/?(?:\.\/)?/, "");
        if (
          !path
            .split("/")
            .some((part) => !part || part === "." || part === "..") &&
          /\.(?:[jt]sx?|html)$/.test(path)
        ) {
          entryPath = path;
          source = files[path] ?? defaultSource(path);
        }
      }
    } catch {
      // Invalid packages cannot provide a trustworthy executable entry.
    }
    // Angular configuration can override package.main. Do not instrument an
    // inactive entry when this project uses a custom CLI configuration.
    if (
      !entryPath ||
      source === undefined ||
      (template === "angular" &&
        ("angular.json" in files || ".angular-cli.json" in files))
    ) {
      return { ...identity, supported: false, reason: "missing-entry" };
    }
    if (entryPath.endsWith(".html")) {
      if (template !== "vanilla" && template !== "vanilla-ts") {
        return { ...identity, supported: false, reason: "missing-entry" };
      }
      scriptEntry = false;
    }
  } else {
    entryPath = Object.keys(files).find(
      (path) => !path.includes("/") && path.toLowerCase() === "index.html",
    );
    source = entryPath ? files[entryPath] : undefined;
  }
  if (
    !entryPath ||
    source === undefined ||
    (!scriptEntry && !/<\/body\s*>/i.test(source))
  ) {
    return { ...identity, supported: false, reason: "missing-index" };
  }
  if (source.includes(DESIGN_BRIDGE_MARKER)) {
    return { ...identity, supported: false, reason: "reserved-path" };
  }
  const startMarker = scriptEntry
    ? `/* ${DESIGN_BRIDGE_MARKER}:start */`
    : `<!-- ${DESIGN_BRIDGE_MARKER}:start -->`;
  const endMarker = scriptEntry
    ? `/* ${DESIGN_BRIDGE_MARKER}:end */`
    : `<!-- ${DESIGN_BRIDGE_MARKER}:end -->`;
  const relativeRoot = "../".repeat(entryPath.split("/").length - 1) || "./";
  const block = scriptEntry
    ? `${startMarker}\n${[
        ...(captureRuntimeSource ? [DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH] : []),
        DESIGN_BRIDGE_VIRTUAL_PATH,
      ]
        .map((path) => `import ${JSON.stringify(relativeRoot + path)};`)
        .join("\n")}\n${endMarker}\n`
    : `${bridgeTags(Boolean(captureRuntimeSource))}\n`;
  const projected = scriptEntry
    ? source.replace(/^(#![^\n]*\n)?/, (prefix) => prefix + block)
    : source.replace(/<\/body\s*>/i, (closing) => block + closing);
  const injectedFiles: ProjectFiles = {
    ...files,
    [entryPath]: projected,
    [DESIGN_BRIDGE_VIRTUAL_PATH]: previewBridgeClientSource(
      Boolean(captureRuntimeSource),
      generation,
    ),
  };
  if (captureRuntimeSource) {
    injectedFiles[DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH] = captureRuntimeSource;
  }
  return {
    supported: true,
    ...(!scriptEntry ? { indexPath: entryPath } : {}),
    files: injectedFiles,
    restore(path, content) {
      if (
        path === DESIGN_BRIDGE_VIRTUAL_PATH ||
        path === DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH
      )
        return undefined;
      if (path !== entryPath) return content;
      // Template-only entries are preview scaffolding, not new project files.
      if (files[path] === undefined) return undefined;
      if (content === projected) return source;
      const start = content.indexOf(startMarker);
      const end = content.indexOf(endMarker);
      if (start < 0 && end < 0) return content;
      if (start < 0 || end < start) return undefined;
      const afterMarker = end + endMarker.length;
      const afterBlock = afterMarker + (content[afterMarker] === "\n" ? 1 : 0);
      return content.slice(0, start) + content.slice(afterBlock);
    },
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

function sanitizePreviewRoute(value: unknown): string {
  if (isSafePrototypePreviewRoute(value)) return value as string;
  const cleaned = cleanText(value, PROTOTYPE_PREVIEW_ROUTE_MAX_LENGTH);
  if (!cleaned) return "/";
  if (isSafePrototypePreviewRoute(cleaned)) return cleaned;
  const path = cleaned.split(/[?#]/, 1)[0] ?? "/";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

export function getDesignPreviewRoute(value: unknown): string {
  return sanitizePreviewRoute(value);
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
  const route = sanitizePreviewRoute(raw.route);
  if (
    raw.idSource !== undefined &&
    raw.idSource !== "explicit" &&
    raw.idSource !== "runtime"
  ) {
    return null;
  }
  if (
    raw.anchorElementId !== undefined &&
    (typeof raw.anchorElementId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw.anchorElementId))
  ) {
    return null;
  }
  const idSource =
    raw.idSource === "explicit" || raw.idSource === "runtime"
      ? raw.idSource
      : undefined;
  const anchorElementId =
    typeof raw.anchorElementId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw.anchorElementId)
      ? raw.anchorElementId
      : undefined;
  let sourceLocator: DesignSelectionContext["sourceLocator"];
  if (raw.sourceLocator !== undefined) {
    if (
      !raw.sourceLocator ||
      typeof raw.sourceLocator !== "object" ||
      Array.isArray(raw.sourceLocator) ||
      !Array.isArray((raw.sourceLocator as Record<string, unknown>).path) ||
      (raw.sourceLocator as { path: unknown[] }).path.length < 1 ||
      (raw.sourceLocator as { path: unknown[] }).path.length > 12
    ) {
      return null;
    }
    const path: Array<{ tagName: string; nthOfType: number }> = [];
    for (const segment of (raw.sourceLocator as { path: unknown[] }).path) {
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
        return null;
      }
      const rawSegment = segment as Record<string, unknown>;
      if (
        typeof rawSegment.tagName !== "string" ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(rawSegment.tagName) ||
        !Number.isInteger(rawSegment.nthOfType) ||
        (rawSegment.nthOfType as number) < 1 ||
        (rawSegment.nthOfType as number) > 10_000
      ) {
        return null;
      }
      path.push({
        tagName: rawSegment.tagName,
        nthOfType: rawSegment.nthOfType as number,
      });
    }
    sourceLocator = { path };
  }
  if (idSource === "runtime") {
    if (!sourceLocator) return null;
  } else if (anchorElementId || sourceLocator) {
    return null;
  }
  return {
    protocolVersion: DESIGN_BRIDGE_PROTOCOL_VERSION,
    elementId: raw.elementId,
    ...(idSource ? { idSource } : {}),
    ...(anchorElementId ? { anchorElementId } : {}),
    ...(sourceLocator ? { sourceLocator } : {}),
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
    let accessibility: DesignPreviewSemanticElement["accessibility"];
    if (element.accessibility !== undefined) {
      if (
        !element.accessibility ||
        typeof element.accessibility !== "object" ||
        Array.isArray(element.accessibility)
      ) {
        return null;
      }
      const rawAccessibility = element.accessibility as Record<string, unknown>;
      const tabIndex = safeFiniteNumber(
        rawAccessibility.tabIndex,
        -1,
        32_767,
        true,
      );
      const nameSource = String(rawAccessibility.nameSource);
      const imageAlt = rawAccessibility.imageAlt;
      if (
        typeof rawAccessibility.interactive !== "boolean" ||
        typeof rawAccessibility.focusable !== "boolean" ||
        typeof rawAccessibility.disabled !== "boolean" ||
        tabIndex === null ||
        ![
          "aria-label",
          "aria-labelledby",
          "label",
          "alt",
          "placeholder",
          "text",
          "none",
        ].includes(nameSource) ||
        (imageAlt !== undefined &&
          imageAlt !== "missing" &&
          imageAlt !== "empty" &&
          imageAlt !== "named")
      ) {
        return null;
      }
      accessibility = {
        interactive: rawAccessibility.interactive,
        focusable: rawAccessibility.focusable,
        disabled: rawAccessibility.disabled,
        tabIndex,
        nameSource: nameSource as NonNullable<
          DesignPreviewSemanticElement["accessibility"]
        >["nameSource"],
        ...(imageAlt ? { imageAlt } : {}),
      };
    }
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
      ...(accessibility ? { accessibility } : {}),
    });
  }

  const routeValue = sanitizePreviewRoute(raw.route);
  const rawPrototypeIdentity =
    raw.prototypeIdentity !== undefined ? raw.prototypeIdentity : raw.prototype;
  const prototypeIdentity =
    rawPrototypeIdentity === undefined
      ? undefined
      : sanitizePrototypePreviewTarget(rawPrototypeIdentity);
  const legacyPrototypeIdentity =
    raw.prototype === undefined
      ? undefined
      : sanitizePrototypePreviewTarget(raw.prototype);
  if (
    rawPrototypeIdentity !== undefined &&
    (!prototypeIdentity ||
      (raw.prototypeIdentity !== undefined &&
        raw.prototype !== undefined &&
        (!legacyPrototypeIdentity ||
          !prototypePreviewTargetsEqual(
            prototypeIdentity,
            legacyPrototypeIdentity,
          ))))
  ) {
    return null;
  }
  const languageValue = cleanText(documentState.language, 35);
  const language =
    languageValue && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(languageValue)
      ? languageValue
      : undefined;
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
    route: routeValue,
    ...(prototypeIdentity ? { prototypeIdentity } : {}),
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
      ...(language ? { language } : {}),
    },
    ...(designTokens ? { designTokens } : {}),
    elements,
  };
  return (jsonByteLength(snapshot) ?? Infinity) <=
    DESIGN_BRIDGE_SEMANTIC_MAX_BYTES
    ? snapshot
    : null;
}

export function captureImageMetadata(dataUrl: string): {
  mimeType: CompressibleImageMimeType;
  bytes: number;
  width: number;
  height: number;
} | null {
  let bytes: Uint8Array;
  try {
    bytes = readScreenshotImage(dataUrl).bytes;
  } catch {
    return null;
  }
  return captureBytesMetadata(bytes);
}

function captureBytesMetadata(bytes: Uint8Array): {
  mimeType: CompressibleImageMimeType;
  bytes: number;
  width: number;
  height: number;
} | null {
  const inspection = inspectImageBytes(bytes);
  if (!inspection || inspection.animated) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  if (inspection.mimeType === "image/png") {
    if (bytes.length < 33) return null;
    width = view.getUint32(16, false);
    height = view.getUint32(20, false);
  } else if (inspection.mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset, false);
      if (length < 2 || offset + length > bytes.length) return null;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (length < 8) return null;
        height = view.getUint16(offset + 3, false);
        width = view.getUint16(offset + 5, false);
        break;
      }
      offset += length;
    }
  } else {
    if (bytes.length < 30) return null;
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X") {
      width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536;
      height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
    } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      height =
        1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    } else if (
      chunk === "VP8 " &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
  }
  return width > 0 && height > 0
    ? { mimeType: inspection.mimeType, bytes: bytes.length, width, height }
    : null;
}

function captureEnvelope(
  value: unknown,
  expected: DesignBridgeCaptureExpectation,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== DESIGN_BRIDGE_PROTOCOL_VERSION ||
    raw.generation !== expected.generation ||
    raw.nonce !== expected.nonce ||
    raw.requestId !== expected.requestId
  )
    return null;
  return raw;
}

function captureFailure(
  raw: Record<string, unknown>,
): { ok: false; error: string } | null {
  const size = jsonByteLength(raw);
  const error = cleanText(raw.error, 400);
  return raw.type === "open-builder:design-bridge-capture-error" &&
    size !== null &&
    size <= DESIGN_BRIDGE_PAYLOAD_MAX_BYTES &&
    error
    ? { ok: false, error }
    : null;
}

function validateCapturePayload(
  payload: Record<string, unknown>,
  expected: DesignBridgeCaptureExpectation,
  image: ReturnType<typeof captureBytesMetadata>,
  annotation: boolean,
) {
  if (
    !image ||
    !payload.viewport ||
    typeof payload.viewport !== "object" ||
    Array.isArray(payload.viewport)
  )
    return null;
  const viewport = payload.viewport as Record<string, unknown>;
  const width = safeFiniteNumber(viewport.width, 1, 10_000, true);
  const height = safeFiniteNumber(viewport.height, 1, 10_000, true);
  const geometry =
    payload.capture === undefined
      ? undefined
      : sanitizePreviewCaptureGeometry(payload.capture);
  if (
    geometry === null ||
    (annotation && !geometry) ||
    (expected.scope !== undefined && !geometry)
  )
    return null;
  const capturedHeight = safeFiniteNumber(
    viewport.capturedHeight,
    1,
    geometry ? 1_000_000 : DESIGN_BRIDGE_CAPTURE_MAX_HEIGHT,
    true,
  );
  const fullHeight = safeFiniteNumber(viewport.fullHeight, 1, 1_000_000, true);
  const semanticSnapshot = sanitizeSemanticSnapshot(payload.semanticSnapshot);
  const target =
    expected.target === undefined
      ? undefined
      : sanitizePrototypePreviewTarget(expected.target);
  if (!semanticSnapshot || (expected.target !== undefined && !target))
    return null;
  if (
    target &&
    (semanticSnapshot.route !== target.route ||
      !prototypePreviewTargetsEqual(semanticSnapshot.prototypeIdentity, target))
  )
    return null;
  if (
    image.bytes <= 0 ||
    viewport.name !== expected.viewportName ||
    width === null ||
    height === null ||
    !isPreviewViewportSize(expected.viewportName, width, height) ||
    (expected.currentViewport === true &&
      (width !== expected.viewportWidth ||
        height !== expected.viewportHeight)) ||
    capturedHeight === null ||
    fullHeight === null ||
    capturedHeight > fullHeight ||
    typeof viewport.truncated !== "boolean" ||
    semanticSnapshot.viewport.width !== width ||
    semanticSnapshot.viewport.height !== height
  )
    return null;
  if (
    !annotation &&
    (image.bytes > DESIGN_BRIDGE_CAPTURE_MAX_BYTES ||
      image.width > 2000 ||
      image.height > DESIGN_BRIDGE_CAPTURE_MAX_HEIGHT ||
      image.width * image.height > DESIGN_BRIDGE_CAPTURE_MAX_PIXELS)
  )
    return null;
  if (geometry) {
    const { region, scope, scale } = geometry;
    const expectedScope =
      expected.scope ?? (expected.currentViewport ? "viewport" : "full-page");
    if (
      scope !== expectedScope ||
      fullHeight !== Math.max(height, semanticSnapshot.document.scrollHeight) ||
      (annotation && scale !== 1) ||
      capturedHeight !== region.height ||
      image.width !== Math.max(1, Math.floor(region.width * scale)) ||
      image.height !== Math.max(1, Math.floor(region.height * scale))
    )
      return null;
    if (
      scope === "viewport" &&
      (region.width !== width || region.height !== height)
    )
      return null;
    if (
      scope === "full-page" &&
      (region.height !== fullHeight ||
        region.width !== Math.max(width, semanticSnapshot.document.scrollWidth))
    )
      return null;
    const incomplete =
      scope === "viewport" &&
      (region.x !== 0 ||
        region.y !== 0 ||
        region.height < fullHeight ||
        region.width < semanticSnapshot.document.scrollWidth);
    if (viewport.truncated !== incomplete) return null;
  } else if (
    image.width !== width ||
    image.height !== capturedHeight ||
    viewport.truncated !== capturedHeight < fullHeight
  )
    return null;
  return {
    viewport: {
      name: expected.viewportName,
      width,
      height,
      capturedHeight,
      fullHeight,
      truncated: viewport.truncated,
    },
    semanticSnapshot,
    ...(geometry ? { capture: geometry } : {}),
  };
}

export function parseDesignBridgeCaptureResponse(
  value: unknown,
  expected: DesignBridgeCaptureExpectation,
): DesignBridgeCaptureResponse | null {
  if (expected.output === "annotation") return null;
  const raw = captureEnvelope(value, expected);
  if (!raw) return null;
  if (raw.type === "open-builder:design-bridge-capture-error")
    return captureFailure(raw);
  if (raw.type !== "open-builder:design-bridge-capture-result") return null;
  const size = jsonByteLength(raw);
  if (
    size === null ||
    size > DESIGN_BRIDGE_CAPTURE_MESSAGE_MAX_BYTES ||
    !raw.payload ||
    typeof raw.payload !== "object" ||
    Array.isArray(raw.payload)
  )
    return null;
  const payload = raw.payload as Record<string, unknown>;
  if (typeof payload.dataUrl !== "string" || payload.blob !== undefined)
    return null;
  const image = captureImageMetadata(payload.dataUrl);
  const fields = validateCapturePayload(payload, expected, image, false);
  if (!fields || !image) return null;
  return {
    ok: true,
    result: {
      generation: expected.generation,
      dataUrl: readScreenshotImage(payload.dataUrl).dataUrl,
      mimeType: image.mimeType,
      ...fields,
    },
  };
}

export async function parseDesignBridgeAnnotationResponse(
  value: unknown,
  expected: DesignBridgeCaptureExpectation,
): Promise<DesignBridgeAnnotationResponse | null> {
  if (expected.output !== "annotation") return null;
  const raw = captureEnvelope(value, expected);
  if (!raw) return null;
  if (raw.type === "open-builder:design-bridge-capture-error")
    return captureFailure(raw);
  if (
    raw.type !== "open-builder:design-bridge-annotation-result" ||
    !raw.payload ||
    typeof raw.payload !== "object" ||
    Array.isArray(raw.payload)
  )
    return null;
  const payload = raw.payload as Record<string, unknown>;
  if (
    !(payload.blob instanceof Blob) ||
    payload.blob.type !== "image/png" ||
    !payload.blob.size ||
    payload.dataUrl !== undefined
  )
    return null;
  const size = jsonByteLength({
    ...raw,
    payload: { ...payload, blob: undefined },
  });
  if (size === null || size > DESIGN_BRIDGE_SEMANTIC_MAX_BYTES + 4096)
    return null;
  try {
    const image = captureBytesMetadata(
      new Uint8Array(await payload.blob.arrayBuffer()),
    );
    if (!image || image.mimeType !== "image/png") return null;
    const fields = validateCapturePayload(payload, expected, image, true);
    if (!fields || !fields.capture) return null;
    return {
      ok: true,
      result: {
        generation: expected.generation,
        blob: payload.blob,
        mimeType: image.mimeType,
        ...fields,
        capture: fields.capture,
      },
    };
  } catch {
    return null;
  }
}

export function parseDesignBridgeNavigationResponse(
  value: unknown,
  expected: DesignBridgeNavigationExpectation,
): DesignBridgeNavigationResponse | null {
  const expectedTarget = sanitizePrototypePreviewTarget(expected.target);
  if (
    !expectedTarget ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== DESIGN_BRIDGE_PROTOCOL_VERSION ||
    raw.generation !== expected.generation ||
    raw.nonce !== expected.nonce ||
    raw.requestId !== expected.requestId
  ) {
    return null;
  }
  if (raw.type === "open-builder:design-bridge-navigation-error") {
    const size = jsonByteLength(raw);
    const error = cleanText(raw.error, 400);
    return size !== null && size <= DESIGN_BRIDGE_PAYLOAD_MAX_BYTES && error
      ? { ok: false, error }
      : null;
  }
  if (raw.type !== "open-builder:design-bridge-navigation-result") return null;
  const size = jsonByteLength(raw);
  if (
    size === null ||
    size > DESIGN_BRIDGE_PAYLOAD_MAX_BYTES ||
    !raw.payload ||
    typeof raw.payload !== "object" ||
    Array.isArray(raw.payload)
  ) {
    return null;
  }
  const payload = raw.payload as Record<string, unknown>;
  const target = sanitizePrototypePreviewTarget(payload.target);
  const route = payload.route;
  if (
    !target ||
    !prototypePreviewTargetsEqual(target, expectedTarget) ||
    typeof route !== "string" ||
    !isSafePrototypePreviewRoute(route) ||
    route !== expectedTarget.route
  ) {
    return null;
  }
  return { ok: true, target, route };
}

export function parseDesignBridgeRouteMessage(
  value: unknown,
  expectedGeneration: string,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const size = jsonByteLength(raw);
  return raw.type === "open-builder:design-bridge-route" &&
    raw.version === DESIGN_BRIDGE_PROTOCOL_VERSION &&
    raw.generation === expectedGeneration &&
    size !== null &&
    size <= DESIGN_BRIDGE_PAYLOAD_MAX_BYTES &&
    isSafePrototypePreviewRoute(raw.route)
    ? (raw.route as string)
    : null;
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
