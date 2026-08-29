export interface PendingSandpackFileChange {
  conversationId: string;
  path: string;
  content: string;
  commit: (conversationId: string, path: string, content: string) => void;
}

export interface SandpackFileChangeScheduler {
  schedule: (change: PendingSandpackFileChange) => void;
  flush: (conversationId?: string) => void;
  discard: (conversationId?: string) => void;
  dispose: () => void;
}

const activeSchedulers = new Set<SandpackFileChangeScheduler>();

/**
 * Debounces writes for one Sandpack listener while preserving the important
 * transition boundary: an edit is flushed before the listener starts tracking
 * another file or conversation.
 */
export function createSandpackFileChangeScheduler(
  delayMs = 500,
): SandpackFileChangeScheduler {
  let pending: PendingSandpackFileChange | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = (conversationId?: string) => {
    if (
      conversationId !== undefined &&
      pending?.conversationId !== conversationId
    ) {
      return;
    }
    clearTimer();
    const change = pending;
    pending = null;
    activeSchedulers.delete(scheduler);
    if (change) {
      change.commit(change.conversationId, change.path, change.content);
    }
  };

  const discard = (conversationId?: string) => {
    if (
      pending &&
      (conversationId === undefined ||
        pending.conversationId === conversationId)
    ) {
      clearTimer();
      pending = null;
      activeSchedulers.delete(scheduler);
    }
  };

  const scheduler: SandpackFileChangeScheduler = {
    schedule(change) {
      if (
        pending &&
        (pending.conversationId !== change.conversationId ||
          pending.path !== change.path)
      ) {
        flush();
      }
      clearTimer();
      pending = change;
      activeSchedulers.add(scheduler);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    discard,
    dispose() {
      flush();
      activeSchedulers.delete(scheduler);
    },
  };

  return scheduler;
}

/** Prevent a confirmed project reset from being undone by an unmount flush. */
export function discardPendingSandpackFileChanges(
  conversationId: string,
): void {
  for (const scheduler of activeSchedulers) {
    scheduler.discard(conversationId);
  }
}

/** Preserve pending editor content before intentionally remounting Sandpack. */
export function flushPendingSandpackFileChanges(conversationId: string): void {
  for (const scheduler of [...activeSchedulers]) {
    scheduler.flush(conversationId);
  }
}
