import type { ToolSet } from "ai";
import {
  SEARCH_TOOLS,
  WEB_READER_TOOL,
  createSearchToolHandler,
  createJinaReaderHandler,
} from "./search";
import {
  ASSET_SEARCH_TOOLS,
  createAssetSearchToolHandler,
} from "./asset-search";
import { NPM_SEARCH_TOOLS, createNpmSearchToolHandler } from "./npm-search";
import {
  MEMORY_TOOLS,
  MEMORY_TOOL_NAME,
  createMemoryToolHandler,
  type MemoryDeps,
} from "./memory";
import { DISPATCH_SUBAGENT_TOOL } from "./subagent-tool";
import { getSkillTools, SKILL_TOOL_NAME_SET } from "../skills/tools";
import { createSkillToolHandler } from "../skills/tool-handler";
import { getSkillRegistry } from "../skills/instance";
import { isSkillsAvailable } from "../skills/fs";
import {
  INSTALL_COMPONENT_TOOL,
  createInstallComponentHandler,
} from "./install-component";
import {
  SCREENSHOT_TO_CODE_TOOL,
  createScreenshotToCodeHandler,
} from "./screenshot-to-code";
import {
  APPLY_DESIGN_STYLE_TOOL,
  createApplyDesignStyleHandler,
} from "./design-styles";
import { createProjectHealthCheckHandler } from "./project-health";
import { PROJECT_HEALTH_CHECK_TOOL } from "./project-health-tool";
import { formatConsoleLogs, type ConsoleLog } from "./console-log-format";
import { getBuiltinSearchConfig } from "../ai/provider";
import type { ApiType } from "../ai/provider";
import type {
  WebSearchSettings,
  AssetSearchSettings,
  ProjectFiles,
} from "../../types";
import type {
  FileChange,
  GeneratorOptions,
  ToolExecutionContext,
  ToolExecutionOutput,
} from "../ai/generator-types";
import { validateProjectFiles } from "../utils/project-files";
import { detectRuntimePlatform } from "../runtime/platform";
import {
  DESIGN_DIAGNOSTIC_TOOLS,
  DESIGN_HOST_TOOLS,
  PREVIEW_CAPTURE_TOOLS,
  type RuntimePlatform,
} from "../ai/tools-schema";
import type { DesignDiagnosticToolName } from "../design/diagnostics";
import {
  createSubmitDesignReviewHandler,
  type DesignReviewReport,
} from "../design/review";
import { SUBMIT_DESIGN_REVIEW_TOOL } from "../design/review-tool";
import type { DesignAdherenceInput } from "../design/adherence";
import {
  applyProjectDesignToolRequest,
  PROJECT_DESIGN_PATH,
} from "../design/project-design";

export interface ToolFeatures {
  builtinSearch: boolean;
  webSearch: boolean;
  assetSearch: boolean;
  localAgent?: boolean;
}

/** Read/write bridge for tools that fetch or mutate project files asynchronously
 *  (install_component, screenshot_to_code). When absent these tools are not
 *  registered, so the model never sees a tool it cannot actually run. */
export interface ProjectFilesBridge {
  getFiles: () => ProjectFiles;
  onFilesChanged: (newFiles: ProjectFiles, changes: FileChange[]) => void;
}

export interface BuildToolHandlersArgs {
  features: ToolFeatures;
  effectiveWebSearchSettings: WebSearchSettings;
  effectiveAssetSearchSettings: AssetSearchSettings;
  apiConfig: {
    apiType: ApiType;
    apiBaseUrl: string;
    apiKey: string;
    model: string;
  };
  getConsoleLogs: () => ConsoleLog[];
  memoryDeps: MemoryDeps;
  filesBridge?: ProjectFilesBridge;
  developerSkillScriptsEnabled: boolean;
  requestRegistryOriginApproval?: (
    origin: string,
    context: ToolExecutionContext,
  ) => Promise<boolean>;
  onDesignReviewSubmitted?: (report: DesignReviewReport) => void;
  getDesignHealthContext?: () =>
    Omit<DesignAdherenceInput, "files"> | undefined;
  setDefaultPreviewView?: NonNullable<GeneratorOptions["customToolHandler"]>;
  updateDesignTokens?: NonNullable<GeneratorOptions["customToolHandler"]>;
  onProjectDesignUpdated?: (files: ProjectFiles) => void;
  capturePreviewEvidence?: NonNullable<GeneratorOptions["customToolHandler"]>;
  capturePreviewSequence?: NonNullable<GeneratorOptions["customToolHandler"]>;
  designDiagnostics?: NonNullable<GeneratorOptions["customToolHandler"]>;
}

