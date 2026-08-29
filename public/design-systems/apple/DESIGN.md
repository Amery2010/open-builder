# Apple-inspired Design Reference

This is an unofficial visual reference for original interfaces. It constrains presentation only; product behavior, information architecture, and user requirements remain authoritative. Do not copy Apple logos, proprietary typefaces, brand copy, screenshots, illustrations, or other brand assets. The literal values in `tokens.css` are authoritative whenever prose and tokens differ.

## 1. Scope and intent

- Use this direction for premium product launches, focused hardware stories, elegant consumer tools, and image-led feature pages.
- The goal is calm precision: a quiet interface frames one clear product idea at a time.
- Marketing and transaction surfaces may differ in density, but they must share one neutral palette, type scale, and interaction language.
- Original product imagery should carry the expressive weight; interface chrome stays restrained.
- Dense administration, data exploration, and highly decorative campaigns need a different reference.

## 2. Visual identity

- Build a gallery-like sequence of white, pale-gray, and occasional near-black scenes.
- Alternate broad showcase chapters with compact information sections instead of repeating identical cards.
- Give hero media generous scale and clean edges; avoid decorative frames that compete with the subject.
- Reserve saturated color for actions, links, focus, and meaningful status.
- Favor centered compositions for launches and disciplined left alignment for specifications or commerce.
- Use short, concrete copy with a strong headline, a compact explanation, and no more actions than the decision requires.
- Keep icons thin, geometric, and subordinate to text; use original symbols rather than recognizable brand marks.

## 3. Foundations

### Color roles

- `--bg` is the default retail and reading canvas; `--surface` creates pale feature bands and cards.
- `--surface-warm` provides a near-white intermediate step for subtle chapter changes.
- `--fg` carries primary text, while `--fg-2`, `--muted`, and `--meta` form a controlled neutral hierarchy.
- `--border` defines fields and compact panels; `--border-soft` separates rows without creating boxes everywhere.
- `--accent` is the sole persistent action color. Use `--accent-hover` and `--accent-active` for its interaction states.
- `--success`, `--warn`, and `--danger` are functional signals, not decorative accents.
- Dark chapters may invert the neutral hierarchy, but actions must retain an unmistakable interactive role.

### Typography

- Use `--font-display` and `--font-body` as system-first sans-serif stacks; do not download or imitate a proprietary face.
- Display text uses `--leading-tight` and `--tracking-display` for compact, machined headlines.
- Body copy uses `--leading-body` and should remain comfortably readable at `--text-base`.
- Map utility labels to `--text-xs` or `--text-sm`; reserve `--text-3xl` and `--text-4xl` for true chapter anchors.
- Use medium or semibold emphasis selectively; hierarchy should come primarily from scale and spacing.
- Keep long-form text to a readable measure and avoid centered paragraphs longer than a few lines.

### Spacing and shape

- The spacing rhythm follows the `--space-1` through `--space-12` scale, with deliberate jumps between compact controls and broad sections.
- Apply `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone` to major chapter boundaries.
- Use `--radius-sm` for compact controls, `--radius-md` for fields and standard cards, and `--radius-lg` for image-led modules.
- `--radius-pill` is reserved for concise actions, segmented choices, and circular icon controls.
- Prefer open composition over nested containers; one clear surface boundary is usually enough.

### Depth and motion

- `--elev-flat` is the default. Tonal contrast and imagery create most of the depth.
- Use `--elev-ring` for precise containment and `--elev-raised` only for a genuinely floating card or overlay.
- Transitions use `--motion-fast`, `--motion-base`, and `--ease-standard`; they should settle smoothly without bounce.
- Hover may shift color or elevation slightly, while press feedback should feel immediate and controlled.
- Large entrance animation, parallax, glow, and persistent motion are outside this reference.

## 4. Layout and responsive behavior

- Center the main content within `--container-max` and use the matching container gutter token at each viewport tier.
- Full-bleed background chapters may extend beyond the container while text and controls remain aligned to its grid.
- On wide screens, pair concise text with dominant media or use a centered billboard composition.
- Commerce and specification sections may use two or three columns when each column has a distinct scanning role.
- Below 1024px, reduce display scale and collapse secondary columns before compressing readable spacing.
- Below 768px, stack narrative modules, keep the primary action near its supporting copy, and simplify navigation.
- On phones, preserve image centrality, use `--section-y-phone`, and avoid edge-to-edge text.
- Reorder content only when reading order, keyboard order, and visual order remain consistent.
- Give comparison tables and option groups a deliberate small-screen pattern rather than horizontal clipping by default.

## 5. Components and interaction

- Navigation is compact, low-contrast, and stable; the current destination and primary action remain obvious.
- Primary buttons use `--accent` with `--accent-on`; neutral secondary actions use a border or dark fill according to the surrounding scene.
- Keep button labels short and use pill geometry only when the control has enough horizontal padding to remain balanced.
- Cards are image-first or content-first, not decorative shells. Use a single surface, purposeful radius, and minimal elevation.
- Inputs use visible labels, clear borders, concise help text, and an error message adjacent to the affected field.
- Product choices should expose selection, price, availability, and consequences without relying on color alone.
- Carousels require visible controls, position feedback, keyboard support, and a non-carousel fallback for essential content.
- Dialogs and menus need a clear title, close path, focus management, Escape support, and touch-friendly targets.
- Loading, empty, success, and failure states should preserve the same calm hierarchy as the default state.

## 6. Accessibility

- Maintain WCAG AA contrast for body text, controls, links, and semantic states across light and dark scenes.
- Every keyboard target uses a visible `--focus-ring` or an equally clear outline that is not clipped.
- Keep interactive targets at least 44 by 44 CSS pixels when space permits, especially for circular controls.
- Provide descriptive alternative text for informative media and empty alternatives for decoration.
- Do not place essential copy inside images or depend on animation to explain a feature.
- Respect reduced-motion preferences by removing transforms and shortening nonessential transitions.
- Preserve semantic headings, landmarks, form associations, error announcements, and logical tab order.
- Validate text reflow at 200 percent zoom and ensure large headlines do not obscure actions.

## 7. Implementation checklist

- Import the canonical token file once and consume semantic variables instead of duplicating values.
- Verify every referenced variable exists in `tokens.css` and that no component creates a competing token namespace.
- Confirm the page has one dominant message and a clear primary action at each major stage.
- Check neutral section rhythm, media priority, readable line length, and purposeful corner-radius tiers.
- Exercise hover, active, focus, disabled, loading, empty, and error states with keyboard and pointer input.
- Test representative desktop, tablet, and phone widths without hidden essential content.
- Test light and dark chapters for contrast, focus visibility, and media legibility.
- Verify reduced motion, zoom, screen-reader names, and touch target size.
- Replace all placeholder brand references and assets with original product content before release.
- Keep functional behavior unchanged unless the product request explicitly authorizes a behavior change.
