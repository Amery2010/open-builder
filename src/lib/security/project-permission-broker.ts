export type ProjectPermissionOperation = "delete" | "move" | "replace_project";

export type ProjectPermissionScope =
  | Readonly<{ kind: "exact"; paths: readonly string[] }>
  | Readonly<{ kind: "subtree"; path: string }>
  | Readonly<{ kind: "project" }>;

export type ProjectPermissionDecision =
  | Readonly<{ kind: "deny" }>
  | Readonly<{ kind: "allow_once" }>
  | Readonly<{ kind: "allow_session"; scope: ProjectPermissionScope }>;

export type ProjectPermissionRuntime = "api" | "local_cli";

export type ProjectPermissionErrorCode =
  | "permission_denied"
  | "permission_cancelled"
  | "permission_stale"
  | "permission_busy"
  | "permission_audit_unavailable"
  | "permission_authority_stale"
  | "permission_prompt_unavailable";

export class ProjectPermissionError extends Error {
  constructor(
    readonly code: ProjectPermissionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name =
      code === "permission_cancelled" ? "AbortError" : "ProjectPermissionError";
  }
}

export interface ProjectPermissionRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly callId: string;
  readonly tool: string;
  readonly runtime: ProjectPermissionRuntime;
  readonly operation: ProjectPermissionOperation;
  readonly sessionEligible: boolean;
  readonly scope: ProjectPermissionScope;
  readonly affectedPaths: readonly string[];
  readonly affectedCount: number;
  readonly projectRevision: number;
  readonly authorityId: string;
  readonly requirementDigest: string;
}

export interface ProjectPermissionDecisionAdapter {
  decide(
    request: ProjectPermissionRequest,
    signal: AbortSignal,
  ): ProjectPermissionDecision | Promise<ProjectPermissionDecision>;
}

export type ProjectPermissionAuditOutcome =
  "succeeded" | "failed" | "aborted" | "stale";

export type ProjectPermissionAuditEvent =
  | Readonly<{
      type: "requested";
      at: number;
      request: ProjectPermissionRequest;
      authorityRevision: number;
    }>
  | Readonly<{
      type: "approved";
      at: number;
      request: ProjectPermissionRequest;
      decision: "allow_once" | "allow_session";
      grantId: string;
      grantedScope: ProjectPermissionScope;
      authorityBefore: string;
      authorityAfter: string;
      authorityRevisionBefore: number;
      authorityRevisionAfter: number;
    }>
  | Readonly<{
      type: "denied";
      at: number;
      request: ProjectPermissionRequest;
      reason: "user" | "cached" | "policy";
      authorityId: string;
      authorityRevision: number;
    }>
  | Readonly<{
      type: "cancelled";
      at: number;
      request: ProjectPermissionRequest;
      reason: "aborted" | "stale" | "closed" | "busy" | "prompt_unavailable";
      authorityId: string;
      authorityRevision: number;
    }>
  | Readonly<{
      type: "bypassed";
      at: number;
      request: ProjectPermissionRequest;
      reason: "broker_disabled" | "session_grant";
      grantIds: readonly string[];
      authorityId: string;
      authorityRevision: number;
    }>
  | Readonly<{
      type: "execution_started";
      at: number;
      request: ProjectPermissionRequest;
      permitId: string;
      grantIds: readonly string[];
      lifetime: "once" | "session";
      authorityId: string;
      authorityRevision: number;
    }>
  | Readonly<{
      type: "settled";
      at: number;
      request: ProjectPermissionRequest;
      permitId: string;
      outcome: ProjectPermissionAuditOutcome;
      errorCode?: string;
      authorityId: string;
      authorityRevision: number;
    }>
  | Readonly<{
      type: "authority_changed";
      at: number;
      sessionId: string;
      conversationId: string;
      reason:
        | "project_revision"
        | "grant_revoked"
        | "session_revoked"
        | "session_closed"
        | "bypass_changed";
      authorityBefore: string;
      authorityAfter: string;
      authorityRevisionBefore: number;
      authorityRevisionAfter: number;
    }>;

