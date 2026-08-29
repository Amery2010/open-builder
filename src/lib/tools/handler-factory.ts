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
import {
  APPLY_DESIGN_SYSTEM_TOOL,
  createApplyDesignSystemHandler,
} from "../design-systems/apply";
import {
  PROJECT_HEALTH_CHECK_TOOL,
  createProjectHealthCheckHandler,
} from "./project-health";
import { formatConsoleLogs, type ConsoleLog } from "./console-log-format";
import { getBuiltinSearchConfig } from "../ai/provider";
import type { ApiType } from "../ai/provider";
import type {
  DesignSystemRef,
  WebSearchSettings,
  AssetSearchSettings,
  ProjectFiles,
} from "../../types";
import type {
  FileChange,
  GeneratorOptions,
  ToolExecutionContext,
} from "../ai/generator-types";
import { validateProjectFiles } from "../utils/project-files";
import { detectRuntimePlatform } from "../runtime/platform";
import type { RuntimePlatform } from "../ai/tools-schema";
import {
  createSubmitDesignReviewHandler,
  type DesignReviewReport,
} from "../design/review";
import { SUBMIT_DESIGN_REVIEW_TOOL } from "../design/review-tool";

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
  onDesignSystemApplied?: (reference: DesignSystemRef) => void;
  getSelectedDesignSystemId?: () => string | undefined;
  onDesignReviewSubmitted?: (report: DesignReviewReport) => void;
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
    onDesignSystemApplied,
    getSelectedDesignSystemId,
    onDesignReviewSubmitted,
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
  const applyDesignSystemHandler = guardedFilesBridge
    ? createApplyDesignSystemHandler({
        ...guardedFilesBridge,
        getSelectedSystemId: getSelectedDesignSystemId,
        onApplied: onDesignSystemApplied,
      })
    : null;
  const projectHealthCheckHandler = filesBridge
    ? createProjectHealthCheckHandler({
        getFiles: filesBridge.getFiles,
        getConsoleLogs,
      })
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
  const combinedToolHandler = async (
    name: string,
    handlerArgs: unknown,
    context?: Parameters<NonNullable<GeneratorOptions["customToolHandler"]>>[2],
  ): Promise<string> => {
    if (name === "get_console_logs") {
      if (context?.run.mode === "auto_qa" || context?.run.mode === "subagent") {
        return "Error: runtime console logs are unavailable in isolated runs.";
      }
      return formatConsoleLogs(getConsoleLogs());
    }
    if (name === MEMORY_TOOL_NAME) {
      return memoryHandler(name, handlerArgs);
    }
    if (skillToolHandler && SKILL_TOOL_NAME_SET.has(name)) {
      return skillToolHandler(name, handlerArgs, context);
    }
    if (name === "search_npm_packages" || name === "get_npm_package_detail") {
      return npmSearchHandler(name, handlerArgs);
    }
    if (name === "install_component" && installComponentHandler) {
      return installComponentHandler(name, handlerArgs, context);
    }
    if (name === "screenshot_to_code" && screenshotToCodeHandler) {
      return screenshotToCodeHandler(name, handlerArgs);
    }
    if (name === "apply_design_style" && applyDesignStyleHandler) {
      return applyDesignStyleHandler(name, handlerArgs);
    }
    if (name === "apply_design_system" && applyDesignSystemHandler) {
      return applyDesignSystemHandler(name, handlerArgs);
    }
    if (name === "project_health_check" && projectHealthCheckHandler) {
      return projectHealthCheckHandler(name, handlerArgs, context);
    }
    if (name === "submit_design_review" && submitDesignReviewHandler) {
      return submitDesignReviewHandler(name, handlerArgs);
    }
    if (name === "image_search" && assetSearchHandler) {
      return assetSearchHandler(name, handlerArgs);
    }
    if (name === "web_reader" && jinaReaderHandler) {
      return jinaReaderHandler(name, handlerArgs);
    }
    if (searchHandler) return searchHandler(name, handlerArgs);
    return `Error: unknown tool "${name}"`;
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
    ...(filesBridge
      ? {
          ...INSTALL_COMPONENT_TOOL,
          ...(features.localAgent ? {} : SCREENSHOT_TO_CODE_TOOL),
          ...APPLY_DESIGN_STYLE_TOOL,
          ...APPLY_DESIGN_SYSTEM_TOOL,
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
