import {
  lazy,
  Suspense,
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatInput } from "./chat/ChatInput";
import { EmptyState } from "./chat/EmptyState";
import { MessageBubble } from "./chat/MessageBubble";
import { AskUserQuestionCard } from "./chat/AskUserQuestionCard";
import { GeneratingIndicator } from "./chat/GeneratingIndicator";
import { SettingsWarning } from "./chat/SettingsWarning";
import {
  LocalCliStatusNotice,
  type LocalCliStatusNoticeValue,
} from "./chat/LocalCliStatusNotice";
import { SessionListOverlay } from "./chat/SessionListOverlay";
import { ResetProjectConfirmDialog } from "./chat/ResetProjectConfirmDialog";
import {
  RollbackHint,
  RollbackConfirmDialog,
} from "./chat/RollbackConfirmBanner";
import { useMergedMessages } from "../hooks/useMergedMessages";
import { useRollback } from "../hooks/useRollback";
import {
  findAssistantGroupEnd,
  getMergedMessageStartIndex,
} from "../lib/utils/message-navigation";
import { findWithdrawableUserMessageIndex } from "../lib/utils/merge-messages";
import { useConversationStore } from "../store/conversation";
import { useInteractiveStore } from "../store/interactive";
import { useSnapshotStore } from "../store/snapshot";
import { discardPendingSandpackFileChanges } from "./code-viewer/sandpack-file-changes";
import {
  deleteAttachment,
  deleteAttachmentsForMessages,
  getAttachmentBlob,
} from "../lib/attachments/store";
import {
  getPermissionActivity,
  subscribePermissionActivity,
} from "../lib/security/activity-log";
import { useT } from "../i18n";
import type {
  Message,
  ProjectFiles,
  ProjectSnapshot,
  Attachment,
  ProjectPreviewMode,
  DesignSelectionContext,
} from "../types";
import { useDesignSelectionStore } from "../store/design-selection";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  ProjectImportCommitResult,
  StagedProjectImport,
} from "../lib/utils/project-import";
import type { CustomDesignSystemDraft } from "../lib/design-systems/ai";
import type { StagedDesignSystemImport } from "../lib/design-systems/importer";

const EMPTY_SNAPSHOTS: ProjectSnapshot[] = [];
const MobilePreview = lazy(() =>
  import("./chat/MobilePreview").then((module) => ({
    default: module.MobilePreview,
  })),
);
const DiffModal = lazy(() =>
  import("./chat/DiffModal").then((module) => ({ default: module.DiffModal })),
);
const SnapshotHistoryDialog = lazy(() =>
  import("./chat/SnapshotHistoryDialog").then((module) => ({
    default: module.SnapshotHistoryDialog,
  })),
);
const PermissionActivityDialog = lazy(() =>
  import("./chat/PermissionActivityDialog").then((module) => ({
    default: module.PermissionActivityDialog,
  })),
);

interface ChatInterfaceProps {
  messages: Message[];
  isGenerating: boolean;
  isThinkingStreaming?: boolean;
  hasConfiguredModelRuntime: boolean;
  localCliStatusNotice?: LocalCliStatusNoticeValue | null;
  onGenerate: (
    prompt: string,
    attachments?: Attachment[],
    options?: {
      forcedSkillIds?: string[];
      designSelection?: DesignSelectionContext;
    },
  ) => Promise<void>;
  onStop: () => void;
  onOpenSettings: () => void;
  onSetFiles: (files: ProjectFiles) => void;
  onImportProject: (
    project: StagedProjectImport,
  ) => Promise<ProjectImportCommitResult> | ProjectImportCommitResult;
  files: ProjectFiles;
  template: string;
  previewMode: ProjectPreviewMode;
  sandpackKey: number;
  onReloadPreview: () => void;
  isProjectInitialized: boolean;
  showInlinePreview: boolean;
  onCompressContext: () => Promise<void>;
  onRetry: () => Promise<void>;
  onContinue: () => Promise<void>;
  onReview: () => Promise<void>;
  onHealthCheck: () => Promise<void>;
  onApplyDesignSystem?: (id: string) => Promise<void> | void;
  onCompileDesignSystem?: (
    draft: CustomDesignSystemDraft,
  ) => Promise<StagedDesignSystemImport>;
  onProjectReset?: () => void;
  /** Atomically abort/remove the final genuine user message in the owner and
   * return the draft that should be restored to this composer. */
  onWithdrawLastMessage?: () =>
    WithdrawnMessageDraft | null | Promise<WithdrawnMessageDraft | null>;
}

