import { useCallback, useMemo } from "react";
import type { ProjectTemplate } from "../types";
import {
  createConversationFromProjectTemplate,
  isProjectTemplateUsable,
  prepareProjectTemplateFromConversation,
  prepareProjectTemplateUpgrade,
  type PreparedProjectTemplate,
  type TemplateMetadataInput,
} from "../lib/utils/project-templates";
import { DEFAULT_TITLE, useConversationStore } from "../store/conversation";
import { useProjectTemplateStore } from "../store/project-templates";
import { useProjectTemplateLibraryUi } from "../store/project-template-library-ui";

export { useProjectTemplateLibraryUi } from "../store/project-template-library-ui";

export type ProjectTemplateMetadata = Omit<TemplateMetadataInput, "id" | "now">;

export function useProjectTemplateController() {
  const open = useProjectTemplateLibraryUi((state) => state.open);
  const sourceConversationId = useProjectTemplateLibraryUi(
    (state) => state.sourceConversationId,
  );
  const openLibrary = useProjectTemplateLibraryUi((state) => state.openLibrary);
  const closeLibrary = useProjectTemplateLibraryUi(
    (state) => state.closeLibrary,
  );
  const conversations = useConversationStore((state) => state.conversations);
  const activeId = useConversationStore((state) => state.activeId);
  const conversationHydrated = useConversationStore(
    (state) => state._hasHydrated,
  );
  const templates = useProjectTemplateStore((state) => state.templates);
  const templateHydrated = useProjectTemplateStore(
    (state) => state._hasHydrated,
  );
  const resolvedSourceId = sourceConversationId ?? activeId;
  const sourceConversation = resolvedSourceId
    ? (conversations[resolvedSourceId] ?? null)
    : null;

  const prepareCurrent = useCallback(
    async (metadata: ProjectTemplateMetadata) => {
      const state = useConversationStore.getState();
      const sourceId =
        useProjectTemplateLibraryUi.getState().sourceConversationId ??
        state.activeId;
      const source = sourceId ? state.conversations[sourceId] : undefined;
      if (!source) throw new Error("Source conversation not found.");
      if (!useProjectTemplateStore.getState()._hasHydrated) {
        throw new Error("Project template library is still loading.");
      }
      return prepareProjectTemplateFromConversation(source, {
        ...metadata,
        id: crypto.randomUUID(),
        now: Date.now(),
      });
    },
    [],
  );

  const savePrepared = useCallback((prepared: PreparedProjectTemplate) => {
    return useProjectTemplateStore.getState().addTemplate(prepared.template);
  }, []);

  const prepareUpgrade = useCallback(async (templateId: string) => {
    if (!useProjectTemplateStore.getState()._hasHydrated) {
      throw new Error("Project template library is still loading.");
    }
    const template = useProjectTemplateStore.getState().templates[templateId];
    if (!template) throw new Error("Project template not found.");
    return prepareProjectTemplateUpgrade(template, Date.now());
  }, []);

  const updatePrepared = useCallback(
    (templateId: string, prepared: PreparedProjectTemplate) =>
      useProjectTemplateStore
        .getState()
        .replaceTemplate(templateId, prepared.template),
    [],
  );

  const editTemplate = useCallback(
    (
      templateId: string,
      patch: Partial<Pick<ProjectTemplate, "name" | "description" | "tags">>,
    ) => useProjectTemplateStore.getState().updateTemplate(templateId, patch),
    [],
  );

  const deleteTemplate = useCallback(
    (templateId: string) =>
      useProjectTemplateStore.getState().deleteTemplate(templateId),
    [],
  );

  const useTemplate = useCallback(
    async (templateId: string) => {
      const template = useProjectTemplateStore.getState().templates[templateId];
      if (!template) throw new Error("Project template not found.");
      if (!isProjectTemplateUsable(template)) {
        throw new Error(
          "This template must be safely upgraded before it can be used.",
        );
      }
      const now = Date.now();
      const conversation = await createConversationFromProjectTemplate(
        template,
        {
          id: crypto.randomUUID(),
          now,
        },
      );
      await useProjectTemplateStore
        .getState()
        .markTemplateUsed(templateId, now);
      useConversationStore.getState().addConversation(conversation);
      closeLibrary();
      return conversation.id;
    },
    [closeLibrary],
  );

  const sortedTemplates = useMemo(
    () =>
      Object.values(templates).sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    [templates],
  );

  return {
    open,
    openLibrary,
    closeLibrary,
    sourceConversation,
    sourceTitle:
      sourceConversation?.title === DEFAULT_TITLE
        ? ""
        : (sourceConversation?.title ?? ""),
    templates: sortedTemplates,
    isReady: conversationHydrated && templateHydrated,
    prepareCurrent,
    prepareUpgrade,
    savePrepared,
    updatePrepared,
    editTemplate,
    deleteTemplate,
    useTemplate,
  };
}
