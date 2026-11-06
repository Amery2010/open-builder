import { useMemo } from "react";
import { mergeMessages } from "../lib/utils/merge-messages";
import { getMergedMessageStartIndex } from "../lib/utils/message-navigation";
import type { Message, MergedMessage, PendingUserInstruction } from "../types";
import { useT } from "../i18n";

const EMPTY_INSTRUCTIONS: readonly PendingUserInstruction[] = [];

export function useMergedMessages(
  messages: Message[],
  pendingInstructions: readonly PendingUserInstruction[] = EMPTY_INSTRUCTIONS,
): MergedMessage[] {
  const t = useT();
  return useMemo(() => {
    const merged = mergeMessages(messages, t);
    const insertions = new Map<number, MergedMessage[]>();
    for (const instruction of pendingInstructions) {
      const boundary = Math.max(
        0,
        Math.min(
          instruction.afterMessageIndex ?? messages.length,
          messages.length,
        ),
      );
      let position = 0;
      merged.forEach((message, index) => {
        const start = getMergedMessageStartIndex(message.id, messages);
        if (start !== null && start < boundary) position = index + 1;
      });
      const projected = mergeMessages(
        [
          {
            role: "user",
            content:
              instruction.content ||
              (instruction.forcedSkillIds.length
                ? t.chat.instructions.applySkills
                : ""),
            forcedSkillIds: instruction.forcedSkillIds,
            metadata: {
              instructionId: instruction.id,
              attachments: instruction.attachments,
            },
          },
        ],
        t,
      ).map((message) => ({ ...message, id: `pending-${instruction.id}` }));
      insertions.set(position, [
        ...(insertions.get(position) ?? []),
        ...projected,
      ]);
    }
    return [
      ...(insertions.get(0) ?? []),
      ...merged.flatMap((message, index) => [
        message,
        ...(insertions.get(index + 1) ?? []),
      ]),
    ];
  }, [messages, pendingInstructions, t]);
}
