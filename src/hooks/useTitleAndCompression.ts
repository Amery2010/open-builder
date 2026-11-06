import {
  captureConversationIdentity,
  isConversationIdentityCurrent,
} from "../lib/conversation/branches";
import { useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useConversationStore, DEFAULT_TITLE } from "../store/conversation";
import type { ProviderConfig } from "../lib/ai/provider-config";
import type { Message } from "../types";
import { deriveFallbackTitle } from "../lib/utils/title-fallback";

interface UseTitleAndCompressionArgs {
  /** Returns the current local provider configuration. */
  resolveConfig: () => Promise<ProviderConfig>;
  setIsGenerating: Dispatch<SetStateAction<boolean>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  generateTextOverride?: (
    instructions: string,
    prompt: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<string>;
  generateTitleOverride?: UseTitleAndCompressionArgs["generateTextOverride"];
}

interface SmartTitleRequest {
  conversationId: string;
  firstRequest: Message;
  config: ProviderConfig;
}

export function useTitleAndCompression({
  resolveConfig,
  setIsGenerating,
  setMessages,
  generateTextOverride,
  generateTitleOverride,
}: UseTitleAndCompressionArgs) {
  const titleTasksRef = useRef(new Set<string>());

  const triggerSmartTitle = useCallback(
    async ({
      conversationId,
      firstRequest,
      config,
    }: SmartTitleRequest): Promise<void> => {
      const conversation =
        useConversationStore.getState().conversations[conversationId];
      if (
        !conversation ||
        conversation.title !== DEFAULT_TITLE ||
        titleTasksRef.current.has(conversationId)
      ) {
        return;
      }

      const provisionalTitle = deriveFallbackTitle([firstRequest]);
      if (!provisionalTitle) return;

      titleTasksRef.current.add(conversationId);
      useConversationStore
        .getState()
        .renameConversation(conversationId, provisionalTitle);
      try {
        const { generateSmartTitle } = await import("../lib/utils/smart-title");
        const title = await generateSmartTitle(
          [firstRequest],
          config,
          generateTitleOverride ?? generateTextOverride,
        );
        if (!title || title === provisionalTitle) return;

        const currentConversation =
          useConversationStore.getState().conversations[conversationId];
        if (currentConversation?.title === provisionalTitle) {
          useConversationStore
            .getState()
            .renameConversation(conversationId, title);
        }
      } catch (error) {
        console.warn(
          "[smart-title] Failed to apply conversation title.",
          error,
        );
      } finally {
        titleTasksRef.current.delete(conversationId);
      }
    },
    [generateTextOverride, generateTitleOverride],
  );

  const compressContext = useCallback(async () => {
    const storeState = useConversationStore.getState();
    const conv = storeState.activeId
      ? storeState.conversations[storeState.activeId]
      : null;
    if (!conv) return;
    const identity = captureConversationIdentity(conv);
    const isCurrent = () =>
      useConversationStore.getState().activeId === conv.id &&
      isConversationIdentityCurrent(
        identity,
        useConversationStore.getState().conversations[conv.id],
      );

    setIsGenerating(true);
    try {
      const cfg = await resolveConfig();
      if (!isCurrent()) return;
      const { runCompress } = await import("../lib/utils/run-compress");
      await runCompress(cfg, conv, generateTextOverride, isCurrent);
    } catch (err: any) {
      if (!isCurrent()) return;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `${err?.message || "Compression failed"}`,
        },
      ]);
    } finally {
      if (isCurrent()) {
        setIsGenerating(false);
      }
    }
  }, [resolveConfig, setMessages, setIsGenerating, generateTextOverride]);

  return { triggerSmartTitle, compressContext };
}
