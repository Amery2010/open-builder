# Claude-inspired Design Reference

This is an unofficial visual reference for original interfaces. It constrains presentation only; product behavior, information architecture, and user requirements remain authoritative. Do not copy Claude or Anthropic logos, proprietary typefaces, brand copy, screenshots, illustrations, or other brand assets. The literal values in `tokens.css` are authoritative whenever prose and tokens differ.

## 1. Scope and intent

- Use this direction for AI products, writing tools, research workspaces, calm editorial experiences, and thoughtful service pages.
- The goal is humane clarity: warm materials and literary pacing make complex capabilities feel approachable.
- Product interfaces should remain practical; editorial styling must not obscure controls, status, provenance, or system feedback.
- Marketing and application surfaces share the same warm neutral foundation, restrained terracotta accent, and serif-sans hierarchy.
- High-energy entertainment, neon visuals, and ultra-dense operations consoles need a different reference.

## 2. Visual identity

- Establish a parchment-like ambient canvas rather than a cold white or blue-gray software background.
- Use dark, warm ink and cream-tinted boundaries so every neutral belongs to the same temperature family.
- Pair editorial serif headlines with quiet sans-serif controls to distinguish ideas from actions.
- Reserve terracotta for the highest-value action, selected emphasis, and a few narrative anchors.
- Let layouts feel composed like essays: clear openings, measured sections, and deliberate pauses between ideas.
- Original line art, diagrams, or textured shapes may add warmth when they explain content rather than decorate empty space.
- Use chapter-like light and dark sections sparingly; the transition should signal a real shift in topic or task.

## 3. Foundations

### Color roles

- `--bg` is the warm page canvas; `--surface` is the light reading and card plane.
- `--surface-warm` supports selected controls, subdued callouts, and tactile utility surfaces.
- `--fg`, `--fg-2`, `--muted`, and `--meta` form a warm ink hierarchy from primary reading text to quiet metadata.
- `--border` provides visible containment; `--border-soft` separates nearby content with less weight.
- `--accent` is the terracotta action color, with `--accent-hover` and `--accent-active` for state changes.
- `--success`, `--warn`, and `--danger` must retain their functional meanings and remain visually secondary to content.
- Avoid introducing cool neutral ramps; the cool hue embedded in `--focus-ring` is reserved for unmistakable keyboard focus.

### Typography

- Use the generic serif stack in `--font-display`; never download or emulate a proprietary brand typeface.
- Use `--font-body` for navigation, controls, metadata, and most explanatory copy.
- Use `--font-mono` only for code, model output structure, identifiers, or technical values.
- Headings use `--leading-tight` with regular or medium weight; avoid heavy display bold.
- Reading text uses `--leading-body` and normally starts at `--text-base`.
- Scale from `--text-xs` for metadata to `--text-4xl` for a single hero statement, with restrained intermediate jumps.
- Long prose should stay left aligned, use a comfortable measure, and break into meaningful paragraphs.

### Spacing and shape

- Build local rhythm with `--space-1` through `--space-12`, favoring generous gaps around headings and compact gaps within controls.
- Major chapters use `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone`.
- Use `--radius-sm` for tags and compact controls, `--radius-md` for inputs and cards, and `--radius-lg` for featured media.
- Reserve `--radius-pill` for status chips, segmented choices, and short actions rather than every container.
- Prefer a few broad content planes over deeply nested cards.

### Depth and motion

- `--elev-flat` is standard for reading surfaces.
- `--elev-ring` creates the characteristic fine halo around interactive or selected containers.
- `--elev-raised` is a soft lift for menus, floating composers, and one featured object.
- Motion uses `--motion-fast`, `--motion-base`, and `--ease-standard` for calm fades, small translations, and state transitions.
- Avoid spectacle motion; the interface should feel patient, stable, and ready for sustained reading.

## 4. Layout and responsive behavior

- Center primary content within `--container-max` and use the corresponding gutter token for desktop, tablet, or phone.
- Keep prose columns narrower than the full container while allowing diagrams, comparisons, and product media to expand.
- Use asymmetric editorial layouts when one side carries a clear idea and the other provides evidence or action.
- Product workspaces should prioritize the working surface, with supporting navigation and context panels using quieter contrast.
- Three-column feature groups collapse to two columns before becoming a single readable sequence.
- Below 768px, stack text and media in source order, simplify navigation, and keep task-critical actions visible.
- On phones, use `--section-y-phone`, preserve comfortable paragraph measure, and avoid placing dense controls beside long copy.
- Dark sections should become complete responsive chapters rather than isolated dark cards scattered through a light page.
- Preserve reading order, focus order, and result provenance when panels move or collapse.

## 5. Components and interaction

- Navigation uses warm surfaces, concise labels, and one clearly prioritized action.
- Primary buttons use `--accent` with `--accent-on`; secondary buttons use warm surfaces and `--elev-ring`.
- Cards should contain one coherent idea, task, or comparison and use boundaries lighter than their content hierarchy.
- Inputs need persistent labels, useful examples, visible focus, and nearby validation or privacy guidance.
- Composer and chat surfaces should distinguish user input, generated output, citations, tool activity, and errors without excessive color.
- Tabs and segmented controls use compact geometry and a visible selected state that does not rely on color alone.
- Menus, popovers, and dialogs use `--elev-raised`, manage focus, and close through an explicit control and Escape.
- Tables and model comparisons need meaningful row and column headers, aligned values, and a stacked small-screen alternative.
- Loading states should communicate whether the system is waiting, working, streaming, or blocked.

## 6. Accessibility

- Meet WCAG AA contrast for all reading text, controls, status colors, and inverted sections.
- Every keyboard target receives a visible `--focus-ring` that remains distinct from hover and selected states.
- Preserve at least 44 by 44 CSS pixels for primary touch targets and icon-only controls.
- Pair status color with text, shape, icon, or position so meaning survives color-vision differences.
- Use semantic landmarks, ordered headings, field associations, live regions, and descriptive control names.
- Respect reduced-motion preferences and keep streaming or animated content pausable when it can distract from reading.
- Do not render generated text so quickly that assistive technology loses announcements or the reader loses position.
- Test text reflow, long localized strings, zoom, keyboard-only operation, and screen-reader navigation.

## 7. Implementation checklist

- Import the canonical token file once and use semantic variables rather than copied literals.
- Verify every referenced variable exists in `tokens.css` and no component invents a parallel color or spacing scale.
- Confirm serif and sans roles remain distinct without loading protected fonts.
- Check warm-neutral consistency across default, hover, selected, disabled, loading, and error states.
- Verify the primary action is scarce, clear, and supported by nearby explanatory copy.
- Test prose measure, heading wrap, panel collapse, and task continuity at desktop, tablet, and phone widths.
- Exercise keyboard focus, reduced motion, zoom, screen-reader announcements, and touch targets.
- Confirm citations, provenance, privacy notices, and system status stay legible in AI-oriented experiences.
- Replace all placeholder brand references and assets with original product content before release.
- Keep functional behavior unchanged unless the product request explicitly authorizes a behavior change.
