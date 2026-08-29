# Figma-inspired Design Reference

This is an unofficial visual reference for original interfaces. It constrains presentation only; product behavior, information architecture, and user requirements remain authoritative. Do not copy Figma logos, proprietary typefaces, brand copy, screenshots, editor icons, illustrations, or other brand assets. The literal values in `tokens.css` are authoritative whenever prose and tokens differ.

## 1. Scope and intent

- Use this direction for creative tools, collaborative editors, visual workspaces, prototyping products, and expressive product launches.
- The goal is confident utility: monochrome chrome stays legible while original user work or campaign art supplies color.
- Product interfaces should feel direct and tool-like; marketing surfaces may be playful without turning controls into decoration.
- Collaboration, selection, editing, and state visibility take priority over resemblance to any existing editor.
- Conservative financial, government, or text-heavy editorial services need a different reference.

## 2. Visual identity

- Treat black-and-white interface chrome as a gallery frame around vivid, original content.
- Use bold scale changes, compact labels, and precise alignment to create hierarchy with minimal ornament.
- Apply color in bounded canvases, artwork, previews, or section fields rather than scattering unrelated accents through controls.
- Combine rectangular work surfaces with compact rounded panels and clearly pill-shaped modes or filters.
- Use technical mono labels sparingly for coordinates, properties, versions, or structural signposts.
- Dashed focus treatment may echo selection language, but it must remain a conventional and visible keyboard indicator.
- Keep icons simple and geometric, with consistent optical size and no imitation of proprietary editor symbols.

## 3. Foundations

### Color roles

- `--bg` is the primary white canvas; `--surface` supports toolbars, panels, and quiet content groups.
- `--surface-warm` is a second neutral plane for selected work areas or section transitions.
- `--fg` provides maximum-contrast text, while `--fg-2`, `--muted`, and `--meta` create scan-friendly secondary tiers.
- `--border` defines functional regions; `--border-soft` separates rows and controls inside a region.
- `--accent` is deliberately monochrome, with `--accent-hover` and `--accent-active` expressing interaction through value.
- `--success`, `--warn`, and `--danger` are reserved for system feedback and must not become decorative palette colors.
- Expressive artwork may introduce its own bounded palette, but reusable interface chrome continues to use semantic tokens.

### Typography

- Use the system-first sans stack in `--font-display` and `--font-body`; do not load or recreate a proprietary brand face.
- Use `--font-mono` for compact technical values and uppercase structural labels, not for ordinary prose.
- Display text uses `--leading-tight` and `--tracking-display` for strong, compressed statements.
- Body copy uses `--leading-body` with regular weight and clear contrast.
- Use `--text-xs` and `--text-sm` for properties or metadata; reserve `--text-3xl` and `--text-4xl` for marketing anchors.
- Create hierarchy with a small set of conventional weights rather than simulated micro-weight differences.
- Keep kerning enabled and avoid negative tracking on small text where it reduces recognition.

### Spacing and shape

- Use the `--space-1` through `--space-12` scale for dense tool controls, panel padding, and broad campaign composition.
- Major marketing sections use `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone`.
- `--radius-sm` is the compact control radius, `--radius-md` fits standard cards and dialogs, and `--radius-lg` fits prominent media.
- `--radius-pill` is reserved for modes, filters, compact calls to action, and circular controls.
- The radius scale must progress semantically; small controls are not pills by default.

### Depth and motion

- Start with `--elev-flat`; hierarchy should come from region boundaries and content contrast.
- Use `--elev-ring` for selected panels or compact floating tools and `--elev-raised` for menus, dialogs, or draggable layers.
- Motion uses `--motion-fast`, `--motion-base`, and `--ease-standard` for direct state feedback.
- Selection, drag, resize, and mode changes should feel immediate and preserve spatial context.
- Marketing transitions may be expressive, but editor controls should never drift, bounce, or delay the task.

## 4. Layout and responsive behavior

- Center marketing content within `--container-max` and use the matching gutter token at desktop, tablet, and phone widths.
- Product workspaces may use the full viewport with stable toolbar, canvas, and inspector regions.
- Keep primary editing space dominant; navigation and properties panels should be compact and collapsible.
- Marketing sections may alternate centered statements, offset editorial grids, and full-width original artwork.
- Below 1024px, reduce side-panel width, collapse tertiary controls, and preserve the working canvas.
- Below 768px, turn multi-panel layouts into staged views or sheets instead of squeezing every desktop control onscreen.
- Pill navigation may scroll horizontally only when all options remain discoverable and keyboard accessible.
- On phones, use `--section-y-phone`, reduce display scale, and keep primary creation actions within easy reach.
- Preserve object selection, collaboration status, undo access, and save state through every responsive transition.

## 5. Components and interaction

- Toolbars group related actions by task and show selected modes with more than a color change.
- Primary buttons use `--accent` with `--accent-on`; secondary actions remain neutral and compact.
- Icon-only buttons require accessible names, visible tooltips, and a selected or pressed state when applicable.
- Panels use clear headings, restrained boundaries, and consistent row height so properties scan quickly.
- Cards on marketing pages frame original work samples and should not become nested dashboards.
- Inputs expose units, constraints, validation, and keyboard behavior appropriate to the edited value.
- Tabs, segmented controls, and filters use pill geometry only when their items belong to one exclusive group.
- Menus, dialogs, and popovers use `--elev-raised`, logical placement, focus management, Escape, and an explicit close path.
- Collaborative presence must combine names or initials with color and expose conflicts, offline state, and permissions clearly.
- Drag and resize interactions need pointer, keyboard, cancellation, and recovery behavior.

## 6. Accessibility

- Meet WCAG AA contrast for chrome, text, status, and controls even when vivid content sits behind them.
- Apply a clear dashed outline or `--focus-ring` to every keyboard target without clipping it.
- Do not rely on selection handles, color, cursor shape, or hover alone to communicate state.
- Provide at least 44 by 44 CSS pixels for primary touch actions while retaining compact visual geometry.
- Support keyboard traversal of toolbars, menus, layers, properties, and canvas commands.
- Announce collaboration changes, validation failures, destructive outcomes, and save status appropriately.
- Respect reduced motion and provide alternatives to drag-only or gesture-only actions.
- Test high zoom, reflow, long labels, color-vision differences, and screen-reader names.

## 7. Implementation checklist

- Import the canonical token file once and use semantic variables for reusable chrome.
- Verify every referenced variable exists in `tokens.css` and remove duplicated literal values from components.
- Confirm original content, artwork, icons, and copy replace every placeholder brand reference.
- Check that the monochrome shell remains usable when colorful content is absent or extremely vivid.
- Validate the semantic radius progression, including the corrected compact `--radius-sm`.
- Exercise hover, active, selected, disabled, focus, loading, offline, conflict, and error states.
- Test representative editor and marketing layouts at desktop, tablet, and phone widths.
- Verify keyboard editing, focus order, reduced motion, zoom, announcements, and touch targets.
- Confirm save, undo, permissions, and collaboration state remain visible during responsive changes.
- Keep functional behavior unchanged unless the product request explicitly authorizes a behavior change.
