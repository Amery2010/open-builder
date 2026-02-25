import { useRef, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { WebAppGenerator } from "../lib/generator";
import { createOpenAIGenerator } from "../lib/client";
import type { Message, ProjectFiles, AISettings } from "../types";

interface UseGeneratorOptions {
  settings: AISettings;
  files: ProjectFiles;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setFiles: Dispatch<SetStateAction<ProjectFiles>>;
  setIsGenerating: Dispatch<SetStateAction<boolean>>;
}

export function useGenerator({
  settings,
  files,
  setMessages,
  setFiles,
  setIsGenerating,
}: UseGeneratorOptions) {
  const generatorRef = useRef<WebAppGenerator | null>(null);

  const getGenerator = useCallback(() => {
    if (!settings.apiKey || !settings.apiUrl || !settings.model) return null;

    // Invalidate if settings changed
    if (generatorRef.current) {
      const g = generatorRef.current as any;
      if (
        g._apiKey !== settings.apiKey ||
        g._apiUrl !== settings.apiUrl ||
        g._model !== settings.model
      ) {
        generatorRef.current = null;
      }
    }

    if (!generatorRef.current) {
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
                  { ...last, content: (last.content || "") + delta },
                ];
              }
              return [...prev, { role: "assistant", content: delta }];
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
          onComplete: (result) => {
            setMessages(result.messages);
          },
          onError: (error) => {
            console.error("Generation error:", error);
          },
        },
        files,
      );
    }

    return generatorRef.current;
  }, [settings, files, setMessages, setFiles]);

  const generate = useCallback(
    async (prompt: string) => {
      setIsGenerating(true);
      setMessages((prev) => [...prev, { role: "user", content: prompt }]);
      try {
        const generator = getGenerator();
        if (generator) await generator.generate(prompt);
      } catch (err) {
        console.error("Error generating:", err);
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

  return { generate, stop, updateFiles };
}
