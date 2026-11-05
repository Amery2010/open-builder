import { tool } from "ai";
import { z } from "zod";
import type { ProjectFiles, FileChange } from "../ai/generator-types";
import { basename } from "./file-refs";
import { normalizeProjectPath, validateProjectFileContent } from "./fs-tools";
import {
  fetchWithTimeout,
  readResponseTextWithLimit,
  safeErrorMessage,
} from "./network-guard";
import {
  isAuthorityFilePath,
  isSensitiveProjectPath,
} from "../utils/project-file-policy";
import type { ToolExecutionContext } from "../ai/generator-types";

const DEFAULT_REGISTRY_BASE = "https://ui.shadcn.com/r";
const DEFAULT_STYLE = "styles/new-york";
const INSTALL_COMPONENT_LIMITS = {
  maxRegistryItems: 50,
  maxFiles: 120,
  maxComponentNameChars: 100,
  maxRegistryItemBytes: 2 * 1024 * 1024,
  maxRegistryAggregateBytes: 8 * 1024 * 1024,
} as const;
const REGISTRY_ITEM_NAME_RE = /^[a-z0-9][a-z0-9/_-]*$/i;
const NPM_DEPENDENCY_NAME_RE =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

interface RegistryItem {
  name: string;
  type?: string;
  dependencies?: string[];
  devDependencies?: string[];
  registryDependencies?: string[];
  files?: Array<{
    path: string;
    content?: string;
    type?: string;
    target?: string;
  }>;
  tailwind?: { config?: Record<string, unknown> };
  cssVars?: Record<string, Record<string, string>>;
}

export const INSTALL_COMPONENT_TOOL = {
  install_component: tool({
    description:
      "Install a shadcn/ui component (or third-party shadcn-compatible registry component) by name. " +
      "Auto-fetches component code, recursively resolves registryDependencies, merges npm dependencies " +
      "into package.json, and writes files to src/components/ui/ (or as specified by the registry). " +
      "Use this instead of hand-writing shadcn components — it guarantees correct deps and paths.",
    inputSchema: z.object({
      name: z
        .string()
        .describe("Component name, e.g. 'button', 'dialog', 'data-table'"),
      registry_url: z
        .string()
        .optional()
        .describe(
          "Custom registry base URL (without trailing slash or style suffix). " +
            "Defaults to https://ui.shadcn.com/r (which serves /styles/new-york/<name>.json).",
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe(
          "Overwrite if a target file already exists. Default: false (existing files are kept).",
        ),
    }),
  }),
};

export interface InstallComponentDeps {
  getFiles: () => ProjectFiles;
  onFilesChanged: (newFiles: ProjectFiles, changes: FileChange[]) => void;
  approveRegistryOrigin?: (
    origin: string,
    context: ToolExecutionContext,
  ) => Promise<boolean>;
}

interface InstallArgs {
  name: string;
  registry_url?: string;
  overwrite?: boolean;
}

function buildItemUrl(base: string, name: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (/\/styles\/[\w-]+$/.test(trimmed)) {
    return `${trimmed}/${name}.json`;
  }
  return `${trimmed}/${DEFAULT_STYLE}/${name}.json`;
}

function normalizeRegistryItemName(
  value: unknown,
  label = "name",
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: `${label} must be a string` };
  }
  const name = value.trim();
  if (!name) return { ok: false, error: `${label} must not be empty` };
  if (name.length > INSTALL_COMPONENT_LIMITS.maxComponentNameChars) {
    return {
      ok: false,
      error: `${label} is too long (max ${INSTALL_COMPONENT_LIMITS.maxComponentNameChars} characters)`,
    };
  }
  if (
    !REGISTRY_ITEM_NAME_RE.test(name) ||
    name.includes("..") ||
    name.includes("//")
  ) {
    return { ok: false, error: `${label} must be a safe registry item name` };
  }
  return { ok: true, name };
}

function normalizeRegistryBase(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isLoopbackRegistryHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return (
    !!match &&
    match.slice(1).every((part) => Number(part) <= 255) &&
    match[1] === "127"
  );
}

interface FetchedRegistryItem {
  item: RegistryItem;
  responseBytes: number;
}

async function fetchRegistryItem(
  base: string,
  name: string,
  signal?: AbortSignal,
): Promise<FetchedRegistryItem | { error: string }> {
  const url = buildItemUrl(base, name);
  const expectedOrigin = new URL(base).origin;
  try {
    const { res, body } = await fetchWithTimeout(
      url,
      {
        headers: { Accept: "application/json" },
        signal,
        redirect: "error",
      },
      undefined,
      async (res) => ({
        res,
        body:
          res.ok && (!res.url || new URL(res.url).origin === expectedOrigin)
            ? await readResponseTextWithLimit(
                res,
                INSTALL_COMPONENT_LIMITS.maxRegistryItemBytes,
                "Component registry response",
              )
            : "",
      }),
    );
    if (!res.ok) {
      if (res.status === 404) {
        return {
          error: `component "${name}" not found in registry (HTTP 404 at ${url})`,
        };
      }
      return { error: `HTTP ${res.status} fetching ${url}` };
    }
    if (res.url && new URL(res.url).origin !== expectedOrigin) {
      return { error: "component registry redirected to an unapproved origin" };
    }
    let json: RegistryItem;
    try {
      json = JSON.parse(body) as RegistryItem;
    } catch {
      return { error: `invalid JSON response from ${url}` };
    }
    if (!json || typeof json !== "object") {
      return { error: `invalid JSON response from ${url}` };
    }
    return {
      item: json,
      responseBytes: new TextEncoder().encode(body).byteLength,
    };
  } catch (err: any) {
    signal?.throwIfAborted();
    return { error: `fetch failed for ${url}: ${safeErrorMessage(err)}` };
  }
}

