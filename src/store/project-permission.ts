import { create } from "zustand";

import {
  ProjectPermissionError,
  type ProjectPermissionAuthoritySnapshot,
  type ProjectPermissionDecision,
  type ProjectPermissionRequest,
  type ProjectPermissionSession,
} from "../lib/security/project-permission-broker";

export interface PendingProjectPermission {
  readonly request: ProjectPermissionRequest;
  readonly commonParent: string | null;
  readonly submitting: boolean;
  readonly error: string | null;
}

interface PendingProjectPermissionInternal extends PendingProjectPermission {
  readonly resolve: (decision: ProjectPermissionDecision) => void;
  readonly reject: (error: Error) => void;
  readonly detachAbort: () => void;
}

interface ProjectPermissionUiState {
  pending: PendingProjectPermissionInternal | null;
  authorities: Record<string, ProjectPermissionAuthoritySnapshot>;
  requestDecision: (
    request: ProjectPermissionRequest,
    signal: AbortSignal,
  ) => Promise<ProjectPermissionDecision>;
  submitDecision: (
    requestId: string,
    decision: ProjectPermissionDecision,
  ) => void;
  finishRequest: (callId: string, error?: string) => void;
  cancelPending: (reason: string) => void;
}

interface RegisteredPermissionSession {
  readonly session: ProjectPermissionSession;
  readonly rotateHostAuthority: () => void;
}

const registeredSessions = new Map<string, RegisteredPermissionSession>();

function commonParent(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const directorySegments = paths.map((path) => {
    const segments = path.split("/");
    segments.pop();
    return segments;
  });
  if (directorySegments.some((segments) => segments.length === 0)) return null;
  const shared: string[] = [];
  const max = Math.min(...directorySegments.map((segments) => segments.length));
  for (let index = 0; index < max; index += 1) {
    const segment = directorySegments[0][index];
    if (!directorySegments.every((segments) => segments[index] === segment)) {
      break;
    }
    shared.push(segment);
  }
  return shared.length > 0 ? shared.join("/") : null;
}

function abortError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(fallback, "AbortError");
}

export const useProjectPermissionStore = create<ProjectPermissionUiState>(
  (set, get) => ({
    pending: null,
    authorities: {},

    requestDecision: (request, signal) => {
      if (signal.aborted) {
        return Promise.reject(
          abortError(signal, "Permission request cancelled."),
        );
      }
      if (get().pending) {
        return Promise.reject(
          new ProjectPermissionError(
            "permission_busy",
            "Another project permission request is already visible.",
          ),
        );
      }
      return new Promise<ProjectPermissionDecision>((resolve, reject) => {
        const onAbort = () => {
          const current = get().pending;
          if (current?.request.requestId !== request.requestId) return;
          set({ pending: null });
          reject(abortError(signal, "Permission request cancelled."));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        set({
          pending: {
            request,
            commonParent: commonParent(request.affectedPaths),
            submitting: false,
            error: null,
            resolve,
            reject,
            detachAbort: () => signal.removeEventListener("abort", onAbort),
          },
        });
      });
    },

    submitDecision: (requestId, decision) => {
      const pending = get().pending;
      if (!pending || pending.request.requestId !== requestId) return;
      if (pending.submitting) return;
      if (pending.error) {
        pending.detachAbort();
        set({ pending: null });
        return;
      }
      pending.detachAbort();
      set({ pending: { ...pending, submitting: true, error: null } });
      pending.resolve(decision);
    },

    finishRequest: (callId, error) => {
      const pending = get().pending;
      if (!pending || pending.request.callId !== callId) return;
      pending.detachAbort();
      if (error) {
        set({ pending: { ...pending, submitting: false, error } });
        return;
      }
      set({ pending: null });
    },

    cancelPending: (reason) => {
      const pending = get().pending;
      if (!pending) return;
      pending.detachAbort();
      set({ pending: null });
      pending.reject(new DOMException(reason, "AbortError"));
    },
  }),
);

export function registerProjectPermissionSession(
  conversationId: string,
  session: ProjectPermissionSession,
  rotateHostAuthority: () => void,
): void {
  const previous = registeredSessions.get(conversationId);
  if (previous && previous.session !== session) {
    previous.session.change({ type: "close" });
  }
  registeredSessions.set(conversationId, { session, rotateHostAuthority });
  publishProjectPermissionAuthority(conversationId, session);
}

export function publishProjectPermissionAuthority(
  conversationId: string,
  session: ProjectPermissionSession,
): void {
  const authority = session.authority();
  const registered = registeredSessions.get(conversationId);
  // A closed generator may publish one final snapshot after its replacement
  // has already registered. Ignore that late callback so it cannot erase or
  // overwrite the active session's grants in the Permission Activity UI.
  if (registered && registered.session !== session) return;
  if (authority.closed && registered?.session === session) {
    registeredSessions.delete(conversationId);
  }
  useProjectPermissionStore.setState((state) => {
    if (authority.closed) {
      const next = { ...state.authorities };
      delete next[conversationId];
      return { authorities: next };
    }
    return {
      authorities: { ...state.authorities, [conversationId]: authority },
    };
  });
}

export function revokeProjectPermissionGrant(
  conversationId: string,
  grantId: string,
): boolean {
  const registered = registeredSessions.get(conversationId);
  if (!registered) return false;
  const before = registered.session.authority();
  registered.session.change({ type: "revoke_grant", grantId });
  const after = registered.session.authority();
  if (after.revision === before.revision) return false;
  registered.rotateHostAuthority();
  publishProjectPermissionAuthority(conversationId, registered.session);
  return true;
}

export const projectPermissionDecisionAdapter = Object.freeze({
  decide(request: ProjectPermissionRequest, signal: AbortSignal) {
    return useProjectPermissionStore
      .getState()
      .requestDecision(request, signal);
  },
});
