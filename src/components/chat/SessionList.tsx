import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LayoutTemplate,
  MessageSquarePlus,
  PanelLeftClose,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConversationStore, DEFAULT_TITLE } from "../../store/conversation";
import { useProjectTemplateStore } from "../../store/project-templates";
import { useSettingsStore } from "../../store/settings";
import {
  getNextVisibleCount,
  getVisibleListWindow,
} from "../../lib/utils/list-window";
import {
  createConversationFromProjectTemplate,
  createProjectTemplateFromConversation,
} from "../../lib/utils/project-templates";
import { useT } from "../../i18n";
import type { Conversation } from "../../types";
import {
  ProjectTemplateDialog,
  type ProjectTemplateSaveInput,
} from "./ProjectTemplateDialog";
import { SessionItem } from "./session-list/SessionItem";
import { SessionGroup } from "./session-list/SessionGroup";

interface SessionListProps {
  onClose: () => void;
}

const SESSION_LIST_BATCH = 5;

export function SessionList({ onClose }: SessionListProps) {
  const t = useT();
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const createConversation = useConversationStore((s) => s.createConversation);
  const addConversation = useConversationStore((s) => s.addConversation);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const renameConversation = useConversationStore((s) => s.renameConversation);
  const pinConversation = useConversationStore((s) => s.pinConversation);
  const unpinConversation = useConversationStore((s) => s.unpinConversation);
  const archiveConversation = useConversationStore(
    (s) => s.archiveConversation,
  );
  const unarchiveConversation = useConversationStore(
    (s) => s.unarchiveConversation,
  );
  const templateRecord = useProjectTemplateStore((s) => s.templates);
  const addTemplate = useProjectTemplateStore((s) => s.addTemplate);
  const deleteTemplate = useProjectTemplateStore((s) => s.deleteTemplate);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [normalOpen, setNormalOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateSourceId, setTemplateSourceId] = useState<string | null>(null);
  const isSearching = query.trim().length > 0;
  const [visibleSessionCount, setVisibleSessionCount] =
    useState(SESSION_LIST_BATCH);
  const [visiblePinnedCount, setVisiblePinnedCount] =
    useState(SESSION_LIST_BATCH);
  const [visibleNormalCount, setVisibleNormalCount] =
    useState(SESSION_LIST_BATCH);
  const [visibleArchivedCount, setVisibleArchivedCount] =
    useState(SESSION_LIST_BATCH);

  useEffect(() => {
    setVisibleSessionCount(SESSION_LIST_BATCH);
    setVisiblePinnedCount(SESSION_LIST_BATCH);
    setVisibleNormalCount(SESSION_LIST_BATCH);
    setVisibleArchivedCount(SESSION_LIST_BATCH);
  }, [query]);

  const matchesQuery = useCallback(
    (conv: Conversation) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      const title = (
        conv.title === DEFAULT_TITLE ? t.chat.newApp : conv.title
      ).toLowerCase();
      return title.includes(q);
    },
    [query, t.chat.newApp],
  );

  const sorted = useMemo(
    () =>
      Object.values(conversations)
        .filter(matchesQuery)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations, matchesQuery],
  );

  const pinned = useMemo(
    () => sorted.filter((c) => c.pinned && !c.archived),
    [sorted],
  );
  const normal = useMemo(
    () => sorted.filter((c) => !c.pinned && !c.archived),
    [sorted],
  );
  const archived = useMemo(() => sorted.filter((c) => c.archived), [sorted]);
  const templates = useMemo(
    () =>
      Object.values(templateRecord).sort((a, b) => b.updatedAt - a.updatedAt),
    [templateRecord],
  );

  const hasGroups = pinned.length > 0 || archived.length > 0;
  const deleteDisabled = Object.keys(conversations).length <= 1;
  const sessionWindow = useMemo(
    () =>
      getVisibleListWindow(
        sorted,
        isSearching ? sorted.length : visibleSessionCount,
      ),
    [isSearching, sorted, visibleSessionCount],
  );
  const pinnedWindow = useMemo(
    () =>
      getVisibleListWindow(
        pinned,
        isSearching ? pinned.length : visiblePinnedCount,
      ),
    [isSearching, pinned, visiblePinnedCount],
  );
  const normalWindow = useMemo(
    () =>
      getVisibleListWindow(
        normal,
        isSearching ? normal.length : visibleNormalCount,
      ),
    [isSearching, normal, visibleNormalCount],
  );
  const archivedWindow = useMemo(
    () =>
      getVisibleListWindow(
        archived,
        isSearching ? archived.length : visibleArchivedCount,
      ),
    [archived, isSearching, visibleArchivedCount],
  );

  const handleNew = () => {
    createConversation();
    onClose();
  };

  const handleSelect = useCallback(
    (id: string) => {
      switchConversation(id);
      onClose();
    },
    [switchConversation, onClose],
  );

  const displayTitle = useCallback(
    (conv: Conversation) =>
      conv.title === DEFAULT_TITLE ? t.chat.newApp : conv.title,
    [t.chat.newApp],
  );

  const openTemplates = useCallback(
    (sourceId?: string) => {
      setTemplateSourceId(sourceId ?? activeId);
      setTemplatesOpen(true);
    },
    [activeId],
  );

  const templateSourceConversation = useMemo(() => {
    const sourceId = templateSourceId ?? activeId;
    return sourceId ? (conversations[sourceId] ?? null) : null;
  }, [activeId, conversations, templateSourceId]);

  const templateSourceTitle = templateSourceConversation
    ? displayTitle(templateSourceConversation)
    : t.chat.newApp;

  const handleSaveCurrentTemplate = useCallback(
    (input: ProjectTemplateSaveInput) => {
      const sourceId = templateSourceId ?? activeId;
      const conversation = sourceId
        ? useConversationStore.getState().conversations[sourceId]
        : null;
      if (!conversation) {
        return { ok: false as const, error: "Source conversation not found." };
      }

      try {
        addTemplate(
          createProjectTemplateFromConversation(conversation, {
            id: crypto.randomUUID(),
            name: input.name,
            description: input.description,
            tags: input.tags,
            now: Date.now(),
          }),
        );
        return { ok: true as const };
      } catch (err) {
        return {
          ok: false as const,
          error:
            err instanceof Error ? err.message : "Failed to save template.",
        };
      }
    },
    [activeId, addTemplate, templateSourceId],
  );

  const handleCreateFromTemplate = useCallback(
    (templateId: string) => {
      const template = useProjectTemplateStore.getState().templates[templateId];
      if (!template) return;
      const conversation = createConversationFromProjectTemplate(template, {
        id: crypto.randomUUID(),
        now: Date.now(),
      });
      addConversation(conversation);
      setQuery("");
      setTemplatesOpen(false);
      onClose();
    },
    [addConversation, onClose],
  );

  const handleSmartRename = useCallback(
    async (convId: string) => {
      const conv = useConversationStore.getState().conversations[convId];
      if (!conv || conv.messages.length === 0) return;

      const ai = useSettingsStore.getState().ai;
      if (ai.runtime === "api" && (!ai.apiKey || !ai.apiBaseUrl || !ai.model))
        return;

      setRenamingId(convId);
      try {
        const { generateSmartTitle } =
          await import("../../lib/utils/smart-title");
        const localText =
          ai.runtime === "localCli"
            ? await import("../../lib/local-agent/generator").then(
                ({ runLocalUtilityText }) => {
                  const provider = ai.localAgent.provider;
                  const preferences = ai.localAgent[provider];
                  return (
                    instructions: string,
                    prompt: string,
                    options?: { timeoutMs?: number; signal?: AbortSignal },
                  ) =>
                    runLocalUtilityText(
                      {
                        provider,
                        model: preferences.model,
                        effort: preferences.effort,
                      },
                      instructions,
                      prompt,
                      options,
                    );
                },
              )
            : undefined;
        const title = await generateSmartTitle(
          conv.messages,
          {
            apiType: ai.apiType,
            apiBaseUrl: ai.apiBaseUrl,
            apiKey: ai.apiKey,
            model: ai.model,
          },
          localText,
        );
        if (title) {
          renameConversation(convId, title);
        }
      } finally {
        setRenamingId(null);
      }
    },
    [renameConversation],
  );

  const renderItem = (conv: Conversation) => (
    <SessionItem
      key={conv.id}
      conv={conv}
      isActive={conv.id === activeId}
      isSmartRenaming={renamingId === conv.id}
      defaultEditValue={conv.title === DEFAULT_TITLE ? "" : conv.title}
      displayTitle={displayTitle}
      onSelect={handleSelect}
      onRename={renameConversation}
      onSmartRename={handleSmartRename}
      onSaveAsTemplate={openTemplates}
      canSaveAsTemplate={Object.keys(conv.files).length > 0}
      pin={pinConversation}
      unpin={unpinConversation}
      archive={archiveConversation}
      unarchive={unarchiveConversation}
      onDelete={deleteConversation}
      deleteDisabled={deleteDisabled}
    />
  );

  const renderLoadMore = (hiddenCount: number, onClick: () => void) =>
    hiddenCount > 0 ? (
      <div className="px-3 py-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-full text-[11px] font-normal text-muted-foreground/60 hover:text-muted-foreground"
          onClick={onClick}
        >
          {t.sessions.loadMore}
        </Button>
      </div>
    ) : null;

  return (
    <nav
      aria-label={t.sessions.title}
      className="flex h-full flex-col overflow-hidden bg-background"
    >
      <header className="flex items-center justify-between border-b px-3 py-2.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label={t.sessions.close}
              className="h-8 w-8"
            >
              <PanelLeftClose size={18} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t.sessions.close}</TooltipContent>
        </Tooltip>
        <h2 className="text-sm font-medium">{t.sessions.title}</h2>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => openTemplates()}
                aria-label={t.sessions.templates.title}
              >
                <LayoutTemplate size={17} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t.sessions.templates.title}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleNew}
                aria-label={t.commandPalette.actions.newConversation}
              >
                <MessageSquarePlus size={18} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t.commandPalette.actions.newConversation}
            </TooltipContent>
          </Tooltip>
        </div>
      </header>
      <div className="px-3 py-3">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.sessions.searchPlaceholder}
            aria-label={t.sessions.searchPlaceholder}
            name="session-search"
            autoComplete="off"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">
            {t.sessions.emptySearch}
          </p>
        ) : hasGroups ? (
          <>
            <SessionGroup
              label={t.sessions.pinned}
              count={pinned.length}
              open={isSearching || pinnedOpen}
              onOpenChange={setPinnedOpen}
            >
              {pinnedWindow.visible.map(renderItem)}
              {renderLoadMore(pinnedWindow.hiddenCount, () =>
                setVisiblePinnedCount((count) =>
                  getNextVisibleCount(count, pinned.length, SESSION_LIST_BATCH),
                ),
              )}
            </SessionGroup>
            <SessionGroup
              label={t.sessions.normal}
              count={normal.length}
              open={isSearching || normalOpen}
              onOpenChange={setNormalOpen}
            >
              {normalWindow.visible.map(renderItem)}
              {renderLoadMore(normalWindow.hiddenCount, () =>
                setVisibleNormalCount((count) =>
                  getNextVisibleCount(count, normal.length, SESSION_LIST_BATCH),
                ),
              )}
            </SessionGroup>
            <SessionGroup
              label={t.sessions.archived}
              count={archived.length}
              open={isSearching || archivedOpen}
              onOpenChange={setArchivedOpen}
            >
              {archivedWindow.visible.map(renderItem)}
              {renderLoadMore(archivedWindow.hiddenCount, () =>
                setVisibleArchivedCount((count) =>
                  getNextVisibleCount(
                    count,
                    archived.length,
                    SESSION_LIST_BATCH,
                  ),
                ),
              )}
            </SessionGroup>
          </>
        ) : (
          <>
            {sessionWindow.visible.map(renderItem)}
            {renderLoadMore(sessionWindow.hiddenCount, () =>
              setVisibleSessionCount((count) =>
                getNextVisibleCount(count, sorted.length, SESSION_LIST_BATCH),
              ),
            )}
          </>
        )}
      </div>

      {templatesOpen && (
        <ProjectTemplateDialog
          sourceConversation={templateSourceConversation}
          sourceTitle={templateSourceTitle}
          templates={templates}
          onClose={() => setTemplatesOpen(false)}
          onSaveCurrent={handleSaveCurrentTemplate}
          onCreateFromTemplate={handleCreateFromTemplate}
          onDeleteTemplate={deleteTemplate}
        />
      )}
    </nav>
  );
}
