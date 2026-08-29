# IBM-inspired Design Reference

> This is an unofficial visual reference inspired by IBM's structured enterprise language. It constrains visual expression only; product requirements, content, behavior, and project architecture remain authoritative. Do not copy IBM logos, proprietary fonts, brand copy, illustrations, or other brand assets. Use project-owned assets and the fallback families declared in `tokens.css`. The literal values in `tokens.css` are the source of truth; this document defines how those semantic tokens work together.

## 1. Scope and intent

Use this reference for enterprise software, data-heavy products, regulated workflows, technical documentation, and authoritative technology marketing. The interface should feel systematic, legible, and operational rather than decorative.

Product surfaces favor density, explicit hierarchy, and predictable component behavior. Marketing surfaces may use more display type and vertical space, but they keep the same rectangular geometry, blue interaction signal, and neutral surface ladder.

## 2. Visual identity

- Build hierarchy with a white-to-gray surface ladder, strong black typography, and one disciplined blue interaction color.
- Favor rectangular modules, aligned edges, and grid-based composition. Rounded cards are not part of the core language.
- Use background layering and dividers for structure. Reserve shadows for elements that genuinely overlap content.
- Pair light display typography with compact body and technical text to balance authority with clarity.
- Keep imagery purposeful: diagrams, product views, data, or technical photography should explain the subject rather than decorate empty space.

## 3. Foundations

### Color roles

- `--bg` is the page canvas. `--surface` supports cards, tiles, inputs, and alternating sections; `--surface-warm` is the selected or informational tint.
- `--fg` carries headings and primary content. Use `--fg-2`, `--muted`, and `--meta` as a descending information hierarchy.
- `--border` defines controls and strong dividers; `--border-soft` separates rows and nested regions.
- `--accent` is the only general interaction color. Use `--accent-hover` and `--accent-active` for its states and `--accent-on` for content placed on the accent.
- `--success`, `--warn`, and `--danger` are reserved for status and feedback, not decoration.

### Typography

- Use `--font-display` for hero and major section headings, `--font-body` for interface and reading text, and `--font-mono` for code, identifiers, and aligned technical data.
- Prefer weight 300 for large display text, 400 for body text, and 600 for labels or emphasis. Avoid introducing an unrelated bold display voice.
- Build the main scale from `--text-base`, `--text-xl`, `--text-2xl`, `--text-3xl`, and `--text-4xl`. Use `--text-xs`, `--text-sm`, and `--text-lg` for compact product hierarchy.
- Use `--leading-body` for reading and `--leading-tight` for headings. `--tracking-display` is the display baseline.

### Spacing and shape

- Align layouts to the `--space-1` through `--space-12` scale. Repeated component spacing should use these values rather than arbitrary gaps.
- `--radius-sm`, `--radius-md`, and `--radius-lg` intentionally preserve square geometry. Use `--radius-pill` only for compact tags or status labels when their semantics benefit from a capsule.
- Keep buttons, fields, cards, and tiles aligned to shared horizontal and vertical edges.

### Depth and motion

- Use `--elev-flat` for normal content, `--elev-ring` for border-led containment, and `--elev-raised` only for menus, popovers, dialogs, and other overlapping surfaces.
- Use `--motion-fast` for state changes and `--motion-base` for disclosure or overlay transitions, with `--ease-standard`.
- Motion should clarify state or spatial origin. Avoid decorative floating, bounce, parallax, or staggered page-load effects.

## 4. Layout and responsive behavior

- The maximum content width is `--container-max`. Use `--container-gutter-desktop`, `--container-gutter-tablet`, and `--container-gutter-phone` at the corresponding widths rather than substituting a larger framework breakpoint.
- Use a disciplined multi-column grid for wide layouts, typically reserving wider spans for primary content and narrower spans for navigation, filters, or supporting data.
- Use `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone` for page rhythm. Product workflows may use tighter internal spacing without shrinking interactive targets.
- Collapse multi-column data and card layouts progressively. Preserve reading order, labels, actions, and status context when regions stack.
- Allow wide tables and visualizations to scroll or adopt a deliberate compact representation; do not squeeze data until it becomes unreadable.

## 5. Components and interaction

| Component        | Visual treatment                                                      | Interaction                                                      |
| ---------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Primary action   | `--accent` fill, `--accent-on` content, square geometry               | Move through hover and active accent tokens; keep labels direct  |
| Secondary action | Neutral dark or outlined treatment using foreground and border tokens | Preserve equal target size and visible pressed state             |
| Card or tile     | `--surface` fill, aligned edges, little or no shadow                  | Clickable tiles may shift surface value; avoid lift-by-scale     |
| Text field       | `--surface` fill with a strong bottom edge or explicit focus edge     | Show focus, validation, disabled, and read-only states           |
| Navigation       | Compact body text, clear active indicator, grid alignment             | Keep primary destinations visible; collapse into an ordered menu |
| Tag or status    | Compact label using semantic color and limited pill geometry          | Include text or icon meaning in addition to color                |
| Overlay          | Structured header, content, and actions on a raised surface           | Trap focus where appropriate and restore it on close             |

## 6. Accessibility

- Apply `--focus-ring` to every keyboard-interactive control without suppressing the browser focus path.
- Maintain readable contrast across every surface tier, including muted metadata and disabled controls.
- Keep touch targets at least 44 by 44 CSS pixels where space allows; compact visible labels may sit inside larger hit areas.
- Pair semantic colors with text, icons, or patterns. Never make success, warning, or error meaning depend on color alone.
- Respect reduced-motion preferences by removing nonessential transitions and shortening spatial movement.
- Preserve semantic landmarks, heading order, field labels, table headers, and meaningful control names.

## 7. Implementation checklist

- The current literal values come from `tokens.css`; this document does not override them.
- Layout uses `--container-max` and the declared gutter and section tokens.
- Buttons, inputs, cards, and tiles retain the rectangular IBM-inspired geometry.
- Blue is used for interaction; status colors remain semantic and restrained.
- Product density does not reduce readability, keyboard access, or target size.
- Responsive layouts preserve content order, actions, labels, and data context.
- No IBM logo, proprietary font file, brand copy, or unlicensed brand asset has been copied.
