# Open Builder Domain Context

This glossary names the concepts used across Open Builder project state, Design workflows, Host tools, and local CLI runtimes.

## Project and preview language

**Conversation**:
The persisted owner of one project tree, project metadata, chat history, and runtime session references.
_Avoid_: Chat-only record, tab

**Preview Mode**:
Whether a project uses the Sandpack preview runtime or is code-only. It is independent of viewport choice.
_Avoid_: Device, default view

**Preview Preference**:
The Conversation-owned default viewport (`desktop`, `tablet`, or `mobile`). It is inherited by forks and Project Templates, but is not file content and is not restored by file snapshots.
_Avoid_: Current viewport, responsive breakpoint

**Manual Preview Override**:
A mount-local viewport selected by the user. It temporarily takes precedence over Preview Preference and disappears when the Conversation or preview mount changes.
_Avoid_: Saved preference, user lock

**Preview Generation**:
The digest of the exact project files, template, and Preview Mode that a mounted preview represents. Evidence from another generation is stale and must be rejected.
_Avoid_: Build number, Conversation timestamp

**Preview Evidence**:
A run-scoped WebP capture plus a bounded semantic snapshot for one explicit viewport. Conversation history retains only dimensions, digests, overflow/font/element counts, errors, and placeholder text.
_Avoid_: Design Review report, persisted screenshot

**Preview Comparison**:
An exact comparison between current Preview Evidence and a previously persisted evidence summary in the same Conversation. It compares image digests and bounded metadata, not perceptual regions or historical file snapshots.
_Avoid_: Pixel diff, snapshot renderer

## Design language

**Design Token Contract**:
The validated root `tokens.css` contract attached to the currently applied Design system.
_Avoid_: Arbitrary CSS variables, theme file

**Design Token Mutation**:
The atomic operation that validates a batch of editable semantic Token changes, checks Conversation revision and Design authority, commits once, invalidates Review evidence, and creates a snapshot.
_Avoid_: CSS patch, token write helper

**Design System Application**:
The host-owned transaction that loads a registered package, rechecks the user-selected reference and digest, validates its Token contract, and either applies it to an existing Conversation or prepares initialized files.
_Avoid_: Selecting a card, model style suggestion

**Design Diagnostics**:
The read-only Design Host tools that inspect system consistency, sampled preview layout, bounded DOM-derived accessibility semantics, evidence comparisons, and current-state provenance through one execution interface.
_Avoid_: Automatic Design Review, write fixer

**Sampled Preview Semantics**:
At most 120 sanitized landmark, heading, media, form, and interactive elements captured from the current route. It supports bounded diagnostics but is not a complete DOM or browser-native accessibility tree.
_Avoid_: WCAG conformance, whole-page proof

## Host Tool language

**Host Tool Record**:
A single flat declaration containing a tool's model schema, source and effects, run availability, approval and retention policy, presentation metadata, and Host implementation or provider ownership.
_Avoid_: Capability row, handler registration

**Host Tool Catalog**:
The unique inventory of static Host Tool Records plus explicitly compiled dynamic adapters. Duplicate public names fail closed.
_Avoid_: Tool pack, handler map

**Host Tool Run**:
An immutable snapshot compiled from the Host Tool Catalog for one mode, profile, platform, and approval state. It exposes model tools, authority, provider-owned names, and the single Host dispatch seam; principal-specific checks remain at the guarded mutation boundary.
_Avoid_: Mutable allowlist, lifecycle manager

**Output Retention**:
The record-level rule (`full`, `summary-only`, or `run-only`) determining what a live model may receive and what Conversation history may retain.
_Avoid_: UI truncation, provider context limit

**Dynamic Tool Adapter**:
A run-scoped contribution backed by a real external or mounted runtime, such as MCP, provider-native search, Local attachments, or Preview runtime.
_Avoid_: Static builtin, speculative plugin hook

## Runtime and catalog language

**Local CLI Runtime**:
A desktop execution mode in which an installed provider CLI carries out an Open Builder run.
_Avoid_: Offline model, shell mode

**Verified Local CLI Run**:
A Local CLI Runtime run whose executable identity, launch selection, session compatibility, process lifecycle, and normalized outcome are verified behind one interface before the result reaches a caller.
_Avoid_: CLI connection, raw subprocess run

**Local CLI Observation**:
A non-authoritative record of the most recently inspected Provider state, retained to describe what Open Builder last observed without claiming that a future run can start.
_Avoid_: Readiness proof, cached authorization

**Host Tool Authority**:
The immutable authority projection from a Host Tool Run that defines exactly which Open Builder tools exist and what Host authorization each tool requires. Web and Local CLI consume the same projection.
_Avoid_: Provider permission, CLI allowlist

**Provider Approval Projection**:
A non-authoritative representation of the Host Tool Authority supplied to a Provider so its headless CLI can reach the Host authorization flow without requesting a second approval.
_Avoid_: Automatic authorization, Provider-owned permission

**Provider**:
A model-runtime family that owns a local CLI and its model-selection rules.
_Avoid_: Vendor, backend

**Model Catalog**:
The set of model IDs that a runtime or configured gateway reports as available for selection.
_Avoid_: Model list, model registry

**Gateway Catalog**:
A model catalog supplied by a configured third-party gateway for a provider runtime.
_Avoid_: Claude-only catalog, remote defaults

**Model ID**:
The exact identifier used to select one model in a model catalog; an alias is a separate selectable name.
_Avoid_: Model name, display label

**Model Alias**:
A provider-local name that routes to a model without being the model's exact ID.
_Avoid_: Synonym, canonical ID

## Selection language

**Reasoning Effort**:
A provider-reported level controlling how much reasoning work a selected model may use.
_Avoid_: Static effort, quality preset

**Model Capability**:
A provider's statement that a selected model supports a particular reasoning effort.
_Avoid_: Assumed support, global capability

**Catalog Authority**:
The degree to which a model catalog is complete enough to decide whether a model or capability is supported.
_Avoid_: Catalog status, discovery flag

**Unverified Preference**:
A saved model or reasoning-effort choice retained when the available catalog cannot confirm or reject it.
_Avoid_: Invalid preference, fallback choice
