export interface ConfirmationOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface ConfirmationPrompt extends ConfirmationOptions {
  id: number;
}

interface PendingConfirmation extends ConfirmationPrompt {
  resolve: (confirmed: boolean) => void;
}

const listeners = new Set<() => void>();
const queue: PendingConfirmation[] = [];
let nextId = 0;
let hostCount = 0;

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeToConfirmations(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCurrentConfirmation(): ConfirmationPrompt | null {
  return queue[0] ?? null;
}

export function registerConfirmationHost() {
  hostCount += 1;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    hostCount = Math.max(0, hostCount - 1);
    if (hostCount === 0) cancelAllConfirmations();
  };
}

export function requestConfirmation(
  options: ConfirmationOptions,
): Promise<boolean> {
  // A confirmation without a mounted host must never silently authorize an
  // operation. This also keeps server-side or early-startup calls fail-closed.
  if (typeof window === "undefined" || hostCount === 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    queue.push({ ...options, id: ++nextId, resolve });
    emit();
  });
}

export function settleConfirmation(id: number, confirmed: boolean): boolean {
  const current = queue[0];
  if (!current || current.id !== id) return false;
  queue.shift();
  current.resolve(confirmed);
  emit();
  return true;
}

export function cancelAllConfirmations() {
  if (queue.length === 0) return;
  while (queue.length > 0) queue.shift()?.resolve(false);
  emit();
}
