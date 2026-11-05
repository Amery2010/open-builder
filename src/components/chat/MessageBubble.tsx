import { useState, useEffect, memo } from "react";
import type { ComponentType, ReactNode } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  ChevronDown,
  ChevronRight,
  Lightbulb,
  GitCompareArrows,
  Undo2,
  RefreshCw,
  FileText,
  Check,
  Copy,
  Settings,
  Archive,
  Activity,
} from "lucide-react";
import { ToolCallCard } from "./ToolCallCard";
import { AgnesMediaResult, agnesToolNameForBlock } from "./AgnesMediaResult";
import { PlanApprovalCard } from "./PlanApprovalCard";
import {
  AskUserAnswerSummary,
  AskUserQuestionCard,
} from "./AskUserQuestionCard";
import { SubagentCallCard } from "./SubagentCallCard";
import { DesignReviewActivityBlock } from "./DesignReviewActivityBlock";
import { useT } from "../../i18n";
import { useInteractiveStore } from "../../store/interactive";
import type {
  MergedMessage,
  TextBlock,
  ImageBlock,
  FileBlock,
} from "../../types";
import { getAttachmentBlob } from "../../lib/attachments/store";
import { LazyMarkdownContent } from "./LazyMarkdownContent";
import { readAskUserAnswerSummary } from "../../lib/utils/tool-result";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : "";
}

interface MessageBubbleProps {
  message: MergedMessage;
  isGenerating?: boolean;
  isThinkingStreaming?: boolean;
  isLastAssistant?: boolean;
  snapshotExists?: boolean;
  onShowDiff?: (messageId: string) => void;
  onRollback?: (messageId: string) => void;
  onRetry?: () => void;
  onOpenSettings?: () => void;
  onCompressContext?: () => void;
  onHealthCheck?: () => void;
  /** Render the one-shot withdrawal affordance for the final genuine user
   *  message. The owner performs the atomic removal and draft restoration. */
  canWithdraw?: boolean;
  onWithdraw?: () => void;
  withdrawLabel?: string;
  statusLabel?: string;
}