function mapTargetPath(
  file: { path: string; target?: string },
  componentName: string,
): string {
  if (file.target && file.target.trim()) {
    return file.target.replace(/^\/+/, "");
  }
  const p = file.path.replace(/^\/+/, "");
  if (p.startsWith("ui/")) return `src/components/${p}`;
  if (p.startsWith("hooks/")) return `src/${p}`;
  if (p.startsWith("lib/")) return `src/${p}`;
  if (p.startsWith("components/")) return `src/${p}`;
  return `src/components/${componentName}/${basename(p)}`;
}

function mergePackageJson(
  existing: string | undefined,
  npmDeps: Set<string>,
  devDeps: Set<string>,
): { content: string; changed: boolean } | { error: string } {
  let parsed: Record<string, any>;
  if (existing) {
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { error: "existing package.json is not valid JSON" };
    }
  } else {
    parsed = {
      name: "app",
      version: "0.0.0",
      dependencies: {},
      devDependencies: {},
    };
  }

  parsed.dependencies = parsed.dependencies ?? {};
  parsed.devDependencies = parsed.devDependencies ?? {};

  let changed = false;
  for (const dep of npmDeps) {
    if (!parsed.dependencies[dep]) {
      parsed.dependencies[dep] = "latest";
      changed = true;
    }
  }
  for (const dep of devDeps) {
    if (!parsed.devDependencies[dep] && !parsed.dependencies[dep]) {
      parsed.devDependencies[dep] = "latest";
      changed = true;
    }
  }

  return { content: JSON.stringify(parsed, null, 2) + "\n", changed };
}

