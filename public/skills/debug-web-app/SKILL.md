---
name: debug-web-app
description: Diagnose reproducible web-app failures with evidence, isolate the smallest cause, apply a scoped fix, and verify the original symptom. Use for runtime errors, broken interactions, incorrect data flow, rendering failures, or regressions; do not use for speculative cleanup.
version: 2.0.0
tags:
  - debugging
  - web
  - reliability
---

# Debug a web app

Turn a reported symptom into a reproducible cause, a minimal correction, and evidence that the original failure no longer occurs. Debug within the user's requested scope. Do not use a bug report as permission to redesign, upgrade dependencies, rewrite adjacent systems, weaken validation, or change external services.

## Define the failure

Record the observable symptom in concrete terms: action, expected result, actual result, environment, and frequency. Separate what the user observed from what you infer. Inspect repository instructions, relevant entry points, configuration, recent changes, and existing tests before asking for information that the project already contains.

Reproduce through the cheapest faithful path available:

- a focused unit or integration test for deterministic logic;
- a static fixture for parsing, serialization, or policy behavior;
- runtime logs and a permitted preview for interaction or rendering failures;
- a provider or service boundary stub for error and retry behavior.

If faithful reproduction requires credentials, production data, a device, or browser execution that is unavailable or unauthorized, do not fabricate it. Continue with static evidence, state the boundary, and define the exact manual reproduction still needed.

## Capture evidence before changing code

Collect the complete error, stack, failing input, relevant state transition, network or tool result, and the smallest code path that can produce it. Prefer source evidence over intuition. Watch for failures that are swallowed, converted into empty success values, retried indefinitely, or reported at the wrong layer.

For stateful UI failures, trace the sequence:

1. user or system event;
2. synchronous state update;
3. async preparation or request;
4. response, stream, callback, or tool result;
5. state commit and visible rendering;
6. cancellation, navigation, retry, or duplicate action.

For server and provider failures, verify request construction, timeout and abort handling, status or error metadata, retry policy, response parsing, and the terminal state seen by the caller.

## Localize the cause

Reduce the search space without changing behavior. Trace values from source to sink, inspect callers and consumers, and compare a passing path with the failing path. Use logging or temporary assertions only when they produce evidence; remove diagnostics that are not part of the final fix.

Form one falsifiable hypothesis at a time:

> When condition X occurs, component Y treats value Z as success, causing symptom S. If true, test T will fail before the patch and pass after it.

Disprove the hypothesis quickly. Do not accumulate unrelated edits while the cause remains uncertain. Common boundaries worth checking include stale closures, duplicated messages, race conditions, unhandled stream events, incompatible persisted data, false truthiness, incomplete discriminated unions, authorization mismatches, and cleanup that runs against a newer request.

## Fix the responsible layer

Correct the earliest layer that owns the broken contract. Preserve public inputs, outputs, routes, storage formats, selectors, permissions, and visual behavior unless one of them is the defect being fixed.

- Convert error-like values into errors before success logic consumes them.
- Make cancellation distinct from failure and from successful empty output.
- Make retries bounded and driven by explicit metadata or known transient conditions.
- Guard async completion with request identity when navigation or replacement can invalidate it.
- Prefer a small invariant or shared classifier when two paths must interpret the same protocol consistently.
- Do not mask a provider, database, or authorization problem with local fake success.

Handle nearby cleanup only when the fix itself makes code unused or inconsistent.

## Build the regression test

The test should fail for the original reason and assert observable behavior, not implementation wording. Include the smallest meaningful happy path plus the boundary that caused the bug. For async workflows, control time and promises explicitly rather than relying on sleeps. Assert call counts when duplicate execution is dangerous, and verify that retries retain completed state without replaying consequential work.

Relevant cases may include:

- success after one transient failure;
- cancellation with no retry;
- permanent client error with immediate failure;
- retry exhaustion with a visible terminal error;
- navigation or a newer request invalidating stale work;
- persisted legacy state crossing a renamed or versioned boundary.

## Verify and report

Run the focused regression first, then affected suites, type checks, lint, and build steps in proportion to the change. Do not run disabled E2E or mutate live infrastructure without authorization. Review the final diff for debug residue and unrelated edits.

Report the confirmed cause, the behavior changed, the checks actually run, and any runtime boundary not verified. If the hypothesis was not confirmed, say so and provide the strongest remaining evidence instead of presenting a guess as a fix.
