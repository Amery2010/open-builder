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

import {
  runStaticProjectHealthCheck,
  STATIC_PROJECT_HEALTH_LIMITS,
  type ProjectHealthIssue,
  type ProjectHealthReport,
} from "@open-builder/core";
export type {
  ProjectHealthIssue,
  ProjectHealthReport,
} from "@open-builder/core";

export const PROJECT_HEALTH_LIMITS = {
  maxIssues: STATIC_PROJECT_HEALTH_LIMITS.maxIssues,
  maxConsoleLogs: CONSOLE_LOG_LIMITS.maxLogs,
  maxConsoleMessageChars: CONSOLE_LOG_LIMITS.maxItemChars,
} as const;

export function runProjectHealthCheck(
  files: ProjectFiles,
  consoleLogs: ConsoleLog[] = [],
  options: {
    includeConsole?: boolean;
    design?: Omit<DesignAdherenceInput, "files">;
  } = {},
): ProjectHealthReport {
  const additionalIssues: ProjectHealthIssue[] = [];
  if (options.design) {
    const designReport = runDesignSystemAdherenceCheck({
      files,
      ...options.design,
    });
    additionalIssues.push(
      ...designReport.issues.map(({ severity, category, message, path }) => ({
        severity,
        category,
        message,
        ...(path ? { path } : {}),
      })),
    );
  }
  if (options.includeConsole !== false) {
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
      additionalIssues.push({
        severity: method === "error" ? "error" : "warning",
        category: "runtime",
        message: `[${method}] ${text}`,
      });
    }
  }
  return runStaticProjectHealthCheck(files, { additionalIssues });
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