export interface WithdrawnMessageDraft {
  content: string;
  attachments: Attachment[];
  forcedSkillIds: string[];
  designSelection?: DesignSelectionContext;
}

async function restoreAvailableAttachments(
  attachments: readonly Attachment[],
): Promise<{ attachments: Attachment[]; missingNames: string[] }> {
  const missingNames: string[] = [];
  const restored = await Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.content || attachment.previewUrl) return attachment;
      const blob = await getAttachmentBlob(attachment.id).catch(() => null);
      if (!blob) {
        missingNames.push(attachment.name);
        return null;
      }
      if (attachment.type !== "image") return attachment;
      const previewUrl =
        typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(blob)
          : undefined;
      return previewUrl ? { ...attachment, previewUrl } : attachment;
    }),
  );
  return {
    attachments: restored.filter(
      (attachment): attachment is Attachment => !!attachment,
    ),
    missingNames,
  };
}

export function ChatInterface({
  messages,
  isGenerating,
  isThinkingStreaming = false,
  hasConfiguredModelRuntime,
  localCliStatusNotice = null,
  onGenerate,
  onStop,
  onOpenSettings,
  onSetFiles,
  onImportProject,
  files,
  template,
  previewMode,
  sandpackKey,
  onReloadPreview,
  isProjectInitialized,
  showInlinePreview,
  onCompressContext,
  onRetry,
  onContinue,
  onReview,
  onHealthCheck,
  onApplyDesignSystem = () => {},
  onCompileDesignSystem,
  onProjectReset,
  onWithdrawLastMessage,
}: ChatInterfaceProps) {
  const t = useT();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [forcedSkillIds, setForcedSkillIds] = useState<string[]>([]);
  const [showSessionList, setShowSessionList] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const virtualListRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const mergedMessages = useMergedMessages(messages);
  const shouldVirtualizeMessages = mergedMessages.length > 40;
  const virtualScrollMargin = virtualListRef.current?.offsetTop ?? 0;
  const messageVirtualizer = useVirtualizer({
    count: shouldVirtualizeMessages ? mergedMessages.length : 0,
    getScrollElement: () => messagesViewportRef.current,
    estimateSize: () => 160,
    getItemKey: (index) => mergedMessages[index]?.id ?? index,
    overscan: 6,
    scrollMargin: virtualScrollMargin,
  });
  const activeId = useConversationStore((s) => s.activeId);
  const pendingQuestionnaire = useInteractiveStore((state) =>
    state.pending.find(
      (item) =>
        item.kind === "question" && item.presentation === "questionnaire",
    ),
  );
  const hasPendingInteraction = useInteractiveStore(
    (state) => state.pending.length > 0,
  );
  const isQuestionnairePending = pendingQuestionnaire !== undefined;
  const withdrawableUserMessageIndex = findWithdrawableUserMessageIndex(
    messages,
    mergedMessages,
  );
  const lastVisibleMessage = mergedMessages.at(-1);
  const canWithdrawLastMessage = Boolean(
    onWithdrawLastMessage && withdrawableUserMessageIndex !== null,
  );
  useEffect(() => {
    if (!isQuestionnairePending) return;
    const cancelQuestionnaire = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onStop();
    };
    document.addEventListener("keydown", cancelQuestionnaire);
    return () => document.removeEventListener("keydown", cancelQuestionnaire);
  }, [isQuestionnairePending, onStop]);
  useEffect(() => {
    setForcedSkillIds([]);
    setAttachmentRestoreWarning(null);
  }, [activeId]);
  const compressFromIndex = useConversationStore((s) =>
    s.activeId
      ? (s.conversations[s.activeId]?.compressedContext?.fromIndex ?? -1)
      : -1,
  );
  const snapshots = useSnapshotStore((s) =>
    activeId ? (s.snapshots[activeId] ?? EMPTY_SNAPSHOTS) : EMPTY_SNAPSHOTS,
  );
  const snapshotMessageIds = useMemo(
    () => new Set(snapshots.map((s) => s.messageId)),
    [snapshots],
  );
  const [diffMessageId, setDiffMessageId] = useState<string | null>(null);
  const [showPermissionActivity, setShowPermissionActivity] = useState(false);
  const [permissionActivityCount, setPermissionActivityCount] = useState(0);
  const [showSnapshotHistory, setShowSnapshotHistory] = useState(false);
  const [showResetProjectConfirm, setShowResetProjectConfirm] = useState(false);
  const [attachmentRestoreWarning, setAttachmentRestoreWarning] = useState<
    string | null
  >(null);

  useEffect(() => {
    setShowPermissionActivity(false);
    if (!activeId) {
      setPermissionActivityCount(0);
      return;
    }

    const refresh = () => {
      setPermissionActivityCount(getPermissionActivity(activeId).length);
    };
    refresh();
    return subscribePermissionActivity(refresh);
  }, [activeId]);

  const {
    rollbackConfirmId,
    setRollbackConfirmId,
    rollbackInfo,
    setRollbackInfo,
    handleRollback,
    flushSnapshotUpdate,
  } = useRollback({
    activeId,
    messages,
    snapshotsLength: snapshots.length,
    onSetFiles,
  });

  const handleSlashCommand = useCallback(
    async (cmd: string) => {
      if (isQuestionnairePending) return;
      setInput("");
      switch (cmd) {
        case "new":
          useConversationStore.getState().createConversation();
          break;
        case "fork":
          useConversationStore.getState().forkConversation();
          break;
        case "clear":
          try {
            const state = useConversationStore.getState();
            const retainedMessages = Object.values(state.conversations)
              .filter((conversation) => conversation.id !== state.activeId)
              .flatMap((conversation) => conversation.messages);
            await Promise.all([
              deleteAttachmentsForMessages(messages, retainedMessages),
              ...attachments.map((attachment) =>
                deleteAttachment(attachment.id),
              ),
            ]);
          } catch (error) {
            console.warn(
              "Failed to delete one or more cleared attachments:",
              error,
            );
          }
          for (const attachment of attachments) {
            if (attachment.previewUrl)
              URL.revokeObjectURL(attachment.previewUrl);
          }
          useConversationStore.getState().clearContext();
          setAttachments([]);
          setForcedSkillIds([]);
          setRollbackConfirmId(null);
          setRollbackInfo(null);
          break;
        case "reset":
          setShowResetProjectConfirm(true);
          break;
        case "compact":
          onCompressContext();
          break;
        case "health":
          onHealthCheck();
          break;
        case "review":
          onReview();
          break;
        case "continue":
          onContinue();
          break;
        case "retry":
          onRetry();
          break;
      }
    },
    [
      onCompressContext,
      onHealthCheck,
      onReview,
      onRetry,
      onContinue,
      attachments,
      messages,
      setRollbackConfirmId,
      setRollbackInfo,
      isQuestionnairePending,
    ],
  );

  const handleResetProject = useCallback(async () => {
    if (activeId) {
      discardPendingSandpackFileChanges(activeId);
    }
    try {
      const state = useConversationStore.getState();
      const retainedMessages = Object.values(state.conversations)
        .filter((conversation) => conversation.id !== state.activeId)
        .flatMap((conversation) => conversation.messages);
      await Promise.all([
        deleteAttachmentsForMessages(messages, retainedMessages),
        ...attachments.map((attachment) => deleteAttachment(attachment.id)),
      ]);
    } catch (error) {
      console.warn("Failed to delete one or more reset attachments:", error);
    }
    for (const attachment of attachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    useConversationStore.getState().resetProject();
    setAttachments([]);
    setForcedSkillIds([]);
    setRollbackConfirmId(null);
    setRollbackInfo(null);
    setDiffMessageId(null);
    setShowSnapshotHistory(false);
    setShowResetProjectConfirm(false);
    onProjectReset?.();
  }, [
    activeId,
    attachments,
    messages,
    onProjectReset,
    setRollbackConfirmId,
    setRollbackInfo,
  ]);

  const lastAssistantId = useMemo(() => {
    for (let i = mergedMessages.length - 1; i >= 0; i--) {
      if (mergedMessages[i].role === "assistant") return mergedMessages[i].id;
    }
    return null;
  }, [mergedMessages]);

  const handleShowDiff = useCallback((id: string) => setDiffMessageId(id), []);
  const handleShowDiffFromHistory = useCallback((id: string) => {
    setShowSnapshotHistory(false);
    setDiffMessageId(id);
  }, []);
  const handleRollbackConfirm = useCallback(
    (id: string) => setRollbackConfirmId(id),
    [setRollbackConfirmId],
  );
  const handleRollbackFromHistory = useCallback(
    (id: string) => {
      setShowSnapshotHistory(false);
      setRollbackConfirmId(id);
    },
    [setRollbackConfirmId],
  );

  const updateAutoScrollIntent = useCallback(() => {
    const el = messagesViewportRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 96;
  }, []);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    messagesEndRef.current?.scrollIntoView({
      behavior: isGenerating ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, isGenerating]);

  useEffect(() => {
    if (!showSessionList) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSessionList(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showSessionList]);

  const handleWithdrawLastMessage = useCallback(async () => {
    if (!onWithdrawLastMessage || !canWithdrawLastMessage) {
      return;
    }
    const conversationId = activeId;
    const draft = await onWithdrawLastMessage();
    if (!draft) return;
    if (
      conversationId &&
      useConversationStore.getState().activeId !== conversationId
    ) {
      return;
    }

    const restored = await restoreAvailableAttachments(draft.attachments);
    const restoredAttachments = restored.attachments;
    if (
      conversationId &&
      useConversationStore.getState().activeId !== conversationId
    ) {
      for (const attachment of restoredAttachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      return;
    }
    setAttachmentRestoreWarning(
      restored.missingNames.length > 0
        ? restored.missingNames
            .map((name) =>
              t.chat.attachmentErrors.readFailed.replace("{name}", name),
            )
            .join(" ")
        : null,
    );
    setInput(draft.content);
    setAttachments(restoredAttachments);
    setForcedSkillIds([...draft.forcedSkillIds]);
    if (conversationId) {
      const currentConversation =
        useConversationStore.getState().conversations[conversationId];
      if (
        draft.designSelection &&
        currentConversation?.workspaceMode === "design"
      ) {
        useDesignSelectionStore
          .getState()
          .setSelection(conversationId, draft.designSelection);
      } else {
        useDesignSelectionStore.getState().clearSelection(conversationId);
      }
    }
    shouldAutoScrollRef.current = true;
  }, [
    activeId,
    canWithdrawLastMessage,
    onWithdrawLastMessage,
    t.chat.attachmentErrors.readFailed,
  ]);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (
      isQuestionnairePending ||
      (!input.trim() && attachments.length === 0) ||
      isGenerating
    )
      return;
    if (!hasConfiguredModelRuntime) {
      onOpenSettings();
      return;
    }
    const prompt = input.trim();
    const atts = [...attachments];
    const forced = [...forcedSkillIds];
    setInput("");
    setAttachments([]);
    setForcedSkillIds([]);
    setAttachmentRestoreWarning(null);
    shouldAutoScrollRef.current = true;

    flushSnapshotUpdate();

    if (rollbackInfo) {
      const endIdx = findAssistantGroupEnd(messages, rollbackInfo.messageId);
      useConversationStore.getState().setMessages(messages.slice(0, endIdx));
      setRollbackInfo(null);
    }

    const activeConversation = activeId
      ? useConversationStore.getState().conversations[activeId]
      : undefined;
    const designSelection =
      activeId && activeConversation?.workspaceMode === "design"
        ? useDesignSelectionStore.getState().selections[activeId]
        : undefined;
    // A design selection belongs to this one request. Clear it before the
    // asynchronous generation starts so a withdrawal can restore it after an
    // abort without a stale finally block erasing the restored selection.
    if (activeId && designSelection) {
      useDesignSelectionStore.getState().clearSelection(activeId);
    }
    await onGenerate(prompt, atts.length > 0 ? atts : undefined, {
      forcedSkillIds: forced.length > 0 ? forced : undefined,
      ...(designSelection ? { designSelection } : {}),
    });
  };

  const withdrawLabel = t.message.withdraw;
  const questionnaireCloseLabel = t.chat.askQuestion.close;

  const renderMergedMessage = (
    msg: (typeof mergedMessages)[number],
    index: number,
  ) => {
    const messageIndex = getMergedMessageStartIndex(msg.id);
    const previousIndex =
      index > 0
        ? getMergedMessageStartIndex(mergedMessages[index - 1].id)
        : null;
    const showDivider =
      compressFromIndex >= 0 &&
      messageIndex !== null &&
      messageIndex >= compressFromIndex &&
      (previousIndex === null || previousIndex < compressFromIndex);
    const isLast = msg.id === lastAssistantId;
    const canWithdraw =
      canWithdrawLastMessage && msg.id === lastVisibleMessage?.id;
    return (
      <div>
        <MessageBubble
          message={msg}
          isGenerating={isLast && isGenerating}
          isThinkingStreaming={isLast && isThinkingStreaming}
          isLastAssistant={isLast}
          snapshotExists={snapshotMessageIds.has(msg.id)}
          onShowDiff={handleShowDiff}
          onRollback={handleRollbackConfirm}
          onRetry={onRetry}
          onOpenSettings={onOpenSettings}
          onCompressContext={onCompressContext}
          onHealthCheck={onHealthCheck}
          canWithdraw={canWithdraw}
          onWithdraw={canWithdraw ? handleWithdrawLastMessage : undefined}
          withdrawLabel={withdrawLabel}
        />
        {showDivider && (
          <div className="flex items-center gap-3 my-4 text-xs text-muted-foreground">
            <div className="flex-1 border-t" />
            <span>{t.compress.divider}</span>
            <div className="flex-1 border-t" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="contents" inert={isQuestionnairePending}>
        <ChatHeader
          isGenerating={isGenerating}
          onOpenSettings={onOpenSettings}
          onToggleSessionList={() => setShowSessionList(true)}
          onOpenPermissionActivity={() => setShowPermissionActivity(true)}
          onOpenSnapshotHistory={() => setShowSnapshotHistory(true)}
          permissionActivityCount={permissionActivityCount}
          snapshotCount={snapshots.length}
        />

        {showSessionList && (
          <SessionListOverlay
            closeLabel={t.sessions.close}
            onClose={() => setShowSessionList(false)}
          />
        )}

        <div
          ref={messagesViewportRef}
          className="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4 pb-0"
          onScroll={updateAutoScrollIntent}
          style={{ scrollbarGutter: "stable" }}
        >
          {!hasConfiguredModelRuntime && (
            <SettingsWarning onOpenSettings={onOpenSettings} />
          )}

          {hasConfiguredModelRuntime && localCliStatusNotice ? (
            <LocalCliStatusNotice
              notice={localCliStatusNotice}
              onOpenSettings={onOpenSettings}
            />
          ) : null}

          {messages.length === 0 && hasConfiguredModelRuntime && (
            <EmptyState onSelectSuggestion={setInput} />
          )}

          {shouldVirtualizeMessages ? (
            <div
              ref={virtualListRef}
              className="relative w-full"
              style={{ height: messageVirtualizer.getTotalSize() }}
            >
              {messageVirtualizer.getVirtualItems().map((virtualRow) => (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={messageVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full pb-4"
                  style={{
                    transform: `translateY(${virtualRow.start - virtualScrollMargin}px)`,
                  }}
                >
                  {renderMergedMessage(
                    mergedMessages[virtualRow.index],
                    virtualRow.index,
                  )}
                </div>
              ))}
            </div>
          ) : (
            mergedMessages.map((message, index) => (
              <div key={message.id}>{renderMergedMessage(message, index)}</div>
            ))
          )}

          {showInlinePreview &&
            previewMode !== "code-only" &&
            isProjectInitialized &&
            !isGenerating && (
              <Suspense
                fallback={
                  <div className="flex min-h-40 items-center justify-center rounded-lg border bg-muted/30">
                    <p className="text-sm text-muted-foreground">
                      {t.app.loading}
                    </p>
                  </div>
                }
              >
                <MobilePreview
                  files={files}
                  template={template}
                  sandpackKey={sandpackKey}
                  onReloadPreview={onReloadPreview}
                />
              </Suspense>
            )}

          {isGenerating && !hasPendingInteraction && <GeneratingIndicator />}

          {rollbackInfo && !isGenerating && (
            <RollbackHint
              label={rollbackInfo.label}
              onDismiss={() => setRollbackInfo(null)}
            />
          )}

          {!isGenerating &&
            messages.length > 0 &&
            messages[messages.length - 1].role === "assistant" &&
            messages[messages.length - 1].isError &&
            (messages[messages.length - 1].errorKind === "context_length" ||
              (typeof messages[messages.length - 1].content === "string" &&
                (messages[messages.length - 1].content as string).includes(
                  "context_length_exceeded",
                ))) && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/10 border border-orange-500/20 text-xs text-orange-700 dark:text-orange-400">
                <span>{t.compress.hint}</span>
                <button
                  onClick={() => onCompressContext()}
                  className="ml-auto shrink-0 px-2 py-1 rounded bg-orange-500 text-white text-xs hover:bg-orange-600 transition-colors cursor-pointer"
                >
                  {t.compress.button}
                </button>
              </div>
            )}

          <div ref={messagesEndRef} />
        </div>

        <div className="relative shrink-0">
          <ChatInput
            input={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            onStop={onStop}
            isGenerating={isGenerating}
            isQuestionnairePending={isQuestionnairePending}
            attachmentRestoreWarning={attachmentRestoreWarning ?? undefined}
            messages={messages}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            onImportProject={onImportProject}
            hasExistingProject={isProjectInitialized}
            onSlashCommand={handleSlashCommand}
            forcedSkillIds={forcedSkillIds}
            onForcedSkillIdsChange={setForcedSkillIds}
            onApplyDesignSystem={onApplyDesignSystem}
            onCompileDesignSystem={onCompileDesignSystem}
          />
        </div>

        {diffMessageId && activeId && (
          <Suspense fallback={null}>
            <DiffModal
              conversationId={activeId}
              messageId={diffMessageId}
              onClose={() => setDiffMessageId(null)}
            />
          </Suspense>
        )}

        {showSnapshotHistory && activeId && (
          <Suspense fallback={null}>
            <SnapshotHistoryDialog
              conversationId={activeId}
              messages={messages}
              onClose={() => setShowSnapshotHistory(false)}
              onShowDiff={handleShowDiffFromHistory}
              onRollback={handleRollbackFromHistory}
            />
          </Suspense>
        )}

        {showPermissionActivity && activeId && (
          <Suspense fallback={null}>
            <PermissionActivityDialog
              open
              conversationId={activeId}
              onClose={() => setShowPermissionActivity(false)}
            />
          </Suspense>
        )}

        {rollbackConfirmId && (
          <RollbackConfirmDialog
            onCancel={() => setRollbackConfirmId(null)}
            onConfirm={() => handleRollback(rollbackConfirmId)}
          />
        )}

        {showResetProjectConfirm && (
          <ResetProjectConfirmDialog
            onCancel={() => setShowResetProjectConfirm(false)}
            onConfirm={handleResetProject}
          />
        )}
      </div>

      {pendingQuestionnaire?.kind === "question" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t.chat.askQuestion.title}
          className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-[1px]"
        >
          <div className="w-full max-w-2xl">
            <AskUserQuestionCard
              key={pendingQuestionnaire.toolCallId}
              toolCallId={pendingQuestionnaire.toolCallId}
              questions={pendingQuestionnaire.questions}
              presentation="questionnaire"
              onClose={onStop}
              closeLabel={questionnaireCloseLabel}
            />
          </div>
        </div>
      )}
    </div>
  );
}
