import {
  captureConversationIdentity,
  isConversationIdentityCurrent,
} from "../conversation/branches";
import type { ProviderConfig } from "../ai/provider";
import type { Conversation } from "../../types";
import { compressContext, type CompressResult } from "./compress-context";
import { useConversationStore } from "../../store/conversation";

export async function runCompress(
  cfg: ProviderConfig,
  conv: Conversation,
  generateTextOverride?: (
    instructions: string,
    prompt: string,
  ) => Promise<string>,
  isCurrent: () => boolean = () => true,
): Promise<CompressResult | null> {
  const identity = captureConversationIdentity(conv);
  const result = await compressContext(
    conv.messages,
    cfg,
    conv.compressedContext,
    conv.files,
    generateTextOverride,
  );
  if (
    !isCurrent() ||
    !isConversationIdentityCurrent(
      identity,
      useConversationStore.getState().conversations[conv.id],
    )
  )
    return null;
  if (result) {
    useConversationStore
      .getState()
      .setCompressedContextForConversation(conv.id, result);
  }
  return result;
}
