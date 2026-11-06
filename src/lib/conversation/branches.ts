import type {
  Conversation,
  ConversationBranchState,
  Message,
  ProjectSnapshot,
} from "../../types";

export interface ConversationIdentity {
  conversationId: string;
  branchId: string;
  checkoutEpoch: number;
}

export const defaultBranchId = (id: string) => `${id}:main`;

export function captureConversationIdentity(
  conversation: Conversation,
): ConversationIdentity {
  return {
    conversationId: conversation.id,
    branchId: conversation.activeBranchId ?? defaultBranchId(conversation.id),
    checkoutEpoch: conversation.checkoutEpoch ?? 0,
  };
}

export function isConversationIdentityCurrent(
  identity: ConversationIdentity,
  conversation?: Conversation,
): boolean {
  return (
    !!conversation &&
    identity.conversationId === conversation.id &&
    identity.branchId ===
      (conversation.activeBranchId ?? defaultBranchId(conversation.id)) &&
    identity.checkoutEpoch === (conversation.checkoutEpoch ?? 0)
  );
}

export function branchState(
  conversation: Conversation,
): ConversationBranchState {
  return {
    messages: conversation.messages,
    files: conversation.files,
    assets: conversation.assets,
    template: conversation.template,
    previewMode: conversation.previewMode,
    isProjectInitialized: conversation.isProjectInitialized,
    designState: conversation.designState,
    activeFile: conversation.activeFile,
    compressedContext: conversation.compressedContext,
  };
}

/** Preserve identity when a streaming generator replaces its unfinished tail. */
export function identifyMessages(
  messages: Message[],
  previous: readonly Message[] = [],
  legacyOwner?: string,
): Message[] {
  let changed = false;
  const next = messages.map((message, index) => {
    if (message.id) return message;
    const old = previous[index];
    const sameSlot =
      old?.role === message.role &&
      old.tool_call_id === message.tool_call_id &&
      old.metadata?.instructionId === message.metadata?.instructionId;
    changed = true;
    return {
      ...message,
      id:
        (sameSlot ? old?.id : undefined) ??
        (legacyOwner ? `${legacyOwner}:legacy:${index}` : crypto.randomUUID()),
    };
  });
  return changed ? next : messages;
}

export function normalizeConversationBranches(
  conversation: Conversation,
): Conversation {
  if (
    conversation.activeBranchId &&
    conversation.branches?.[conversation.activeBranchId]
  )
    return conversation;
  const messages = identifyMessages(conversation.messages, [], conversation.id);
  const activeBranchId = defaultBranchId(conversation.id);
  const next = {
    ...conversation,
    messages,
    activeBranchId,
    checkoutEpoch: conversation.checkoutEpoch ?? 0,
    checkout: undefined,
  };
  return {
    ...next,
    branches: {
      [activeBranchId]: {
        id: activeBranchId,
        name: "1",
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        state: branchState(next),
      },
    },
  };
}

export function writableConversation(conversation: Conversation): Conversation {
  const current = normalizeConversationBranches(conversation);
  if (!current.checkout) return current;
  const branchId = crypto.randomUUID();
  const now = Date.now();
  const next = {
    ...current,
    activeBranchId: branchId,
    checkout: undefined,
    checkoutEpoch: (current.checkoutEpoch ?? 0) + 1,
    compressedContext: undefined,
    localAgentSessions: undefined,
    pendingUserInstructions: [],
  };
  return {
    ...next,
    branches: {
      ...current.branches,
      [branchId]: {
        id: branchId,
        name: String(Object.keys(current.branches ?? {}).length + 1),
        parentBranchId: current.checkout.branchId,
        forkMessageId: current.checkout.messageId,
        forkSnapshotId: current.checkout.snapshotId,
        headSnapshotId: current.checkout.snapshotId,
        createdAt: now,
        updatedAt: now,
        state: branchState(next),
      },
    },
  };
}

function sameRecord(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  if (left === right) return true;
  const a = left ?? {};
  const b = right ?? {};
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  );
}

/** The only publication boundary for the active projection and its branch. */
export function reconcileConversation(
  next: Conversation,
  previous?: Conversation,
): Conversation {
  let current = normalizeConversationBranches(next);
  const explicitCheckout =
    previous &&
    ((current.checkoutEpoch ?? 0) !== (previous.checkoutEpoch ?? 0) ||
      current.activeBranchId !== previous.activeBranchId);
  if (
    !explicitCheckout &&
    previous?.checkout &&
    (next.messages.length !== previous.messages.length ||
      next.messages.some(
        (message, index) => message !== previous.messages[index],
      ) ||
      !sameRecord(next.files, previous.files) ||
      !sameRecord(next.assets, previous.assets) ||
      next.template !== previous.template ||
      next.designState !== previous.designState)
  ) {
    const fork = writableConversation(previous);
    current = {
      ...current,
      branches: fork.branches,
      activeBranchId: fork.activeBranchId,
      checkout: undefined,
      checkoutEpoch: fork.checkoutEpoch,
      compressedContext: undefined,
      localAgentSessions: undefined,
      pendingUserInstructions: [],
    };
  }
  current = {
    ...current,
    messages: identifyMessages(
      current.messages,
      explicitCheckout ? [] : previous?.messages,
    ),
  };
  if (current.checkout) return current;
  const id = current.activeBranchId!;
  return {
    ...current,
    branches: {
      ...current.branches,
      [id]: {
        ...current.branches![id],
        updatedAt: current.updatedAt,
        state: branchState(current),
      },
    },
  };
}

export function canonicalSnapshotMessageId(
  snapshot: ProjectSnapshot,
  conversation?: Conversation,
): string {
  if (!conversation) return snapshot.messageId;
  const branch =
    conversation.branches?.[
      snapshot.branchId ?? defaultBranchId(conversation.id)
    ];
  const messages = branch?.state.messages ?? conversation.messages;
  if (
    messages.some(
      (message) =>
        message.id && `${message.role}-${message.id}` === snapshot.messageId,
    )
  )
    return snapshot.messageId;
  // A memory-only first assistant message can disappear when the run finishes.
  // The retained tail identifies the same group without using a shifted offset.
  if (snapshot.endMessageId && /^(assistant|user)-/.test(snapshot.messageId)) {
    let index = messages.findIndex(
      (message) => message.id === snapshot.endMessageId,
    );
    if (
      index >= 0 &&
      (messages[index].role === "assistant" || messages[index].role === "tool")
    ) {
      while (
        index > 0 &&
        (messages[index - 1].role === "assistant" ||
          messages[index - 1].role === "tool")
      )
        index--;
      const first = messages[index];
      if (first.role === "assistant" && first.id)
        return `assistant-${first.id}`;
    }
  }
  if (snapshot.messageLinkVersion === 1) return snapshot.messageId;
  const match = /^(assistant|user)-(\d+)$/.exec(snapshot.messageId);
  if (!match) return snapshot.messageId;
  const message = messages[Number(match[2])];
  return message?.role === match[1] && message.id
    ? `${message.role}-${message.id}`
    : `unlinked-${snapshot.id}`;
}

/** All branch roots participate in attachment and asset reachability. */
export function conversationBranchStates(
  conversation: Conversation,
): ConversationBranchState[] {
  return [
    branchState(conversation),
    ...Object.values(conversation.branches ?? {}).map((branch) => branch.state),
  ];
}
