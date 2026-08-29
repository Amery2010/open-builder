# GitHub-inspired Design Reference

This is an unofficial visual reference for original interfaces. It constrains presentation only; product behavior, information architecture, and user requirements remain authoritative. Do not copy GitHub logos, proprietary typefaces, brand copy, screenshots, icon sets, illustrations, or other brand assets. The literal values in `tokens.css` are authoritative whenever prose and tokens differ.

## 1. Scope and intent

- Use this direction for developer platforms, repository tools, technical dashboards, automation consoles, and review-heavy workflows.
- The goal is dependable density: users should scan many precise states and actions without decorative friction.
- Product structure, permissions, auditability, and recovery matter more than marketing spectacle.
- Public-facing pages may open the spacing while retaining system typography, explicit borders, and technical clarity.
- Luxury storytelling, image-led campaigns, and soft lifestyle products need a different reference.

## 2. Visual identity

- Build with neutral canvases, rectangular regions, hairline borders, and compact vertical rhythm.
- Make information density intentional through alignment, grouping, and typography rather than tiny unreadable text.
- Use blue for navigation and primary interaction, green for constructive or successful states, and red for destructive or failed states.
- Let code, diffs, logs, checks, and metadata provide the visual texture.
- Favor familiar system controls and straightforward language over novelty.
- Use original geometric icons with consistent stroke, baseline, and size; meaning should remain clear without the icon.
- Keep elevation rare so menus and overlays stand out against otherwise flat panes.

## 3. Foundations

### Color roles

- `--bg` is the default canvas and `--surface` is the secondary panel, table header, or inset region.
- `--surface-warm` provides a slightly stronger neutral step for selected or deeply grouped content.
- `--fg`, `--fg-2`, `--muted`, and `--meta` create a readable hierarchy for titles, descriptions, paths, timestamps, and counters.
- `--border` defines major panes and controls; `--border-soft` separates rows inside a shared container.
- `--accent` handles links, focus-adjacent interaction, and primary navigation, with `--accent-hover` and `--accent-active` for state.
- `--success`, `--warn`, and `--danger` are reserved for workflow meaning and must be paired with text or icons.
- Large status-tinted surfaces should remain pale enough that foreground text keeps strong contrast.

### Typography

- Use the system stack in `--font-display` and `--font-body` for fast, platform-native rendering.
- Use `--font-mono` for code, diffs, hashes, commands, logs, and fixed-width technical values.
- Default product copy may use `--text-sm`; `--text-base` supports longer explanations and less dense surfaces.
- Reserve `--text-3xl` and `--text-4xl` for page or marketing anchors, not ordinary panel headings.
- Headings use `--leading-tight`; prose and row descriptions use `--leading-body`.
- Apply `--tracking-display` only at larger sizes and keep small technical text at normal tracking.
- Use regular weight for most content and semibold for headings, selected labels, and decisive values.

### Spacing and shape

- Use the `--space-1` through `--space-12` scale, with compact row gaps and larger separation between unrelated regions.
- Major public-facing sections use `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone`.
- `--radius-sm` fits compact controls, `--radius-md` fits fields and panels, and `--radius-lg` fits larger callouts or dialogs.
- `--radius-pill` is for labels, status chips, filters, and counters rather than general card geometry.
- Prefer shared bordered groups over a separate rounded card for every row.

### Depth and motion

- `--elev-flat` is the default for pages, panes, and tables.
- `--elev-ring` reinforces focused or selected containment without adding visual weight.
- `--elev-raised` is limited to menus, popovers, dialogs, and drag surfaces.
- Motion uses `--motion-fast`, `--motion-base`, and `--ease-standard` for quick disclosure and state feedback.
- Avoid page-load choreography, parallax, or animation that delays access to technical content.

## 4. Layout and responsive behavior

- Center broad pages within `--container-max` and apply the matching container gutter token at each viewport tier.
- Product layouts may combine a stable sidebar, primary work pane, and contextual details pane.
- Align repeated rows to consistent columns so names, states, owners, timestamps, and actions scan vertically.
- Place page-level actions near the heading and row-level actions inside the row they affect.
- Below 1012px, collapse or overlay secondary navigation before compressing the primary content.
- Below 768px, stack split panes, convert wide action groups into menus, and keep the current context visible.
- Tables need a responsive strategy: prioritized columns, expandable rows, or structured cards with preserved labels.
- On phones, use `--section-y-phone`, maintain readable code wrapping or controlled scrolling, and avoid fixed desktop widths.
- Keep breadcrumbs, filters, pagination, selection, and unsaved state stable when the layout changes.

## 5. Components and interaction

- Navigation is compact, explicit, and anchored by clear current-location styling.
- Primary interaction uses `--accent` with `--accent-on`; constructive actions may use `--success` only when the meaning is truly constructive.
- Default buttons use a neutral surface, visible border, concise label, and clear hover or pressed response.
- Destructive buttons use `--danger`, require unambiguous wording, and add confirmation when recovery is difficult.
- Inputs expose persistent labels, constraints, validation, and monospace treatment when the value is technical.
- Lists and tables use shared boundaries, consistent row height, row focus, and actions discoverable by keyboard.
- Status chips combine color with a text label or icon and use `--radius-pill`.
- Code and diff views preserve line structure, selectable text, accessible annotations, and horizontal overflow when wrapping would corrupt meaning.
- Menus and dialogs use `--elev-raised`, manage focus, support Escape, and return focus to their trigger.
- Loading, queued, running, passed, failed, empty, and permission-denied states must be visibly distinct.

## 6. Accessibility

- Meet WCAG AA contrast for text, links, borders that convey state, controls, and semantic colors.
- Apply `--focus-ring` to every keyboard target and keep it visible against both default and tinted surfaces.
- Provide at least 44 by 44 CSS pixels for important touch targets, even when the visible control is compact.
- Never encode workflow state solely through red, green, or purple; include readable labels and accessible names.
- Use semantic tables, lists, headings, landmarks, form labels, status regions, and error summaries.
- Preserve keyboard access to row actions, disclosure controls, code annotations, menus, and pagination.
- Respect reduced motion and avoid stealing focus when background work completes.
- Test zoom, text reflow, long paths, localization, screen-reader navigation, and high-contrast modes.

## 7. Implementation checklist

- Import the canonical token file once and use semantic variables instead of copied literals.
- Verify every referenced variable exists in `tokens.css` and no component introduces an incompatible local scale.
- Confirm dense layouts remain scannable through alignment, headings, grouping, and sufficient line height.
- Exercise hover, active, selected, disabled, loading, success, warning, failure, and permission states.
- Test list, table, code, diff, filter, pagination, menu, and dialog keyboard behavior.
- Test representative wide, medium, and phone layouts without losing context or actions.
- Verify focus visibility, semantic structure, reduced motion, zoom, screen-reader names, and touch targets.
- Confirm destructive actions communicate scope, consequences, and recovery.
- Replace all placeholder brand references and assets with original product content before release.
- Keep functional behavior unchanged unless the product request explicitly authorizes a behavior change.
