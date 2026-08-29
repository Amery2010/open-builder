# Stripe-inspired Design Reference

This is an unofficial visual reference for creating original technical and financial interfaces. It constrains visual decisions only; it does not change product requirements, behavior, data, permissions, compliance obligations, or content strategy. Do not copy Stripe logos, proprietary typefaces, brand copy, illustrations, interface screenshots, or other protected assets. Use licensed or system substitutes and original content. `tokens.css` is the literal-value authority; this document defines the roles and relationships those values should express.

## 1. Scope and intent

Use this reference for fintech, infrastructure, analytics, API, billing, and conversion experiences that need to make complex systems feel clear and trustworthy. The visual voice combines a bright technical canvas, compact precision, generous explanatory space, and one saturated violet action color.

The system should communicate capability without looking institutional. Product evidence, exact labels, useful diagrams, and clear state feedback matter more than decorative spectacle. It is less suitable for quiet literary publishing, playful children's products, or image-only campaigns.

## 2. Visual identity

- Use `--bg` as the page canvas, `--surface` for primary cards and forms, and `--surface-warm` for soft technical sections, examples, and secondary bands.
- Reserve `--accent` for decisive actions, active navigation, key links, and focused data emphasis. Do not flood large areas with violet.
- Create depth through pale layer shifts, precise borders, restrained shadows, and occasional original abstract geometry. Avoid glass panels, glossy gradients, and decorative crypto imagery.
- Pair large, tightly tracked headings with plain explanatory copy and compact technical metadata. The result should feel confident, exact, and readable rather than futuristic for its own sake.
- Use asymmetry selectively in marketing layouts, but keep forms, tables, pricing, and dashboards rigorously aligned.

## 3. Foundations

### Color roles

`--fg` carries primary headings and critical values; `--fg-2` supports labels and emphasized body copy. Use `--muted` for descriptions and `--meta` for timestamps, code annotations, and tertiary details. `--border` defines inputs and cards; `--border-soft` creates low-contrast grouping without adding another container.

Primary controls use `--accent` with `--accent-on`, followed by `--accent-hover` and `--accent-active`. Apply `--success`, `--warn`, and `--danger` only to validated status meaning. Never use semantic colors as generic decoration, especially in financial or compliance-sensitive flows.

### Typography

Use `--font-display` for hero statements, section titles, and high-value metrics. Use `--font-body` for product copy, navigation, forms, and tables. Use `--font-mono` for code, request identifiers, command examples, and aligned technical values. The stacks are broadly available substitutes, not proprietary brand fonts.

`--text-xs` and `--text-sm` serve metadata and compact controls; `--text-base` and `--text-lg` support reading; `--text-xl` through `--text-4xl` build a controlled display hierarchy. Use `--leading-body` for explanations and `--leading-tight` with `--tracking-display` for headings. Avoid applying compressed display treatment to dense tables or long paragraphs.

### Spacing and shape

Use the `--space-1` through `--space-12` scale. Product controls should stay compact and consistent, while marketing sections use larger gaps to separate ideas. Align form labels, values, validation, and actions to a predictable vertical rhythm.

Use `--radius-sm` for buttons, inputs, and compact badges; `--radius-md` for standard cards and code samples; `--radius-lg` for large feature panels. `--radius-pill` is limited to short statuses, filters, and compact segmented choices, not every action or container.

### Depth and motion

`--elev-flat` is the default for content embedded in the page. Use `--elev-ring` for crisp containment and `--elev-raised` for menus, dialogs, and featured panels that genuinely sit above the canvas. Do not stack multiple shadow styles on nested cards.

Use `--motion-fast` for hover, pressed, and validation feedback; use `--motion-base` for disclosure, panel, and chart transitions. Apply `--ease-standard` consistently. Motion should explain continuity and state change, not delay data access.

## 4. Layout and responsive behavior

Center primary content with `--container-max` and the matching `--container-gutter-desktop`, `--container-gutter-tablet`, or `--container-gutter-phone`. Use `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone` for large page rhythm.

Marketing pages may alternate text-led, diagram-led, and proof-led compositions while sharing one alignment grid. Product interfaces should use stable columns, clear label-value alignment, and predictable action placement. Keep a visible relationship between a technical explanation and the evidence, code, or visualization it describes.

At tablet widths, reduce peripheral decoration before compressing text. On phones, stack comparisons, pricing, and split panels; preserve the order of explanation before action. Tables should retain critical identifiers and values, then move secondary columns into disclosure. Keep touch targets at least 44px and prevent code or long identifiers from forcing horizontal page overflow.

## 5. Components and interaction

- Primary buttons use the complete accent state sequence. Secondary and tertiary actions remain neutral and visually subordinate.
- Inputs have persistent labels, unambiguous boundaries, helpful descriptions, visible focus, and specific validation. Placeholder text never replaces a label.
- Pricing and plan comparisons emphasize differences through hierarchy and alignment, not oversized badges or artificial urgency.
- Data cards pair a short label, a primary value, context, and a meaningful trend or status. Avoid card grids where every statistic has equal prominence.
- Tables support scanning with restrained separators, aligned numeric values, clear sorting state, and useful empty and loading rows.
- Code samples use `--font-mono`, clear language or context labels, keyboard-accessible copy actions, and safe horizontal scrolling.
- Navigation presents one clear current destination and keeps high-risk account or billing actions distinct from ordinary navigation.
- Dialogs and menus establish a visible title, focus management, Escape behavior, and a clear completion or cancellation path.

## 6. Accessibility

Apply `--focus-ring` to all keyboard-focusable controls. Check contrast for muted copy, pale borders, semantic text, disabled states, charts, and violet-on-light combinations. Never encode payment, verification, dispute, or risk state by color alone.

Use semantic headings, tables, lists, form controls, and status announcements. Associate validation with its field and move focus appropriately after failed submission. Support keyboard operation for navigation, tabs, menus, dialogs, data controls, and copy actions. Respect reduced motion, zoom, reflow, localization, long numbers, and high-contrast preferences.

## 7. Implementation checklist

- Load `tokens.css` once and use its semantic values instead of introducing nearby replacements.
- Keep the light layer hierarchy, navy text hierarchy, and violet action hierarchy distinct.
- Use original diagrams, illustrations, copy, and data; include no protected brand assets or proprietary font files.
- Verify all interactive, validation, loading, empty, success, warning, danger, and disabled states.
- Test forms, tables, code samples, pricing, long identifiers, localization, keyboard flow, contrast, zoom, and reduced motion.
- Confirm responsive layouts preserve explanation, evidence, and action order.
- Preserve product behavior, data handling, security, and compliance boundaries; this reference changes presentation only.
