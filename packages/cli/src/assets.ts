import { readFile } from "node:fs/promises";
import {
  validateDesignSystemPackage,
  type DesignSystemPackage,
} from "@open-builder/core";

export interface DesignSystemDescriptor {
  id: string;
  name: string;
  category: string;
  bestFor: { en: string; zh: string };
  version: string;
  digest: string;
}

const assetsRoot = new URL("../assets/design-systems/", import.meta.url);

export async function listDesignSystems(): Promise<DesignSystemDescriptor[]> {
  const entries = JSON.parse(
    await readFile(new URL("catalog.json", assetsRoot), "utf8"),
  ) as DesignSystemDescriptor[];
  return entries.map(({ id, name, category, bestFor, version, digest }) => ({
    id,
    name,
    category,
    bestFor,
    version,
    digest,
  }));
}

export async function loadDesignSystem(
  id: string,
): Promise<DesignSystemPackage> {
  const entry = (await listDesignSystems()).find((item) => item.id === id);
  if (!entry || !/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`Unknown design system "${id}". Use design list.`);
  }
  const files = await Promise.all(
    ["manifest.json", "DESIGN.md", "tokens.css"].map(async (path) => ({
      path,
      content: await readFile(new URL(`${id}/${path}`, assetsRoot), "utf8"),
    })),
  );
  return validateDesignSystemPackage(files, {
    source: "builtin",
    version: entry.version,
    expectedDigest: entry.digest,
  });
}
