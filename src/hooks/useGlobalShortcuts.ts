import { useEffect, useRef } from "react";
import { useCommandPaletteStore } from "../store/command-palette";
import { useInteractiveStore } from "../store/interactive";

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

interface GlobalShortcutHandlers {
  newConversation: () => void;
  openSettings: () => void;
  focusChatInput: () => void;
  stopGenerating?: () => void;
  isGenerating: boolean;
  /** Optional override for hosts that already track the questionnaire state. */
  isQuestionnairePending?: boolean;
}

/** Detect whether the keydown should be ignored because the user is typing
 *  into an editable element. Always lets Cmd/Ctrl-K and Esc through. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useGlobalShortcuts(handlers: GlobalShortcutHandlers) {
  const setPaletteOpen = useCommandPaletteStore((s) => s.setOpen);
  const togglePalette = useCommandPaletteStore((s) => s.toggle);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const h = handlersRef.current;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();
      const questionnairePending =
        h.isQuestionnairePending === true ||
        useInteractiveStore
          .getState()
          .pending.some(
            (item) =>
              item.kind === "question" && item.presentation === "questionnaire",
          );

      // A questionnaire owns the chat pane. Escape is its explicit cancel
      // action; all other global shortcuts are blocked until it is resolved.
      if (questionnairePending && key === "escape") {
        e.preventDefault();
        h.stopGenerating?.();
        return;
      }
      if (
        questionnairePending &&
        mod &&
        (key === "k" || key === "n" || key === "," || key === "/")
      ) {
        e.preventDefault();
        return;
      }
      if (questionnairePending) return;

      // Cmd/Ctrl+K — toggle command palette. Always available.
      if (mod && key === "k") {
        e.preventDefault();
        togglePalette();
        return;
      }

      // Esc — close palette first, otherwise stop generating.
      if (key === "escape") {
        if (useCommandPaletteStore.getState().open) {
          setPaletteOpen(false);
          return;
        }
        if (h.isGenerating && h.stopGenerating) {
          e.preventDefault();
          h.stopGenerating();
        }
        return;
      }

      const inEditable = isEditableTarget(e.target);

      // Cmd/Ctrl+/ — focus chat input. Skipped while typing.
      if (mod && key === "/" && !inEditable) {
        e.preventDefault();
        h.focusChatInput();
        return;
      }

      // Cmd/Ctrl+N — new conversation. Skipped while typing.
      if (mod && key === "n" && !inEditable) {
        e.preventDefault();
        h.newConversation();
        return;
      }

      // Cmd/Ctrl+, — open settings.
      if (mod && key === "," && !inEditable) {
        e.preventDefault();
        h.openSettings();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setPaletteOpen, togglePalette]);
}

export const SHORTCUT_LABELS = {
  newConversation: isMac ? "⌘N" : "Ctrl+N",
  openSettings: isMac ? "⌘," : "Ctrl+,",
  commandPalette: isMac ? "⌘K" : "Ctrl+K",
  stopGenerating: "Esc",
  focusInput: isMac ? "⌘/" : "Ctrl+/",
};
