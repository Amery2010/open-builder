import { readdirSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dist = new URL("../dist/", import.meta.url);
const assets = new URL("assets/", dist);
const html = readFileSync(new URL("index.html", dist), "utf8");
const files = readdirSync(assets);
const failures = [];
const forbiddenTauriSpecifiers = [
  "@tauri-apps/plugin-dialog",
  "@tauri-apps/plugin-fs",
  "@tauri-apps/plugin-opener",
  "@tauri-apps/api/path",
];

for (const file of files.filter((name) => name.endsWith(".js"))) {
  const source = readFileSync(new URL(file, assets), "utf8");
  for (const specifier of forbiddenTauriSpecifiers) {
    if (source.includes(specifier)) {
      failures.push(
        `Production chunk ${file} contains unresolved Tauri module specifier ${specifier}.`,
      );
    }
  }
}

const preloadHrefs = [
  ...html.matchAll(/rel="modulepreload"[^>]+href="([^"]+)"/g),
].map((match) => match[1]);
const forbiddenInitialChunks = [
  "vendor-editor-",
  "vendor-sandpack-",
  "vendor-ai-",
  "CodeViewer-",
  "SettingsDialog-",
  "McpPanel-",
  "SkillsPanel-",
  "MarkdownContent-",
];
for (const href of preloadHrefs) {
  if (
    forbiddenInitialChunks.some((prefix) => href.includes(`/assets/${prefix}`))
  ) {
    failures.push(`Heavy lazy chunk is preloaded on first paint: ${href}`);
  }
}

for (const prefix of [
  "CodeViewer-",
  "SettingsDialog-",
  "McpPanel-",
  "SkillsPanel-",
  "MarkdownContent-",
]) {
  if (!files.some((file) => file.startsWith(prefix) && file.endsWith(".js"))) {
    failures.push(`Expected a lazy ${prefix} chunk in the production build.`);
  }
}

const markdownChunk = files.find(
  (file) => file.startsWith("MarkdownContent-") && file.endsWith(".js"),
);
if (markdownChunk) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    { url: "http://localhost" },
  );
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  for (const key of [
    "window",
    "document",
    "localStorage",
    "sessionStorage",
    "HTMLElement",
    "Element",
    "Node",
    "MutationObserver",
    "CustomEvent",
    "Event",
    "URL",
    "Blob",
    "FileReader",
    "DOMParser",
  ]) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    });
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);

  try {
    // Catch circular-chunk failures that only appear in the production graph.
    await import(new URL(markdownChunk, assets));
  } catch (error) {
    failures.push(
      `Production Markdown chunk failed to initialize: ${error instanceof Error ? error.message : String(error)}.`,
    );
  } finally {
    dom.window.close();
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`build-artifacts: ${failure}`);
  process.exit(1);
}

console.log("Production artifact checks passed.");
