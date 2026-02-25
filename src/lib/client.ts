import {
  WebAppGenerator,
  GeneratorOptions,
  GeneratorEvents,
  ProjectFiles,
} from "./generator";

/**
 * OpenAI 兼容客户端配置
 */
export interface OpenAIClientConfig {
  /** API 端点 URL */
  apiUrl?: string;
  /** API 密钥 */
  apiKey: string;
  /** 模型名称 */
  model?: string;
  /** 是否启用流式输出 */
  stream?: boolean;
  /** 温度参数 */
  temperature?: number;
  /** 最大 token 数 */
  maxTokens?: number;
}

/**
 * 创建 OpenAI 兼容的 Web App 生成器
 */
export function createOpenAIGenerator(
  config: OpenAIClientConfig,
  events?: GeneratorEvents,
  initialFiles?: ProjectFiles,
): WebAppGenerator {
  const options: GeneratorOptions = {
    apiUrl: config.apiUrl || "https://api.openai.com/v1/chat/completions",
    apiKey: config.apiKey,
    model: config.model || "gpt-4o",
    stream: config.stream ?? true,
    temperature: config.temperature ?? 0,
    maxTokens: config.maxTokens ?? 16384,
    initialFiles,
  };

  return new WebAppGenerator(options, events);
}

/**
 * 简化的生成函数 - 用于单次代码生成
 */
export async function generateWithOpenAI(
  prompt: string,
  config: OpenAIClientConfig,
  currentFiles?: ProjectFiles,
): Promise<{ code: string; files: ProjectFiles }> {
  let generatedText = "";
  let finalFiles: ProjectFiles = {};

  const generator = createOpenAIGenerator(
    config,
    {
      onText: (delta) => {
        generatedText += delta;
      },
      onFileChange: (files) => {
        finalFiles = files;
      },
      onError: (error) => {
        console.error("Generation error:", error);
      },
    },
    currentFiles,
  );

  const result = await generator.generate(prompt);

  // 如果有 App.tsx 文件，返回其内容作为主代码
  const mainCode = finalFiles["src/App.tsx"] || finalFiles["App.tsx"] || "";

  return {
    code: mainCode,
    files: finalFiles,
  };
}
