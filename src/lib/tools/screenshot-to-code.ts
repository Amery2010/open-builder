import { tool, generateText } from "ai";
import { z } from "zod";
import { getProviderModel } from "../ai/provider";
import type { ApiType } from "../ai/provider";
import type {
  ProjectFiles,
  FileChange,
  ToolExecutionContext,
} from "../ai/generator-types";
import { prepareScreenshot } from "../images/screenshot";
import { normalizeProjectPath, validateProjectFileContent } from "./fs-tools";
import {
  normalizeHttpUrl,
  fetchWithTimeout,
  readResponseBytesWithLimit,
  safeErrorMessage,
} from "./network-guard";

export const SCREENSHOT_TO_CODE_TOOL = {
  screenshot_to_code: tool({
    description:
      "Generate a UI component from a screenshot or design image. " +
      "Calls a vision-capable model to analyze the image and produce framework-specific code, " +
      "then writes the result to the project. Use when the user provides an image of a UI they want built " +
      "and you want a single end-to-end generation step. " +
      "For minor tweaks afterwards, use patch_file / write_file directly.",
    inputSchema: z.object({
      image_url: z
        .string()
        .describe(
          "Image source: a base64 data URL (data:image/...;base64,...) or an http(s) URL.",
        ),
      framework: z
        .enum(["react", "vue", "svelte"])
        .optional()
        .describe("Target framework. Default: react"),
      style_hints: z
        .string()
        .optional()
        .describe(
          "Style guidance, e.g. 'Tailwind dark theme, shadcn/ui components, modern minimal'.",
        ),
      output_path: z
        .string()
        .optional()
        .describe(
          "Output file path. Defaults based on framework, e.g. src/components/GeneratedComponent.tsx",
        ),
    }),
  }),
};

export interface ScreenshotToCodeDeps {
  apiConfig: {
    apiType: ApiType;
    apiBaseUrl: string;
    apiKey: string;
    model: string;
  };
  getFiles: () => ProjectFiles;
  onFilesChanged: (newFiles: ProjectFiles, changes: FileChange[]) => void;
}

interface ScreenshotArgs {
  image_url: string;
  framework?: "react" | "vue" | "svelte";
  style_hints?: string;
  output_path?: string;
}

const DEFAULT_OUTPUT: Record<
  NonNullable<ScreenshotArgs["framework"]>,
  string
> = {
  react: "src/components/GeneratedComponent.tsx",
  vue: "src/components/GeneratedComponent.vue",
  svelte: "src/components/GeneratedComponent.svelte",
};
const SCREENSHOT_TO_CODE_LIMITS = {
  maxStyleHintChars: 2000,
  maxDataUrlChars: 6_000_000,
} as const;

function normalizeScreenshotImageUrl(
  value: unknown,
): { ok: true; imageUrl: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "image_url must be a string" };
  }
  const imageUrl = value.trim();
  if (/^data:[^;,]*;base64,/i.test(imageUrl)) {
    if (imageUrl.length > SCREENSHOT_TO_CODE_LIMITS.maxDataUrlChars) {
      return {
        ok: false,
        error: `image_url data URL is too large (max ${SCREENSHOT_TO_CODE_LIMITS.maxDataUrlChars} characters)`,
      };
    }
    return { ok: true, imageUrl };
  }
  const checkedUrl = normalizeHttpUrl(imageUrl, "image_url");
  if (!checkedUrl.ok) {
    return {
      ok: false,
      error: "image_url must be a base64 data:image URL or an http(s) URL",
    };
  }
  return { ok: true, imageUrl: checkedUrl.url };
}

function buildPrompt(framework: string, styleHints?: string): string {
  const style = styleHints?.trim() || "Tailwind CSS";
  return [
    `You are an expert UI developer.`,
    `Rebuild the provided UI screenshot as one complete, runnable ${framework} component`,
    `using ${style}. It must be self-contained and visually faithful to the screenshot.`,
    ``,
    `Output requirements:`,
    `- Emit the component in a single fenced code block (\`\`\`${framework === "react" ? "tsx" : framework}) and nothing else — no prose before or after.`,
    `- Working code only: no placeholders, no TODOs.`,
    `- React: default-export a function component named GeneratedComponent.`,
    `- Vue: one single-file component with <script setup lang="ts"> and <template>.`,
    `- Svelte: one .svelte file with <script lang="ts"> and markup.`,
  ].join("\n");
}

