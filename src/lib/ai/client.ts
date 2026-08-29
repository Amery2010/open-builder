import {
  WebAppGenerator,
  GeneratorOptions,
  GeneratorEvents,
  ProjectFiles,
} from "./generator";
import type { ToolSet } from "ai";
import type { ApiType } from "./provider";
import {
  defaultModelForApiType,
  DEFAULT_OPENAI_MODEL,
} from "./provider-config";

export interface OpenAIClientConfig {
  apiType?: ApiType;
  apiBaseUrl?: string;
  apiKey: string;
  model?: string;
  stream?: boolean;
  providerToolNames?: string[];
}

export function createOpenAIGenerator(
  config: OpenAIClientConfig,
  events?: GeneratorEvents,
  initialFiles?: ProjectFiles,
  customTools?: ToolSet,
  customToolHandler?: GeneratorOptions["customToolHandler"],
  extras?: Pick<
    GeneratorOptions,
    | "tools"
    | "askUserQuestion"
    | "requestPlanApproval"
    | "onPlanApproved"
    | "dispatchSubagent"
    | "executionMode"
    | "runtimePlatform"
    | "conversationId"
    | "allowedMcpAliases"
    | "initialSkillContext"
    | "prepareInitializedProject"
  >,
): WebAppGenerator {
  const apiType = config.apiType ?? "openai-compatible";
  const options: GeneratorOptions = {
    apiType,
    apiBaseUrl: config.apiBaseUrl || "https://api.openai.com",
    apiKey: config.apiKey,
    model:
      config.model || defaultModelForApiType(apiType) || DEFAULT_OPENAI_MODEL,
    stream: config.stream ?? true,
    initialFiles,
    customTools,
    customToolHandler,
    providerToolNames: config.providerToolNames,
    ...(extras ?? {}),
  };

  return new WebAppGenerator(options, events);
}