export interface ProjectPermissionAuditAdapter {
  record(event: ProjectPermissionAuditEvent): void | Promise<void>;
}

export type ProjectPermissionSessionOperation = Exclude<
  ProjectPermissionOperation,
  "replace_project"
>;

export interface ProjectPermissionGrant {
  readonly id: string;
  readonly operation: ProjectPermissionSessionOperation;
  readonly scope: ProjectPermissionScope;
}

export type PermissionGrant = ProjectPermissionGrant;

export interface ProjectPermissionAuthoritySnapshot {
  readonly id: string;
  readonly digest: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly policyVersion: string;
  readonly projectRevision: number;
  readonly bypassEnabled: boolean;
  readonly closed: boolean;
  readonly grants: readonly ProjectPermissionGrant[];
}

export type PermissionAuthoritySnapshot = ProjectPermissionAuthoritySnapshot;

const projectPermissionPermit = Symbol("project-permission-permit");

export interface ProjectPermissionPermit {
  readonly [projectPermissionPermit]: true;
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly requirementDigest: string;
  readonly projectRevision: number;
  readonly authorityId: string;
  readonly grantIds: readonly string[];
  readonly lifetime: "once" | "session" | "bypass";
}

export interface ProjectPermissionAuthorizeInput {
  readonly runId: string;
  readonly callId: string;
  readonly tool: string;
  readonly runtime: ProjectPermissionRuntime;
  readonly operation: ProjectPermissionOperation;
  readonly sessionEligible: boolean;
  readonly scope: ProjectPermissionScope;
  readonly affectedPaths: readonly string[];
  readonly affectedCount: number;
  readonly projectRevision: number;
  readonly authorityId: string;
  readonly signal: AbortSignal;
}

export interface ProjectPermissionSettleInput {
  readonly outcome: ProjectPermissionAuditOutcome;
  readonly errorCode?: string;
}

export type ProjectPermissionSessionChange =
  | Readonly<{ type: "project_revision"; revision: number }>
  | Readonly<{ type: "revoke_grant"; grantId: string }>
  | Readonly<{ type: "revoke_session" }>
  | Readonly<{ type: "set_bypass"; enabled: boolean }>
  | Readonly<{ type: "close" }>;

export interface ProjectPermissionSession {
  authorize(
    input: ProjectPermissionAuthorizeInput,
  ): Promise<ProjectPermissionPermit>;
  settle(
    permit: ProjectPermissionPermit,
    result: ProjectPermissionSettleInput,
  ): Promise<void>;
  change(change: ProjectPermissionSessionChange): void;
  authority(): ProjectPermissionAuthoritySnapshot;
}

export interface ProjectPermissionBroker {
  openSession(
    input: ProjectPermissionOpenSessionInput,
  ): ProjectPermissionSession;
}

export interface ProjectPermissionOpenSessionInput {
  readonly conversationId: string;
  readonly policyVersion: string;
  readonly projectRevision: number;
  readonly bypassEnabled: boolean;
}

export interface ProjectPermissionBrokerDependencies {
  readonly decision: ProjectPermissionDecisionAdapter;
  readonly audit: ProjectPermissionAuditAdapter;
  readonly createId?: () => string;
  readonly now?: () => number;
}

interface PendingRequest {
  request: ProjectPermissionRequest;
  controller: AbortController;
}

interface IssuedPermit {
  permit: ProjectPermissionPermit;
  request: ProjectPermissionRequest;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function invalidInput(message: string): TypeError {
  return new TypeError(message);
}

function normalizePath(path: unknown): string {
  if (typeof path !== "string" || CONTROL_CHARACTERS.test(path)) {
    throw invalidInput("Permission scope path is invalid.");
  }
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/") || /^[a-zA-Z]:\//.test(trimmed)) {
    throw invalidInput("Permission scope must be project-relative.");
  }
  const segments = trimmed.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw invalidInput("Permission scope contains an unsafe path segment.");
  }
  return segments.join("/");
}

