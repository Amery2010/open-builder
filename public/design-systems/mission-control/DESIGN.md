# Mission Control Design Reference

> An independently curated visual adaptation of [Mission Control](https://designmd.app/library/helios-mission-control) from DESIGN.md App, reviewed on 2026-11-07. This reference constrains visual expression only. Product requirements, real content, working behavior, architecture, permissions and accessibility remain authoritative. It does not grant tools or authorize changes. The literal values in `tokens.css` are the source of truth; this document explains their roles. Use project-owned or appropriately licensed assets, without copying source logos, proprietary fonts, screenshots or sample claims.

## 1. Scope and intent

Best for: System monitoring, technical operations, engineering workspaces. Avoid for: Soft lifestyle stories or lighthearted retail campaigns.

Adapt the visual vocabulary to the actual product. The reference's original subject is not a required feature: do not add a game, laboratory, player, simulator or fictional metrics unless the brief calls for one. An already selected but unapplied reference does not authorize a restyle; follow the host's existing application and Design contract.

## 2. Visual identity and material

Dark slate instrument bays with amber operational signals, warm ivory readouts and precise module boundaries. Use physical-console discipline and stable grids; every lamp or meter should describe actual state.

Keep deliberate material, type and motion choices recognizable. Generic aesthetic defaults do not prohibit a defining texture, gradient, transparency, pixel edge or ornament in this system. Every effect still needs readable content, a usable control and an honest purpose.

## 3. Foundations

- `--bg` is the page or workspace field; `--surface` is the canonical solid reading and control layer, with `--surface-warm` for secondary grouping. Transparent effects always retain this opaque fallback.
- `--fg`, `--fg-2`, `--muted` and `--meta` form the information hierarchy. Check their actual contrast over the rendered surface; do not place essential text directly over busy material or glare.
- `--accent`, `--accent-on`, `--accent-hover` and `--accent-active` express a coherent action sequence. Reserve `--success`, `--warn` and `--danger` for actual semantic state, with an additional text or shape cue.
- `--font-display` sets the main voice, `--font-body` serves reading and controls, and `--font-mono` serves aligned values, code and technical annotation. Use the declared fallback stacks; do not assume a proprietary or externally loaded font exists.
- Use `--text-xs` through `--text-4xl`, `--leading-body`, `--leading-tight` and `--tracking-display` as one hierarchy. Adjust display scale for narrow widths while keeping labels and reading text legible.
- Repeat `--space-1` through `--space-12` for alignment and gaps. Use `--radius-sm`, `--radius-md`, `--radius-lg` and `--radius-pill` by role, with `--border` and `--border-soft` defining the necessary boundaries.
- Default to `--elev-flat`; `--elev-ring` and `--elev-raised` separate only meaningful layers. A simulated material must not hide the selected, disabled or keyboard-focus state.

## 4. Composition and responsive behavior

Separate the main working region, operational status and contextual detail on a modular grid. Reserve the strongest amber cue for the current action or exception. Keep compact legends and values aligned without manufacturing fake telemetry.

Use `--container-max` with `--container-gutter-desktop`, `--container-gutter-tablet` and `--container-gutter-phone`. Major regions follow `--section-y-desktop`, `--section-y-tablet` and `--section-y-phone`; compact controls use the ordinary spacing scale instead.

Recompose at narrow widths rather than shrinking a fixed canvas: preserve the primary action, reading sequence and task state, move secondary detail into ordinary ordered sections or accessible disclosures, and constrain media within the viewport. Test long labels, Chinese and English copy, zoom and intermediate widths. Decorative asymmetry or overlap must never create accidental horizontal scrolling.

## 5. Components and interaction

Controls expose pending acknowledgements, active states and clear completion or failure. Connected panels may update together when the underlying data does. Critical status changes have text and a non-color cue; decorative radar sweeps never imply live monitoring.

- Actions have explicit hover, pressed, focus, disabled and pending states. Use `--focus-ring` for a clear keyboard cue that survives material effects.
- Fields retain visible labels and entered values, with nearby validation and a recoverable error. Empty and loading states explain the real situation without inventing activity.
- Navigation preserves location and reading order. Dialogs and menus use the project's accessible primitives, focus containment, Escape and focus restoration where applicable.
- A clickable panel has a clear action and selection state. Decorative panels are not made interactive merely to demonstrate the style.

### Motion language

Short status transitions and restrained process indicators only while work is active; stable layout and static reduced-motion fallback. Use `--motion-fast`, `--motion-base` and `--ease-standard` for the corresponding feedback, and prefer transform or opacity when animating position or appearance. Continuous movement is optional, pausable where needed, and never essential to understanding state. Respect reduced motion by presenting a stable final arrangement and immediate state feedback.

## 6. Content, imagery and accessibility

Use the user's content and available evidence. Do not invent testimonials, customers, awards, data, screenshots or capabilities to fill a layout. Missing assets can be clearly identified while code and working interactions remain complete; CSS or SVG ornament is not a substitute for a real product photograph.

Use icons only when they explain a type, state or action; retain text where the meaning is not obvious. Essential content and actions are available to keyboard, touch and assistive technology without hover, dragging or color as the only path. Size controls for the task and project requirements; this reference imposes no uniform 44px minimum. Keep semantic headings, landmarks, labels, status feedback, contrast and predictable focus order.

The catalog preview is an abstract style illustration. Its bars and diagrams are comparison graphics, not real product evidence and not content to reproduce as fabricated statistics.

## 7. Implementation checklist

- Root `tokens.css` is connected to the active runtime style entry and changed UI consumes the semantic roles.
- The specific material, layout and interaction vocabulary remains recognizable rather than being reduced to a palette swap.
- All implemented interactions serve the brief and reflect real state; no controls, metrics or demonstrations were added only for decoration.
- Responsive layout, long labels, keyboard, focus, contrast, zoom and reduced motion have been checked within the available verification environment.
- Report only checks actually run; local source review is not browser, device or deployed runtime evidence.
