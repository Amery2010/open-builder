// ============================================================================
//  web-app-generator.ts
//  AI Tool Call 引擎 —— 通过 OpenAI 兼容 API 驱动，在内存文件系统中生成 Web App
//  所有文件以 Record<path, content> 形式存储，无任何 Node.js 依赖，可在浏览器运行
// ============================================================================

import { SANDBOX_TEMPLATES } from "@codesandbox/sandpack-react";

// ═══════════════════════════════ 类型定义 ═══════════════════════════════════

/** 项目文件：路径 → 内容 */
export type ProjectFiles = Record<string, string>;

/** OpenAI 多模态内容块 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** OpenAI 格式的消息 */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** 模型思考过程（extended thinking） */
  thinking?: string;
}

/** 工具调用 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** 工具定义（OpenAI function calling 格式） */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 文件变更记录 */
export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
}

/** generate() 的最终返回值 */
export interface GenerateResult {
  files: ProjectFiles;
  messages: Message[];
  text: string;
  aborted: boolean;
  maxIterationsReached: boolean;
}

/** 构造选项 */
export interface GeneratorOptions {
  /** OpenAI 兼容 API 端点, 如 "https://api.openai.com/v1/chat/completions" */
  apiUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 模型 ID, 如 "gpt-5.3-codex"、"deepseek-chat"、"claude-3-5-sonnet" */
  model: string;
  /** 自定义系统提示词（提供了合理默认值） */
  systemPrompt?: string;
  /** 初始项目文件 */
  initialFiles?: ProjectFiles;
  /** 工具调用最大循环轮次（默认 30） */
  maxIterations?: number;
  /** 是否启用流式输出（默认 true） */
  stream?: boolean;
  /** 附加请求头 */
  headers?: Record<string, string>;
  /** 额外的自定义工具定义 */
  customTools?: ToolDefinition[];
  /** 自定义工具的执行回调（内置工具之外的分发到这里） */
  customToolHandler?: (name: string, args: unknown) => string | Promise<string>;
  /** 是否启用 thinking（默认 true） */
  thinking?: boolean;
  /** thinking 的 budget_tokens（默认 10000） */
  thinkingBudget?: number;
}

/** 事件回调 */
export interface GeneratorEvents {
  /** AI 输出文本片段（流式时逐 chunk 触发） */
  onText?: (delta: string) => void;
  /** AI 思考过程片段（流式时逐 chunk 触发） */
  onThinking?: (delta: string) => void;
  /** AI 开始调用某个工具 */
  onToolCall?: (name: string, toolCallId: string) => void;
  /** 工具执行完毕 */
  onToolResult?: (name: string, args: unknown, result: string) => void;
  /** 项目文件发生变更 */
  onFileChange?: (files: ProjectFiles, changes: FileChange[]) => void;
  /** 项目模板变更（init_project 触发） */
  onTemplateChange?: (template: string, files: ProjectFiles) => void;
  /** 项目依赖变更（manage_dependencies 触发，需要重启 Sandpack） */
  onDependenciesChange?: (files: ProjectFiles) => void;
  /** 整个 generate 流程结束 */
  onComplete?: (result: GenerateResult) => void;
  /** 出错 */
  onError?: (error: Error) => void;
}

// ═══════════════════════════════ 默认常量 ═══════════════════════════════════

const DEFAULT_SYSTEM_PROMPT = `You are an expert web developer. You build complete, working web applications using the provided file-system tools.

Guidelines:
1. Create well-structured projects with proper file organization.
2. Always write complete, runnable code. Never use placeholders like "// TODO" or "..." to omit code.
3. Default to modern HTML / CSS / JavaScript unless the user specifies otherwise.
4. Batch multiple file creations into a single response when possible (parallel tool calls).
5. For small edits, prefer patch_file over rewriting entire files with write_file.
6. Always read files before modifying them. Use read_files (plural) when reading 2 or more files at once — never call read_file multiple times in a row.
7. Briefly explain your plan before starting and summarize when finished.
8. After completing all file changes, call get_console_logs to check for runtime errors. If errors exist, fix them before finishing.`;

