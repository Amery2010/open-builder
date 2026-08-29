---
name: build-accessible-ui
description: Build or repair accessible web interfaces using native semantics, keyboard and focus behavior, clear forms, perceivable states, and appropriate ARIA. Use when implementing or reviewing interactive UI; pair it with the project's existing accessibility and browser requirements.
version: 2.0.0
tags:
  - accessibility
  - a11y
  - ui
  - forms
---

# Build accessible UI

Make the requested experience usable without relying on a particular pointer, viewport, color perception, motion tolerance, or assistive technology. Preserve the project's framework, component system, visual identity, browser support, and explicit accessibility target. Do not claim WCAG conformance from static inspection alone.

## Establish the interaction contract

Before editing, identify the task a person must complete, the controls involved, the state transitions, and how success or failure is communicated. Inspect nearby components, shared primitives, styles, tests, and repository guidance. Preserve working labels, selectors, routes, payloads, and keyboard conventions unless the request changes them.

Use the native HTML element whose behavior matches the action:

- buttons perform actions; links navigate;
- labels name form controls; fieldsets and legends group related choices;
- headings describe document structure rather than visual size;
- lists, tables, dialogs, navigation, main content, and status regions use their native semantics;
- disabled controls use native disabled behavior when they truly cannot be operated.

Avoid clickable `div` or `span` elements. If a custom widget is unavoidable, reproduce its complete keyboard, focus, name, role, value, and state contract—not only an ARIA role.

## Keyboard and focus

- Every action must be reachable and operable from the keyboard in a logical order.
- Preserve standard keys: Enter or Space activates buttons, arrow keys operate composite widgets when the relevant pattern requires them, and Escape closes dismissible overlays.
- Do not add positive `tabIndex` values. Use DOM order and layout structure to produce the intended sequence.
- Show a visible focus indicator with sufficient contrast. Do not remove outlines without a clear replacement.
- When a dialog opens, place focus at a useful starting point, contain focus while modal, expose a visible close action, support Escape, and restore focus to the trigger when it closes.
- After deletion, navigation, validation failure, or dynamic insertion, move focus only when doing so prevents disorientation. Otherwise announce the update and retain the user's position.
- Skip links are appropriate when repeated navigation precedes substantial page content.

Test keyboard behavior as a sequence, not as isolated attributes: enter the surface, move through it, operate each control, recover from an error, and leave it.

## Names, descriptions, and ARIA

Every interactive control needs an accessible name that matches its visible purpose. Prefer visible text or an associated label; use `aria-label` only when the visual design legitimately has no text. Icon-only controls also need a shared tooltip or equivalent visible discovery mechanism when the product uses one.

Use ARIA to expose information native HTML cannot express:

- `aria-expanded` and `aria-controls` for disclosure state;
- `aria-current` for the active page or step;
- `aria-describedby` for persistent help or validation details;
- `aria-live`, `role="status"`, or `role="alert"` for meaningful asynchronous updates;
- `aria-pressed` only for toggle buttons, not as a replacement for radio or checkbox semantics.

IDs referenced by ARIA must be stable and unique. Do not add redundant roles, contradictory attributes, or announcements for every streaming token. Announce state changes at a cadence that remains understandable.

## Forms and validation

- Keep a persistent label for every input. Placeholder text may offer an example but is not the label.
- Use the correct input type, `name`, autocomplete token, input mode, and required state.
- Use radio buttons for one choice and checkboxes for independent multiple choices. Group related controls with a fieldset and legend.
- Associate error text with the affected field, explain how to recover, and keep submitted values intact.
- On failed submission, focus the first invalid field or an error summary according to the form's established pattern.
- Do not rely on color, border color, or an icon alone to communicate validity.
- Prevent duplicate submissions while a consequential request is pending, but keep progress and cancellation behavior understandable.

## Perception, layout, and motion

- Check text, icons, focus rings, disabled states, selected states, and information graphics against the project's contrast target.
- Preserve meaning in high contrast and forced-colors environments where the project supports them.
- Provide text alternatives that communicate the function of informative images. Decorative images use an empty alternative.
- Captions, transcripts, or equivalent alternatives are required when media content is part of the task.
- The interface must remain operable at text zoom and narrow widths without hiding actions, trapping horizontal content, or overlapping controls. Data tables may use an intentional scroll region when reflow would destroy meaning.
- Keep pointer targets comfortably operable and avoid hover-only disclosure for required information.
- Respect reduced-motion preferences. Motion must not be the only indication of change, and essential workflows must not depend on animation completion.

## Dynamic and application states

Loading, empty, error, success, offline, and permission states are part of the accessible interface. Give each state clear text, appropriate focus behavior, and a recovery action when one exists. Skeletons and spinners need a meaningful surrounding status; decorative animation should be hidden from assistive technology.

For virtualized content, drag-and-drop, canvases, charts, and custom editors, preserve an equivalent semantic path for the task. If the existing product cannot provide full equivalence within the requested scope, implement the safest improvement available and state the remaining limitation precisely.

## Verification

Run the narrowest relevant component and static accessibility checks, then broader project checks in proportion to risk. When browser testing is permitted, verify keyboard order, focus restoration, zoom or reflow, reduced motion, and a representative screen-reader path. Automated scans are useful regression detectors, not proof of usability.

Before finishing, confirm:

1. native roles and names match the visible interaction;
2. keyboard and focus behavior covers open, operate, error, and close paths;
3. states are perceivable without color or motion alone;
4. form errors and async updates are associated and recoverable;
5. no existing contract was changed accidentally;
6. the final report distinguishes static checks from browser or assistive-technology evidence actually run.