function canonicalScope(scope: ProjectPermissionScope): ProjectPermissionScope {
  if (!scope || typeof scope !== "object") {
    throw invalidInput("Permission scope is invalid.");
  }
  if (scope.kind === "project") return Object.freeze({ kind: "project" });
  if (scope.kind === "subtree") {
    return Object.freeze({ kind: "subtree", path: normalizePath(scope.path) });
  }
  if (scope.kind === "exact") {
    if (!Array.isArray(scope.paths) || scope.paths.length === 0) {
      throw invalidInput(
        "An exact permission scope requires at least one path.",
      );
    }
    const paths = [...new Set(scope.paths.map(normalizePath))].sort(
      (left, right) => left.localeCompare(right),
    );
    return Object.freeze({ kind: "exact", paths: Object.freeze(paths) });
  }
  throw invalidInput("Permission scope kind is invalid.");
}

function pathWithin(path: string, subtree: string): boolean {
  return path === subtree || path.startsWith(`${subtree}/`);
}

export function projectPermissionScopeCovers(
  granted: ProjectPermissionScope,
  requested: ProjectPermissionScope,
): boolean {
  const grant = canonicalScope(granted);
  const request = canonicalScope(requested);
  if (grant.kind === "project") return true;
  if (request.kind === "project") return false;
  if (grant.kind === "exact") {
    if (request.kind !== "exact") return false;
    const allowed = new Set(grant.paths);
    return request.paths.every((path) => allowed.has(path));
  }
  if (request.kind === "subtree") return pathWithin(request.path, grant.path);
  return request.paths.every((path) => pathWithin(path, grant.path));
}

function stableDigest(value: unknown): string {
  const text = JSON.stringify(value);
  const seeds = [
    0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1,
    0xd3a2646c, 0xfd7046c5,
  ];
  return seeds
    .map((seed) => {
      let hash = seed;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
}

function validateRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw invalidInput("Project revision must be a non-negative safe integer.");
  }
  return revision;
}

function nonEmpty(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw invalidInput(`${label} must not be empty.`);
  return result;
}

function validateOperation(
  operation: ProjectPermissionOperation,
): ProjectPermissionOperation {
  if (
    operation !== "delete" &&
    operation !== "move" &&
    operation !== "replace_project"
  ) {
    throw invalidInput("Permission operation is invalid.");
  }
  return operation;
}

