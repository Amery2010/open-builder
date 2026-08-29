# Spotify-inspired Design Reference

This is an unofficial visual reference for creating original media experiences. It constrains visual decisions only; it does not change product requirements, behavior, data, permissions, or content strategy. Do not copy Spotify logos, proprietary typefaces, brand copy, album artwork, interface screenshots, or other protected assets. Use licensed or system substitutes and original content. `tokens.css` is the literal-value authority; this document defines how those values should be used.

## 1. Scope and intent

Use this reference for music, podcast, entertainment, and creator products that benefit from a dark, immediate, content-first interface. The experience should feel energetic without becoming neon-heavy: artwork and editorial imagery provide most of the color, while the shell stays charcoal and the primary action uses a focused green.

The system supports both dense product surfaces and more expressive campaign sections. Preserve a clear distinction between persistent application chrome, browsable media collections, and the currently active item. It is a poor fit for formal enterprise workflows, quiet long-form publishing, or products whose identity depends on a light canvas.

## 2. Visual identity

- Build the shell from `--bg`, `--surface`, and `--surface-warm`. Avoid pure-black page-sized areas; the small lift between charcoal layers should remain visible.
- Use `--accent` for the primary play, follow, save, or confirmation action and for the current navigation state. It is a signal, not a decorative wash.
- Let original cover art, photography, or illustrations carry expressive color. Keep surrounding UI neutral so media remains the focal point.
- Favor bold, direct labels, compact metadata, and confident scale changes. Avoid glassmorphism, multicolor gradients, glossy controls, and excessive green borders.
- Use circles and true pills only for controls whose meaning benefits from them, such as play, avatar, filter chip, or compact status. Ordinary cards and panels remain softly rectangular.

## 3. Foundations

### Color roles

`--fg` is the highest-emphasis text and icon color; `--fg-2` supports prominent secondary copy. Use `--muted` for descriptions and inactive labels, and `--meta` for timestamps, durations, counts, and tertiary information. `--border` separates controls that require an explicit edge, while `--border-soft` handles low-contrast dividers.

`--accent-hover` and `--accent-active` define the complete primary-action state sequence. Keep `--accent-on` on accent-filled controls. Reserve `--success`, `--warn`, and `--danger` for status meaning; success may share the green family but must not turn every positive-looking element into a success message.

### Typography

Use `--font-display` for page titles, collection names, and high-impact campaign statements. Use `--font-body` for navigation, controls, descriptions, and long copy; `--font-mono` is limited to technical identifiers or aligned numeric data. The stacks are licensed substitutes, not copies of proprietary brand fonts.

Apply `--text-xs` and `--text-sm` to metadata, `--text-base` and `--text-lg` to reading and controls, and `--text-xl` through `--text-4xl` to increasingly prominent titles. Use `--leading-body` for prose and `--leading-tight` for display text. `--tracking-display` should make large headings feel compact without harming recognition.

### Spacing and shape

Use the `--space-1` through `--space-12` scale. Dense rows generally use `--space-2` or `--space-3`; card interiors use `--space-4` or `--space-6`; major section transitions use `--space-8` or `--space-12`.

`--radius-sm` is the default for compact rectangular controls and must never be treated as a pill. Use `--radius-md` for media cards, `--radius-lg` for large panels, and `--radius-pill` only for circular or capsule geometry.

### Depth and motion

Use `--elev-flat` for ordinary rows, `--elev-ring` for selected or bounded surfaces, and `--elev-raised` for menus, playback overlays, and floating controls. Depth should clarify stacking rather than make every card float.

Use `--motion-fast` for hover and pressed feedback and `--motion-base` for panel, artwork, and state transitions. Apply `--ease-standard` consistently. Prefer opacity, color, and small scale changes; avoid long parallax, bouncing navigation, or motion that delays playback.

## 4. Layout and responsive behavior

Center major content with `--container-max` and the appropriate `--container-gutter-desktop`, `--container-gutter-tablet`, or `--container-gutter-phone`. Use `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone` for large page rhythm, then tighten spacing inside product views.

Desktop layouts may combine a stable navigation rail, a flexible content canvas, and a persistent playback region. Collapse secondary navigation before content becomes cramped. Media grids should move from wide multi-column arrangements to two columns and then one column while preserving artwork aspect ratios.

On narrow screens, keep the current item and primary playback action reachable, reduce nonessential metadata, and convert dense toolbars into focused menus. Do not merely shrink desktop controls. Maintain at least a 44px touch target and keep text reflow independent of fixed artwork dimensions.

## 5. Components and interaction

- Primary actions use `--accent`, `--accent-on`, and the defined hover and active tokens. Secondary actions use neutral surfaces and clear text.
- Media cards combine consistent artwork ratios, a short title, restrained metadata, and an explicit hover or focus state. Avoid heavy card borders in large grids.
- Navigation shows one unmistakable active destination. Pair icon and text where ambiguity is possible; icon-only controls require accessible names.
- Search uses a clear input boundary, visible focus treatment, and useful empty and no-result states.
- Playback controls prioritize play or pause, current progress, and volume. Secondary actions must not compete with the primary control.
- Lists and queues use alignment and spacing rather than nested containers. Selection, hover, and current-playing states must remain distinguishable without relying only on green.
- Loading states should preserve artwork and row geometry. Empty and error states explain the next useful action instead of presenting inert decoration.

## 6. Accessibility

Use `--focus-ring` on every keyboard-focusable control and never remove focus visibility on the dark canvas. Verify contrast for `--muted`, `--meta`, borders, and disabled states rather than assuming white text solves all contrast issues.

Support keyboard navigation for playback, menus, tabs, sliders, queues, and modal surfaces. Communicate current, selected, expanded, pressed, and playback states semantically. Provide text alternatives for meaningful artwork, captions or transcripts for time-based media where relevant, and reduced-motion behavior that removes nonessential animation while preserving state feedback.

## 7. Implementation checklist

- Load `tokens.css` once and consume its semantic tokens instead of scattering replacement values.
- Keep the dark layer hierarchy visible and reserve green for meaningful actions and states.
- Confirm `--radius-sm` remains rectangular and `--radius-pill` is used intentionally.
- Use original or licensed media and generic font substitutes; include no protected brand assets.
- Verify hover, active, focus, disabled, loading, empty, and error states.
- Test grid collapse, persistent controls, long titles, localization, keyboard use, touch targets, contrast, and reduced motion.
- Preserve product behavior and data flow; this reference changes presentation only.
