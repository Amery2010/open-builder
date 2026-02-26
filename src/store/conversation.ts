import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import localforage from "localforage";
import type { Conversation, Message, ProjectFiles } from "../types";

// ─── localforage storage adapter ─────────────────────────────────────────────

const localforageStorage = {
  getItem: async (name: string) => {
    const value = await localforage.getItem<string>(name);
    return value ?? null;
  },
  setItem: async (name: string, value: string) => {
    await localforage.setItem(name, value);
  },
  removeItem: async (name: string) => {
    await localforage.removeItem(name);
  },
};

// ─── Store types ─────────────────────────────────────────────────────────────

type Updater<T> = T | ((prev: T) => T);
function applyUpdater<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function"
    ? (updater as (p: T) => T)(prev)
    : updater;
}

interface ConversationState {
  conversations: Record<string, Conversation>;
  activeId: string | null;
  _hasHydrated: boolean;

  createConversation: () => string;
  deleteConversation: (id: string) => void;
  switchConversation: (id: string) => void;

  setMessages: (updater: Updater<Message[]>) => void;
  setFiles: (updater: Updater<ProjectFiles>) => void;
  setTemplate: (updater: Updater<string>) => void;
  setIsProjectInitialized: (updater: Updater<boolean>) => void;
  renameConversation: (id: string, title: string) => void;
}

// ─── Helper: extract title from first user message ───────────────────────────

function deriveTitle(messages: Message[]): string | null {
  const first = messages.find((m) => m.role === "user");
  if (!first) return null;
  const text =
    typeof first.content === "string"
      ? first.content
      : ((first.content as any[])?.find((p: any) => p.type === "text")?.text ??
        "");
  if (!text) return null;
  return text.slice(0, 20) + (text.length > 20 ? "..." : "");
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useConversationStore = create<ConversationState>()(
  persist(
    (set, get) => ({
      conversations: {},
      activeId: null,
      _hasHydrated: false,

      createConversation: () => {
        const id = crypto.randomUUID();
        const conv: Conversation = {
          id,
          title: "新应用",
          messages: [],
          files: {},
          template: "vite-react-ts",
          isProjectInitialized: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((s) => ({
          conversations: { ...s.conversations, [id]: conv },
          activeId: id,
        }));
        return id;
      },

      deleteConversation: (id) => {
        set((s) => {
          const { [id]: _, ...rest } = s.conversations;
          let nextActiveId = s.activeId;
          if (s.activeId === id) {
            const remaining = Object.values(rest).sort(
              (a, b) => b.updatedAt - a.updatedAt,
            );
            nextActiveId = remaining[0]?.id ?? null;
          }
          return { conversations: rest, activeId: nextActiveId };
        });
      },

      switchConversation: (id) => {
        set({ activeId: id });
      },

      setMessages: (updater) => {
        set((s) => {
          if (!s.activeId || !s.conversations[s.activeId]) return s;
          const conv = s.conversations[s.activeId];
          const newMessages = applyUpdater(updater, conv.messages);
          let title = conv.title;
          if (title === "新应用") {
            const derived = deriveTitle(newMessages);
            if (derived) title = derived;
          }
          return {
            conversations: {
              ...s.conversations,
              [s.activeId]: {
                ...conv,
                messages: newMessages,
                title,
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      setFiles: (updater) => {
        set((s) => {
          if (!s.activeId || !s.conversations[s.activeId]) return s;
          const conv = s.conversations[s.activeId];
          return {
            conversations: {
              ...s.conversations,
              [s.activeId]: {
                ...conv,
                files: applyUpdater(updater, conv.files),
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      setTemplate: (updater) => {
        set((s) => {
          if (!s.activeId || !s.conversations[s.activeId]) return s;
          const conv = s.conversations[s.activeId];
          return {
            conversations: {
              ...s.conversations,
              [s.activeId]: {
                ...conv,
                template: applyUpdater(updater, conv.template),
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      setIsProjectInitialized: (updater) => {
        set((s) => {
          if (!s.activeId || !s.conversations[s.activeId]) return s;
          const conv = s.conversations[s.activeId];
          return {
            conversations: {
              ...s.conversations,
              [s.activeId]: {
                ...conv,
                isProjectInitialized: applyUpdater(
                  updater,
                  conv.isProjectInitialized,
                ),
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      renameConversation: (id, title) => {
        set((s) => {
          if (!s.conversations[id]) return s;
          return {
            conversations: {
              ...s.conversations,
              [id]: { ...s.conversations[id], title, updatedAt: Date.now() },
            },
          };
        });
      },
    }),
    {
      name: "open-builder-conversations",
      storage: createJSONStorage(() => localforageStorage),
      partialize: (state) => ({
        conversations: state.conversations,
        activeId: state.activeId,
      }),
      onRehydrateStorage: () => () => {
        useConversationStore.setState({ _hasHydrated: true });
      },
    },
  ),
);
