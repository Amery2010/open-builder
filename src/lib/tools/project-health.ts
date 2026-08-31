import type { ProjectFiles } from "../../types";
import type { ToolExecutionContext } from "../ai/generator-types";
import { redactSensitiveText } from "../utils/message-security";
import { truncateText } from "./network-guard";
import {
  CONSOLE_LOG_LIMITS,
  stringifyConsoleItem,
  type ConsoleLog,
} from "./console-log-format";
import {
  runDesignSystemAdherenceCheck,
  type DesignAdherenceInput,
} from "../design/adherence";

export const PROJECT_HEALTH_LIMITS = {
  maxIssues: 20,
  maxConsoleLogs: CONSOLE_LOG_LIMITS.maxLogs,
  maxConsoleMessageChars: CONSOLE_LOG_LIMITS.maxItemChars,
} as const;

export interface ProjectHealthIssue {
  severity: "error" | "warning" | "info";
  category:
    | "files"
    | "dependencies"
    | "environment"
    | "runtime"
    | "html"
    | "accessibility"
    | "responsive"
    | "design_system";
  message: string;
  path?: string;
}

export interface ProjectHealthReport {
  ok: boolean;
  summary: {
    files: number;
    dependencies: number;
    errors: number;
    warnings: number;
    info: number;
    totalIssues: number;
  };
  issues: ProjectHealthIssue[];
  truncated?: boolean;
}

