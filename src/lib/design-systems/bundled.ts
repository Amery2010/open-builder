import {
  BUNDLED_DESIGN_SYSTEM_VERSION,
  getBundledDesignSystem,
} from "./catalog";
import {
  validateDesignSystemPackage,
  type DesignSystemPackage,
} from "./validation";

interface RuntimeCatalogEntry {
  id: string;
  digest: string;
  version: string;
  files: { manifest: string; design: string; tokens: string };
}

type TextFetcher = (path: string) => Promise<string>;

function assetPath(path: string): string {
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${base}design-systems/${path}`;
}

async function defaultTextFetcher(path: string): Promise<string> {
  const response = await fetch(assetPath(path), {
    headers: { Accept: "text/plain, application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to load bundled design system: HTTP ${response.status}.`,
    );
  }
  return response.text();
}

export async function loadBundledDesignSystem(
  id: string,
  fetchText: TextFetcher = defaultTextFetcher,
): Promise<DesignSystemPackage> {
  if (!getBundledDesignSystem(id)) {
    throw new Error(`Unknown bundled design system "${id}".`);
  }
  const runtimeCatalog = JSON.parse(
    await fetchText("catalog.json"),
  ) as RuntimeCatalogEntry[];
  const entry = runtimeCatalog.find((candidate) => candidate.id === id);
  if (!entry || entry.version !== BUNDLED_DESIGN_SYSTEM_VERSION) {
    throw new Error(
      `Bundled design-system metadata is unavailable for "${id}".`,
    );
  }
  const [manifestText, design, tokens] = await Promise.all([
    fetchText(entry.files.manifest),
    fetchText(entry.files.design),
    fetchText(entry.files.tokens),
  ]);
  return validateDesignSystemPackage(
    [
      { path: "manifest.json", content: manifestText },
      { path: "DESIGN.md", content: design },
      { path: "tokens.css", content: tokens },
    ],
    {
      source: "builtin",
      version: BUNDLED_DESIGN_SYSTEM_VERSION,
      expectedDigest: entry.digest,
    },
  );
}
