import type { ConversationDesignState, ProjectFiles } from "../../types";
import {
  EDITABLE_DESIGN_TOKENS,
  findRootTokensPath,
  inspectDesignTokenContract,
  readEditableTokenValues,
  sameDesignSystemReference,
} from "./tokens";
import type { DesignContract } from "./run-contract";
import type { DesignPreviewSemanticSnapshot } from "./preview-bridge";

export type DesignAdherenceSeverity = "error" | "warning";

export interface DesignAdherenceIssue {
  severity: DesignAdherenceSeverity;
  category: "design_system";
  code:
    | "state_mismatch"
    | "digest_mismatch"
    | "missing_contract_file"
    | "legacy_contract"
    | "tokens_not_loaded"
    | "semantic_group_unused"
    | "runtime_token_missing"
    | "runtime_token_mismatch"
    | "runtime_root_override"
    | "literal_drift"
    | "tailwind_drift"
    | "motion_token_unused";
  message: string;
  path?: string;
  viewport?: string;
}

export interface DesignAdherenceReport {
  ok: boolean;
  summary: { errors: number; warnings: number; totalIssues: number };
  issues: DesignAdherenceIssue[];
  changedUiPaths: string[];
  tokenUsage: Record<
    "color" | "typography" | "shape" | "layout" | "motion",
    string[]
  >;
}

export interface DesignAdherenceInput {
  files: ProjectFiles;
  designState?: ConversationDesignState;
  contract?: DesignContract | null;
  beforeFiles?: ProjectFiles;
  changedPaths?: readonly string[];
  runtimeSnapshots?: readonly DesignPreviewSemanticSnapshot[];
}

const COLOR_TOKENS = new Set([
  "--bg",
  "--surface",
  "--fg",
  "--muted",
  "--border",
  "--accent",
  "--accent-on",
  "--success",
  "--warn",
  "--danger",
]);
const TYPOGRAPHY_TOKENS = new Set(["--font-display", "--font-body"]);
const SHAPE_TOKENS = new Set(["--radius-md"]);
const LAYOUT_TOKENS = new Set(["--section-y-desktop", "--container-max"]);
const MOTION_TOKENS = new Set(["--motion-base"]);

const UI_PATH_PATTERN =
  /(^|\/)(src\/)?(app|pages?|routes?|components?|views?|layouts?|screens?)\/|\.(?:html|css|scss|sass|less|styl|jsx|tsx|vue|svelte|astro)$/i;
const RUNTIME_PATH_PATTERN =
  /\.(?:html|css|scss|sass|less|styl|js|jsx|ts|tsx|vue|svelte|astro)$/i;