function validateRuntime(
  runtime: ProjectPermissionRuntime,
): ProjectPermissionRuntime {
  if (runtime !== "api" && runtime !== "local_cli") {
    throw invalidInput("Permission runtime is invalid.");
  }
  return runtime;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function canonicalAffectedPaths(
  paths: readonly string[],
  affectedCount: number,
): { affectedPaths: readonly string[]; affectedCount: number } {
  if (!Array.isArray(paths)) {
    throw invalidInput("Affected paths must be an array.");
  }
  const normalized = Object.freeze(
    [...new Set(paths.map(normalizePath))].sort((left, right) =>
      left.localeCompare(right),
    ),
  );
  if (
    !Number.isSafeInteger(affectedCount) ||
    affectedCount < normalized.length ||
    affectedCount < 0
  ) {
    throw invalidInput("Affected path count is invalid.");
  }
  return { affectedPaths: normalized, affectedCount };
}

function validateImpact(
  operation: ProjectPermissionOperation,
  scope: ProjectPermissionScope,
  affectedPaths: readonly string[],
  affectedCount: number,
): void {
  if (
    operation !== "replace_project" &&
    affectedPaths.length === 0 &&
    affectedCount > 0
  ) {
    throw invalidInput(
      "Destructive file operations must expose affected paths.",
    );
  }
  if (
    affectedPaths.length > 0 &&
    !projectPermissionScopeCovers(scope, {
      kind: "exact",
      paths: affectedPaths,
    })
  ) {
    throw invalidInput("Affected paths fall outside the requested scope.");
  }
  if (operation !== "replace_project" && scope.kind === "exact") {
    if (
      affectedCount !== scope.paths.length ||
      affectedPaths.length !== scope.paths.length ||
      affectedPaths.some((path, index) => path !== scope.paths[index])
    ) {
      throw invalidInput(
        "Exact destructive scope must equal its affected paths.",
      );
    }
  }
}

function freezeRequest(
  input: Omit<ProjectPermissionRequest, "requirementDigest">,
): ProjectPermissionRequest {
  const requirementDigest = stableDigest({
    tool: input.tool,
    runtime: input.runtime,
    operation: input.operation,
    sessionEligible: input.sessionEligible,
    scope: input.scope,
    affectedPaths: input.affectedPaths,
    affectedCount: input.affectedCount,
  });
  return Object.freeze({ ...input, requirementDigest });
}

function freezeGrant(grant: ProjectPermissionGrant): ProjectPermissionGrant {
  return Object.freeze({ ...grant, scope: canonicalScope(grant.scope) });
}

function freezePermit(
  input: Omit<ProjectPermissionPermit, typeof projectPermissionPermit>,
): ProjectPermissionPermit {
  return Object.freeze({
    ...input,
    grantIds: Object.freeze([...input.grantIds]),
    [projectPermissionPermit]: true as const,
  });
}

function cancelled(message: string, cause?: unknown): ProjectPermissionError {
  return new ProjectPermissionError(
    "permission_cancelled",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function signalError(signal: AbortSignal): Error {
  if (signal.reason instanceof ProjectPermissionError) return signal.reason;
  return cancelled("Permission request was cancelled.", signal.reason);
}

async function waitForDecision(
  decision: Promise<ProjectPermissionDecision>,
  signals: readonly AbortSignal[],
): Promise<ProjectPermissionDecision> {
  for (const signal of signals) {
    if (signal.aborted) throw signalError(signal);
  }
  return new Promise<ProjectPermissionDecision>((resolve, reject) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      callback();
    };
    for (const signal of signals) {
      const listener = () => finish(() => reject(signalError(signal)));
      signal.addEventListener("abort", listener, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", listener));
    }
    decision.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function denialKey(request: ProjectPermissionRequest): string {
  return stableDigest({
    tool: request.tool,
    operation: request.operation,
    scope: request.scope,
    affectedPaths: request.affectedPaths,
    affectedCount: request.affectedCount,
  });
}

function authorizedCallKey(request: ProjectPermissionRequest): string {
  return `${request.callId}\u0000${request.requirementDigest}\u0000${request.projectRevision}`;
}

export function createProjectPermissionBroker(
  dependencies: ProjectPermissionBrokerDependencies,
): ProjectPermissionBroker {
  const createId =
    dependencies.createId ??
    (() =>
      globalThis.crypto?.randomUUID?.() ??
      `permission-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const now = dependencies.now ?? Date.now;

  return Object.freeze({
    openSession(input: ProjectPermissionOpenSessionInput) {
      const conversationId = nonEmpty(input.conversationId, "conversationId");
      const policyVersion = nonEmpty(input.policyVersion, "policyVersion");
      const sessionId = createId();
      let projectRevision = validateRevision(input.projectRevision);
      let bypassEnabled = input.bypassEnabled === true;
      let authorityRevision = 0;
      let closed = false;
      let grants: readonly ProjectPermissionGrant[] = Object.freeze([]);
      let pending: PendingRequest | null = null;
      const deniedByRun = new Map<string, Set<string>>();
      const issuedPermits = new Map<string, IssuedPermit>();
      const authorizedCalls = new Set<string>();

      const bestEffortAudit = (event: ProjectPermissionAuditEvent): void => {
        try {
          void Promise.resolve(dependencies.audit.record(event)).catch(
            () => undefined,
          );
        } catch {
          // Bypass and terminal events are attempted exactly once.
        }
      };

      const requiredAudit = async (
        event: ProjectPermissionAuditEvent,
      ): Promise<void> => {
        try {
          await dependencies.audit.record(event);
        } catch (cause) {
          throw new ProjectPermissionError(
            "permission_audit_unavailable",
            "Permission activity could not be recorded; access was not granted.",
            { cause },
          );
        }
      };

      const makeAuthority = (): ProjectPermissionAuthoritySnapshot => {
        const canonicalGrants = Object.freeze(
          grants
            .map(freezeGrant)
            .sort((left, right) => left.id.localeCompare(right.id)),
        );
        const body = {
          revision: authorityRevision,
          sessionId,
          conversationId,
          policyVersion,
          projectRevision,
          bypassEnabled,
          closed,
          grants: canonicalGrants,
        };
        return Object.freeze({
          id: createId(),
          digest: stableDigest(body),
          ...body,
        });
      };

      let currentAuthority = makeAuthority();

      const rotate = (
        nextGrants: readonly ProjectPermissionGrant[],
        reason?: Extract<
          ProjectPermissionAuditEvent,
          { type: "authority_changed" }
        >["reason"],
      ) => {
        const previous = currentAuthority;
        grants = Object.freeze(nextGrants.map(freezeGrant));
        authorityRevision += 1;
        currentAuthority = makeAuthority();
        if (reason) {
          bestEffortAudit(
            Object.freeze({
              type: "authority_changed",
              at: now(),
              sessionId,
              conversationId,
              reason,
              authorityBefore: previous.id,
              authorityAfter: currentAuthority.id,
              authorityRevisionBefore: previous.revision,
              authorityRevisionAfter: currentAuthority.revision,
            }),
          );
        }
        return { previous, current: currentAuthority };
      };

      const assertRequestCurrent = (request: ProjectPermissionRequest) => {
        if (closed) throw cancelled("Permission session is closed.");
        if (request.projectRevision !== projectRevision) {
          throw new ProjectPermissionError(
            "permission_stale",
            "The project changed while permission was pending.",
          );
        }
      };

      const matchingGrants = (
        request: ProjectPermissionRequest,
      ): readonly ProjectPermissionGrant[] => {
        if (!request.sessionEligible) return [];
        return grants.filter(
          (grant) =>
            grant.operation === request.operation &&
            projectPermissionScopeCovers(grant.scope, request.scope),
        );
      };

      const issuePermit = async (
        request: ProjectPermissionRequest,
        grantIds: readonly string[],
        lifetime: ProjectPermissionPermit["lifetime"],
        authority: ProjectPermissionAuthoritySnapshot,
        auditExecutionStart: boolean,
      ): Promise<ProjectPermissionPermit> => {
        if (auditExecutionStart) assertRequestCurrent(request);
        // A provider run rotation must not make an already-consumed call
        // replayable. The logical call identity is bound to the call id, the
        // normalized requirement, and the ProjectFiles revision, while the
        // permit itself remains additionally bound to its originating run.
        const callKey = authorizedCallKey(request);
        if (auditExecutionStart && authorizedCalls.has(callKey)) {
          throw new ProjectPermissionError(
            "permission_authority_stale",
            "This tool call already consumed a permission authorization.",
          );
        }
        const permit = freezePermit({
          id: createId(),
          sessionId,
          runId: request.runId,
          callId: request.callId,
          requirementDigest: request.requirementDigest,
          projectRevision: request.projectRevision,
          authorityId: authority.id,
          grantIds,
          lifetime,
        });
        if (auditExecutionStart) {
          // A Host implementation can start as soon as authorize returns. Mark
          // the call consumed before the required execution audit and before
          // exposing the opaque permit, so a call id cannot be replayed.
          authorizedCalls.add(callKey);
          await requiredAudit(
            Object.freeze({
              type: "execution_started",
              at: now(),
              request,
              permitId: permit.id,
              grantIds: permit.grantIds,
              lifetime: lifetime as "once" | "session",
              authorityId: authority.id,
              authorityRevision: authority.revision,
            }),
          );
          assertRequestCurrent(request);
          if (currentAuthority.id !== authority.id) {
            throw new ProjectPermissionError(
              "permission_authority_stale",
              "Permission authority changed before execution could start.",
            );
          }
          if (
            lifetime === "session" &&
            grantIds.some(
              (grantId) => !grants.some((grant) => grant.id === grantId),
            )
          ) {
            throw new ProjectPermissionError(
              "permission_authority_stale",
              "The session grant was revoked before execution could start.",
            );
          }
        }
        issuedPermits.set(permit.id, { permit, request });
        return permit;
      };

      const session: ProjectPermissionSession = {
        async authorize(input) {
          if (closed) throw cancelled("Permission session is closed.");

          const request = freezeRequest({
            requestId: createId(),
            sessionId,
            conversationId,
            runId: nonEmpty(input.runId, "runId"),
            callId: nonEmpty(input.callId, "callId"),
            tool: nonEmpty(input.tool, "tool"),
            runtime: validateRuntime(input.runtime),
            operation: validateOperation(input.operation),
            sessionEligible: input.sessionEligible === true,
            scope: canonicalScope(input.scope),
            ...canonicalAffectedPaths(input.affectedPaths, input.affectedCount),
            projectRevision: validateRevision(input.projectRevision),
            authorityId: input.authorityId,
          });
          validateImpact(
            request.operation,
            request.scope,
            request.affectedPaths,
            request.affectedCount,
          );
          if (
            request.operation === "replace_project" &&
            request.sessionEligible
          ) {
            throw invalidInput(
              "Whole-project replacement cannot receive a session grant.",
            );
          }

          if (bypassEnabled) {
            bestEffortAudit(
              Object.freeze({
                type: "bypassed",
                at: now(),
                request,
                reason: "broker_disabled",
                grantIds: Object.freeze([]),
                authorityId: currentAuthority.id,
                authorityRevision: currentAuthority.revision,
              }),
            );
            return issuePermit(request, [], "bypass", currentAuthority, false);
          }

          if (input.signal.aborted) throw signalError(input.signal);
          if (input.authorityId !== currentAuthority.id) {
            throw new ProjectPermissionError(
              "permission_authority_stale",
              "Permission authority changed; reopen the Host Tool Run.",
            );
          }
          assertRequestCurrent(request);
          if (authorizedCalls.has(authorizedCallKey(request))) {
            throw new ProjectPermissionError(
              "permission_authority_stale",
              "This tool call already consumed a permission authorization.",
            );
          }

          const denied = deniedByRun.get(request.runId);
          const deniedKey = denialKey(request);
          if (denied?.has(deniedKey)) {
            bestEffortAudit(
              Object.freeze({
                type: "denied",
                at: now(),
                request,
                reason: "cached",
                authorityId: currentAuthority.id,
                authorityRevision: currentAuthority.revision,
              }),
            );
            throw new ProjectPermissionError(
              "permission_denied",
              "The user already denied this operation for the current run.",
            );
          }

          const matching = matchingGrants(request);
          if (matching.length > 0) {
            bestEffortAudit(
              Object.freeze({
                type: "bypassed",
                at: now(),
                request,
                reason: "session_grant",
                grantIds: Object.freeze(matching.map((grant) => grant.id)),
                authorityId: currentAuthority.id,
                authorityRevision: currentAuthority.revision,
              }),
            );
            return issuePermit(
              request,
              matching.map((grant) => grant.id),
              "session",
              currentAuthority,
              true,
            );
          }

          if (pending) {
            throw new ProjectPermissionError(
              "permission_busy",
              "Another project permission request is already pending.",
            );
          }

          const pendingRequest: PendingRequest = {
            request,
            controller: new AbortController(),
          };
          const forwardAbort = () =>
            pendingRequest.controller.abort(signalError(input.signal));
          input.signal.addEventListener("abort", forwardAbort, { once: true });
          pending = pendingRequest;

          try {
            await requiredAudit(
              Object.freeze({
                type: "requested",
                at: now(),
                request,
                authorityRevision: currentAuthority.revision,
              }),
            );
            if (input.signal.aborted) throw signalError(input.signal);
            if (pendingRequest.controller.signal.aborted) {
              throw signalError(pendingRequest.controller.signal);
            }

            let decision: ProjectPermissionDecision;
            try {
              decision = await waitForDecision(
                Promise.resolve(
                  dependencies.decision.decide(
                    request,
                    pendingRequest.controller.signal,
                  ),
                ),
                [input.signal, pendingRequest.controller.signal],
              );
            } catch (error) {
              if (error instanceof ProjectPermissionError) throw error;
              if (isAbortError(error)) {
                throw cancelled("Permission request was cancelled.", error);
              }
              throw new ProjectPermissionError(
                "permission_prompt_unavailable",
                "The permission prompt could not complete.",
                { cause: error },
              );
            }
            assertRequestCurrent(request);

            if (decision.kind === "deny") {
              const cache = deniedByRun.get(request.runId) ?? new Set<string>();
              cache.add(deniedKey);
              deniedByRun.set(request.runId, cache);
              bestEffortAudit(
                Object.freeze({
                  type: "denied",
                  at: now(),
                  request,
                  reason: "user",
                  authorityId: currentAuthority.id,
                  authorityRevision: currentAuthority.revision,
                }),
              );
              throw new ProjectPermissionError(
                "permission_denied",
                "The user denied this project operation.",
              );
            }

            if (
              decision.kind !== "allow_once" &&
              decision.kind !== "allow_session"
            ) {
              throw new ProjectPermissionError(
                "permission_prompt_unavailable",
                "The permission prompt returned an invalid decision.",
              );
            }

            if (decision.kind === "allow_session" && !request.sessionEligible) {
              const cache = deniedByRun.get(request.runId) ?? new Set<string>();
              cache.add(deniedKey);
              deniedByRun.set(request.runId, cache);
              bestEffortAudit(
                Object.freeze({
                  type: "denied",
                  at: now(),
                  request,
                  reason: "policy",
                  authorityId: currentAuthority.id,
                  authorityRevision: currentAuthority.revision,
                }),
              );
              throw new ProjectPermissionError(
                "permission_denied",
                "Replacing the project can only be allowed once.",
              );
            }

            const grantedScope =
              decision.kind === "allow_session"
                ? canonicalScope(decision.scope)
                : request.scope;
            if (!projectPermissionScopeCovers(grantedScope, request.scope)) {
              throw new ProjectPermissionError(
                "permission_authority_stale",
                "The selected session scope does not cover this operation.",
              );
            }

            const beforeApproval = currentAuthority;
            const grantId = createId();
            const isSession = decision.kind === "allow_session";
            const sessionGrant: ProjectPermissionGrant | undefined = isSession
              ? freezeGrant({
                  id: grantId,
                  operation:
                    request.operation as ProjectPermissionSessionOperation,
                  scope: grantedScope,
                })
              : undefined;
            const approved = rotate(
              sessionGrant ? [...grants, sessionGrant] : grants,
            );
            try {
              await requiredAudit(
                Object.freeze({
                  type: "approved",
                  at: now(),
                  request,
                  decision: isSession ? "allow_session" : "allow_once",
                  grantId,
                  grantedScope,
                  authorityBefore: beforeApproval.id,
                  authorityAfter: approved.current.id,
                  authorityRevisionBefore: beforeApproval.revision,
                  authorityRevisionAfter: approved.current.revision,
                }),
              );
            } catch (error) {
              rotate(
                sessionGrant
                  ? grants.filter((grant) => grant.id !== sessionGrant.id)
                  : grants,
                sessionGrant ? "grant_revoked" : undefined,
              );
              throw error;
            }

            try {
              assertRequestCurrent(request);
              return await issuePermit(
                request,
                [sessionGrant?.id ?? grantId],
                isSession ? "session" : "once",
                currentAuthority,
                true,
              );
            } catch (error) {
              if (sessionGrant) {
                rotate(
                  grants.filter((grant) => grant.id !== sessionGrant.id),
                  "grant_revoked",
                );
              }
              throw error;
            }
          } catch (error) {
            const reason =
              error instanceof ProjectPermissionError &&
              (error.code === "permission_stale" ||
                error.code === "permission_authority_stale")
                ? "stale"
                : error instanceof ProjectPermissionError &&
                    error.code === "permission_cancelled"
                  ? closed
                    ? "closed"
                    : "aborted"
                  : error instanceof ProjectPermissionError &&
                      error.code === "permission_busy"
                    ? "busy"
                    : error instanceof ProjectPermissionError &&
                        error.code === "permission_prompt_unavailable"
                      ? "prompt_unavailable"
                      : undefined;
            if (reason) {
              bestEffortAudit(
                Object.freeze({
                  type: "cancelled",
                  at: now(),
                  request,
                  reason,
                  authorityId: currentAuthority.id,
                  authorityRevision: currentAuthority.revision,
                }),
              );
            }
            throw error;
          } finally {
            input.signal.removeEventListener("abort", forwardAbort);
            if (pending === pendingRequest) pending = null;
          }
        },

        async settle(permit, result) {
          const issued = issuedPermits.get(permit.id);
          if (!issued) return;
          if (
            permit !== issued.permit ||
            permit[projectPermissionPermit] !== true ||
            permit.sessionId !== sessionId ||
            permit.runId !== issued.permit.runId ||
            permit.callId !== issued.permit.callId ||
            permit.requirementDigest !== issued.permit.requirementDigest ||
            permit.projectRevision !== issued.permit.projectRevision
          ) {
            return;
          }
          issuedPermits.delete(permit.id);
          if (permit.lifetime === "bypass") return;
          bestEffortAudit(
            Object.freeze({
              type: "settled",
              at: now(),
              request: issued.request,
              permitId: permit.id,
              outcome: result.outcome,
              ...(result.errorCode ? { errorCode: result.errorCode } : {}),
              authorityId: currentAuthority.id,
              authorityRevision: currentAuthority.revision,
            }),
          );
        },

        change(change) {
          if (change.type === "project_revision") {
            const nextRevision = validateRevision(change.revision);
            if (closed || nextRevision === projectRevision) return;
            projectRevision = nextRevision;
            pending?.controller.abort(
              new ProjectPermissionError(
                "permission_stale",
                "The project changed while permission was pending.",
              ),
            );
            rotate(grants, "project_revision");
            return;
          }
          if (change.type === "revoke_grant") {
            if (closed) return;
            const next = grants.filter((grant) => grant.id !== change.grantId);
            if (next.length !== grants.length) rotate(next, "grant_revoked");
            return;
          }
          if (change.type === "set_bypass") {
            if (closed || bypassEnabled === change.enabled) return;
            bypassEnabled = change.enabled;
            pending?.controller.abort(
              cancelled("Permission bypass setting changed."),
            );
            deniedByRun.clear();
            rotate([], "bypass_changed");
            return;
          }
          if (change.type === "revoke_session") {
            if (closed) return;
            const hadGrants = grants.length > 0;
            pending?.controller.abort(cancelled("Permission session revoked."));
            deniedByRun.clear();
            rotate([], hadGrants ? "session_revoked" : undefined);
            return;
          }
          if (closed) return;
          const hadGrants = grants.length > 0;
          closed = true;
          pending?.controller.abort(cancelled("Permission session closed."));
          deniedByRun.clear();
          authorizedCalls.clear();
          for (const issued of issuedPermits.values()) {
            if (issued.permit.lifetime === "bypass") continue;
            bestEffortAudit(
              Object.freeze({
                type: "settled",
                at: now(),
                request: issued.request,
                permitId: issued.permit.id,
                outcome: "aborted",
                errorCode: "permission_cancelled",
                authorityId: currentAuthority.id,
                authorityRevision: currentAuthority.revision,
              }),
            );
          }
          issuedPermits.clear();
          rotate([], hadGrants ? "session_closed" : undefined);
        },

        authority() {
          return currentAuthority;
        },
      };

      return Object.freeze(session);
    },
  });
}
