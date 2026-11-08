import type {
  ProjectAssets,
  ProjectFiles,
  ProjectPreviewMode,
} from "../../types";
import type { ProjectDesign } from "./project-design";

const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".json",
  ".css",
  ".scss",
];
const REFERENCE_PATTERNS = [
  /\b(?:from|import)\s*["']([^"']+)["']/g,
  /\b(?:import|require|fetch)\s*\(\s*["']([^"']+)["']/g,
  /@(?:import|use|forward)\s+(?:url\(\s*)?["']([^"']+)["']/gi,
  /\b(?:src|srcset)\s*=\s*["']([^"']+)["']/gi,
  /<(?:link|use|image)\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
  /\burl\(\s*["']?([^"'()\s]+)["']?\s*\)/gi,
  /\bnew\s+URL\(\s*["']([^"']+)["']/g,
];

function resolveReferences(
  path: string,
  source: string,
  files: ProjectFiles,
  packages: Set<string>,
): Set<string> | null {
  // Ambiguous dependency discovery must not leave an apparently fresh image.
  if (
    /import\.meta\.glob|require\.context|\b(?:from|import|require|fetch|new|URL)\s*\/[/*]/.test(
      source,
    )
  )
    return null;
  for (const call of source.matchAll(
    /\b(?:import|require|fetch|new\s+URL)\s*\(/g,
  )) {
    const argument = source.slice(call.index + call[0].length);
    // A quoted prefix followed by +/a conditional is still a dynamic path.
    if (!/^\s*(?:"[^"\\]*"|'[^'\\]*')\s*[,)]/.test(argument)) return null;
  }
  const refs = new Set<string>();
  for (const pattern of REFERENCE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1];
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(raw)) continue;
      const specifier = raw.split(/[?#]/)[0];
      if (!specifier) continue;
      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (
        !specifier.startsWith(".") &&
        !specifier.startsWith("/") &&
        packages.has(packageName)
      )
        continue;
      // Aliases require the bundler's resolver; conservatively use all sources.
      if (/^[@~]/.test(specifier)) return null;
      const resolved = new URL(
        specifier,
        `https://preview.invalid/${path}`,
      ).pathname.slice(1);
      const bases = [
        resolved,
        ...(specifier.startsWith("/") ? [`public/${resolved}`] : []),
      ];
      const candidates = bases
        .flatMap((base) => [
          base,
          ...MODULE_EXTENSIONS.map((ext) => base + ext),
          ...MODULE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
          ...(base.endsWith(".js")
            ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx"]
            : []),
        ])
        .filter((candidate) => Object.hasOwn(files, candidate));
      if (!candidates.length) return null;
      candidates.forEach((candidate) => refs.add(candidate));
    }
  }
  return refs;
}

function pageScopes(design: ProjectDesign): Map<string, Set<string>> {
  return new Map(
    design.pages.map((page) => {
      const paths = new Set(page.filePaths);
      const shared = new Set(page.sharedUiRefs);
      for (const layout of design.layouts) {
        if (layout.id !== page.layoutId && !layout.pageIds.includes(page.id))
          continue;
        layout.filePaths.forEach((path) => paths.add(path));
        layout.sharedUiRefs.forEach((id) => shared.add(id));
      }
      for (const ref of design.sharedUiRefs) {
        if (shared.has(ref.id))
          ref.filePaths.forEach((path) => paths.add(path));
      }
      return [page.id, paths];
    }),
  );
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Display-only source identities. They are not Preview Generations or evidence. */
export async function computeCanvasPreviewSources({
  files,
  assets,
  template,
  previewMode,
  design,
}: {
  /** Browser-safe source, without the injected capture/bridge runtime. */
  files: ProjectFiles;
  assets: ProjectAssets;
  template: string;
  previewMode: ProjectPreviewMode;
  design: ProjectDesign | null;
}): Promise<Record<string, string>> {
  const paths = Object.keys(files).sort();
  const scopes = design
    ? pageScopes(design)
    : new Map([
        [
          "current-preview",
          new Set(paths.filter((path) => !/\.(?:md|txt)$/i.test(path))),
        ],
      ]);
  const owned = new Set([...scopes.values()].flatMap((scope) => [...scope]));
  // Documentation alone does not affect pixels, but imported markdown remains
  // a dependency. Unknown dynamic lookups below fall back to the entire source.
  const common = paths.filter(
    (path) => !owned.has(path) && !/\.(?:md|txt)$/i.test(path),
  );
  const packages = new Set<string>();
  try {
    const pkg = JSON.parse(files["package.json"] ?? "{}");
    [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].forEach((name) => packages.add(name));
  } catch {
    /* An invalid manifest is still part of the source identity. */
  }
  const graph = new Map(
    paths.map((path) => [
      path,
      /\.(?:[cm]?[jt]sx?|vue|svelte|html?|css|s[ac]ss|less)$/i.test(path)
        ? resolveReferences(path, files[path], files, packages)
        : new Set<string>(),
    ]),
  );
  function dependencies(seeds: Iterable<string>): string[] {
    const visited = new Set<string>();
    const pending = [...seeds];
    while (pending.length) {
      const path = pending.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const refs = graph.get(path);
      if (refs === null) return paths;
      refs?.forEach((ref) => pending.push(ref));
    }
    return [...visited].sort();
  }
  const fileDigests = new Map(
    await Promise.all(
      paths.map(async (path) => [path, await digest(files[path])] as const),
    ),
  );
  const environment = JSON.stringify({
    template,
    previewMode,
    assets: Object.entries(assets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, asset]) => [
        key,
        asset.path,
        asset.digest,
        asset.modulePath,
        asset.publicPath,
      ]),
  });
  return Object.fromEntries(
    await Promise.all(
      [...scopes].map(async ([pageId, scope]) => {
        // Missing declarations cannot establish independence from another page.
        const selected =
          !scope.size || [...scope].some((path) => !Object.hasOwn(files, path))
            ? paths
            : dependencies([...common, ...scope]);
        return [
          pageId,
          await digest(
            JSON.stringify([
              environment,
              selected.map((path) => [path, fileDigests.get(path)]),
            ]),
          ),
        ];
      }),
    ),
  );
}
