import { useRef, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { WebAppGenerator } from "../lib/generator";
import { createOpenAIGenerator } from "../lib/client";
import { useConversationStore } from "../store/conversation";
import { useSettingsStore } from "../store/settings";
import { useSandpackStore } from "../store/sandpack";
import { TAVILY_TOOLS, createTavilyToolHandler } from "../lib/tavily";
import { MEMORY_TOOLS, MEMORY_TOOL_NAME, createMemoryToolHandler, buildMemoryPromptSection } from "../lib/memory";
import { useSnapshotStore } from "../store/snapshot";
import { mergeMessages } from "../lib/mergeMessages";
import { compressContext as doCompress } from "../lib/compressContext";
import { generateSmartTitle } from "../lib/smartName";
import { DEFAULT_TITLE } from "../store/conversation";
import type { Message, ContentPart, Conversation, ProjectFiles, AISettings, WebSearchSettings, Attachment } from "../types";

const isErrorMessage = (m: Message) =>
  m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("⚠️");

const removeErrorMessages = (prev: Message[]) => prev.filter((m) => !isErrorMessage(m));

/**
 * Filter out memory-related messages from the message array.
 * Memory messages are:
 *  - assistant messages where tool_calls contains manage_memories
 *  - tool result messages with tool_call_ids matching manage_memories calls
 *
 * If an assistant message has BOTH text content AND memory tool_calls,
 * keep the text but strip the memory tool_calls.
 */
function filterMemoryMessages(messages: Message[]): Message[] {
  // First pass: collect all manage_memories tool_call IDs
  const memoryToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function.name === MEMORY_TOOL_NAME) {
          memoryToolCallIds.add(tc.id);
        }
      }
    }
  }

  if (memoryToolCallIds.size === 0) return messages;

  // Second pass: filter
  const result: Message[] = [];
  for (const msg of messages) {
    // Skip tool result messages for memory operations
    if (msg.role === "tool" && msg.tool_call_id && memoryToolCallIds.has(msg.tool_call_id)) {
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls) {
      const nonMemoryToolCalls = msg.tool_calls.filter(
        (tc) => tc.function.name !== MEMORY_TOOL_NAME,
      );

      if (nonMemoryToolCalls.length === 0) {
        // All tool_calls were memory operations
        if (msg.content) {
          // Keep the text content, remove tool_calls
          result.push({ ...msg, tool_calls: undefined });
        }
        // If no content either, skip the entire message
        continue;
      }

      // Some tool_calls were non-memory — keep those
      result.push({ ...msg, tool_calls: nonMemoryToolCalls });
      continue;
    }

    result.push(msg);
  }

  return result;
}

/** Apply compression: return summary + messages after compression point */
function getMessagesForAPI(conv: Conversation): Message[] {
  const ctx = conv.compressedContext;
  if (!ctx) return removeErrorMessages(conv.messages);
  const recent = removeErrorMessages(conv.messages.slice(ctx.fromIndex));
  console.log("[compress-debug] fromIndex:", ctx.fromIndex, "total:", conv.messages.length, "recent:", recent.length, "summary:", ctx.summary.slice(0, 60));
  return [
    { role: "user", content: `[Previous conversation summary]\n${ctx.summary}` },
    { role: "assistant", content: "Understood. I'll continue based on the conversation summary above." },
    ...recent,
  ];
}

