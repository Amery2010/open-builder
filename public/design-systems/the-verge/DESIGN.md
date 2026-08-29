# The Verge-inspired Design Reference

This is an unofficial visual reference for creating original technology-editorial experiences. It constrains visual decisions only; it does not change product requirements, behavior, data, permissions, editorial policy, or content strategy. Do not copy The Verge logos, proprietary typefaces, brand copy, article text, photography, illustrations, interface screenshots, or other protected assets. Recreate the broad Manuka-like condensed display, PolySans-like grotesk, and mono editorial roles only with licensed or system substitutes. `tokens.css` is the literal-value authority; this document defines how those values should be used.

## 1. Scope and intent

Use this reference for technology publications, culture reporting, reviews, opinion, launch coverage, and editorial products that need a strong point of view. The system combines a `#131313` canvas, acid-mint action color, ultraviolet feature surfaces, oversized condensed headlines, mono metadata, and assertive spatial rhythm.

The result should feel edited rather than chaotic. Color, scale, and geometry establish story priority, while reading surfaces remain legible and predictable. It is a poor fit for restrained enterprise administration, compliance-heavy workflows, or products where quiet neutrality is the primary trust signal.

## 2. Visual identity

- `--bg` is the persistent deep canvas. `--surface` creates neutral editorial modules, while `--surface-warm` is the ultraviolet secondary accent for a small number of featured stories or campaign moments.
- `--accent` is acid mint and identifies primary actions, selected navigation, focus, and high-value editorial signals. Never use it as a low-contrast background wash.
- Build hierarchy through dramatic scale contrast: condensed display headlines, sturdy grotesk body and interface text, and compact mono labels with deliberate tracking.
- Use large, confident corner geometry on feature cards and image-led modules. Small controls remain precise; not every element becomes a pill.
- Favor solid color fields, hard crops, decisive rules, and original editorial imagery. Avoid soft pastel gradients, glassmorphism, generic dashboard cards, and decorative shadows without structural purpose.

## 3. Foundations

### Color roles

`--fg` is the primary headline and body color; `--fg-2` supports secondary emphasis. Use `--muted` for descriptions and `--meta` for section labels, timestamps, and category markers. `--border` defines strong editorial divisions, while `--border-soft` separates dense lists and supporting content.

Primary actions use `--accent` and `--accent-on`, followed by `--accent-hover` and `--accent-active`. The ultraviolet value lives in `--surface-warm` and should be treated as a secondary accent surface, not a general page background. Reserve `--success`, `--warn`, and `--danger` for actual status meaning.

### Typography

`--font-display` represents the Manuka-like role: tall, condensed, emphatic, and limited to large headlines or short campaign statements. `--font-body` represents the PolySans-like role for navigation, decks, article summaries, controls, and readable body copy. `--font-mono` handles categories, timestamps, live labels, specifications, and compact metadata. Use only licensed substitutes from the token stacks.

Use `--text-xs` and `--text-sm` for mono metadata, `--text-base` and `--text-lg` for reading, and `--text-xl` through `--text-4xl` for increasingly dominant editorial headlines. Pair `--leading-body` with prose and `--leading-tight` with display text. Apply `--tracking-display` only to large condensed headlines; mono labels need their own positive letter spacing in component styles.

### Spacing and shape

Use `--space-1` through `--space-12` to create sharp contrast between dense metadata and generous story separation. Lists may be compact, but feature stories need enough space for headline rhythm and imagery.

`--radius-sm` serves buttons and compact controls, `--radius-md` serves ordinary story cards, and `--radius-lg` gives feature modules their unmistakable large geometry. `--radius-pill` is reserved for short category filters, status capsules, and circular icon controls.

### Depth and motion

Most content uses `--elev-flat`; hierarchy comes from color fields, borders, crop, and scale. Use `--elev-ring` for selected or bounded modules and `--elev-raised` sparingly for menus, dialogs, and high-priority floating media.

Use `--motion-fast` for hover, underline, and pressed feedback and `--motion-base` for menus, story disclosure, and media transitions. Apply `--ease-standard` consistently. Motion should be brisk and editorial; avoid floating card lifts, elastic motion, or long cinematic transitions in reading paths.

## 4. Layout and responsive behavior

Use `--container-max` with `--container-gutter-desktop`, `--container-gutter-tablet`, or `--container-gutter-phone`. Apply `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone` to major editorial bands.

Desktop compositions may mix a dominant lead story, a narrow story stream, secondary tiles, and full-width color fields. Maintain one obvious lead and avoid equal-weight card walls. Align headlines, metadata rails, and image edges to a shared grid even when modules span different column counts.

At tablet widths, collapse peripheral story rails before reducing headline character. On phones, move to a strong single-column sequence, keep category and timestamp near their story, and preserve full-width feature color. Scale `--text-4xl` down through the declared type ladder rather than clipping or forcing horizontal scroll. Touch targets remain at least 44px.

## 5. Components and interaction

- The masthead pairs a distinctive original wordmark treatment with restrained navigation; it must not reproduce the source logo.
- Lead stories combine one dominant headline, a concise deck, essential metadata, and original imagery. Do not bury the primary story inside nested cards.
- Story-stream rows use mono metadata, a clear headline, a visible divider, and an explicit hover and focus state.
- Feature cards may use `--surface-warm` or `--accent` as solid fields, but text contrast and action hierarchy must remain clear.
- Buttons use the complete accent state sequence. Neutral controls sit on `--surface` and do not compete with editorial color fields.
- Category filters show one current value and remain keyboard operable. Pills should be short and functional, never decorative labels on every card.
- Article pages prioritize readable measure, stable heading hierarchy, captions, related-story boundaries, and persistent but unobtrusive sharing or save actions.
- Loading placeholders preserve headline, image, and row geometry. Empty and error states use direct editorial language and a useful next action.

## 6. Accessibility

Use `--focus-ring` on every keyboard-focusable element. Verify white, muted, acid-mint, and ultraviolet combinations at the actual text size and weight. Never communicate live, selected, sponsored, warning, or error state by color or uppercase styling alone.

Maintain semantic heading order despite visual scale changes. Provide accessible names for icon controls, alt text or captions for meaningful media, transcript support where relevant, and keyboard access for navigation, filters, galleries, media, menus, and dialogs. Respect reduced motion and user zoom; condensed display text must reflow before it becomes unreadable.

## 7. Implementation checklist

- Load `tokens.css` once and use its semantic values instead of introducing alternate mint, ultraviolet, or charcoal values.
- Preserve the `#131313` canvas, acid-mint primary accent, ultraviolet secondary surface, and three-role typography hierarchy.
- Use licensed font substitutes and original logos, copy, illustrations, photography, and story data.
- Keep one dominant editorial priority per viewport and avoid uniform dashboard-card layouts.
- Verify large-radius feature modules, compact controls, focus, hover, active, disabled, loading, empty, and error states.
- Test headline reflow, story ordering, image crops, localization, keyboard use, touch targets, contrast, zoom, and reduced motion.
- Preserve application behavior, editorial data, and permissions; this reference changes presentation only.
