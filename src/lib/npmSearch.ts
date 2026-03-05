import type { ToolDefinition } from "./generator";

const NPMS_API = "https://api.npms.io/v2";
const NPM_REGISTRY = "https://registry.npmjs.org";
const CACHE_TTL = 10 * 60 * 1000;

const cache = new Map<string, { data: unknown; expiry: number }>();

export const NPM_SEARCH_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_npm_packages",
      description:
        "Search npm packages by short keywords. Use when you need to find third-party libraries for specific functionality. " +
        "Returns packages sorted by score with metadata including downloads, quality, and maintenance ratings.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Search keywords in English, e.g. "react date picker", "markdown parser"',
          },
          maxResults: {
            type: "number",
            description: "Max results to return (default: 5, max: 15)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_npm_package_detail",
      description:
        "Get detailed information about a specific npm package including dependencies, TypeScript support, and README. " +
        "Use when you need to verify package suitability or understand its API.",
      parameters: {
        type: "object",
        properties: {
          packageName: {
            type: "string",
            description: 'Package name, e.g. "lodash", "@tanstack/react-query"',
          },
        },
        required: ["packageName"],
      },
    },
  },
];

async function fetchWithCache<T>(url: string): Promise<T> {
  const cached = cache.get(url);
  if (cached && cached.expiry > Date.now()) return cached.data as T;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as T;
  cache.set(url, { data, expiry: Date.now() + CACHE_TTL });
  return data;
}

async function searchPackages(args: any): Promise<string> {
  const { query, maxResults = 5 } = args;
  const size = Math.min(Math.max(maxResults, 1), 15);
  const params = new URLSearchParams({
    q: query,
    size: String(size),
  });
  try {
    const data = await fetchWithCache<any>(`${NPMS_API}/search?${params}`);
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
    return JSON.stringify({ success: true, data: packages });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

async function getPackageDetail(args: any): Promise<string> {
  const { packageName } = args;
  const encoded = encodeURIComponent(packageName).replace("%40", "@");
  try {
    const registry = await fetchWithCache<any>(`${NPM_REGISTRY}/${encoded}`);
    const latest =
      registry["dist-tags"]?.latest || Object.keys(registry.versions).pop();
    const pkg = registry.versions[latest];
    if (!pkg)
      return JSON.stringify({ success: false, error: "Package not found" });
    const hasTypes = !!(
      pkg.types ||
      pkg.typings ||
      pkg.dependencies?.["@types/" + packageName.replace(/[@/]/g, "__")]
    );
    const detail = {
      name: packageName,
      version: latest,
      description: pkg.description || "",
      license:
        typeof pkg.license === "string" ? pkg.license : pkg.license?.type,
      homepage: pkg.homepage || registry.homepage,
      repository: extractRepo(pkg.repository),
      keywords: pkg.keywords || [],
      dependencies: pkg.dependencies || {},
      peerDependencies: pkg.peerDependencies || {},
      hasTypes,
      readme: (registry.readme || "").slice(0, 2000),
      versions: Object.keys(registry.versions).slice(-5).reverse(),
    };
    return JSON.stringify({ success: true, data: detail });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
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
) => Promise<string> {
  return async (name: string, args: unknown): Promise<string> => {
    if (name === "search_npm_packages") return searchPackages(args);
    if (name === "get_npm_package_detail") return getPackageDetail(args);
    return `Error: unknown tool "${name}"`;
  };
}
