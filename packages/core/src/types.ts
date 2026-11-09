export type ProjectFiles = Record<string, string>;

export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
}

export type DesignSystemSource = "builtin" | "imported" | "custom" | "legacy";

export interface DesignSystemRef {
  id: string;
  name: string;
  source: DesignSystemSource;
  version: string;
  /** SHA-256 of the source package; optional for legacy references. */
  digest?: string;
}
