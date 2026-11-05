import { tool } from "ai";
import { z } from "zod";
import {
  NPM_DEPENDENCY_MAX_KEYS,
  NPM_README_MAX_CHARS,
  NPM_SEARCH_MAX_RESULTS,
  clampInt,
  fetchWithTimeout,
  limitRecord,
  normalizeToolQuery,
  safeErrorMessage,
  truncateText,
} from "./network-guard";

const NPMS_API = "https://api.npms.io/v2";
const NPM_REGISTRY = "https://registry.npmjs.org";
const CACHE_TTL = 10 * 60 * 1000;
const NPM_PACKAGE_NAME_MAX_CHARS = 214;
const NPM_PACKAGE_NAME_RE =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

const cache = new Map<string, { data: unknown; expiry: number }>();

export const NPM_SEARCH_TOOLS = {
  search_npm_packages: tool({
    description:
      "Search npm packages by short keywords. Use when you need to find third-party libraries for specific functionality. " +
      "Returns packages sorted by score with metadata including downloads, quality, and maintenance ratings.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'Search keywords in English, e.g. "react date picker", "markdown parser"',
        ),
      maxResults: z
        .number()
        .optional()
        .describe("Max results to return (default: 5, max: 15)"),
    }),
  }),
  get_npm_package_detail: tool({
    description:
      "Get detailed information about a specific npm package including dependencies, TypeScript support, and README. " +
      "Use when you need to verify package suitability or understand its API.",
    inputSchema: z.object({
      packageName: z
        .string()
        .describe('Package name, e.g. "lodash", "@tanstack/react-query"'),
    }),
  }),
};

async function fetchWithCache<T>(
  url: string,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const cached = cache.get(url);
  if (cached && cached.expiry > Date.now()) return cached.data as T;
  const data = await fetchWithTimeout(
    url,
    {
      headers: { Accept: "application/json" },
      signal,
    },
    undefined,
    async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return (await res.json()) as T;
    },
  );
  cache.set(url, { data, expiry: Date.now() + CACHE_TTL });
  return data;
}

async function searchPackages(
  args: any,
  signal?: AbortSignal,
): Promise<string> {
  const { query, maxResults = 5 } = args;
  const checkedQuery = normalizeToolQuery(query);
  if (!checkedQuery.ok) {
    return JSON.stringify({ success: false, error: checkedQuery.error });
  }
  const size = clampInt(maxResults, 5, 1, NPM_SEARCH_MAX_RESULTS);
  const params = new URLSearchParams({
    q: checkedQuery.query,
    size: String(size),
  });
  try {
    const data = await fetchWithCache<any>(
      `${NPMS_API}/search?${params}`,
      signal,
    );
    const packages = (data.results || []).map((item: any) => ({
      name: item.package.name,
      version: item.package.version,
      description: item.package.description || "",
      keywords: item.package.keywords || [],
      score: {
        final: round(item.score.final),
        quality: round(item.score.detail.quality),
        popularity: round(item.score.detail.popularity),
        maintenance: round(item.score.detail.maintenance),
      },
      links: {
        npm: item.package.links?.npm || "",
        homepage: item.package.links?.homepage,
        repository: item.package.links?.repository,
      },
    }));
    return JSON.stringify({
      success: true,
      data: packages,
      meta: {
        maxResults: size,
        truncatedResults: (data.results || []).length > size,
      },
    });
  } catch (err: any) {
    signal?.throwIfAborted();
    return JSON.stringify({ success: false, error: safeErrorMessage(err) });
  }
}

async function getPackageDetail(
  args: any,
  signal?: AbortSignal,
): Promise<string> {
  const { packageName } = args;
  const checkedName = normalizeNpmPackageName(packageName);
  if (!checkedName.ok) {
    return JSON.stringify({ success: false, error: checkedName.error });
  }
  const encoded = encodeURIComponent(checkedName.name).replace("%40", "@");
  try {
    const registry = await fetchWithCache<any>(
      `${NPM_REGISTRY}/${encoded}`,
      signal,
    );
    const latest =
      registry["dist-tags"]?.latest || Object.keys(registry.versions).pop();
    const pkg = registry.versions[latest];
    if (!pkg)
      return JSON.stringify({ success: false, error: "Package not found" });
    const hasTypes = !!(
      pkg.types ||
      pkg.typings ||
      pkg.dependencies?.["@types/" + checkedName.name.replace(/[@/]/g, "__")]
    );
    const dependencies = limitRecord(pkg.dependencies, NPM_DEPENDENCY_MAX_KEYS);
    const peerDependencies = limitRecord(
      pkg.peerDependencies,
      NPM_DEPENDENCY_MAX_KEYS,
    );
    const readme = truncateText(registry.readme || "", NPM_README_MAX_CHARS);
    const detail = {
      name: checkedName.name,
      version: latest,
      description: pkg.description || "",
      license:
        typeof pkg.license === "string" ? pkg.license : pkg.license?.type,
      homepage: pkg.homepage || registry.homepage,
      repository: extractRepo(pkg.repository),
      keywords: pkg.keywords || [],
      dependencies: dependencies.value,
      dependenciesTruncated: dependencies.truncated,
      peerDependencies: peerDependencies.value,
      peerDependenciesTruncated: peerDependencies.truncated,
      hasTypes,
      readme: readme.text,
      readmeTruncated: readme.truncated,
      versions: Object.keys(registry.versions).slice(-5).reverse(),
    };
    return JSON.stringify({
      success: true,
      data: detail,
      meta: {
        dependencyLimit: NPM_DEPENDENCY_MAX_KEYS,
        readmeLimit: NPM_README_MAX_CHARS,
      },
    });
  } catch (err: any) {
    signal?.throwIfAborted();
    return JSON.stringify({ success: false, error: safeErrorMessage(err) });
  }
}

function normalizeNpmPackageName(
  value: unknown,
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "packageName must be a string" };
  }
  const name = value.trim();
  if (!name) return { ok: false, error: "packageName must not be empty" };
  if (name.length > NPM_PACKAGE_NAME_MAX_CHARS) {
    return {
      ok: false,
      error: `packageName is too long (max ${NPM_PACKAGE_NAME_MAX_CHARS} characters)`,
    };
  }
  if (!NPM_PACKAGE_NAME_RE.test(name) || name.includes("..")) {
    return {
      ok: false,
      error: "packageName must be a valid npm package name",
    };
  }
  return { ok: true, name };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function extractRepo(repo?: string | { url?: string }): string | undefined {
  if (!repo) return undefined;
  if (typeof repo === "string") return repo;
  return repo.url?.replace(/^git\+/, "").replace(/\.git$/, "");
}

export function createNpmSearchToolHandler(): (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<string> {
  return async (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<string> => {
    signal?.throwIfAborted();
    if (name === "search_npm_packages") return searchPackages(args, signal);
    if (name === "get_npm_package_detail")
      return getPackageDetail(args, signal);
    return `Error: unknown tool "${name}"`;
  };
}
