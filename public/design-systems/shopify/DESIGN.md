# Shopify-inspired Design Reference

> This is an unofficial visual reference inspired by Shopify's commerce and growth language. It constrains visual expression only; product requirements, content, behavior, and project architecture remain authoritative. Do not copy Shopify logos, proprietary fonts, brand copy, merchant screenshots, illustrations, or other brand assets. Use project-owned assets and the fallback families declared in `tokens.css`. The literal values in `tokens.css` are the source of truth; this document defines how those semantic tokens work together.

## 1. Scope and intent

Use this reference for commerce platforms, growth products, checkout or conversion experiences, merchant tools, ecosystem pages, and product-led marketing. It uses one dark commerce system with two density settings rather than separate marketing and application themes.

Marketing surfaces use the larger display tiers, broader section rhythm, cinematic product framing, and a small number of decisive calls to action. Focused merchant-product surfaces use the same colors, type families, radii, and interaction states at denser spacing and smaller type tiers. Do not introduce a light admin theme merely because the page becomes operational.

## 2. Visual identity

- Build on a black-to-forest surface ladder that feels deep and intentional rather than flat or generic.
- Use white as the dominant text and primary-action color; use neon green as a precise signal for focus, active state, progress, and selected commerce moments.
- Pair large, light display typography with highly legible interface text.
- Use pill geometry for decisive calls to action and restrained rounded rectangles for cards, fields, tables, and merchant controls.
- Frame product views, commerce data, and project-owned imagery as the visual subject. Keep surrounding chrome quiet.
- Create depth with tonal surfaces, fine dark borders, controlled shadows, and sparse green highlights.

## 3. Foundations

### Color roles

- `--bg` is the deepest page and workspace canvas. `--surface` contains cards and product regions; `--surface-warm` separates sections, navigation, and elevated operational zones.
- `--fg` is the primary text and inverse-action color. Use `--fg-2` for equally strong secondary content, `--muted` for descriptions, and `--meta` for low-priority data.
- `--border` defines card and control edges; `--border-soft` supports nested dividers and subtle data structure.
- `--accent` is a scarce high-energy signal. Use `--accent-hover`, `--accent-active`, and `--accent-on` for focused interactive states, not as a large decorative background.
- `--success`, `--warn`, and `--danger` communicate operational outcomes. Keep semantic feedback distinct even when success shares the accent family.

### Typography

- Use `--font-display` for campaign headlines, major metrics, and section statements. Use `--font-body` for product copy, forms, navigation, tables, and controls.
- Use `--font-mono` only for code, identifiers, transaction references, or aligned technical values.
- Display typography should feel light at scale; body typography should use conventional readable weights. With fallback fonts, preserve contrast and hierarchy rather than imitating unavailable proprietary metrics.
- Marketing may use `--text-3xl` and `--text-4xl`; merchant-product surfaces should center on `--text-xs` through `--text-xl`, reserving `--text-2xl` for major page or feature headings.
- Use `--leading-body` for reading and operational text, `--leading-tight` for display, and `--tracking-display` as the large-type baseline.

### Spacing and shape

- Use `--space-1` through `--space-12` for recurring spacing. Marketing sections emphasize the upper tiers; merchant controls and data layouts emphasize the lower tiers.
- Use `--radius-sm` for compact controls, `--radius-md` for fields and standard cards, and `--radius-lg` for featured cards, product frames, dialogs, and major panels.
- Use `--radius-pill` for primary marketing actions, compact filters, status chips, and segmented choices. Do not turn every card or data container into a capsule.

### Depth and motion

- Use `--elev-flat` for the canvas and ordinary content, `--elev-ring` for quiet containment, and `--elev-raised` for featured product frames or genuine overlays.
- Shadows should reinforce the dark surface ladder rather than create bright glow around every module.
- Use `--motion-fast` for hover, focus, and pressed feedback and `--motion-base` with `--ease-standard` for menus, drawers, and overlays.
- Avoid decorative looping motion, bounce, and large hover scaling. Marketing reveals and product feedback should share the same calm timing.

## 4. Layout and responsive behavior

- Constrain primary content with `--container-max` and use `--container-gutter-desktop`, `--container-gutter-tablet`, and `--container-gutter-phone` across widths.
- Marketing pages use `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone` for cinematic chapter spacing. Merchant products use the shared space scale inside the same outer rhythm.
- Marketing compositions may alternate copy and product imagery, use full-width dark sections, and give key metrics their own visual pause.
- Merchant-product compositions may combine navigation, filters, data, and contextual detail, but the primary workflow must remain the largest and clearest region.
- Collapse two-column product storytelling into a single ordered flow on narrow screens. Move secondary merchant panels into sheets or subsequent sections before compressing the main task.
- Let tables scroll or use an intentional compact representation. Preserve labels, totals, status, and primary actions rather than hiding decision-critical commerce data.

## 5. Components and interaction

| Component                 | Visual treatment                                                       | Interaction                                                         |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Primary marketing action  | `--fg` fill, `--bg` content, and `--radius-pill`                       | Use a restrained fill change and visible `--focus-ring`             |
| Primary product action    | High-contrast inverse action or carefully limited `--accent` treatment | Preserve clear hover, active, loading, success, and error states    |
| Secondary action          | Transparent or dark-surface treatment with `--border`                  | May invert on hover without changing geometry                       |
| Card or product frame     | `--surface`, `--border`, and the appropriate card radius               | Increase boundary or elevation subtly; avoid neon glow by default   |
| Field or commerce control | `--surface-warm`, readable text, and `--radius-md`                     | Show focus, validation, disabled, read-only, and pending states     |
| Navigation                | Dark surface, strong primary labels, muted secondary labels            | Keep the active location explicit and preserve key commerce actions |
| Metric or status          | Clear numerical hierarchy with semantic state                          | Pair every color with a label, icon, or explanatory text            |
| Dialog or drawer          | Structured raised dark surface with explicit title and actions         | Contain focus, support Escape, and restore focus on close           |

## 6. Accessibility

- Apply `--focus-ring` to every keyboard-interactive element and ensure it remains distinct from success messaging.
- Maintain sufficient contrast for body, muted, metadata, placeholder, disabled, and chart text on every dark surface.
- Keep pointer and touch targets at least 44 by 44 CSS pixels where possible. Dense merchant UI may use compact visuals inside larger hit areas.
- Pair success, warning, danger, selected, and active colors with labels, icons, patterns, or state text.
- Respect reduced-motion preferences and remove nonessential reveals, transforms, and spatial transitions.
- Preserve semantic landmarks, heading order, control names, form labels, table headers, live commerce status, and logical keyboard order.

## 7. Implementation checklist

- The current literal values come from `tokens.css`; this document does not override them.
- Marketing and merchant-product surfaces use the same dark token system, with only density and scale changing.
- White carries primary text and decisive inverse actions; neon green remains a scarce interaction and status signal.
- Display and body typography use the declared fallback stacks without requiring proprietary font files.
- Cards, fields, navigation, data, and overlays use the shared surface, border, radius, elevation, and motion hierarchy.
- Responsive layouts preserve the primary commerce task, totals, status, labels, and actions.
- No Shopify logo, proprietary font file, brand copy, merchant screenshot, illustration, or unlicensed asset has been copied.