export function runProjectHealthCheck(
  files: ProjectFiles,
  consoleLogs: ConsoleLog[] = [],
  options: {
    includeConsole?: boolean;
    design?: Omit<DesignAdherenceInput, "files">;
  } = {},
): ProjectHealthReport {
  const includeConsole = options.includeConsole !== false;
  const issues: ProjectHealthIssue[] = [];
  const paths = Object.keys(files);

  if (paths.length === 0) {
    issues.push({
      severity: "warning",
      category: "files",
      message: "Project has no files yet.",
    });
  }

  const packagePath = findPackageJsonPath(files);
  let dependencyCount = 0;
  if (!packagePath) {
    const hasStaticHtml = paths.some((path) => path.endsWith("index.html"));
    issues.push({
      severity: hasStaticHtml ? "info" : "warning",
      category: "dependencies",
      message: hasStaticHtml
        ? "No package.json found; project appears to be static HTML."
        : "No package.json found, so dependencies and scripts cannot be checked.",
    });
  } else {
    try {
      const pkg = JSON.parse(files[packagePath]);
      dependencyCount =
        Object.keys(pkg.dependencies ?? {}).length +
        Object.keys(pkg.devDependencies ?? {}).length;
      if (!pkg.scripts || Object.keys(pkg.scripts).length === 0) {
        issues.push({
          severity: "info",
          category: "dependencies",
          path: packagePath,
          message: "package.json has no scripts.",
        });
      }
    } catch (err) {
      issues.push({
        severity: "error",
        category: "dependencies",
        path: packagePath,
        message:
          err instanceof Error
            ? `package.json is invalid JSON: ${err.message}`
            : "package.json is invalid JSON.",
      });
    }
  }

  if (!hasLikelyEntryFile(paths)) {
    issues.push({
      severity: "warning",
      category: "files",
      message:
        "No common entry file found (index.html, src/main.*, src/App.*, App.*, or index.*).",
    });
  }

  const htmlPath = paths.find((path) => path.endsWith("index.html"));
  if (htmlPath) {
    const html = files[htmlPath];
    if (!/<title>.+<\/title>/i.test(html)) {
      issues.push({
        severity: "info",
        category: "html",
        path: htmlPath,
        message: "index.html has no non-empty <title>.",
      });
    }
    if (!/name=["']viewport["']/i.test(html)) {
      issues.push({
        severity: "warning",
        category: "html",
        path: htmlPath,
        message: "index.html is missing a viewport meta tag.",
      });
    }
  }

  inspectAccessibility(files, issues);
  inspectResponsive(files, issues);

  if (options.design) {
    const designReport = runDesignSystemAdherenceCheck({
      files,
      ...options.design,
    });
    issues.push(
      ...designReport.issues.map(({ severity, category, message, path }) => ({
        severity,
        category,
        message,
        ...(path ? { path } : {}),
      })),
    );
  }

  const envExample = files[".env.example"];
  if (envExample) {
    const exampleKeys = parseEnvKeys(envExample);
    const envKeys = parseEnvKeys(files[".env"] ?? "");
    const missing = exampleKeys.filter((key) => !envKeys.includes(key));
    if (missing.length > 0) {
      issues.push({
        severity: "info",
        category: "environment",
        path: ".env",
        message: `Missing local values for ${missing.length} .env.example key(s): ${missing.join(", ")}`,
      });
    }
  }

  if (includeConsole) {
    for (const log of consoleLogs.slice(
      -PROJECT_HEALTH_LIMITS.maxConsoleLogs,
    )) {
      const method = log.method.toLowerCase();
      if (method !== "error" && method !== "warn") continue;
      const text = truncateText(
        redactSensitiveText(
          log.data.map((item) => stringifyConsoleItem(item)).join(" "),
        ),
        PROJECT_HEALTH_LIMITS.maxConsoleMessageChars,
      ).text;
      issues.push({
        severity: method === "error" ? "error" : "warning",
        category: "runtime",
        message: `[${method}] ${text}`,
      });
    }
  }

  const counts = countIssues(issues);
  const sortedIssues = sortIssuesByImpact(issues);
  const visibleIssues = sortedIssues.slice(0, PROJECT_HEALTH_LIMITS.maxIssues);
  const truncated = sortedIssues.length > visibleIssues.length;
  return {
    ok: counts.errors === 0 && counts.warnings === 0,
    summary: {
      files: paths.length,
      dependencies: dependencyCount,
      errors: counts.errors,
      warnings: counts.warnings,
      info: counts.info,
      totalIssues: issues.length,
    },
    issues: visibleIssues,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function createProjectHealthCheckHandler(deps: {
  getFiles: () => ProjectFiles;
  getConsoleLogs: () => ConsoleLog[];
  getDesignContext?: () => Omit<DesignAdherenceInput, "files"> | undefined;
}): (name: string, args: unknown, context?: ToolExecutionContext) => string {
  return (name, args, context) => {
    if (name !== "project_health_check") {
      return `Error: unknown tool "${name}"`;
    }
    const restrictedMode =
      context?.run.mode === "auto_qa" || context?.run.mode === "subagent";
    const includeConsole =
      !restrictedMode &&
      (args as { include_console?: boolean } | undefined)?.include_console !==
        false;
    return JSON.stringify(
      runProjectHealthCheck(deps.getFiles(), deps.getConsoleLogs(), {
        includeConsole,
        design: deps.getDesignContext?.(),
      }),
    );
  };
}

function sortIssuesByImpact(
  issues: ProjectHealthIssue[],
): ProjectHealthIssue[] {
  const severityRank: Record<ProjectHealthIssue["severity"], number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  return [...issues].sort((a, b) => {
    const severityDelta = severityRank[a.severity] - severityRank[b.severity];
    if (severityDelta !== 0) return severityDelta;
    return (
      a.category.localeCompare(b.category) || a.message.localeCompare(b.message)
    );
  });
}

function findPackageJsonPath(files: ProjectFiles): string | undefined {
  return (
    Object.keys(files).find((path) => path === "package.json") ??
    Object.keys(files).find((path) => path.endsWith("/package.json"))
  );
}

function hasLikelyEntryFile(paths: string[]): boolean {
  return paths.some((path) =>
    /(^|\/)(index\.html|src\/main\.[jt]sx?|src\/App\.[jt]sx?|App\.[jt]sx?|index\.[jt]sx?)$/.test(
      path,
    ),
  );
}

function parseEnvKeys(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")).trim())
    .filter(Boolean);
}

function inspectAccessibility(
  files: ProjectFiles,
  issues: ProjectHealthIssue[],
): void {
  let reported = 0;
  for (const [path, content] of Object.entries(files)) {
    if (!isMarkupFile(path)) continue;

    for (const match of content.matchAll(/<img\b([^>]*)>/gi)) {
      const attrs = match[1] ?? "";
      const decorative =
        /\brole\s*=\s*["']presentation["']/i.test(attrs) ||
        /\baria-hidden\s*=\s*{?["']?true["']?}?/i.test(attrs);
      if (!/\balt\s*=/.test(attrs) && !decorative) {
        issues.push({
          severity: "warning",
          category: "accessibility",
          path,
          message: "Image element is missing alt text.",
        });
        reported++;
      }
      if (reported >= 5) return;
    }

    for (const match of content.matchAll(
      /<button\b([^>]*)>([\s\S]*?)<\/button>/gi,
    )) {
      const attrs = match[1] ?? "";
      const body = stripTags(match[2] ?? "").trim();
      const named =
        /\baria-label\s*=/.test(attrs) ||
        /\btitle\s*=/.test(attrs) ||
        /\baria-labelledby\s*=/.test(attrs);
      if (!body && !named) {
        issues.push({
          severity: "warning",
          category: "accessibility",
          path,
          message:
            "Icon-only or empty button is missing aria-label, aria-labelledby, or title.",
        });
        reported++;
      }
      if (reported >= 5) return;
    }
  }
}

function inspectResponsive(
  files: ProjectFiles,
  issues: ProjectHealthIssue[],
): void {
  let reported = 0;
  const fixedWidthPatterns = [
    /\b(?:width|min-width)\s*:\s*(\d{3,5})px/gi,
    /\bw-\[(\d{3,5})px\]/gi,
    /\b(?:width|minWidth)\s*:\s*(\d{3,5})\b/g,
  ];

  for (const [path, content] of Object.entries(files)) {
    if (!isStyleOrMarkupFile(path)) continue;
    for (const pattern of fixedWidthPatterns) {
      for (const match of content.matchAll(pattern)) {
        const width = Number(match[1]);
        if (width < 768) continue;
        issues.push({
          severity: "info",
          category: "responsive",
          path,
          message: `Large fixed width (${width}px) may need a max-width or responsive alternative.`,
        });
        reported++;
        if (reported >= 5) return;
      }
    }
  }
}

function isMarkupFile(path: string): boolean {
  return /\.(html|jsx|tsx|vue|svelte)$/.test(path);
}

function isStyleOrMarkupFile(path: string): boolean {
  return /\.(html|jsx|tsx|vue|svelte|css|scss|sass|less)$/.test(path);
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/[{}()]/g, "");
}

function countIssues(issues: ProjectHealthIssue[]): {
  errors: number;
  warnings: number;
  info: number;
} {
  return issues.reduce(
    (counts, issue) => {
      if (issue.severity === "error") counts.errors++;
      else if (issue.severity === "warning") counts.warnings++;
      else counts.info++;
      return counts;
    },
    { errors: 0, warnings: 0, info: 0 },
  );
}
