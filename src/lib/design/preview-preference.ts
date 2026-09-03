import { useConversationStore } from "../../store/conversation";
import { isPreviewView, type PreviewView } from "../../types";

export type SetDefaultPreviewViewResult =
  | { ok: true; status: "updated" | "deferred" | "no-op"; view: PreviewView }
  | {
      ok: false;
      status: "invalid" | "unavailable" | "stale";
      error: string;
      view?: PreviewView;
    };

/** Host-owned mutation for the project default; toolbar state is not touched. */
export function setConversationDefaultPreviewView(input: {
  conversationId: string;
  view: unknown;
}): SetDefaultPreviewViewResult {
  if (!isPreviewView(input.view)) {
    return {
      ok: false,
      status: "invalid",
      error: "view must be desktop, tablet, or mobile",
    };
  }
  const state = useConversationStore.getState();
  const conversation = state.conversations[input.conversationId];
  if (!conversation || state.activeId !== input.conversationId) {
    return {
      ok: false,
      status: "stale",
      error: "The active Conversation changed.",
    };
  }
  if (conversation.previewMode === "code-only") {
    return {
      ok: false,
      status: "unavailable",
      error: "Default preview selection is unavailable for code-only projects.",
      view: conversation.defaultPreviewView ?? "desktop",
    };
  }
  if ((conversation.defaultPreviewView ?? "desktop") === input.view) {
    return { ok: true, status: "no-op", view: input.view };
  }
  state.setDefaultPreviewViewForConversation(input.conversationId, input.view);
  const committed =
    useConversationStore.getState().conversations[input.conversationId];
  if (committed?.defaultPreviewView !== input.view) {
    return {
      ok: false,
      status: "stale",
      error: "The Conversation changed before the preview default was saved.",
    };
  }
  return {
    ok: true,
    status: conversation.isProjectInitialized ? "updated" : "deferred",
    view: input.view,
  };
}
