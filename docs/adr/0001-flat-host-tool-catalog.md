# ADR 0001: Flat Host Tool Catalog and Immutable Run Snapshots

- Status: Accepted
- Date: 2026-09-03

## Context

Open Builder exposes static Host tools, provider-native search, MCP aliases,
Local CLI attachments, and mounted Preview capabilities. Tool schemas,
availability, effects, approval metadata, execution routing, and UI
presentation previously lived in parallel registries. That allowed names and
permissions to drift and made Web and Local CLI authority difficult to compare.

Design tools add stricter requirements: they must remain outside Plan, Auto QA,
subagents, and Design Review; runtime evidence must match the rendered project
generation; and rich evidence must not become durable Conversation payload.

## Decision

Use a flat catalog of immutable `HostToolRecord` values. A record owns the
model definition, source, effects, mode/profile/platform availability, approval
and output-retention policy, localized presentation, and Host or provider
ownership.

`HostToolCatalog.openRun()` compiles an immutable `HostToolRun` exposing only:

- `modelTools`
- `authority`
- `providerOwnedNames`
- `dispatch(call)`

Dispatch order is authority membership, schema validation, Skill/Design guard,
approval, implementation, state validation, and output retention/audit. Plan
approval opens a new Run Snapshot; it never expands an existing authority.

Web and Local CLI project the same Run Snapshot. MCP, provider-native search,
Local attachments, and mounted Preview remain real dynamic adapters. Static or
dynamic name collisions fail closed, except when a static record explicitly
declares a provider-native alternative.

The Design Diagnostics tools use one deep execution module. Runtime tools share
the conversation-scoped Preview adapter, generation checks, cancellation, and
single-flight lock. Layout and accessibility reports explicitly describe their
bounded sampled coverage; Preview Comparison uses exact image digests and
metadata rather than claiming a perceptual diff.

## Consequences

- Adding a static tool requires one definition and one catalog record; Web and
  Local authority derive from that same source.
- Design Review remains a strict replacement profile containing only
  `list_files`, `read_files`, `search_in_files`, and `submit_design_review`.
- Provider ownership cannot silently replace Host implementations.
- `summary-only` and `run-only` results are scrubbed at the persistence seam.
- Some runtime tools can return `unavailable`, `capture_busy`, or
  `stale_generation`; callers must treat these as evidence limits, not success.

## Rejected alternatives

### Tool Packs

Tool Packs add a second grouping and lifecycle vocabulary without replacing the
catalog facts callers must already understand. Profile composition remains a
compile-time property of records instead.

### Lifecycle-oriented Catalog

An `open/invoke/finish` framework would make automatic Review and unrelated run
coordination part of tool authority. Those lifecycles already have owners; the
catalog stays focused on immutable visibility and dispatch.

### One adapter per tool

Most tools are in-process implementations. Creating pass-through ports for them
would be shallow indirection. Adapters are retained only where behavior really
varies: provider, MCP, Local CLI, attachment, registry storage, and Preview
runtime.