/** 内置工具定义 */
const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "init_project",
      description:
        "Initialize the project with a Sandpack template. Call this FIRST when starting a new project. " +
        "Available templates: " +
        "static (plain HTML/CSS/JS), " +
        "vanilla (vanilla JS with bundler), " +
        "vanilla-ts (vanilla TypeScript), " +
        "react (React with JavaScript), " +
        "react-ts (React with TypeScript, DEFAULT), " +
        "vue (Vue 3 with JavaScript), " +
        "vue-ts (Vue 3 with TypeScript), " +
        "svelte (Svelte with JavaScript), " +
        "angular (Angular with TypeScript), " +
        "solid (SolidJS with TypeScript), " +
        "vite (Vite vanilla), " +
        "vite-react (Vite + React JS), " +
        "vite-react-ts (Vite + React TypeScript), " +
        "vite-vue (Vite + Vue JS), " +
        "vite-vue-ts (Vite + Vue TypeScript), " +
        "vite-svelte (Vite + Svelte JS), " +
        "vite-svelte-ts (Vite + Svelte TypeScript), " +
        "astro (Astro), " +
        "test-ts (TypeScript test runner).",
      parameters: {
        type: "object",
        properties: {
          template: {
            type: "string",
            description: "Template name from the available list",
          },
        },
        required: ["template"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_dependencies",
      description:
        "Add, remove, or update project dependencies by modifying package.json. " +
        "This triggers a full project restart to install the new dependencies. " +
        "Provide the complete updated package.json content.",
      parameters: {
        type: "object",
        properties: {
          package_json: {
            type: "string",
            description: "The complete package.json content to write",
          },
        },
        required: ["package_json"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List all file paths currently in the project. Returns one path per line, or '(empty)' if no files exist.",
      parameters: { type: "object", properties: {} },
    },
  },
  // {
  //   type: "function",
  //   function: {
  //     name: "read_file",
  //     description: "Read and return the full content of a single file. Use read_files instead when reading 2 or more files.",
  //     parameters: {
  //       type: "object",
  //       properties: {
  //         path: {
  //           type: "string",
  //           description: "File path relative to project root",
  //         },
  //       },
  //       required: ["path"],
  //     },
  //   },
  // },
  {
    type: "function",
    function: {
      name: "read_files",
      description:
        "Read and return the full content of multiple files at once. Always prefer this over calling read_file multiple times.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "List of file paths relative to project root",
          },
        },
        required: ["paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or completely overwrite an existing file with the provided content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to project root",
          },
          content: {
            type: "string",
            description: "The complete file content to write",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_file",
      description:
        "Apply one or more search-and-replace patches to an existing file. " +
        "Each patch replaces the FIRST occurrence of the search string. " +
        "Include enough surrounding context in 'search' to ensure uniqueness.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to patch",
          },
          patches: {
            type: "array",
            description: "Ordered list of search-and-replace operations",
            items: {
              type: "object",
              properties: {
                search: {
                  type: "string",
                  description:
                    "Exact text to find (must be unique in the file)",
                },
                replace: {
                  type: "string",
                  description: "Text to replace the match with",
                },
              },
              required: ["search", "replace"],
            },
          },
        },
        required: ["path", "patches"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_in_files",
      description: "Search for a regex pattern across all project files",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the project.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to delete",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_console_logs",
      description:
        "Get the browser console output from the running Sandpack preview. " +
        "Use this after finishing code changes to check for runtime errors, warnings, or syntax errors. " +
        "If errors are found, fix them immediately.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ════════════════════════════ WebAppGenerator 类 ════════════════════════════

export class WebAppGenerator {
  // ── 内部状态 ──
  private files: ProjectFiles;
  private messages: Message[];
  private events: GeneratorEvents;
  private ctrl: AbortController | null = null;

  // ── 配置（只读） ──
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;
  private readonly useStream: boolean;
  private readonly extraHeaders: Record<string, string>;
  private readonly tools: ToolDefinition[];
  private readonly customToolHandler?: GeneratorOptions["customToolHandler"];
  private readonly useThinking: boolean;
  private readonly thinkingBudget: number;

  constructor(options: GeneratorOptions, events: GeneratorEvents = {}) {
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxIterations = options.maxIterations ?? 30;
    this.useStream = options.stream ?? true;
    this.extraHeaders = options.headers ?? {};
    this.tools = [...BUILTIN_TOOLS, ...(options.customTools ?? [])];
    this.customToolHandler = options.customToolHandler;
    this.useThinking = options.thinking ?? true;
    this.thinkingBudget = options.thinkingBudget ?? 10000;

    this.files = { ...(options.initialFiles ?? {}) };
    this.messages = [];
    this.events = events;
  }

  // ═══════════════════════════ 公开 API ═══════════════════════════════════

  /** 获取当前项目文件快照 */
  getFiles(): ProjectFiles {
    return { ...this.files };
  }

  /** 替换整个项目文件 */
  setFiles(files: ProjectFiles): void {
    this.files = { ...files };
  }

  /** 获取完整对话消息历史 */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** 清空对话历史（文件保留） */
  resetMessages(): void {
    this.messages = [];
  }

  /** 中止正在进行的 generate 请求 */
  abort(): void {
    this.ctrl?.abort();
    this.ctrl = null;
  }

  /**
   * 重试：不添加新的用户消息，直接重新运行生成循环
   * 用于错误后重试，此时用户消息已在历史中
   */
  async retry(): Promise<GenerateResult> {
    return this._runGenerateLoop();
  }

  /**
   * 核心方法：发送用户消息，驱动 AI 通过 Tool Call 循环生成/修改项目文件
   */
  async generate(
    userMessage: string,
    images?: string[],
  ): Promise<GenerateResult> {
    // Build user message: multi-part if images present
    if (images && images.length > 0) {
      const parts: ContentPart[] = [];
      if (userMessage) parts.push({ type: "text", text: userMessage });
      for (const url of images) {
        parts.push({ type: "image_url", image_url: { url } });
      }
      this.messages.push({ role: "user", content: parts });
    } else {
      this.messages.push({ role: "user", content: userMessage });
    }

    return this._runGenerateLoop();
  }

  private async _runGenerateLoop(): Promise<GenerateResult> {
    const systemContent = this.buildSystemContent();
    let fullText = "";
    let aborted = false;
    let maxReached = false;

    try {
      for (let iter = 0; iter < this.maxIterations; iter++) {
        const requestMessages: Message[] = [
          { role: "system", content: systemContent },
          ...this.messages,
        ];

        const assistantMsg = this.useStream
          ? await this.requestStream(requestMessages)
          : await this.requestJSON(requestMessages);

        this.messages.push(assistantMsg);
        if (assistantMsg.content) {
          fullText += assistantMsg.content;
        }

        if (!assistantMsg.tool_calls?.length) {
          break;
        }

        for (const toolCall of assistantMsg.tool_calls) {
          const { result, changes } = await this.executeTool(toolCall);

          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });

          if (changes.length > 0) {
            this.events.onFileChange?.(this.getFiles(), changes);
          }
        }

        if (iter === this.maxIterations - 1) {
          maxReached = true;
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        aborted = true;
      } else {
        this.events.onError?.(err);
        throw err;
      }
    }

    const result: GenerateResult = {
      files: this.getFiles(),
      messages: this.getMessages(),
      text: fullText,
      aborted,
      maxIterationsReached: maxReached,
    };

    this.events.onComplete?.(result);
    return result;
  }

  // ══════════════════════════ 内部方法 ══════════════════════════════════════

  private buildSystemContent(): string {
    const paths = Object.keys(this.files).sort();
    const listing =
      paths.length > 0
        ? "\n\nCurrent project files:\n" + paths.map((p) => `- ${p}`).join("\n")
        : "\n\nThe project is empty — no files yet.";
    return this.systemPrompt + listing;
  }

  private buildFetchInit(messages: Message[], stream: boolean): RequestInit {
    this.ctrl = new AbortController();

    return {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools: this.tools.length > 0 ? this.tools : undefined,
        stream,
        ...(this.useThinking
          ? { thinking: { type: "enabled", budget_tokens: this.thinkingBudget } }
          : {}),
      }),
      signal: this.ctrl.signal,
    };
  }

  private async parseApiError(res: Response): Promise<string> {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      const msg =
        json.error?.message || json.message || json.detail || json.msg;
      if (msg) return `API error ${res.status}: ${msg}`;
    } catch {
      /* not JSON */
    }
    return `API error ${res.status}: ${text}`;
  }

  private async requestJSON(messages: Message[]): Promise<Message> {
    const res = await fetch(this.apiUrl, this.buildFetchInit(messages, false));
    if (!res.ok) {
      throw new Error(await this.parseApiError(res));
    }

    const json = await res.json();
    const choice = json.choices?.[0]?.message;
    if (!choice) throw new Error("API returned empty choices");

    if (choice.content) {
      this.events.onText?.(choice.content);
    }
    if (choice.thinking) {
      this.events.onThinking?.(choice.thinking);
    }
    if (choice.tool_calls) {
      for (const tc of choice.tool_calls) {
        this.events.onToolCall?.(tc.function.name, tc.id);
      }
    }

    return {
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: choice.tool_calls?.length ? choice.tool_calls : undefined,
      thinking: choice.thinking ?? undefined,
    };
  }

  private async requestStream(messages: Message[]): Promise<Message> {
    const res = await fetch(this.apiUrl, this.buildFetchInit(messages, true));
    if (!res.ok) {
      throw new Error(await this.parseApiError(res));
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let contentAccum = "";
    let thinkingAccum = "";
    const toolCallAccum = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;

        const payload = trimmed.slice(6);
        if (payload === "[DONE]") continue;

        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          contentAccum += delta.content;
          this.events.onText?.(delta.content);
        }

        // Handle thinking delta (extended thinking / reasoning)
        if (delta.reasoning_content || delta.thinking) {
          const thinkingDelta = delta.reasoning_content || delta.thinking;
          thinkingAccum += thinkingDelta;
          this.events.onThinking?.(thinkingDelta);
        }

        if (delta.tool_calls) {
          for (const dtc of delta.tool_calls) {
            const idx: number = dtc.index;

            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, { id: "", name: "", arguments: "" });
            }

            const entry = toolCallAccum.get(idx)!;

            if (dtc.id) {
              entry.id = dtc.id;
            }
            if (dtc.function?.name) {
              entry.name = dtc.function.name;
              this.events.onToolCall?.(entry.name, entry.id);
            }
            if (dtc.function?.arguments) {
              entry.arguments += dtc.function.arguments;
            }
          }
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolCallAccum.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => ({
        id: entry.id,
        type: "function" as const,
        function: {
          name: entry.name,
          arguments: entry.arguments,
        },
      }));

    return {
      role: "assistant",
      content: contentAccum || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      thinking: thinkingAccum || undefined,
    };
  }

  private async executeTool(
    toolCall: ToolCall,
  ): Promise<{ result: string; changes: FileChange[] }> {
    const name = toolCall.function.name;

    let args: any;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      const errMsg = `Error: failed to parse arguments for "${name}"`;
      this.events.onToolResult?.(name, null, errMsg);
      return { result: errMsg, changes: [] };
    }

    const changes: FileChange[] = [];
    let result: string;

    switch (name) {
      case "init_project":
        result = this.toolInitProject(args.template, changes);
        break;

      case "manage_dependencies":
        result = this.toolManageDependencies(args.package_json, changes);
        break;

      case "list_files":
        result = this.toolListFiles();
        break;

      // case "read_file":
      //   result = this.toolReadFile(args.path);
      //   break;

      case "read_files":
        result = this.toolReadFiles(args.paths);
        break;

      case "write_file":
        result = this.toolWriteFile(args.path, args.content, changes);
        break;

      case "patch_file": {
        const patches = Array.isArray(args.patches)
          ? args.patches
          : [args.patches];
        result = this.toolPatchFile(args.path, patches, changes);
        break;
      }

      case "delete_file":
        result = this.toolDeleteFile(args.path, changes);
        break;

      case "search_in_files":
        result = this.toolSearchInFiles(args.pattern);
        break;

      default:
        if (this.customToolHandler) {
          try {
            result = await this.customToolHandler(name, args);
          } catch (err: any) {
            result = `Error in custom tool "${name}": ${err.message}`;
          }
        } else {
          result = `Error: unknown tool "${name}"`;
        }
    }

    this.events.onToolResult?.(name, args, result);
    return { result, changes };
  }

  private toolInitProject(template: string, changes: FileChange[]): string {
    const tmpl = SANDBOX_TEMPLATES[template as keyof typeof SANDBOX_TEMPLATES];
    if (!tmpl) {
      return `Error: unknown template "${template}". Use one of: ${Object.keys(SANDBOX_TEMPLATES).join(", ")}`;
    }
    const newFiles: ProjectFiles = {};
    for (const [path, file] of Object.entries(tmpl.files)) {
      const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
      const code =
        typeof file === "string" ? file : (file as { code: string }).code;
      newFiles[normalizedPath] = code;
      changes.push({ path: normalizedPath, action: "created" });
    }
    this.files = newFiles;
    this.events.onTemplateChange?.(template, this.getFiles());
    return `OK — initialized project with template "${template}" (${Object.keys(newFiles).length} files)`;
  }

  private toolManageDependencies(
    packageJson: string,
    changes: FileChange[],
  ): string {
    try {
      JSON.parse(packageJson);
    } catch {
      return "Error: invalid JSON in package_json";
    }
    const pkgPath =
      Object.keys(this.files).find((p) => p.endsWith("package.json")) ||
      "package.json";
    const action: FileChange["action"] =
      pkgPath in this.files ? "modified" : "created";
    this.files[pkgPath] = packageJson;
    changes.push({ path: pkgPath, action });
    this.events.onDependenciesChange?.(this.getFiles());
    return `OK — ${action} ${pkgPath}, dependencies updated. Sandpack will restart.`;
  }

  private toolListFiles(): string {
    const paths = Object.keys(this.files).sort();
    if (paths.length === 0) return "(empty project — no files)";
    return paths.join("\n");
  }

  // private toolReadFile(path: string): string {
  //   if (!(path in this.files)) {
  //     return `Error: file not found — "${path}"`;
  //   }
  //   return this.files[path];
  // }

  private toolReadFiles(paths: string[]): string {
    if (!Array.isArray(paths) || paths.length === 0) {
      return "Error: no paths provided";
    }
    return paths
      .map((path) => {
        if (!(path in this.files)) {
          return `=== ${path} ===\nError: file not found`;
        }
        return `=== ${path} ===\n${this.files[path]}`;
      })
      .join("\n\n");
  }

  private toolWriteFile(
    path: string,
    content: string,
    changes: FileChange[],
  ): string {
    const action: FileChange["action"] =
      path in this.files ? "modified" : "created";
    this.files[path] = content;
    changes.push({ path, action });
    return `OK — ${action}: ${path} (${content.length} chars)`;
  }

  private toolPatchFile(
    path: string,
    patches: Array<{ search: string; replace: string }>,
    changes: FileChange[],
  ): string {
    if (!(path in this.files)) {
      return `Error: file not found — "${path}"`;
    }

    let content = this.files[path];
    const log: string[] = [];

    for (let i = 0; i < patches.length; i++) {
      const { search, replace } = patches[i];
      const idx = content.indexOf(search);

      if (idx >= 0) {
        content =
          content.slice(0, idx) + replace + content.slice(idx + search.length);
        log.push(`patch #${i + 1}: ✓ applied`);
      } else {
        const preview = search.length > 60 ? search.slice(0, 60) + "…" : search;
        log.push(`patch #${i + 1}: ✗ not found — "${preview}"`);
      }
    }

    this.files[path] = content;
    changes.push({ path, action: "modified" });
    return log.join("\n");
  }

  private toolSearchInFiles(pattern: string): string {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "g");
    } catch {
      return `Error: invalid regex pattern — "${pattern}"`;
    }
    const results: string[] = [];
    for (const [path, content] of Object.entries(this.files)) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${path}:${i + 1}: ${lines[i].trim()}`);
        }
        regex.lastIndex = 0;
      }
    }
    return results.length > 0 ? results.join("\n") : "(no matches found)";
  }

  private toolDeleteFile(path: string, changes: FileChange[]): string {
    if (!(path in this.files)) {
      return `Error: file not found — "${path}"`;
    }
    delete this.files[path];
    changes.push({ path, action: "deleted" });
    return `OK — deleted: ${path}`;
  }
}