function StoredAttachmentImage({ block }: { block: ImageBlock }) {
  const [url, setUrl] = useState(block.url ?? "");
  useEffect(() => {
    if (!block.attachmentId) return;
    let active = true;
    let objectUrl = "";
    void getAttachmentBlob(block.attachmentId).then((blob) => {
      if (!active || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [block.attachmentId]);
  if (!url) return null;
  return (
    <img
      src={url}
      alt={block.name ?? ""}
      className="max-w-48 max-h-48 rounded-lg object-cover"
    />
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isGenerating = false,
  isThinkingStreaming = false,
  isLastAssistant = false,
  snapshotExists = false,
  onShowDiff,
  onRollback,
  onRetry,
  onOpenSettings,
  onCompressContext,
  onHealthCheck,
  canWithdraw = false,
  onWithdraw,
  withdrawLabel = "Withdraw",
  statusLabel,
}: MessageBubbleProps) {
  const t = useT();
  const pendingInteractions = useInteractiveStore((state) => state.pending);
  if (message.reviewJobId) {
    return (
      <DesignReviewActivityBlock
        reviewJobId={message.reviewJobId}
        summary={message.reviewSummary}
      />
    );
  }
  if (message.role === "user") {
    const textBlocks = message.blocks.filter(
      (b): b is TextBlock => b.type === "text",
    );
    const imageBlocks = message.blocks.filter(
      (b): b is ImageBlock => b.type === "image",
    );
    const fileBlocks = message.blocks.filter(
      (b): b is FileBlock => b.type === "file",
    );

    if (message.origin === "auto_qa" || message.origin === "design_auto_fix") {
      return (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        >
          <Activity size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium text-foreground">
              {message.origin === "design_auto_fix"
                ? t.chat.autoDesignFixActivity
                : t.chat.autoQaActivity}
            </p>
            {textBlocks.length > 0 && (
              <p className="mt-0.5 line-clamp-2">
                {textBlocks.map((block) => block.content).join(" ")}
              </p>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-end gap-1">
        <div className="bg-secondary px-4 py-2.5 rounded-2xl rounded-tr-sm max-w-[80%]">
          {imageBlocks.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-2">
              {imageBlocks.map((img) => (
                <StoredAttachmentImage key={img.id} block={img} />
              ))}
            </div>
          )}
          {fileBlocks.length > 0 && (
            <div className="flex flex-col gap-1.5 mb-2">
              {fileBlocks.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border/60 bg-neutral-200 dark:bg-neutral-700 max-w-64"
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 shrink-0">
                    <FileText size={15} className="text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-xs font-medium line-clamp-2"
                      title={f.name}
                    >
                      {f.name}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {getFileExt(f.name)}
                      {getFileExt(f.name) && " · "}
                      {f.size > 0 ? formatFileSize(f.size) : ""}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {textBlocks.length > 0 && (
            <LazyMarkdownContent
              content={textBlocks.map((b) => b.content).join("\n\n")}
              variant="user"
            />
          )}
        </div>
        {statusLabel && (
          <p role="status" className="px-1 text-xs text-muted-foreground">
            {statusLabel}
          </p>
        )}
        {canWithdraw && !message.origin && onWithdraw && (
          <button
            type="button"
            onClick={onWithdraw}
            aria-label={withdrawLabel}
            className="flex items-center gap-1 px-1 text-xs text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
          >
            <Undo2 className="size-3.5" aria-hidden="true" />
            <span>{withdrawLabel}</span>
          </button>
        )}
      </div>
    );
  }

  // Prefer the structured isError flag carried on the merged message.
  // Fall back to scanning the leading "⚠️" prefix for backward compatibility
  // with messages persisted before the flag existed.
  const isError =
    message.isError ??
    message.blocks.some((b) => b.type === "text" && b.content.startsWith("⚠️"));

  const assistantText = message.blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.content)
    .join("\n\n")
    .trim();
  const lastThinkingBlockId = message.blocks.reduce<string | null>(
    (lastId, block) => (block.type === "thinking" ? block.id : lastId),
    null,
  );

  return (
    <div className="flex-1 min-w-0 space-y-2">
      {message.blocks.map((block) => {
        if (block.type === "thinking") {
          return (
            <ThinkingBlockCard
              key={block.id}
              content={block.content}
              isStreaming={
                isThinkingStreaming &&
                isLastAssistant &&
                block.id === lastThinkingBlockId
              }
            />
          );
        }
        if (block.type === "text") {
          return (
            <div key={block.id} className="text-sm text-foreground">
              <LazyMarkdownContent
                content={block.content}
                variant="assistant"
              />
            </div>
          );
        }
        if (block.type === "tool") {
          if (agnesToolNameForBlock(block)) {
            return <AgnesMediaResult key={block.id} block={block} />;
          }
          const pending = pendingInteractions.find(
            (item) =>
              item.toolCallId === block.toolCallId && item.kind === "question",
          );
          if (pending?.kind === "question") {
            if (pending.presentation === "questionnaire") return null;
            return (
              <AskUserQuestionCard
                key={block.id}
                toolCallId={block.toolCallId}
                questions={pending.questions}
                presentation="approval"
              />
            );
          }
          if (block.toolName === "exit_plan_mode") {
            return (
              <PlanApprovalCard
                key={block.id}
                toolCallId={block.toolCallId}
                plan={
                  typeof block.rawArgs?.plan === "string"
                    ? (block.rawArgs.plan as string)
                    : ""
                }
                result={block.result}
              />
            );
          }
          if (block.toolName === "ask_user_question") {
            const rawQuestions = Array.isArray(block.rawArgs?.questions)
              ? block.rawArgs.questions
              : [];
            const headers = rawQuestions.map((question) =>
              question &&
              typeof question === "object" &&
              typeof (question as { header?: unknown }).header === "string"
                ? ((question as { header: string }).header ?? "")
                : "",
            );
            const answers = readAskUserAnswerSummary(
              block.toolOutput?.structuredContent,
              block.result,
              headers,
            );
            return <AskUserAnswerSummary key={block.id} answers={answers} />;
          }
          if (block.toolName === "dispatch_subagent") {
            return <SubagentCallCard key={block.id} {...block} />;
          }
          return <ToolCallCard key={block.id} {...block} />;
        }
        return null;
      })}
      {(snapshotExists || isError || assistantText) &&
        !(isGenerating && isLastAssistant) && (
          <div className="flex items-center gap-3 mt-2 pt-2 border-t border-border/30">
            {snapshotExists && (
              <>
                <button
                  onClick={() => onShowDiff?.(message.id)}
                  aria-label={t.diff.showDiff}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <GitCompareArrows className="w-3.5 h-3.5" />
                  <span>{t.diff.showDiff}</span>
                </button>
                <button
                  onClick={() => onRollback?.(message.id)}
                  aria-label={t.message.rollback}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  <span>{t.message.rollback}</span>
                </button>
              </>
            )}
            {assistantText && !isError && (
              <CopyMessageButton text={assistantText} />
            )}
            {isError && (
              <ErrorActions
                message={message}
                onRetry={onRetry}
                onOpenSettings={onOpenSettings}
                onCompressContext={onCompressContext}
                onHealthCheck={onHealthCheck}
              />
            )}
          </div>
        )}
    </div>
  );
});

function ErrorActions({
  message,
  onRetry,
  onOpenSettings,
  onCompressContext,
  onHealthCheck,
}: {
  message: MergedMessage;
  onRetry?: () => void;
  onOpenSettings?: () => void;
  onCompressContext?: () => void;
  onHealthCheck?: () => void;
}) {
  const t = useT();
  const kind = message.errorKind;
  const retryable = message.errorRetryable !== false;
  let action: ReactNode = null;

  if (kind === "auth" && onOpenSettings) {
    action = (
      <MessageActionButton
        icon={Settings}
        label={t.warning.openSettings}
        onClick={onOpenSettings}
      />
    );
  } else if (kind === "context_length" && onCompressContext) {
    action = (
      <MessageActionButton
        icon={Archive}
        label={t.compress.button}
        onClick={onCompressContext}
      />
    );
  } else if (kind === "runtime_check" && onHealthCheck) {
    action = (
      <MessageActionButton
        icon={Activity}
        label={t.message.runHealthCheck}
        onClick={onHealthCheck}
      />
    );
  } else if (retryable && onRetry) {
    action = (
      <MessageActionButton
        icon={RefreshCw}
        label={t.message.retry}
        onClick={onRetry}
      />
    );
  }

  if (!message.localCliFailure && !action) return null;
  return (
    <>
      {message.localCliFailure && (
        <CopyDiagnosticIdButton
          diagnosticId={message.localCliFailure.diagnosticId}
        />
      )}
      {action}
    </>
  );
}

function MessageActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
    </button>
  );
}

function CopyMessageButton({ text }: { text: string }) {
  const t = useT();
  const [copied, copy] = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={() => copy(text)}
      aria-label={copied ? t.message.copied : t.message.copy}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
      <span>{copied ? t.message.copied : t.message.copy}</span>
    </button>
  );
}

function CopyDiagnosticIdButton({ diagnosticId }: { diagnosticId: string }) {
  const t = useT();
  const [copied, copy] = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={() => copy(diagnosticId)}
      aria-label={t.message.generationError.localCli.copyDiagnosticId}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
      <span>
        {copied
          ? t.message.copied
          : t.message.generationError.localCli.copyDiagnosticId}
      </span>
    </button>
  );
}

function ThinkingBlockCard({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(isStreaming);

  // A new thinking phase opens the panel. Manual collapse is preserved until
  // that phase ends, and the next false -> true transition opens it again.
  useEffect(() => {
    setExpanded(isStreaming);
  }, [isStreaming]);

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden bg-muted/30">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={t.message.thinking}
        className="flex items-center gap-2 w-full px-3 py-2 text-muted-foreground hover:bg-muted/50 transition-colors"
      >
        <Lightbulb className="w-3.5 h-3.5 text-purple-500" />
        <span className="font-medium text-xs text-foreground">
          {t.message.thinking}
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 ml-auto" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 ml-auto" />
        )}
      </button>
      {expanded && (
        <div className="thought px-3 py-2 text-xs text-muted-foreground max-h-60 overflow-y-auto">
          <LazyMarkdownContent content={content} variant="assistant" />
        </div>
      )}
    </div>
  );
}