export function createInstallComponentHandler(deps: InstallComponentDeps) {
  const approvedOrigins = new Set([new URL(DEFAULT_REGISTRY_BASE).origin]);
  return async (
    _name: string,
    args: unknown,
    context?: ToolExecutionContext,
  ): Promise<string> => {
    const parsed = args as InstallArgs;
    const checkedComponentName = normalizeRegistryItemName(parsed?.name);
    if (!checkedComponentName.ok) {
      return JSON.stringify({ ok: false, error: checkedComponentName.error });
    }
    const componentName = checkedComponentName.name;

    const base = normalizeRegistryBase(
      parsed.registry_url || DEFAULT_REGISTRY_BASE,
    );
    if (!base) {
      return JSON.stringify({
        ok: false,
        error: "registry_url must be an http(s) URL",
      });
    }
    const registryOrigin = new URL(base).origin;
    const registryUrl = new URL(base);
    if (
      registryUrl.protocol !== "https:" &&
      !isLoopbackRegistryHost(registryUrl.hostname)
    ) {
      return JSON.stringify({
        ok: false,
        error: "custom non-loopback registries must use HTTPS",
      });
    }
    if (!approvedOrigins.has(registryOrigin)) {
      if (!context || !deps.approveRegistryOrigin) {
        return JSON.stringify({
          ok: false,
          error: `custom registry origin "${registryOrigin}" requires user approval`,
        });
      }
      if (!(await deps.approveRegistryOrigin(registryOrigin, context))) {
        return JSON.stringify({
          ok: false,
          error: `custom registry origin "${registryOrigin}" was denied`,
        });
      }
      approvedOrigins.add(registryOrigin);
    }
    const overwrite = parsed.overwrite ?? false;

    const visited = new Set<string>();
    let layer = [componentName];
    const items: RegistryItem[] = [];
    let registryResponseBytes = 0;
    while (layer.length > 0) {
      const toFetch = layer.filter((n) => !visited.has(n));
      for (const n of toFetch) visited.add(n);
      if (visited.size > INSTALL_COMPONENT_LIMITS.maxRegistryItems) {
        return JSON.stringify({
          ok: false,
          error: `too many registry dependencies (max ${INSTALL_COMPONENT_LIMITS.maxRegistryItems})`,
        });
      }
      const nextLayer: string[] = [];
      for (const itemName of toFetch) {
        const fetched = await fetchRegistryItem(
          base,
          itemName,
          context?.signal,
        );
        if ("error" in fetched) {
          return JSON.stringify({ ok: false, error: fetched.error });
        }
        registryResponseBytes += fetched.responseBytes;
        if (
          registryResponseBytes >
          INSTALL_COMPONENT_LIMITS.maxRegistryAggregateBytes
        ) {
          return JSON.stringify({
            ok: false,
            error:
              "component registry dependency graph exceeds aggregate response budget",
          });
        }
        const item = fetched.item;
        items.push(item);
        if (
          item.registryDependencies != null &&
          !Array.isArray(item.registryDependencies)
        ) {
          return JSON.stringify({
            ok: false,
            error: "registryDependencies must be an array",
          });
        }
        for (const sub of item.registryDependencies ?? []) {
          const checkedSub = normalizeRegistryItemName(
            sub,
            "registryDependency",
          );
          if (!checkedSub.ok) {
            return JSON.stringify({ ok: false, error: checkedSub.error });
          }
          if (!visited.has(checkedSub.name)) nextLayer.push(checkedSub.name);
        }
      }
      layer = nextLayer;
    }

    const npmDeps = new Set<string>();
    const devDeps = new Set<string>();
    for (const item of items) {
      if (item.dependencies != null && !Array.isArray(item.dependencies)) {
        return JSON.stringify({
          ok: false,
          error: "dependencies must be an array",
        });
      }
      if (
        item.devDependencies != null &&
        !Array.isArray(item.devDependencies)
      ) {
        return JSON.stringify({
          ok: false,
          error: "devDependencies must be an array",
        });
      }
      for (const d of item.dependencies ?? []) {
        if (typeof d !== "string" || !NPM_DEPENDENCY_NAME_RE.test(d)) {
          return JSON.stringify({
            ok: false,
            error: `invalid dependency name "${d}"`,
          });
        }
        npmDeps.add(d);
      }
      for (const d of item.devDependencies ?? []) {
        if (typeof d !== "string" || !NPM_DEPENDENCY_NAME_RE.test(d)) {
          return JSON.stringify({
            ok: false,
            error: `invalid devDependency name "${d}"`,
          });
        }
        devDeps.add(d);
      }
    }

    const files = deps.getFiles();
    const newFiles: ProjectFiles = { ...files };
    const changes: FileChange[] = [];
    const writtenPaths: string[] = [];
    const skippedPaths: string[] = [];
    let registryFileCount = 0;

    for (const item of items) {
      for (const f of item.files ?? []) {
        if (typeof f.content !== "string") continue;
        registryFileCount++;
        if (registryFileCount > INSTALL_COMPONENT_LIMITS.maxFiles) {
          return JSON.stringify({
            ok: false,
            error: `component writes too many files (max ${INSTALL_COMPONENT_LIMITS.maxFiles})`,
          });
        }
        const rawTargetPath = mapTargetPath(f, item.name);
        const checkedPath = normalizeProjectPath(rawTargetPath);
        if (!checkedPath.ok) {
          return JSON.stringify({ ok: false, error: checkedPath.error });
        }
        if (isAuthorityFilePath(checkedPath.path)) {
          return JSON.stringify({
            ok: false,
            error: `component registry cannot write project authority file "${checkedPath.path}"`,
          });
        }
        if (isSensitiveProjectPath(checkedPath.path)) {
          return JSON.stringify({
            ok: false,
            error: `component registry cannot write protected file "${checkedPath.path}"`,
          });
        }
        const checkedContent = validateProjectFileContent(f.content);
        if (!checkedContent.ok) {
          return JSON.stringify({ ok: false, error: checkedContent.error });
        }
        const targetPath = checkedPath.path;
        if (targetPath in newFiles && !overwrite) {
          skippedPaths.push(targetPath);
          continue;
        }
        const action: FileChange["action"] =
          targetPath in files ? "modified" : "created";
        newFiles[targetPath] = checkedContent.content;
        changes.push({ path: targetPath, action });
        writtenPaths.push(targetPath);
      }
    }

    const pkgPath =
      Object.keys(newFiles).find(
        (p) => p === "package.json" || p.endsWith("/package.json"),
      ) || "package.json";
    const pkgMerge = mergePackageJson(newFiles[pkgPath], npmDeps, devDeps);
    if ("error" in pkgMerge) {
      return JSON.stringify({ ok: false, error: pkgMerge.error });
    }
    let dependenciesChanged = false;
    if (pkgMerge.changed) {
      const checkedPkg = validateProjectFileContent(pkgMerge.content);
      if (!checkedPkg.ok) {
        return JSON.stringify({
          ok: false,
          error: `package.json ${checkedPkg.error}`,
        });
      }
      const action: FileChange["action"] =
        pkgPath in files ? "modified" : "created";
      newFiles[pkgPath] = checkedPkg.content;
      changes.push({ path: pkgPath, action });
      dependenciesChanged = true;
    }

    deps.onFilesChanged(newFiles, changes);

    const installedNames = items.map((i) => i.name);
    return JSON.stringify({
      ok: true,
      installed: installedNames,
      writtenFiles: writtenPaths,
      skippedFiles: skippedPaths,
      packageJsonUpdated: dependenciesChanged,
      addedDependencies: Array.from(npmDeps),
      addedDevDependencies: Array.from(devDeps),
    });
  };
}