export interface BuiltToolHandlers {
  customToolSet: ToolSet;
  combinedToolHandler: NonNullable<GeneratorOptions["customToolHandler"]>;
  providerToolNames: string[];
  runtimePlatform: RuntimePlatform;
}

export async function buildToolHandlers(
  args: BuildToolHandlersArgs,
): Promise<BuiltToolHandlers> {
  const {
    features,
    effectiveWebSearchSettings,
    effectiveAssetSearchSettings,
    apiConfig,
    getConsoleLogs,
    memoryDeps,
    filesBridge,
    developerSkillScriptsEnabled,
    requestRegistryOriginApproval,
    onDesignReviewSubmitted,
    getDesignHealthContext,
    setDefaultPreviewView,
    updateDesignTokens,
    onProjectDesignUpdated,
    capturePreviewEvidence,
    capturePreviewSequence,
    designDiagnostics,
  } = args;
  const runtimePlatform = await detectRuntimePlatform();

  let builtinSearchTools: Record<string, unknown> = {};
  let providerToolNames: string[] = [];
  if (features.builtinSearch) {
    const builtinConfig = getBuiltinSearchConfig(apiConfig);
    if (builtinConfig) {
      builtinSearchTools = builtinConfig.tools || {};
      providerToolNames = builtinConfig.providerToolNames;
    }
  }

  const searchHandler = features.webSearch
    ? createSearchToolHandler(effectiveWebSearchSettings)
    : undefined;
  const jinaReaderHandler = features.builtinSearch
    ? createJinaReaderHandler()
    : undefined;
  const assetSearchHandler = features.assetSearch
    ? createAssetSearchToolHandler(effectiveAssetSearchSettings)
    : undefined;
  const memoryHandler = createMemoryToolHandler(memoryDeps);
  const npmSearchHandler = createNpmSearchToolHandler();
  const guardedFilesBridge = filesBridge
    ? {
        getFiles: filesBridge.getFiles,
        onFilesChanged: (newFiles: ProjectFiles, changes: FileChange[]) => {
          const validation = validateProjectFiles(newFiles);
          if (!validation.ok) {
            throw new Error(validation.error);
          }
          filesBridge.onFilesChanged(newFiles, changes);
        },
      }
    : undefined;
  const installComponentHandler = guardedFilesBridge
    ? createInstallComponentHandler({
        ...guardedFilesBridge,
        approveRegistryOrigin: requestRegistryOriginApproval,
      })
    : null;
  const screenshotToCodeHandler =
    guardedFilesBridge && !features.localAgent
      ? createScreenshotToCodeHandler({ apiConfig, ...guardedFilesBridge })
      : null;
  const applyDesignStyleHandler = guardedFilesBridge
    ? createApplyDesignStyleHandler(guardedFilesBridge)
    : null;
  const projectHealthCheckHandler = filesBridge
    ? createProjectHealthCheckHandler({
        getFiles: filesBridge.getFiles,
        getConsoleLogs,
        getDesignContext: getDesignHealthContext,
      })
    : null;
  const updateProjectDesignHandler = guardedFilesBridge
    ? (handlerArgs: unknown): ToolExecutionOutput => {
        const currentFiles = guardedFilesBridge.getFiles();
        const updated = applyProjectDesignToolRequest(
          currentFiles,
          handlerArgs,
        );
        if (!updated.ok) {
          return {
            text: JSON.stringify({
              ok: false,
              error: updated.error,
              issues: updated.issues,
            }),
            isError: true,
          };
        }
        guardedFilesBridge.onFilesChanged(updated.files, [
          {
            path: PROJECT_DESIGN_PATH,
            action: updated.action,
          },
        ]);
        onProjectDesignUpdated?.(updated.files);
        const result = {
          ok: true as const,
          path: PROJECT_DESIGN_PATH,
          revision: updated.design.revision,
          pages: updated.design.pages.length,
          flows: updated.design.flows.length,
          progress: updated.design.buildProgress,
          warnings: updated.warnings,
        };
        return { text: JSON.stringify(result), structuredContent: result };
      }
    : null;
  const submitDesignReviewHandler = onDesignReviewSubmitted
    ? createSubmitDesignReviewHandler(onDesignReviewSubmitted)
    : null;
  const skillsAvailable = isSkillsAvailable();
  const scriptExecutionEnabled =
    runtimePlatform === "desktop" && developerSkillScriptsEnabled;
  const skillTools = getSkillTools(scriptExecutionEnabled);
  const skillToolHandler = skillsAvailable
    ? createSkillToolHandler({
        getRegistry: () => getSkillRegistry(),
        getExecutor: async () => {
          if (!scriptExecutionEnabled) {
            throw new Error("Skill scripts are only available on desktop.");
          }
          return (await import("../skills/script-executor-tauri"))
            .TauriScriptExecutor;
        },
        scriptExecutionEnabled,
      })
    : null;
  type RuntimeHandler = (
    handlerArgs: unknown,
    context?: Parameters<NonNullable<GeneratorOptions["customToolHandler"]>>[2],
  ) => string | ToolExecutionOutput | Promise<string | ToolExecutionOutput>;
  const runtimeHandlers = new Map<string, RuntimeHandler>();
  runtimeHandlers.set("get_console_logs", (_handlerArgs, context) => {
    if (context?.run.mode === "auto_qa" || context?.run.mode === "subagent") {
      return "Error: runtime console logs are unavailable in isolated runs.";
    }
    return formatConsoleLogs(getConsoleLogs());
  });
  runtimeHandlers.set(MEMORY_TOOL_NAME, (handlerArgs) =>
    memoryHandler(MEMORY_TOOL_NAME, handlerArgs),
  );
  for (const name of SKILL_TOOL_NAME_SET) {
    if (skillToolHandler) {
      runtimeHandlers.set(name, (handlerArgs, context) =>
        skillToolHandler(name, handlerArgs, context),
      );
    }
  }
  for (const name of ["search_npm_packages", "get_npm_package_detail"]) {
    runtimeHandlers.set(name, (handlerArgs, context) =>
      npmSearchHandler(name, handlerArgs, context?.signal),
    );
  }
  if (installComponentHandler) {
    runtimeHandlers.set("install_component", (handlerArgs, context) =>
      installComponentHandler("install_component", handlerArgs, context),
    );
  }
  if (screenshotToCodeHandler) {
    runtimeHandlers.set("screenshot_to_code", (handlerArgs, context) =>
      screenshotToCodeHandler("screenshot_to_code", handlerArgs, context),
    );
  }
  if (applyDesignStyleHandler) {
    runtimeHandlers.set("apply_design_style", (handlerArgs, context) =>
      applyDesignStyleHandler(
        "apply_design_style",
        handlerArgs,
        context?.signal,
      ),
    );
  }
  if (projectHealthCheckHandler) {
    runtimeHandlers.set("project_health_check", (handlerArgs, context) =>
      projectHealthCheckHandler("project_health_check", handlerArgs, context),
    );
  }
  if (submitDesignReviewHandler) {
    runtimeHandlers.set("submit_design_review", (handlerArgs) =>
      submitDesignReviewHandler("submit_design_review", handlerArgs),
    );
  }

  if (assetSearchHandler) {
    runtimeHandlers.set("image_search", (handlerArgs, context) =>
      assetSearchHandler("image_search", handlerArgs, context?.signal),
    );
  }
  if (jinaReaderHandler) {
    runtimeHandlers.set("web_reader", (handlerArgs, context) =>
      jinaReaderHandler("web_reader", handlerArgs, context?.signal),
    );
  }
  if (searchHandler) {
    for (const name of Object.keys(SEARCH_TOOLS)) {
      runtimeHandlers.set(name, (handlerArgs, context) =>
        searchHandler(name, handlerArgs, context?.signal),
      );
    }
  }
  if (setDefaultPreviewView) {
    runtimeHandlers.set("set_default_preview_view", (handlerArgs, context) =>
      setDefaultPreviewView("set_default_preview_view", handlerArgs, context),
    );
  }
  if (updateDesignTokens) {
    runtimeHandlers.set("update_design_tokens", (handlerArgs, context) =>
      updateDesignTokens("update_design_tokens", handlerArgs, context),
    );
  }
  if (updateProjectDesignHandler) {
    runtimeHandlers.set("update_project_design", (handlerArgs) =>
      updateProjectDesignHandler(handlerArgs),
    );
  }
  if (capturePreviewSequence) {
    runtimeHandlers.set("capture_preview_sequence", (handlerArgs, context) =>
      capturePreviewSequence("capture_preview_sequence", handlerArgs, context),
    );
  }
  if (capturePreviewEvidence) {
    runtimeHandlers.set("capture_preview_evidence", (handlerArgs, context) =>
      capturePreviewEvidence("capture_preview_evidence", handlerArgs, context),
    );
  }
  if (designDiagnostics) {
    for (const name of Object.keys(
      DESIGN_DIAGNOSTIC_TOOLS,
    ) as DesignDiagnosticToolName[]) {
      runtimeHandlers.set(name, (handlerArgs, context) =>
        designDiagnostics(name, handlerArgs, context),
      );
    }
  }

  const combinedToolHandler = async (
    name: string,
    handlerArgs: unknown,
    context?: Parameters<NonNullable<GeneratorOptions["customToolHandler"]>>[2],
  ): Promise<string | ToolExecutionOutput> => {
    const handler = runtimeHandlers.get(name);
    return handler
      ? handler(handlerArgs, context)
      : `Error: unknown tool "${name}"`;
  };

  const customToolSet: ToolSet = {
    ...(features.webSearch ? SEARCH_TOOLS : {}),
    ...builtinSearchTools,
    ...(features.builtinSearch ? WEB_READER_TOOL : {}),
    ...(features.assetSearch ? ASSET_SEARCH_TOOLS : {}),
    ...NPM_SEARCH_TOOLS,
    ...MEMORY_TOOLS,
    ...DISPATCH_SUBAGENT_TOOL,
    ...(onDesignReviewSubmitted ? SUBMIT_DESIGN_REVIEW_TOOL : {}),
    ...(setDefaultPreviewView
      ? {
          set_default_preview_view: DESIGN_HOST_TOOLS.set_default_preview_view,
        }
      : {}),
    ...(updateDesignTokens
      ? { update_design_tokens: DESIGN_HOST_TOOLS.update_design_tokens }
      : {}),
    ...(updateProjectDesignHandler
      ? { update_project_design: DESIGN_HOST_TOOLS.update_project_design }
      : {}),
    ...(capturePreviewSequence ? PREVIEW_CAPTURE_TOOLS : {}),
    ...(capturePreviewEvidence
      ? {
          capture_preview_evidence: DESIGN_HOST_TOOLS.capture_preview_evidence,
        }
      : {}),
    ...(designDiagnostics ? DESIGN_DIAGNOSTIC_TOOLS : {}),
    ...(filesBridge
      ? {
          ...INSTALL_COMPONENT_TOOL,
          ...(features.localAgent ? {} : SCREENSHOT_TO_CODE_TOOL),
          ...APPLY_DESIGN_STYLE_TOOL,
          ...PROJECT_HEALTH_CHECK_TOOL,
        }
      : {}),
    ...(skillsAvailable ? skillTools : {}),
  };

  return {
    customToolSet,
    combinedToolHandler,
    providerToolNames,
    runtimePlatform,
  };
}
