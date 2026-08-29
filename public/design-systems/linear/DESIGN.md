# Linear-inspired Design Reference

> This is an unofficial visual reference inspired by Linear's focused product language. It constrains visual expression only; product requirements, content, behavior, and project architecture remain authoritative. Do not copy Linear logos, proprietary fonts, brand copy, screenshots, illustrations, or other brand assets. Use project-owned assets and the fallback families declared in `tokens.css`. The literal values in `tokens.css` are the source of truth; this document defines how those semantic tokens work together.

## 1. Scope and intent

Use this reference for developer tools, productivity products, issue or project management, command-oriented workflows, and focused SaaS interfaces. It can support a restrained product landing page, but its center of gravity is a working application.

The result should feel precise, quiet, and fast. Density comes from disciplined alignment and compact typography, while generous dark space isolates major regions and prevents the interface from feeling crowded.

## 2. Visual identity

- Treat darkness as the native medium, not as a light theme with inverted colors.
- Build depth with a small set of solid dark surfaces, fine light borders, and controlled luminance changes. Solid `--surface` panels are valid and expected.
- Reserve the indigo accent for primary actions, active navigation, selection, and focused brand moments.
- Use compact, geometric typography with subtle weight differences instead of oversized bold labels.
- Favor calm product screenshots, structured diagrams, issue lists, command palettes, and precise data over decorative illustration.
- Keep motion short and functional; the interface should respond immediately rather than perform.

## 3. Foundations

### Color roles

- `--bg` is the deepest page and workspace canvas. `--surface` is the canonical solid elevated layer; `--surface-warm` remains within the same dark family for nested regions.
- `--fg` carries primary text. Use `--fg-2`, `--muted`, and `--meta` as a deliberate four-step information hierarchy.
- `--border` defines standard containers and controls; `--border-soft` is for row dividers and quieter nested boundaries.
- `--accent` is the primary interactive signal. Use `--accent-hover`, `--accent-active`, and `--accent-on` for complete control states.
- `--success`, `--warn`, and `--danger` communicate state only. Keep them out of decorative backgrounds and general navigation.

### Typography

- Use `--font-display` for major headings and `--font-body` for product text. Use `--font-mono` only for code, shortcuts, identifiers, timestamps, or aligned technical data.
- When the variable family is available, favor weights around 400 for reading, 510 for controls and navigation, and 590 for strong emphasis. With a fallback font, use the nearest supported weights without synthesizing an artificial face.
- Use `--text-base` as the product baseline, `--text-sm` and `--text-xs` for metadata, and `--text-lg` through `--text-4xl` for progressively larger hierarchy.
- Apply `--leading-body` to reading content and `--leading-tight` to display text. Use `--tracking-display` for large headings; smaller text should remain readable rather than aggressively compressed.

### Spacing and shape

- Use the `--space-1` through `--space-12` scale for repeated gaps, padding, and alignment.
- Use `--radius-sm` for controls, `--radius-md` for cards and menus, and `--radius-lg` for dialogs or prominent panels. `--radius-pill` is limited to filters, status chips, and compact metadata.
- Keep product rows compact, but create larger separation between major workspace or marketing sections with the section rhythm tokens.

### Depth and motion

- `--elev-flat` is the default. `--elev-ring` adds precise containment, while `--elev-raised` is reserved for floating menus, command palettes, dialogs, and selected previews.
- A panel may use the solid `--surface` value without transparency. Optional translucent overlays must remain within the same luminance hierarchy and must not replace the canonical solid surface layer.
- Use `--motion-fast` for hover, focus, and press feedback; use `--motion-base` with `--ease-standard` for menus and overlays.
- Avoid page-load choreography, bounce, large scaling, or motion that delays a command.

## 4. Layout and responsive behavior

- Constrain primary content with `--container-max` and the responsive `--container-gutter-desktop`, `--container-gutter-tablet`, and `--container-gutter-phone`.
- Use `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone` for major page rhythm. Product panels can use tighter internal spacing from the shared space scale.
- Wide product layouts may combine a compact sidebar, main work area, and contextual detail panel. Give the main task the largest stable region.
- Collapse secondary panels before hiding primary actions. On narrow screens, move contextual details into sheets or ordered sections while preserving task state.
- Let card and table grids move from multiple columns to one column without changing reading order. Command and search entry points should remain easy to reach.
- Product imagery and diagrams should scale within their containers; simplify decorative layers before reducing text or controls below usable sizes.

## 5. Components and interaction

| Component             | Visual treatment                                                   | Interaction                                                    |
| --------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Primary action        | `--accent` fill with `--accent-on` content and `--radius-sm`       | Use the complete accent state sequence; keep labels concise    |
| Secondary action      | `--surface` or quiet transparent treatment with `--border`         | Increase luminance on hover and show a stable pressed state    |
| Card or panel         | Solid `--surface`, `--border`, and `--radius-md`                   | Use border or luminance change for selection; avoid scale lift |
| Field or search       | Dark surface, quiet border, primary text, muted placeholder        | Show focus, validation, disabled, and read-only states         |
| Navigation row        | Compact body type with muted default and clear active state        | Keep icon and label aligned; preserve a generous hit area      |
| Filter or status chip | Limited `--radius-pill`, compact type, semantic color when needed  | Support removal or selection with an explicit label            |
| Command palette       | `--surface`, `--radius-lg`, and `--elev-raised`                    | Support keyboard traversal, clear active result, and Escape    |
| Dialog or sheet       | Structured raised surface with explicit title and action hierarchy | Contain focus, support Escape, and return focus on close       |

## 6. Accessibility

- Apply `--focus-ring` consistently to keyboard-interactive controls and ensure it remains visible on every dark surface.
- Maintain sufficient contrast for `--muted` and `--meta`; neither should carry essential instructions alone when contrast becomes marginal.
- Keep pointer and touch targets at least 44 by 44 CSS pixels where possible, even when the visible control is compact.
- Pair success, warning, and danger colors with text or icons. Selected and active states also need a non-color cue where ambiguity is possible.
- Respect reduced-motion preferences and remove nonessential transforms and spatial transitions.
- Preserve semantic landmarks, heading order, control names, field labels, status announcements, and predictable keyboard order.

## 7. Implementation checklist

- The current literal values come from `tokens.css`; this document does not override them.
- The design uses a native dark canvas with solid, clearly ordered surface layers.
- Indigo remains limited to meaningful interaction and selection.
- Typography uses the declared fallback stack and remains compact without sacrificing readability.
- Cards, fields, menus, and dialogs use the shared radius, border, elevation, and motion tokens consistently.
- Responsive layouts retain the primary task, current state, command access, and action hierarchy.
- No Linear logo, proprietary font file, brand copy, screenshot, or unlicensed asset has been copied.
