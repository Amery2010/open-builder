import type { ProjectFiles } from "../../types";
import {
  DESIGN_BRIDGE_VIRTUAL_PATH,
  DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH,
} from "../../lib/design/preview-bridge";

export const REACT_PREVIEW_ENTRY = "__open_builder_react_preview__.js";

export interface ReactPreviewProjection {
  files: ProjectFiles;
  customSetup?: { environment: "create-react-app"; entry: string };
  sourceEntry?: string;
  restore: (path: string, content: string) => string | undefined;
}

function record(
  source: string | undefined,
): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(source ?? "");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function withoutComments(source: string): string {
  // Keep quoted text opaque; never execute a project configuration to select a runtime.
  return source.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (token) => (token.startsWith("/") ? "" : token),
  );
}

function stockReactConfig(source: string): boolean {
  return /^\s*import\s*\{\s*defineConfig\s*\}\s*from\s*(['"])vite\1\s*;?\s*import\s+react\s+from\s*(['"])@vitejs\/plugin-react\2\s*;?\s*export\s+default\s+defineConfig\s*\(\s*\{\s*plugins\s*:\s*\[\s*react\s*\(\s*\)\s*\]\s*,?\s*\}\s*\)\s*;?\s*$/.test(
    withoutComments(source),
  );
}

/** Only the built-in, browser-only React/Vite profile has equivalent CRA semantics. */
function compatibleEntry(
  files: ProjectFiles,
  template: string,
): string | undefined {
  if (template !== "vite-react" && template !== "vite-react-ts") return;
  if (
    !files["index.html"] ||
    files["public/index.html"] !== undefined ||
    files[REACT_PREVIEW_ENTRY] !== undefined
  )
    return;
  const pkg = record(files["package.json"]);
  if (!pkg) return;
  const deps = {
    ...(pkg.dependencies as object),
    ...(pkg.devDependencies as object),
  } as Record<string, unknown>;
  if (
    !["4.1.4", "4.2.0"].includes(String(deps.vite)) ||
    !["3.1.0", "^4.3.4", "4.3.4"].includes(
      String(deps["@vitejs/plugin-react"]),
    ) ||
    !/^[~^]?(?:17|18|19)\./.test(String(deps.react)) ||
    !/^[~^]?(?:17|18|19)\./.test(String(deps["react-dom"]))
  )
    return;
  const scripts = pkg.scripts as Record<string, unknown> | undefined;
  if (!/^vite(?: --clearScreen false)?$/.test(String(scripts?.dev))) return;
  if (
    [
      "imports",
      "exports",
      "browser",
      "alias",
      "babel",
      "browserslist",
      "postcss",
      "overrides",
      "resolutions",
      "pnpm",
    ].some((key) => key in pkg)
  )
    return;
  const configs = Object.keys(files).filter((path) =>
    /(?:^|\/)vite\.config\./.test(path),
  );
  if (
    configs.length !== 1 ||
    !/^vite\.config\.[jt]s$/.test(configs[0]) ||
    !stockReactConfig(files[configs[0]])
  )
    return;
  for (const [path, source] of Object.entries(files)) {
    if (
      /(?:^|\/)(?:\.babelrc(?:\.|$)|babel\.config\.|postcss\.config\.|\.postcssrc|tailwind\.config\.|\.env(?:\.|$))/.test(
        path,
      )
    )
      return;
    if (/(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(path)) {
      const config = record(source);
      if (!config || config.extends) return;
      const options = config.compilerOptions;
      if (
        options !== undefined &&
        (!options || typeof options !== "object" || Array.isArray(options))
      )
        return;
      if (
        options &&
        [
          "paths",
          "baseUrl",
          "jsxImportSource",
          "jsxFactory",
          "jsxFragmentFactory",
          "experimentalDecorators",
          "emitDecoratorMetadata",
          "verbatimModuleSyntax",
          "importsNotUsedAsValues",
          "preserveValueImports",
        ].some((key) => key in options)
      )
        return;
    }
    if (
      /\.[cm]?[jt]sx?$/.test(path) &&
      (/\bimport\s*\.\s*meta\b|\bprocess\s*\.\s*env\b|\bnew\s+(?:Shared)?Worker\b/.test(
        withoutComments(source),
      ) ||
        /["'][^"'\n]*\?(?:raw|url|worker|inline|direct)\b/.test(source) ||
        /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:|fs["'/]|path["'/]|child_process["']|http["']|https["']|worker_threads["'])/.test(
          withoutComments(source),
        ))
    )
      return;
  }
  const html = new DOMParser().parseFromString(
    files["index.html"],
    "text/html",
  );
  if (html.querySelector("base")) return;
  if (
    html.body.attributes.length ||
    [...html.documentElement.attributes].some(
      (attribute) => !["lang", "dir"].includes(attribute.name),
    )
  )
    return;
  const modules = html.querySelectorAll('script[type="module"]');
  if (
    modules.length !== 1 ||
    modules[0].textContent?.trim() ||
    html.querySelectorAll("script").length !== 1
  )
    return;
  const src = modules[0].getAttribute("src");
  if (!src || !/^\/?(?:[\w.-]+\/)*[\w.-]+\.[jt]sx?$/.test(src)) return;
  const entry = src.replace(/^\//, "").replace(/^\.\//, "");
  if (
    entry.split("/").some((part) => part === ".." || part === ".") ||
    files[entry] === undefined
  )
    return;
  if (pkg.main !== undefined && pkg.main !== entry && pkg.main !== `/${entry}`)
    return;
  return `/${entry}`;
}

/** Bypass Nodebox's large esbuild plugin-response failure for the stock React profile. */
export function projectReactPreview(
  source: ProjectFiles,
  prepared: ProjectFiles,
  template: string,
  enabled = true,
): ReactPreviewProjection {
  const identity = {
    files: prepared,
    restore: (_path: string, content: string) => content,
  };
  const entry = enabled ? compatibleEntry(source, template) : undefined;
  const pkg = record(prepared["package.json"]);
  if (!entry || !pkg) return identity;
  const html = new DOMParser().parseFromString(
    prepared["index.html"],
    "text/html",
  );
  html.querySelector('script[type="module"]')?.remove();
  // CRA consumes the HTML body, but doesn't execute its script tags or copy
  // head metadata. Execute our bridges and the actual entry explicitly, after
  // restoring the document head (including project styles/fonts).
  const bootstrap = `const head = new DOMParser().parseFromString(${JSON.stringify(html.head.innerHTML)}, "text/html").head;
document.title = ${JSON.stringify(html.title)};
document.documentElement.lang = ${JSON.stringify(html.documentElement.lang)};
document.documentElement.dir = ${JSON.stringify(html.documentElement.dir)};
document.querySelectorAll('[data-open-builder-react-head]').forEach(node => node.remove());
for (const node of head.children) {
  if (!['META', 'LINK', 'STYLE'].includes(node.tagName)) continue;
  const copy = document.importNode(node, true);
  copy.setAttribute('data-open-builder-react-head', '');
  document.head.appendChild(copy);
}
${[DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH, DESIGN_BRIDGE_VIRTUAL_PATH]
  .filter((path) => prepared[path] !== undefined && source[path] === undefined)
  .map((path) => `require(${JSON.stringify(`./${path}`)});`)
  .join("\n")}
require(${JSON.stringify(`.${entry}`)});
`;
  const runtimeEntry = `/${REACT_PREVIEW_ENTRY}`;
  const projectedPackage = JSON.stringify(
    { ...pkg, main: runtimeEntry },
    null,
    2,
  );
  return {
    customSetup: { environment: "create-react-app", entry: runtimeEntry },
    sourceEntry: entry,
    files: {
      ...prepared,
      "package.json": projectedPackage,
      "public/index.html": "<!doctype html>\n" + html.documentElement.outerHTML,
      [REACT_PREVIEW_ENTRY]: bootstrap,
    },
    restore(path, content) {
      if (path === "public/index.html" || path === REACT_PREVIEW_ENTRY)
        return undefined;
      if (path !== "package.json") return content;
      if (content === projectedPackage) return prepared["package.json"];
      const edited = record(content);
      if (!edited || edited.main !== runtimeEntry) return content;
      if ("main" in pkg) edited.main = pkg.main;
      else delete edited.main;
      return JSON.stringify(edited, null, 2);
    },
  };
}
