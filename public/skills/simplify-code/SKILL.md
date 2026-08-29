---
name: simplify-code
description: Simplify user-selected or newly changed code while preserving observable behavior and established contracts. Use to reduce unnecessary nesting, duplication, indirection, or cleverness in a bounded area; do not turn a focused cleanup into a broad refactor.
version: 2.0.0
tags:
  - refactoring
  - clarity
  - maintainability
---

# Simplify code

Make the requested code easier to read, reason about, test, and change without altering observable behavior. Work only on files the user selected or code changed in the current task unless the user explicitly broadens scope. Follow repository guidance, formatter and lint rules, public contracts, and nearby conventions.

## Define what must not change

Before editing, identify the behavior boundary:

- inputs, outputs, exceptions, and error messages that callers depend on;
- ordering, timing, retries, cancellation, and side effects;
- routes, payloads, storage formats, migrations, and public types;
- selectors, labels, ARIA, visual states, and keyboard behavior;
- performance characteristics on sensitive paths;
- test seams and extension points intentionally provided by the architecture.

Read callers, consumers, and relevant tests. If equivalence cannot be established cheaply, keep the existing structure or add characterization coverage before simplifying.

## Find accidental complexity

Good candidates include:

- nested branches that become clearer with an early return;
- duplicated conditions or protocol interpretation that should share one small helper;
- temporary variables that obscure rather than name intent;
- wrappers that add no policy, transformation, or test seam;
- repeated object construction or state updates that can use one explicit path;
- stale abstractions created for requirements that no longer exist;
- comments that restate code while hiding the important invariant;
- type assertions or boolean combinations that can become an explicit union or guard.

Complexity may be essential when it isolates permissions, platform behavior, concurrency, compatibility, or failure recovery. Do not collapse those boundaries merely to reduce line count.

## Prefer direct code

- Use clear names tied to the domain.
- Keep control flow readable from top to bottom.
- Extract a helper when it names a real operation or enforces one shared invariant, not just to shorten a function.
- Keep a single-use expression inline when extraction would force the reader to jump without adding meaning.
- Prefer explicit branches over clever boolean algebra.
- Prefer existing primitives and utilities over a new local framework.
- Remove only imports, variables, branches, or comments made obsolete by this change.

Do not introduce speculative configuration, generic factories, dependency injection, or reusable component APIs for one current use. Do not compress code into dense chains or one-liners that are harder to debug.

## Preserve architecture and compatibility

Simplification is not authorization to rename public APIs, change URLs, replace libraries, migrate state, reformat unrelated files, remove compatibility behavior, or adopt a different component model. Preserve intentional server/client, domain/presentation, or authority boundaries.

When old and new representations coexist for migration, simplify the adapter only if both paths remain correct. When a dirty worktree contains unrelated edits or deletions, work around them and never restore, reset, or clean them incidentally.

## Work in small equivalence steps

1. Capture the current contract with existing tests or a focused characterization test.
2. Make one coherent simplification.
3. Run the narrow verification that can expose a behavior change.
4. Inspect the diff for unintended formatting or scope growth.
5. Repeat only while each step materially improves clarity.

If a simplification exposes a real bug, do not silently fix it under a behavior-preserving task. Report it or obtain authorization to change behavior, then test that change separately.

## Common traps

- combining separate failure modes into one generic error;
- replacing a named domain type with broad primitives;
- deduplicating code whose small differences encode policy;
- removing a guard because current callers happen to validate first;
- memoizing or caching without measured need;
- replacing readable loops with dense functional chains;
- widening the diff through formatter churn;
- deleting comments that document why a non-obvious invariant exists;
- making UI markup visually shorter while regressing semantics or focus.

## Verification

Run focused tests before and after when possible, then type, lint, and build checks in proportion to risk. For UI, verify interaction and accessibility contracts, not only snapshots. For async code, cover cancellation, stale completion, duplicate actions, and errors when those paths are relevant.

Finish when the target is materially clearer and all identified contracts still hold. Report what was simplified, the evidence used for equivalence, and any browser, service, or production behavior not verified. Do not claim a broader cleanup than the diff supports.