function extractCodeBlock(text: string): string | null {
  const re = /```[\w]*\n([\s\S]+?)```/;
  const m = re.exec(text);
  if (m) return m[1].trim();
  const trimmed = text.trim();
  if (trimmed.length > 0) return trimmed;
  return null;
}

export function createScreenshotToCodeHandler(deps: ScreenshotToCodeDeps) {
  return async (
    _name: string,
    args: unknown,
    context?: ToolExecutionContext,
  ): Promise<string> => {
    const parsed = args as ScreenshotArgs;
    const checkedImageUrl = normalizeScreenshotImageUrl(parsed?.image_url);
    if (!checkedImageUrl.ok) {
      return JSON.stringify({ ok: false, error: checkedImageUrl.error });
    }
    if (
      typeof parsed.style_hints === "string" &&
      parsed.style_hints.length > SCREENSHOT_TO_CODE_LIMITS.maxStyleHintChars
    ) {
      return JSON.stringify({
        ok: false,
        error: `style_hints must be <= ${SCREENSHOT_TO_CODE_LIMITS.maxStyleHintChars} chars`,
      });
    }
    const framework = parsed.framework ?? "react";
    const outputPath = parsed.output_path || DEFAULT_OUTPUT[framework];
    const checkedPath = normalizeProjectPath(outputPath);
    if (!checkedPath.ok) {
      return JSON.stringify({ ok: false, error: checkedPath.error });
    }
    if (checkedPath.path === ".env") {
      return JSON.stringify({
        ok: false,
        error: "screenshot_to_code cannot write .env; use manage_env",
      });
    }

    let model;
    try {
      model = getProviderModel(deps.apiConfig);
    } catch (err: any) {
      return JSON.stringify({
        ok: false,
        error: `failed to init model: ${safeErrorMessage(err)}`,
      });
    }

    let text: string;
    try {
      let dataUrl = checkedImageUrl.imageUrl;
      if (!dataUrl.startsWith("data:")) {
        const bytes = await fetchWithTimeout(
          dataUrl,
          { credentials: "omit", signal: context?.signal },
          undefined,
          async (response) => {
            if (!response.ok)
              throw new Error(
                `Screenshot request failed (${response.status}).`,
              );
            return readResponseBytesWithLimit(
              response,
              Math.floor((SCREENSHOT_TO_CODE_LIMITS.maxDataUrlChars * 3) / 4),
              "Screenshot",
            );
          },
        );
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          chunks.push(
            String.fromCharCode(...bytes.subarray(offset, offset + 32768)),
          );
        }
        dataUrl = `data:;base64,${btoa(chunks.join(""))}`;
      }
      const image = await prepareScreenshot(
        dataUrl,
        undefined,
        context?.signal,
      );
      context?.signal.throwIfAborted();
      const result = await generateText({
        model,
        abortSignal: context?.signal,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildPrompt(framework, parsed.style_hints),
              },
              {
                type: "image",
                image: image.dataUrl,
                mediaType: image.mimeType,
              },
            ],
          },
        ],
        maxRetries: 0,
      });
      text = result.text || "";
    } catch (err: any) {
      context?.signal.throwIfAborted();
      return JSON.stringify({
        ok: false,
        error: `vision request failed: ${safeErrorMessage(err)}`,
      });
    }

    const code = extractCodeBlock(text);
    if (!code) {
      return JSON.stringify({
        ok: false,
        error: "model did not return a code block",
      });
    }
    const checkedContent = validateProjectFileContent(code);
    if (!checkedContent.ok) {
      return JSON.stringify({ ok: false, error: checkedContent.error });
    }

    const files = deps.getFiles();
    const action: FileChange["action"] =
      checkedPath.path in files ? "modified" : "created";
    const newFiles: ProjectFiles = {
      ...files,
      [checkedPath.path]: checkedContent.content,
    };
    deps.onFilesChanged(newFiles, [{ path: checkedPath.path, action }]);

    return JSON.stringify({
      ok: true,
      path: checkedPath.path,
      chars: checkedContent.content.length,
      preview: checkedContent.content.slice(0, 200),
    });
  };
}
