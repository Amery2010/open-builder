---
name: review-code
description: Review a requested diff, file set, or repository scope for concrete correctness, security, performance, reliability, and maintainability problems. Use when the user wants findings or merge confidence; report only unless fixes or external actions are explicitly requested.
version: 2.0.0
tags:
  - review
  - correctness
  - security
  - performance
---

# Review code

Review the requested change or scope with a skeptical, evidence-based standard. The default deliverable is findings, not edits. Do not modify files, post comments, create tickets, approve a merge, or change external systems unless the user explicitly asks for that action.

## Establish scope and intent

Determine whether the target is a supplied diff, current working changes, named files, a commit or branch represented in the workspace, or a repository-wide review. Inspect repository instructions, tests, schemas, public types, nearby code, and callers that define intended behavior. Preserve a dirty worktree and distinguish the target change from unrelated existing modifications.

If the user asks for a whole-project audit, cover the promised dimensions and architecture rather than substituting a narrow diff review. If the target is a change set, prioritize regressions caused by that change and label pre-existing issues separately only when they materially affect merge safety.

## Trace behavior, not just syntax

For each material change, identify inputs, trust boundaries, state transitions, persistence, outputs, side effects, error handling, cancellation, retries, and consumers. Follow changed interfaces to their callers. Read enough surrounding code to understand invariants; a suspicious line without a reachable failure path is not a finding.

Use tests and static checks as evidence, but do not assume passing tests cover the changed behavior. Look for missing cases around:

- empty, null, malformed, oversized, duplicate, and legacy input;
- concurrency, stale async work, ordering, cancellation, and retry exhaustion;
- authorization, tenant or user boundaries, secrets, path and URL validation, and untrusted content;
- partial writes, rollback, persistence migration, and cache invalidation;
- loading, error, empty, and accessibility behavior in visible UI;
- performance changes on realistic data or high-frequency paths;
- platform differences and unavailable external dependencies.

## Review dimensions

### Correctness

Check whether the implementation satisfies the stated contract on happy and failure paths. Watch for swallowed errors, empty values treated as success, duplicated work, off-by-one boundaries, stale closures, incomplete union handling, mismatched serialization, and state updates applied to the wrong request or conversation.

### Security and privacy

Trace untrusted input to sensitive sinks. Check authentication and authorization at the authoritative layer, not only in UI. Review injection, traversal, unsafe URL or origin handling, secret exposure, overbroad tools, unsafe deserialization, permission escalation, and data retention. Calibrate severity to a reachable attacker-controlled path; do not inflate theoretical concerns.

### Reliability

Check abort, timeout, retry, idempotency, cleanup, partial failure, and recovery semantics. A retry must not replay consequential completed work unless the operation is safe and designed for it. Errors should remain distinguishable from cancellation and successful empty output.

### Performance

Look for work that scales with user data, render frequency, network count, bundle cost, or repeated parsing. Report only when the cost is credible in the actual path. Avoid speculative micro-optimization findings.

### Maintainability

Report complexity when it creates a concrete correctness or change-risk problem: duplicated protocol interpretation, misleading types, hidden coupling, unreachable branches, or tests coupled to prose instead of behavior. Style preferences alone are not findings.

## Validate candidate findings

Before reporting, state the triggering input or sequence, trace the path to the bad outcome, and check for an existing guard. Reproduce with a focused test or deterministic command when safe and useful. Do not mutate live data or run disabled E2E without authorization.

Reject a candidate when the path is unreachable, the guard is effective, the behavior is explicitly intended, or the impact is purely hypothetical. When evidence is incomplete, label the uncertainty and the exact verification needed.

## Severity

- **Critical:** reachable compromise or destructive failure with broad impact and no practical mitigation.
- **High:** serious security, data integrity, authorization, or core workflow failure likely under realistic conditions.
- **Medium:** material correctness, reliability, performance, accessibility, or maintenance defect affecting a meaningful path.
- **Low:** concrete limited-impact defect or localized regression worth fixing, not a style preference.

Use repository-specific priority conventions when provided. Severity reflects impact and reachability, not how easy the patch is.

## Finding format

Lead with findings ordered by severity. Each finding contains:

1. a short imperative title and priority;
2. the tightest useful file and line range;
3. the triggering condition and observable outcome;
4. why current guards or tests do not prevent it;
5. a bounded remediation direction.

Do not bury findings in a long summary. Avoid duplicate findings with the same root cause. After findings, include concise assumptions or verification gaps. If no reportable defects remain, say so and list the most important tests or runtime evidence not performed.

## Completion standard

Review every in-scope change, validate each reported path, separate unrun runtime evidence from static confidence, and ensure the response itself does not imply authorization for fixes, commits, deployment, or external tracking.
