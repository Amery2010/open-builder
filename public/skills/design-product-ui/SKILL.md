---
name: design-product-ui
description: Design and implement product interfaces such as dashboards, settings, forms, data views, and multi-step workflows. Use for hierarchy, density, navigation, interaction states, responsive behavior, and accessible product UI; use art-direct-web for marketing-led experiences.
version: 2.0.0
tags:
  - frontend
  - product-ui
  - interaction
  - accessibility
---

# Design product UI

Build application interfaces that help people complete real tasks with low ambiguity. This skill covers dashboards, editors, settings, forms, search, data views, administration, navigation, and multi-step workflows. Their page-level task mode is `operate`. Use `art-direct-web` for `persuade`, `read`, or `experience` surfaces; load both for a genuinely mixed target.

Before the first UI write in Design mode, inspect the active project and submit the run-local Design contract. Distinguish `create` (a new product surface), `extend` (a bounded addition within the current visual language), and `migrate` (the applied Design system replaces conflicting visual Tokens, styles, component grammar, and layout expression inside the named target). An applied Design system is visually authoritative in that target. A selected-but-unapplied system is reference only and cannot authorize a restyle.

In every change mode, preserve product truth: routes, data and state ownership, information architecture, content contracts, permissions, analytics hooks, integration selectors, accessibility semantics, and working behavior unless the user's request independently changes them. Migration is visual-system work, not permission to rebuild the product model.

## Ground the design in the product

Inspect the relevant screens, components, tokens, data types, routes, state stores, permissions, tests, and responsive patterns. Identify:

- the user and the job they are trying to complete;
- the primary action and the information needed before it;
- frequent versus occasional controls;
- irreversible or permission-sensitive actions;
- loading, empty, error, success, partial, and offline states;
- desktop, tablet, phone, localization, and accessibility constraints.

Do not replace working product semantics with a fashionable component pattern. Keep established meters, tabs, toolbars, selectors, dialogs, keyboard shortcuts, and visual identity when they already communicate the domain.

## Information hierarchy and density

Place the most important status, content, and action where the task begins. Use a small number of visual levels: page or workspace, section, group, control, supporting detail. Avoid nested cards, borders around every group, and repeated headers that make all information look equally important.

Choose density based on frequency and expertise. High-frequency workbenches benefit from compact controls, persistent context, and short travel distances. Infrequent or consequential workflows benefit from more explanation and separation. Compact does not mean tiny: preserve readable labels, visible focus, and operable targets.

Use whitespace, alignment, type weight, dividers, and surface contrast before adding decorative containers. A control should visually belong to the content it affects.

## Navigation and workspace structure

Navigation should reflect stable places; actions should not masquerade as navigation. Indicate the current location and preserve browser or application history where the architecture expects it. Keep primary navigation stable across loading and empty states.

For editor or builder layouts, protect the main work surface. Toolbars contain high-frequency actions, side panels contain inspectable context, and dialogs handle bounded decisions that should interrupt the workspace. Avoid sending every action into a modal.

Tabs represent peer views of the same context. Segmented controls change a local mode. Menus collect secondary actions. Selectors choose a value. Preserve these distinctions so users can predict behavior.

## Controls and forms

Use the native interaction model whenever possible:

- radio buttons for exactly one choice;
- checkboxes for independent multiple choices;
- switches for immediate binary settings;
- buttons for actions and links for navigation;
- text fields with persistent labels and clear constraints;
- visible close controls, Escape, focus containment, and focus restoration for dialogs.

Keep labels direct and domain-specific. Helper text explains a constraint or consequence, not the obvious control name. Placeholder text is an example, not a label. Put validation near the affected field, preserve entered values, and provide a clear recovery path.

Consequential actions need accurate scope, confirmation proportional to risk, pending protection against duplicates, and a visible terminal result. Do not make backdrop dismissal destructive by default.

## Data and feedback states

Design the entire state model before polishing the happy path:

- loading indicates what is pending and whether cancellation is possible;
- empty states distinguish no data, no results, missing permissions, and setup required;
- errors preserve context and offer the next valid action;
- partial success identifies what completed and what did not;
- optimistic updates remain reversible when the server rejects them;
- stale or disconnected data is labeled instead of presented as current.

Tables and lists need meaningful headers, alignment, sorting or filtering semantics, selection feedback, truncation strategy, and responsive behavior. Do not turn dense desktop data into unusable cards without considering comparison tasks. Use an intentional scroll region or alternate small-screen view when necessary.

## Visual system

Read root `DESIGN.md` and `tokens.css` when present, then trace the runtime style entry that must import the Tokens. Reuse semantic variables and shared components. Give color roles rather than page-specific meanings. Keep radii, shadows, borders, icons, and typography consistent with the applied system. For `create` and `migrate`, prove that color, typography, shape, and layout semantics are consumed by runtime UI; for `extend`, prove global Token wiring and changed-scope consumption without cleaning unrelated historical debt.

Do not bypass an available semantic variable with new literal colors, font families, radii, Tailwind palette classes, fixed radius classes, or transition durations. When interaction or animation is present, use the system's motion and easing roles and preserve reduced-motion behavior.

Icons supplement meaning. High-frequency icon-only controls need accessible names and the project's shared tooltip behavior. Avoid native `title` when a consistent tooltip primitive exists.

Use motion for state transition and feedback, not spectacle. Keep repeated interactions quick and respect reduced-motion preferences. Loading animation must not be the only description of progress.

## Responsive behavior

Decide which context must remain visible at each width. Reflow groups, collapse secondary panels, preserve primary actions, and prevent toolbars from silently clipping. A phone may be chat-first or content-first rather than a miniature desktop. Intermediate tablet widths need their own layout decisions when neither desktop nor phone composition fits.

Test long labels, translated text, validation messages, zoom, safe overflow, touch operation, and keyboard focus. Avoid fixed heights unless inner scrolling and focus visibility are deliberate.

## Accessibility and implementation

Use semantic HTML and the existing accessible primitives. Maintain keyboard order, focus states, labels, live feedback, contrast, and reduced motion. Do not recreate a radio group, checkbox, disclosure, menu, or dialog with generic pressed buttons solely for visual convenience.

Implement real interactions and data flow. Do not ship inert controls, fake charts, fabricated metrics, or screenshot-like panels. Match the existing framework and state ownership. Add dependencies only when the project lacks the necessary primitive and the benefit justifies the cost.

## Verification

Add or update tests for the state and interaction contract, especially selection, submission, cancellation, duplicate prevention, and error recovery. Run relevant static, component, type, and build checks. Browser or device evidence must be explicitly authorized and accurately reported.

Before finishing, run the project health check and fix every `design_system` error. Confirm the primary task is obvious, density fits usage, controls use familiar semantics, every async state has feedback, responsive layouts protect the work, accessibility behavior is preserved, the changed runtime consumes the applied semantic Tokens, and the diff contains no unrelated redesign. The host may follow with one automatic visual review and one bounded repair; reuse the accepted contract instead of inventing a new direction.