const TOKEN_REFERENCE_PATTERN =
  /(?:@import\s+(?:url\()?\s*["']?[^;)"']*tokens\.css|(?:import\s*|require\s*\()\s*["'][^"']*tokens\.css|<link\b[^>]*\bhref\s*=\s*["'][^"']*tokens\.css)/i;
const COLOR_LITERAL_PATTERN =
  /#[\da-f]{3,8}\b|(?:rgb|hsl|oklch|lab|lch)\([^;{}\n]{1,120}\)/gi;
const FONT_LITERAL_PATTERN =
  /font-family\s*:\s*([^;{}\n]{1,160})|fontFamily\s*:\s*["'`]([^"'`\n]{1,160})/gi;
const RADIUS_LITERAL_PATTERN =
  /border-radius\s*:\s*([^;{}\n]{1,80})|borderRadius\s*:\s*(?:["'`]([^"'`\n]{1,80})|([\d.]+))/gi;
const TAILWIND_COLOR_PATTERN =
  /\b(?:bg|text|border|outline|ring|fill|stroke|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)(?:\/\d{1,3})?\b/gi;
const TAILWIND_RADIUS_PATTERN =
  /\brounded(?!-(?:\[var\(|\(--|\[--))(?:-(?:none|sm|md|lg|xl|2xl|3xl|full|\[[^\]]+\]))?\b/gi;
const TAILWIND_DURATION_PATTERN = /\bduration-\d{2,4}\b/gi;
const MOTION_FEATURE_PATTERN =
  /\b(?:transition(?:-duration|-timing-function)?|animation(?:-duration|-timing-function)?|animate-|duration-\d|framer-motion|motion\.|onMouseEnter|onMouseLeave)\b/i;
const MOTION_TOKEN_PATTERN = /var\(--(?:motion|ease|easing)[a-z0-9_-]*\)/i;

function rootPath(files: ProjectFiles, name: string): string | undefined {
  return Object.keys(files).find(
    (path) => !path.includes("/") && path.toLowerCase() === name.toLowerCase(),
  );
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function matches(content: string, pattern: RegExp): Set<string> {
  const result = new Set<string>();
  pattern.lastIndex = 0;
  for (const match of content.matchAll(pattern)) {
    result.add(
      normalized(
        match.slice(1).find((candidate) => candidate !== undefined) ?? match[0],
      ),
    );
  }
  return result;
}

function newMatches(before: string, after: string, pattern: RegExp): string[] {
  const previous = matches(before, pattern);
  return [...matches(after, pattern)].filter((value) => !previous.has(value));
}

function semanticTokenUses(files: ProjectFiles): Set<string> {
  const result = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    if (
      !RUNTIME_PATH_PATTERN.test(path) ||
      path.toLowerCase() === "tokens.css"
    ) {
      continue;
    }
    for (const match of content.matchAll(
      /var\((--[a-z0-9_-]+)(?:\s*,[^)]*)?\)/gi,
    )) {
      result.add(match[1].toLowerCase());
    }
  }
  return result;
}

function groupUsage(uses: ReadonlySet<string>) {
  const used = (tokens: ReadonlySet<string>) =>
    [...tokens].filter((token) => uses.has(token));
  return {
    color: used(COLOR_TOKENS),
    typography: used(TYPOGRAPHY_TOKENS),
    shape: used(SHAPE_TOKENS),
    layout: used(LAYOUT_TOKENS),
    motion: used(MOTION_TOKENS),
  };
}

export function isDesignUiPath(path: string): boolean {
  return (
    (UI_PATH_PATTERN.test(path) ||
      /(^|\/)(?:main|index|app|page|layout|script)\.[jt]s$/i.test(path)) &&
    !/(^|\/)(?:tokens\.css|DESIGN\.md)$/i.test(path) &&
    !/(?:^|\/)node_modules\//.test(path)
  );
}

export function collectChangedUiPaths(
  beforeFiles: ProjectFiles,
  files: ProjectFiles,
): string[] {
  return [...new Set([...Object.keys(beforeFiles), ...Object.keys(files)])]
    .filter((path) => beforeFiles[path] !== files[path] && isDesignUiPath(path))
    .sort();
}

function inspectStateAndPackage(
  input: DesignAdherenceInput,
  issues: DesignAdherenceIssue[],
): string | undefined {
  const { files, designState } = input;
  const designPath = rootPath(files, "DESIGN.md");
  const tokensPath = findRootTokensPath(files);
  const applied = designState?.appliedSystem;
  const selected = designState?.selectedSystem;

  if (selected && applied && !sameDesignSystemReference(selected, applied)) {
    issues.push({
      severity: "error",
      category: "design_system",
      code: "state_mismatch",
      message:
        "Selected and applied Design-system references differ; the applied package must remain authoritative until the selection is committed.",
    });
  }
  if (!applied) {
    if (
      selected &&
      selected.source !== "legacy" &&
      Object.keys(files).length > 0
    ) {
      issues.push({
        severity: "error",
        category: "design_system",
        code: "state_mismatch",
        message:
          "An initialized project has a selected-but-unapplied Design system. Apply it through the trusted host or restore the applied selection.",
      });
    }
    if (designPath && tokensPath) {
      issues.push({
        severity: "error",
        category: "design_system",
        code: "state_mismatch",
        message:
          "Root DESIGN.md and tokens.css exist without an applied Design-system state.",
      });
    } else if (designPath) {
      issues.push({
        severity: "warning",
        category: "design_system",
        code: "legacy_contract",
        path: designPath,
        message:
          "Legacy DESIGN.md is not an applied package contract; keep system_id null until a package is applied.",
      });
    }
    return tokensPath;
  }
  if (applied.source === "legacy") {
    issues.push({
      severity: "warning",
      category: "design_system",
      code: "legacy_contract",
      path: designPath,
      message:
        "The applied Design state is legacy and has no verifiable package digest.",
    });
    return tokensPath;
  }
  if (!designPath || !tokensPath) {
    issues.push({
      severity: "error",
      category: "design_system",
      code: "missing_contract_file",
      path: designPath ?? tokensPath,
      message:
        "An applied Design system requires root DESIGN.md and root tokens.css.",
    });
    return tokensPath;
  }
  if (!applied.digest) {
    issues.push({
      severity: "error",
      category: "design_system",
      code: "digest_mismatch",
      message: "The applied Design-system reference has no package digest.",
    });
  } else {
    for (const path of [designPath, tokensPath]) {
      if (!files[path].includes(`sha256 ${applied.digest}`)) {
        issues.push({
          severity: "error",
          category: "design_system",
          code: "digest_mismatch",
          path,
          message: `The root contract file does not match applied package digest ${applied.digest}.`,
        });
      }
    }
  }
  const inspection = inspectDesignTokenContract(files, designState);
  if (inspection.status === "invalid") {
    issues.push({
      severity: "error",
      category: "design_system",
      code: "missing_contract_file",
      path: inspection.path,
      message: `Root tokens.css is invalid: ${inspection.error}`,
    });
  }
  return tokensPath;
}

function inspectTokenWiringAndUse(
  input: DesignAdherenceInput,
  tokenPath: string | undefined,
  usage: ReturnType<typeof groupUsage>,
  issues: DesignAdherenceIssue[],
): void {
  if (!input.designState?.appliedSystem || !tokenPath) return;
  const loaded = Object.entries(input.files).some(
    ([path, content]) =>
      path !== tokenPath &&
      RUNTIME_PATH_PATTERN.test(path) &&
      TOKEN_REFERENCE_PATTERN.test(content),
  );
  if (!loaded) {
    issues.push({
      severity: "error",
      category: "design_system",
      code: "tokens_not_loaded",
      path: tokenPath,
      message:
        "Root tokens.css is not referenced by any runtime style or application entry.",
    });
  }
  if (
    input.contract?.change_mode !== "create" &&
    input.contract?.change_mode !== "migrate"
  ) {
    return;
  }
  for (const group of ["color", "typography", "shape", "layout"] as const) {
    if (usage[group].length === 0) {
      issues.push({
        severity: "error",
        category: "design_system",
        code: "semantic_group_unused",
        message: `${input.contract.change_mode} must consume at least one ${group} semantic Token in runtime UI.`,
      });
    }
  }
}

function inspectChangedScope(
  input: DesignAdherenceInput,
  changedUiPaths: readonly string[],
  tokenValues: Record<string, string>,
  issues: DesignAdherenceIssue[],
): void {
  const allowedValues = new Set(
    Object.values(tokenValues).map((value) => normalized(value)),
  );
  const beforeFiles = input.beforeFiles ?? {};
  const paths = input.changedPaths
    ? changedUiPaths.filter((path) => input.changedPaths?.includes(path))
    : changedUiPaths;
  for (const path of paths) {
    const before = beforeFiles[path] ?? "";
    const after = input.files[path] ?? "";
    const literalKinds = [
      ["color", COLOR_LITERAL_PATTERN],
      ["font family", FONT_LITERAL_PATTERN],
      ["border radius", RADIUS_LITERAL_PATTERN],
    ] as const;
    for (const [kind, pattern] of literalKinds) {
      const added = newMatches(before, after, pattern).filter(
        (value) => !value.includes("var(--") && !allowedValues.has(value),
      );
      if (added.length > 0) {
        issues.push({
          severity: "warning",
          category: "design_system",
          code: "literal_drift",
          path,
          message: `New ${kind} literal(s) bypass semantic Tokens: ${added.slice(0, 4).join(", ")}.`,
        });
      }
    }

    const fixedClasses = [
      ...newMatches(before, after, TAILWIND_COLOR_PATTERN),
      ...newMatches(before, after, TAILWIND_RADIUS_PATTERN),
      ...newMatches(before, after, TAILWIND_DURATION_PATTERN),
    ];
    if (fixedClasses.length > 0) {
      issues.push({
        severity: "warning",
        category: "design_system",
        code: "tailwind_drift",
        path,
        message: `New fixed Tailwind visual class(es) bypass semantic variables: ${fixedClasses.slice(0, 6).join(", ")}.`,
      });
    }
    if (
      MOTION_FEATURE_PATTERN.test(after) &&
      !MOTION_FEATURE_PATTERN.test(before) &&
      !MOTION_TOKEN_PATTERN.test(after)
    ) {
      issues.push({
        severity: "warning",
        category: "design_system",
        code: "motion_token_unused",
        path,
        message:
          "New interaction or animation does not consume a motion/easing semantic Token.",
      });
    }
  }
}

function inspectRuntimeTokens(
  input: DesignAdherenceInput,
  expected: Record<string, string>,
  issues: DesignAdherenceIssue[],
): void {
  if (!input.designState?.appliedSystem) return;
  for (const snapshot of input.runtimeSnapshots ?? []) {
    const evidence = snapshot.designTokens;
    const viewport = `${snapshot.viewport.width}x${snapshot.viewport.height}`;
    if (!evidence) {
      issues.push({
        severity: "error",
        category: "design_system",
        code: "runtime_token_missing",
        viewport,
        message: `Preview ${viewport} did not provide computed Design Token evidence.`,
      });
      continue;
    }
    for (const token of EDITABLE_DESIGN_TOKENS) {
      const expectedValue = expected[token.property];
      if (!expectedValue) continue;
      const actual = evidence.computed[token.property];
      if (!actual) {
        issues.push({
          severity: "error",
          category: "design_system",
          code: "runtime_token_missing",
          viewport,
          message: `Preview ${viewport} root is missing required Token ${token.property}.`,
        });
      } else if (normalized(actual) !== normalized(expectedValue)) {
        issues.push({
          severity: "error",
          category: "design_system",
          code: "runtime_token_mismatch",
          viewport,
          message: `Preview ${viewport} resolves ${token.property} to "${actual}" instead of "${expectedValue}".`,
        });
      }
      if (evidence.inline[token.property]) {
        issues.push({
          severity: "error",
          category: "design_system",
          code: "runtime_root_override",
          viewport,
          message: `Preview ${viewport} overrides ${token.property} inline on the root element.`,
        });
      }
    }
  }
}

export function runDesignSystemAdherenceCheck(
  input: DesignAdherenceInput,
): DesignAdherenceReport {
  const issues: DesignAdherenceIssue[] = [];
  const beforeFiles = input.beforeFiles ?? input.files;
  const changedUiPaths = input.changedPaths
    ? [...new Set(input.changedPaths.filter(isDesignUiPath))].sort()
    : collectChangedUiPaths(beforeFiles, input.files);
  const tokenPath = inspectStateAndPackage(input, issues);
  const uses = semanticTokenUses(input.files);
  const usage = groupUsage(uses);
  inspectTokenWiringAndUse(input, tokenPath, usage, issues);
  const tokenValues = tokenPath
    ? (readEditableTokenValues(input.files[tokenPath]) as Record<
        string,
        string
      >)
    : {};
  inspectChangedScope(input, changedUiPaths, tokenValues, issues);
  inspectRuntimeTokens(input, tokenValues, issues);
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  return {
    ok: errors === 0 && warnings === 0,
    summary: { errors, warnings, totalIssues: issues.length },
    issues,
    changedUiPaths,
    tokenUsage: usage,
  };
}
