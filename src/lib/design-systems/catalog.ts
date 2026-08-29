import catalogData from "./catalog.json";

export type DesignSystemCategory =
  "marketing" | "product" | "editorial" | "mixed";

export interface LocalizedDesignSystemText {
  en: string;
  zh: string;
}

export interface BundledDesignSystemEntry {
  id: string;
  name: string;
  previewPath: string;
  category: DesignSystemCategory;
  tags: string[];
  bestFor: LocalizedDesignSystemText;
  avoidFor: LocalizedDesignSystemText;
}

export const BUNDLED_DESIGN_SYSTEM_VERSION = "2.0.0";
export const CUSTOM_DESIGN_SYSTEM_PREVIEW_PATH =
  "/design-systems/previews/custom.webp";

export const BUNDLED_DESIGN_SYSTEMS = Object.freeze(
  catalogData as BundledDesignSystemEntry[],
);

export function getBundledDesignSystem(
  id: string,
): BundledDesignSystemEntry | undefined {
  return BUNDLED_DESIGN_SYSTEMS.find((entry) => entry.id === id);
}