/** Create a snapshot for the current conversation state */
function createSnapshotForCurrentState() {
  const state = useConversationStore.getState();
  const conv = state.activeId ? state.conversations[state.activeId] : null;
  if (!conv || Object.keys(conv.files).length === 0) return;
  const merged = mergeMessages(conv.messages);
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i].role === "assistant") {
      useSnapshotStore.getState().createSnapshot(conv.id, merged[i].id, conv.files);
      return;
    }
  }
}

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
      const memoryHandler = createMemoryToolHandler();

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
        if (name === MEMORY_TOOL_NAME) {
          return memoryHandler(name, args);
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
            const actualId = id || `call_${Math.random().toString(36).substring(2, 11)}`;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                if (last.tool_calls?.some((tc) => tc.id === actualId)) return prev;
                const newToolCall = {
                  id: actualId,
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
              // If not found, we shouldn't add an empty tool_call_id, but rather discard or warn,
              // since OpenAI API rejects empty tool_call_id strings.
              // Just to be safe, if we somehow don't find it, we skip appending or use a dummy ID.
              // However, since it only gets emitted from the parser, it should always have an ID.
              // Let's log a warning but still append to avoid losing the result, except we MUST have a valid ID.
              console.warn("Couldn't find matching tool call for result:", _name);
              return prev;
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
            createSnapshotForCurrentState();

            // Smart naming: generate title if still using default
            const convState = useConversationStore.getState();
            const conv = convState.activeId
              ? convState.conversations[convState.activeId]
              : null;
            if (conv && conv.title === DEFAULT_TITLE) {
              generateSmartTitle(
                conv.messages,
                settings.apiUrl,
                settings.apiKey,
                settings.model,
              ).then((title) => {
                if (title) {
                  const current = useConversationStore.getState();
                  const currentConv = current.conversations[conv.id];
                  if (currentConv && currentConv.title === DEFAULT_TITLE) {
                    useConversationStore.getState().renameConversation(conv.id, title);
                  }
                }
              }).catch(() => {
                // Silently ignore smart naming failures
              });
            }
          },
          onError: (error) => {
            console.error("Generation error:", error);
          },
          onRetry: (attempt, maxAttempts, error) => {
            console.warn(`Retrying API request (${attempt}/${maxAttempts}):`, error.message);
            // Clear partial assistant message from the failed attempt
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                return prev.slice(0, -1);
              }
              return prev;
            });
          },
          onCompact: async () => {
            const s = useConversationStore.getState();
            const conv = s.activeId ? s.conversations[s.activeId] : null;
            if (!conv) return null;
            const result = await doCompress(
              conv.messages,
              settings.apiUrl,
              settings.apiKey,
              settings.model,
              conv.compressedContext,
            );
            if (!result) return null;
            useConversationStore.getState().setCompressedContext(result);
            return getMessagesForAPI({ ...conv, compressedContext: result });
          },
        },
        files,
        [...(webConfigured ? TAVILY_TOOLS : []), ...MEMORY_TOOLS],
        combinedToolHandler,
      );

      // Store config markers for invalidation comparison
      const gen = generatorRef.current as any;
      gen._apiKey = settings.apiKey;
      gen._apiUrl = settings.apiUrl;
      gen._model = settings.model;
      gen._tavilyKey = webSearchSettings.tavilyApiKey;
      gen._tavilyUrl = webSearchSettings.tavilyApiUrl;
    }

    return generatorRef.current;
  }, [settings, webSearchSettings, files, activeId, setMessages, setFiles, setTemplate, setIsProjectInitialized, restartSandpack]);

  const generate = useCallback(
    async (prompt: string, attachments?: Attachment[]) => {
      setIsGenerating(true);

      // Build message content: multi-part if attachments present, plain string otherwise
      let content: string | ContentPart[];
      if (attachments && attachments.length > 0) {
        const parts: ContentPart[] = [];
        if (prompt) parts.push({ type: "text", text: prompt });
        for (const att of attachments) {
          if (att.type === "image") {
            parts.push({ type: "image_url", image_url: { url: att.content } });
          } else {
            parts.push({ type: "text", text: `[File: ${att.name} | ${att.size}]\n${att.content}` });
          }
        }
        content = parts;
      } else {
        content = prompt;
      }

      // Get generator and sync its messages with the store BEFORE adding the new user message.
      // This ensures the generator has the full conversation history even if it was recreated
      // (e.g. after page refresh, settings change, or conversation switch).
      const generator = getGenerator();
      if (generator) {
        const storeState = useConversationStore.getState();
        const activeConv = storeState.activeId ? storeState.conversations[storeState.activeId] : null;
        if (activeConv) {
          generator.syncMessages(getMessagesForAPI(activeConv));
        }
        // Inject current memory context into system prompt
        generator.setSystemPromptSuffix(buildMemoryPromptSection());
      }

      setMessages((prev) => [...removeErrorMessages(prev), { role: "user", content }]);
      try {
        if (generator) await generator.generate(prompt, attachments);
      } catch (err: any) {
        console.error("Error generating:", err);
        if (err?.name !== "AbortError") {
          setMessages((prev) => [
            ...removeErrorMessages(prev),
            { role: "assistant", content: `⚠️ ${err?.message || "Unknown error"}` },
          ]);
        }
      } finally {
        // Filter memory messages from the persisted conversation (silent operation)
        setMessages((prev) => filterMemoryMessages(prev));
        setIsGenerating(false);
      }
    },
    [getGenerator, setIsGenerating, setMessages],
  );

  const stop = useCallback(() => {
    generatorRef.current?.abort();
    setIsGenerating(false);
    createSnapshotForCurrentState();
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
    // Remove error messages and incomplete tool calls (assistant tool_calls with no matching tool result)
    setMessages((prev) => {
      const toolResultIds = new Set(
        prev.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
      );
      return prev.filter((m) => {
        if (isErrorMessage(m)) return false;
        if (m.role === "assistant" && m.tool_calls?.length) {
          return m.tool_calls.every((tc) => toolResultIds.has(tc.id));
        }
        return true;
      });
    });
    try {
      const generator = getGenerator();
      if (generator) {
        // Sync messages from store (error message already removed by setMessages above)
        const storeState = useConversationStore.getState();
        const activeConv = storeState.activeId ? storeState.conversations[storeState.activeId] : null;
        if (activeConv) {
          generator.syncMessages(getMessagesForAPI(activeConv));
        }
        generator.setSystemPromptSuffix(buildMemoryPromptSection());
        await generator.retry();
      }
    } catch (err: any) {
      console.error("Error retrying:", err);
      if (err?.name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ ${err?.message || "Unknown error"}` },
        ]);
      }
    } finally {
      setMessages((prev) => filterMemoryMessages(prev));
      setIsGenerating(false);
    }
  }, [getGenerator, setIsGenerating, setMessages]);

  const compressContext = useCallback(async () => {
    const storeState = useConversationStore.getState();
    const conv = storeState.activeId ? storeState.conversations[storeState.activeId] : null;
    if (!conv) return;

    setIsGenerating(true);
    try {
      const result = await doCompress(
        conv.messages,
        settings.apiUrl,
        settings.apiKey,
        settings.model,
        conv.compressedContext,
      );
      if (result) {
        useConversationStore.getState().setCompressedContext(result);
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...removeErrorMessages(prev),
        { role: "assistant", content: `⚠️ ${err?.message || "Compression failed"}` },
      ]);
    } finally {
      setIsGenerating(false);
    }
  }, [settings, setMessages, setIsGenerating]);

  const review = useCallback(async () => {
    await generate("Please review all project files for security vulnerabilities. Use list_files and read_files to examine the code. Report any security issues found with severity and location, or confirm no issues were detected. If issues are found, ask if I should fix them automatically.");
  }, [generate]);

  const continueTask = useCallback(async () => {
    setIsGenerating(true);
    try {
      const generator = getGenerator();
      if (generator) {
        const storeState = useConversationStore.getState();
        const activeConv = storeState.activeId ? storeState.conversations[storeState.activeId] : null;
        if (activeConv) {
          generator.syncMessages(getMessagesForAPI(activeConv));
        }
        generator.setSystemPromptSuffix(buildMemoryPromptSection());
        await generator.generate("Please continue where you left off and complete any unfinished tasks.");
      }
    } catch (err: any) {
      console.error("Error continuing:", err);
      if (err?.name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ ${err?.message || "Unknown error"}` },
        ]);
      }
    } finally {
      setMessages((prev) => filterMemoryMessages(prev));
      setIsGenerating(false);
    }
  }, [getGenerator, setIsGenerating, setMessages]);

  return { generate, stop, retry, continueTask, updateFiles, deleteFile, renameFile, moveFile, compressContext, review };
}
