---
name: write-safe-typescript
description: Write and refactor TypeScript with trustworthy boundary validation, narrowing, discriminated unions, useful inference, safe async flows, and readable public types. Use when type design or unsafe data handling materially affects correctness; avoid type-level machinery without a concrete payoff.
version: 2.0.0
tags:
  - typescript
  - types
  - correctness
---

# Write safe TypeScript

Use TypeScript to make invalid states and unsafe boundaries visible without making ordinary code harder to understand. Follow the repository's compiler settings, runtime validation library, framework conventions, generated types, and public API contracts. Do not upgrade TypeScript, tighten global compiler options, or redesign unrelated APIs unless requested.

## Start at trust boundaries

Static types do not validate runtime data. Treat network responses, storage, environment values, imported files, tool arguments, JSON, URL parameters, postMessage payloads, and third-party callbacks as `unknown` until checked.

Validate once at the boundary, then pass a trusted domain type inward. Reuse an existing schema or parser when available. Define behavior for missing, null, malformed, extra, and legacy fields according to the actual contract; do not silently coerce values merely to satisfy the compiler.

Prefer a parse result that makes failure explicit:

```ts
type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```

Throw only when the surrounding API is exception-based. Otherwise return the project's established result type and keep failure handling visible to the caller.

## Narrow instead of asserting

Use control flow, `typeof`, `instanceof`, property checks, exhaustive switches, and focused type guards. Assertions are appropriate only when code has established a fact the compiler cannot express. Avoid chained `as unknown as T`, non-null assertions on data that can legitimately be absent, and broad casts around schema or library errors.

A type guard must validate every property its return type promises. A function named `isUser` that checks only for an object is worse than no guard because it creates false trust.

Use `unknown` for values requiring inspection. Use `any` only at a documented compatibility boundary that cannot be typed more precisely, and contain it locally.

## Model states explicitly

Discriminated unions are useful when behavior depends on a finite state:

```ts
type RequestState<T> =
  | { status: "idle" }
  | { status: "loading"; requestId: string }
  | { status: "success"; data: T }
  | { status: "error"; error: Error; retryable: boolean };
```

Choose a stable discriminant and keep state-specific data on the matching branch. Avoid several booleans that permit impossible combinations. Use exhaustive checks when adding a new variant must force callers to decide how it behaves.

Do not create a union when plain optional data has only one meaningful interpretation. Types should expose domain distinctions, not manufacture ceremony.

## Inference, `satisfies`, and public types

Let local variables and return expressions infer naturally. Add annotations at public boundaries, recursive definitions, generic APIs, or places where inference would widen or hide intent.

Use `satisfies` when an object must conform to a shape while retaining literal keys and values. Use `as const` for genuinely immutable literal data, not as a blanket fix for inference problems.

Public types should be stable, readable, and named for the domain. Preserve exported property names, optionality, wire formats, and callback variance. Avoid leaking library-internal types through a public interface when a small domain type is clearer and more stable.

## Generics that earn their cost

Use a generic when an actual relationship between inputs and outputs must be preserved. Constrain it to the operations the implementation performs. Avoid a generic used at only one concrete type, a large conditional type replacing simple overloads, or a utility type that makes errors unreadable.

Prefer composition of small explicit types over deeply recursive mapped types. If callers require assertions to use a supposedly safe generic API, simplify the API.

## Async work, errors, and cancellation

- Await promises when ordering or error propagation matters; use `void` only for intentional fire-and-forget work with its own error handling.
- Preserve the original error object and metadata when retry, status, or cancellation decisions depend on it.
- Treat `AbortError` as cancellation, not an ordinary retryable failure.
- Guard stale async completion with a request ID, epoch, or abort signal when a newer operation can replace it.
- Type timers and browser APIs for the target runtime rather than mixing Node and DOM assumptions.
- Avoid `Promise<any>` and catch blocks that immediately erase errors into strings.

When normalizing errors, extract a safe message for display while retaining the original cause and typed metadata for policy decisions.

## Collections and object operations

Use typed predicates when filtering nullable values. Be careful with `Object.keys`, `Object.entries`, indexed access, and partial updates: runtime keys may be broader than the compiler can prove. Do not cast keys globally when a local membership check is possible.

Distinguish absent, empty, and deleted values when persistence or patch semantics depend on the difference. Preserve readonly inputs and clone only at mutation boundaries.

## Framework code

Follow the framework version and local component conventions. Type component props from their actual contract, events from the element being handled, and refs from the rendered element. Do not resurrect generic framework rules unrelated to the task. State ownership, effects, server/client boundaries, and component composition remain framework and product decisions; TypeScript should describe them accurately rather than dictate them.

## Verification

Add tests for runtime validation and state transitions where types alone cannot protect behavior. Run targeted tests and the repository's type check. A passing type check is necessary evidence, not proof of runtime correctness.

Before finishing, search the changed area for avoidable `any`, unsafe assertions, ignored promises, non-exhaustive state handling, and public contract drift. Keep only complexity that prevents a concrete invalid state or improves a real caller relationship.
