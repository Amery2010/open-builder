# Local CLI Model Selection Context

This glossary names the concepts used when Open Builder selects models and capabilities for desktop local CLI runtimes.

## Runtime and catalog language

**Local CLI Runtime**:
A desktop execution mode in which an installed provider CLI carries out an Open Builder run.
_Avoid_: Offline model, shell mode

**Verified Local CLI Run**:
A Local CLI Runtime run whose executable identity, launch selection, session compatibility, process lifecycle, and normalized outcome are verified behind one interface before the result reaches a caller.
_Avoid_: CLI connection, raw subprocess run

**Host Tool Authority**:
The immutable decision for one Verified Local CLI Run that defines exactly which Open Builder tools exist and what Host authorization each tool requires.
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
