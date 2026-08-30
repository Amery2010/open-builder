import type {
  ConversationDesignState,
  DesignSystemRef,
  ProjectFiles,
} from "../../types";
import { validateSemanticTokensCss } from "../design-systems/validation";

export type EditableTokenGroup =
  "colors" | "typography" | "shape" | "layout" | "motion";

export interface EditableTokenDefinition {
  property: string;
  labelKey:
    | "background"
    | "surface"
    | "foreground"
    | "muted"
    | "border"
    | "accent"
    | "accentOn"
    | "success"
    | "warning"
    | "danger"
    | "displayFont"
    | "bodyFont"
    | "radius"
    | "sectionSpacing"
    | "containerWidth"
    | "motionDuration";
  group: EditableTokenGroup;
}

export const EDITABLE_DESIGN_TOKENS: readonly EditableTokenDefinition[] = [
  { property: "--bg", labelKey: "background", group: "colors" },
  { property: "--surface", labelKey: "surface", group: "colors" },
  { property: "--fg", labelKey: "foreground", group: "colors" },
  { property: "--muted", labelKey: "muted", group: "colors" },
  { property: "--border", labelKey: "border", group: "colors" },
  { property: "--accent", labelKey: "accent", group: "colors" },
  { property: "--accent-on", labelKey: "accentOn", group: "colors" },
  { property: "--success", labelKey: "success", group: "colors" },
  { property: "--warn", labelKey: "warning", group: "colors" },
  { property: "--danger", labelKey: "danger", group: "colors" },
  { property: "--font-display", labelKey: "displayFont", group: "typography" },
  { property: "--font-body", labelKey: "bodyFont", group: "typography" },
  { property: "--radius-md", labelKey: "radius", group: "shape" },
  {
    property: "--section-y-desktop",
    labelKey: "sectionSpacing",
    group: "layout",
  },
  { property: "--container-max", labelKey: "containerWidth", group: "layout" },
  { property: "--motion-base", labelKey: "motionDuration", group: "motion" },
];

export type EditableTokenValues = Partial<Record<string, string>>;

export type DesignTokenContractInspection =
  | {
      status: "ready";
      path: string;
      source: string;
      appliedSystem: DesignSystemRef;
    }
  | {
      status: "selected-unapplied";
      selectedSystem: DesignSystemRef;
      appliedSystem?: DesignSystemRef;
    }
  | {
      status: "missing";
      appliedSystem?: DesignSystemRef;
    }
  | {
      status: "invalid";
      path: string;
      error: string;
      appliedSystem: DesignSystemRef;
    }
  | {
      status: "legacy";
      appliedSystem?: DesignSystemRef;
    };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenPattern(property: string): RegExp {
  return new RegExp(`(${escapeRegExp(property)}\\s*:\\s*)([^;{}]+)(;)`, "i");
}

export function findRootTokensPath(files: ProjectFiles): string | undefined {
  return Object.keys(files).find(
    (path) => !path.includes("/") && path.toLowerCase() === "tokens.css",
  );
}

export function sameDesignSystemReference(
  first: DesignSystemRef | undefined,
  second: DesignSystemRef | undefined,
): boolean {
  return (
    !!first &&
    !!second &&
    first.id === second.id &&
    first.digest === second.digest
  );
}

export function inspectDesignTokenContract(
  files: ProjectFiles,
  designState: ConversationDesignState | undefined,
): DesignTokenContractInspection {
  const selectedSystem = designState?.selectedSystem;
  const appliedSystem = designState?.appliedSystem;
  if (
    selectedSystem &&
    selectedSystem.source !== "legacy" &&
    !sameDesignSystemReference(selectedSystem, appliedSystem)
  ) {
    return { status: "selected-unapplied", selectedSystem, appliedSystem };
  }
  if (
    selectedSystem?.source === "legacy" ||
    appliedSystem?.source === "legacy"
  ) {
    return { status: "legacy", appliedSystem };
  }
  if (!appliedSystem) return { status: "missing" };
  const path = findRootTokensPath(files);
  if (!path) return { status: "missing", appliedSystem };
  const source = files[path];
  try {
    validateSemanticTokensCss(source);
  } catch (error) {
    return {
      status: "invalid",
      path,
      error: error instanceof Error ? error.message : String(error),
      appliedSystem,
    };
  }
  return { status: "ready", path, source, appliedSystem };
}

export function readEditableTokenValues(css: string): EditableTokenValues {
  const values: EditableTokenValues = {};
  for (const definition of EDITABLE_DESIGN_TOKENS) {
    const match = tokenPattern(definition.property).exec(css);
    if (match) values[definition.property] = match[2].trim();
  }
  return values;
}

function validateTokenValue(property: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240) {
    throw new Error(
      `${property} must contain a value of at most 240 characters.`,
    );
  }
  if (
    /[;{}<>]|@(?:import|supports|media|layer|keyframes)|url\s*\(|expression\s*\(|javascript\s*:/i.test(
      trimmed,
    )
  ) {
    throw new Error(`${property} contains an unsupported CSS value.`);
  }
  let depth = 0;
  for (const character of trimmed) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0) throw new Error(`${property} has unbalanced parentheses.`);
  }
  if (depth !== 0) throw new Error(`${property} has unbalanced parentheses.`);
  return trimmed;
}

export function writeEditableTokenValues(
  css: string,
  changes: EditableTokenValues,
): string {
  let output = css;
  const allowed = new Set(
    EDITABLE_DESIGN_TOKENS.map((token) => token.property),
  );
  for (const [property, rawValue] of Object.entries(changes)) {
    if (!allowed.has(property) || rawValue === undefined) {
      throw new Error(`Token ${property} is not editable.`);
    }
    const pattern = tokenPattern(property);
    if (!pattern.test(output)) {
      throw new Error(`tokens.css does not declare ${property}.`);
    }
    const value = validateTokenValue(property, rawValue);
    output = output.replace(
      pattern,
      (_match, prefix: string, _previous: string, suffix: string) =>
        `${prefix}${value}${suffix}`,
    );
  }
  validateSemanticTokensCss(output);
  return output;
}
