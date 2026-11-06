import { GitBranch } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { useConversationStore } from "../../store/conversation";
import { findAssistantGroupEnd } from "../../lib/utils/message-navigation";
import { useT } from "../../i18n";
import type { Conversation } from "../../types";

export function branchesAtMessage(
  conversation: Conversation,
  messageId: string,
) {
  const branches = Object.values(conversation.branches ?? {});
  const children = branches.filter(
    (branch) => branch.forkMessageId === messageId,
  );
  const ids = new Set(
    children.flatMap((branch) => [branch.id, branch.parentBranchId]),
  );
  return branches.filter((branch) => ids.has(branch.id));
}

export function BranchHistoryDialog({
  conversationId,
  messageId,
  onSwitch,
  onClose,
  error,
}: {
  conversationId: string;
  messageId: string;
  onSwitch: (branchId: string) => void;
  onClose: () => void;
  error?: string | null;
}) {
  const t = useT();
  const conversation = useConversationStore(
    (state) => state.conversations[conversationId],
  );
  if (!conversation) return null;
  const branches = branchesAtMessage(conversation, messageId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-4" />
            {t.branches.title}
          </DialogTitle>
          <DialogDescription>
            {t.branches.count.replace("{count}", String(branches.length))}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error && (
            <p role="alert" className="px-5 pt-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="divide-y">
            {branches.map((branch) => {
              const messages =
                branch.id === conversation.activeBranchId &&
                !conversation.checkout
                  ? conversation.messages
                  : branch.state.messages;
              const start = findAssistantGroupEnd(messages, messageId);
              const firstRequest = messages
                .slice(start)
                .find(
                  (message) =>
                    message.role === "user" && !message.metadata?.origin,
                );
              const summary =
                typeof firstRequest?.content === "string"
                  ? firstRequest.content
                  : t.branches.summary;
              const current =
                branch.id === conversation.activeBranchId &&
                !conversation.checkout;
              return (
                <div
                  key={branch.id}
                  className="flex items-start gap-3 px-5 py-4"
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">
                        {t.branches.name.replace("{n}", branch.name)}
                      </p>
                      {current && (
                        <Badge variant="secondary">{t.branches.current}</Badge>
                      )}
                    </div>
                    <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {summary}
                    </p>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <p>
                        {t.branches.created}:{" "}
                        {new Date(branch.createdAt).toLocaleString()}
                      </p>
                      <p>
                        {t.branches.updated}:{" "}
                        {new Date(branch.updatedAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={current}
                    onClick={() => onSwitch(branch.id)}
                  >
                    {t.branches.switch}
                  </Button>
                </div>
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
