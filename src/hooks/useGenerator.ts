import { useRef, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { WebAppGenerator } from "../lib/generator";
import { createOpenAIGenerator } from "../lib/client";
import { useConversationStore } from "../store/conversation";
import { useSettingsStore } from "../store/settings";
import { useSandpackStore } from "../store/sandpack";
import { TAVILY_TOOLS, createTavilyToolHandler } from "../lib/tavily";
import type { Message, ContentPart, ProjectFiles, AISettings, WebSearchSettings } from "../types";

const isErrorMessage = (m: Message) =>
  m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("⚠️");

const removeErrorMessages = (prev: Message[]) => prev.filter((m) => !isErrorMessage(m));

interface UseGeneratorOptions {
  settings: AISettings;
  webSearchSettings: WebSearchSettings;
  files: ProjectFiles;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setFiles: Dispatch<SetStateAction<ProjectFiles>>;
  setIsGenerating: Dispatch<SetStateAction<boolean>>;
  setTemplate: Dispatch<SetStateAction<string>>;
  restartSandpack: () => void;
  setIsProjectInitialized: Dispatch<SetStateAction<boolean>>;
}

export function useGenerator({
  settings,
  webSearchSettings,
  files,
  setMessages,
  setFiles,
  setIsGenerating,
  setTemplate,
  restartSandpack,
  setIsProjectInitialized,
}: UseGeneratorOptions) {
  const generatorRef = useRef<WebAppGenerator | null>(null);
  const activeId = useConversationStore((s) => s.activeId);
  const prevActiveIdRef = useRef(activeId);

  const getGenerator = useCallback(() => {
    if (!settings.apiKey || !settings.apiUrl || !settings.model) return null;

    // Invalidate on conversation switch
    if (prevActiveIdRef.current !== activeId) {
      generatorRef.current = null;
      prevActiveIdRef.current = activeId;
    }

    // Invalidate if settings changed
    if (generatorRef.current) {
      const g = generatorRef.current as any;
      if (
        g._apiKey !== settings.apiKey ||
        g._apiUrl !== settings.apiUrl ||
        g._model !== settings.model ||
        g._tavilyKey !== webSearchSettings.tavilyApiKey ||
        g._tavilyUrl !== webSearchSettings.tavilyApiUrl
      ) {
        generatorRef.current = null;
      }
    }

    if (!generatorRef.current) {
      const webConfigured = useSettingsStore.getState().isWebSearchConfigured();
      const tavilyHandler = webConfigured ? createTavilyToolHandler(webSearchSettings) : undefined;

      const combinedToolHandler = async (name: string, args: unknown): Promise<string> => {
        if (name === "get_console_logs") {
          const { consoleLogs } = useSandpackStore.getState();
          if (consoleLogs.length === 0) return "No console output yet.";
          return consoleLogs
            .map((log) => {
              const data = log.data
                .map((d) => (typeof d === "string" ? d : JSON.stringify(d)))
                .join(" ");
              return `[${log.method.toUpperCase()}] ${data}`;
            })
            .join("\n");
        }
        if (tavilyHandler) return tavilyHandler(name, args);
        return `Error: unknown tool "${name}"`;
      };

      generatorRef.current = createOpenAIGenerator(
        {
          apiKey: settings.apiKey,
          apiUrl: settings.apiUrl,
          model: settings.model,
          stream: true,
        },
        {
          onText: (delta) => {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: ((typeof last.content === "string" ? last.content : "") || "") + delta },
                ];
              }
              return [...prev, { role: "assistant", content: delta }];
            });
          },
          onThinking: (delta) => {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                return [
                  ...prev.slice(0, -1),
                  { ...last, thinking: (last.thinking || "") + delta },
                ];
              }
              return [...prev, { role: "assistant", content: null, thinking: delta }];
            });
          },
          onToolCall: (name, id) => {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                if (last.tool_calls?.some((tc) => tc.id === id)) return prev;
                const newToolCall = {
                  id,
                  type: "function" as const,
                  function: { name, arguments: "" },
                };
                return [
                  ...prev.slice(0, -1),
                  { ...last, tool_calls: [...(last.tool_calls || []), newToolCall] },
                ];
              }
              return prev;
            });
          },
          onToolResult: (_name, _args, result) => {
            setMessages((prev) => {
              const msgs = [...prev];
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === "assistant" && msgs[i].tool_calls) {
                  const toolCallIndex = msgs[i].tool_calls!.findIndex(
                    (tc) => !msgs.some((m) => m.role === "tool" && m.tool_call_id === tc.id),
                  );
                  if (toolCallIndex !== -1) {
                    const toolCall = msgs[i].tool_calls![toolCallIndex];
                    // Update the tool call's arguments so the UI can display correct info
                    const updatedToolCalls = [...msgs[i].tool_calls!];
                    updatedToolCalls[toolCallIndex] = {
                      ...toolCall,
                      function: {
                        ...toolCall.function,
                        arguments: JSON.stringify(_args),
                      },
                    };
                    const updatedMsgs = [...msgs];
                    updatedMsgs[i] = { ...msgs[i], tool_calls: updatedToolCalls };
                    return [...updatedMsgs, { role: "tool", content: result, tool_call_id: toolCall.id }];
                  }
                  break;
                }
              }
              return [...msgs, { role: "tool", content: result, tool_call_id: "" }];
            });
          },
          onFileChange: (newFiles) => {
            setFiles(newFiles);
          },
          onTemplateChange: (tmpl, newFiles) => {
            setTemplate(tmpl);
            setFiles(newFiles);
            setIsProjectInitialized(true);
            restartSandpack();
          },
          onDependenciesChange: (newFiles) => {
            setFiles(newFiles);
            restartSandpack();
          },
          onComplete: () => {
            // Messages already kept in sync via onText/onToolCall/onToolResult.
          },
          onError: (error) => {
            console.error("Generation error:", error);
            setMessages((prev) => [
              ...removeErrorMessages(prev),
              { role: "assistant", content: `⚠️ ${error.message || "Unknown error"}` },
            ]);
          },
        },
        files,
        webConfigured ? TAVILY_TOOLS : undefined,
        combinedToolHandler,
      );
    }

    return generatorRef.current;
  }, [settings, webSearchSettings, files, activeId, setMessages, setFiles, setTemplate, setIsProjectInitialized, restartSandpack]);

  const generate = useCallback(
    async (prompt: string, images?: string[]) => {
      setIsGenerating(true);

      // Build message content: multi-part if images present, plain string otherwise
      let content: string | ContentPart[];
      if (images && images.length > 0) {
        const parts: ContentPart[] = [];
        if (prompt) parts.push({ type: "text", text: prompt });
        for (const url of images) {
          parts.push({ type: "image_url", image_url: { url } });
        }
        content = parts;
      } else {
        content = prompt;
      }

      setMessages((prev) => [...removeErrorMessages(prev), { role: "user", content }]);
      try {
        const generator = getGenerator();
        if (generator) await generator.generate(prompt, images);
      } catch (err: any) {
        console.error("Error generating:", err);
        if (err?.name !== "AbortError") {
          setMessages((prev) => [
            ...removeErrorMessages(prev),
            { role: "assistant", content: `⚠️ ${err?.message || "Unknown error"}` },
          ]);
        }
      } finally {
        setIsGenerating(false);
      }
    },
    [getGenerator, setIsGenerating, setMessages],
  );

  const stop = useCallback(() => {
    generatorRef.current?.abort();
    setIsGenerating(false);
  }, [setIsGenerating]);

  const updateFiles = useCallback(
    (path: string, content: string) => {
      setFiles((prev) => {
        const next = { ...prev, [path]: content };
        generatorRef.current?.setFiles(next);
        return next;
      });
    },
    [setFiles],
  );

  const deleteFile = useCallback(
    (path: string) => {
      setFiles((prev) => {
        const next = { ...prev };
        // Delete exact match and all children (for folders)
        const prefix = path + "/";
        for (const key of Object.keys(next)) {
          if (key === path || key.startsWith(prefix)) {
            delete next[key];
          }
        }
        generatorRef.current?.setFiles(next);
        return next;
      });
    },
    [setFiles],
  );

  const renameFile = useCallback(
    (oldPath: string, newPath: string) => {
      setFiles((prev) => {
        const next: ProjectFiles = {};
        const prefix = oldPath + "/";
        for (const [key, value] of Object.entries(prev)) {
          if (key === oldPath) {
            next[newPath] = value;
          } else if (key.startsWith(prefix)) {
            next[newPath + key.slice(oldPath.length)] = value;
          } else {
            next[key] = value;
          }
        }
        generatorRef.current?.setFiles(next);
        return next;
      });
    },
    [setFiles],
  );

  const moveFile = useCallback(
    (sourcePath: string, targetFolder: string) => {
      const fileName = sourcePath.split("/").pop()!;
      const newPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;
      renameFile(sourcePath, newPath);
    },
    [renameFile],
  );

  const retry = useCallback(async () => {
    setIsGenerating(true);
    // Remove the error assistant message from UI
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && typeof last.content === "string" && last.content.startsWith("⚠️")) {
        return prev.slice(0, -1);
      }
      return prev;
    });
    try {
      const generator = getGenerator();
      if (generator) await generator.retry();
    } catch (err: any) {
      console.error("Error retrying:", err);
      if (err?.name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ ${err?.message || "Unknown error"}` },
        ]);
      }
    } finally {
      setIsGenerating(false);
    }
  }, [getGenerator, setIsGenerating, setMessages]);

  return { generate, stop, retry, updateFiles, deleteFile, renameFile, moveFile };
}
