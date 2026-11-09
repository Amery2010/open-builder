---
name: open-builder-workflow
description: Create, extend, debug, or review a frontend application in a target project using Open Builder's project workflow. Use for application delivery with host tools, the Open Builder CLI, or its MCP tools; maintenance of Open Builder's own runtime follows that repository's development instructions instead.
license: GPL-3.0-only
metadata:
  version: "0.1.0"
---

# Open Builder workflow

Requires a coding agent with project file access. CLI and MCP are optional; project scripts require their own runtime and dependencies.

Deliver the requested application change in the target project. The project files, active entry/import chain, and user instructions determine its structure and scope.

## Choose available capabilities

Discover tools rather than assuming they exist. Read [tool integration](references/tools.md) when using the Open Builder CLI or MCP.

- With host tools only, use the host's file editing and the project's existing validation commands.
- With `open-builder` available, use its template, design, check, and verify commands where appropriate.
- With the `builder_*` MCP tools available, use the corresponding tools. The host still owns code editing, model reasoning, and permission decisions.

An unavailable integration is not a reason to stop ordinary development. Use the available path and report its evidence accurately.

## Understand and scope

Read the target project's instructions and current changes. For an existing application, trace its package/configuration, entry, root UI, routes, and imported styles before editing. Preserve unrelated user changes and continue the active structure.

For substantial work, state the deliverables, non-goals, and observable acceptance criteria, then work in small increments. Handle a small local edit directly with appropriate verification.

For a new project, choose `react-ts` or `static` when Open Builder initialization is available. Otherwise use the host's normal project creation tools. State material stack assumptions. Install dependencies only through the host when authorized by the task; Open Builder does not install them.

## Implement the requested change

Keep every new runtime file connected to the entry, route, or import chain. Implement real interactions and the necessary loading, empty, error, and success states. Reuse existing design conventions, accessible semantics, and responsive behavior.

Load only the references relevant to the task:

- Product workflows, forms, dashboards, or settings: [product UI](references/design-product-ui.md).
- Marketing, portfolio, or editorial composition: [web art direction](references/art-direct-web.md).
- Existing Tailwind styling: [Tailwind UI](references/build-tailwind-ui.md).
- Keyboard, focus, forms, or accessible interaction: [accessible UI](references/build-accessible-ui.md).
- Type/data correctness: [safe TypeScript](references/write-safe-typescript.md).
- A reproducible failure: [debugging](references/debug-web-app.md).
- Requested findings: [code review](references/review-code.md).
- Simplifying changed code: [code simplification](references/simplify-code.md).

Read existing `DESIGN.md` and `tokens.css` when present. Open Builder design application adds these files and refuses to overwrite existing ones. A visual migration remains an explicitly scoped code change performed by the host. Judge touch targets by context and operability; this workflow imposes no universal 44px minimum.

## Verify and repair

Use checks appropriate to the changed behavior. Static health checks are source heuristics; they do not execute the application. Execute applicable build, type, lint, or test scripts and repair in-scope failures. Keep failure output as evidence; skipping a failed check does not make it pass.

Use the host's browser tools when available and appropriate to the task. Without browser evidence, state: “未进行视觉验证 / Visual verification was not performed.” A successful local build does not establish deployment or production behavior.

## Deliver and clean up

Report the changed behavior, checks actually run, failures or limitations, and the target project location. Distinguish static checks, real script execution, browser evidence, and deployment evidence. Stop background processes or preview services started for this task and remove its temporary artifacts. Commit only when the user explicitly requests it.
