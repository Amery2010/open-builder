export const AGNES_POLLING_SESSION_ID =
  globalThis.crypto?.randomUUID?.() ??
  `agnes-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
