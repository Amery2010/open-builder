# Notion-inspired Design Reference

> This is an unofficial visual reference inspired by Notion's warm, modular product language. It constrains visual expression only; product requirements, content, behavior, and project architecture remain authoritative. Do not copy Notion logos, proprietary fonts, brand copy, character illustrations, screenshots, or other brand assets. Use project-owned assets and the fallback families declared in `tokens.css`. The literal values in `tokens.css` are the source of truth; this document defines how those semantic tokens work together.

## 1. Scope and intent

Use this reference for knowledge tools, documents, team workspaces, lightweight productivity products, modular dashboards, and calm product marketing. It should feel approachable and content-first, with enough structure for complex information but little visual noise.

The design should behave like a flexible working canvas. Product interfaces use compact modules and direct controls; marketing surfaces increase type scale and whitespace while preserving the same warm neutrals, crisp sans-serif typography, quiet borders, and restrained blue action signal.

## 2. Visual identity

- Use warm paper-like neutrals rather than cool blue-gray surfaces.
- Keep the page light, calm, and content-led. Structure should come from spacing, alignment, fine borders, and gentle surface shifts.
- Use a clean sans-serif hierarchy with compressed large headings and comfortable reading text.
- Reserve blue for links, primary actions, focus, and selected states; avoid distributing saturated color across general chrome.
- Use compact functional radii for controls and more comfortable radii for content cards and featured modules.
- Let product views, documents, diagrams, and project-owned illustration carry personality without competing with the information hierarchy.

## 3. Foundations

### Color roles

- `--bg` is the main canvas. `--surface` creates warm section alternation and contained regions; `--surface-warm` stays within the same warm family.
- `--fg` carries primary content and headings. Use `--fg-2` for stronger secondary content, `--muted` for descriptions, and `--meta` for placeholders and low-priority metadata.
- `--border` is the standard whisper boundary; `--border-soft` separates nested rows and quieter regions.
- `--accent` is the primary action and link signal. Use `--accent-hover`, `--accent-active`, and `--accent-on` for complete interactive states.
- `--success`, `--warn`, and `--danger` are semantic feedback colors. Additional decorative color should come from content or project-owned imagery, not general UI chrome.

### Typography

- Use `--font-display` for display and section headings and `--font-body` for interface and reading text. Both roles share a crisp sans-serif character.
- Use `--font-mono` for code, formulas, identifiers, and aligned technical values only.
- Prefer weight 400 for reading, 500 for interactive text, 600 for emphasis, and 700 for headings. With fallback fonts, use supported weights and preserve hierarchy rather than simulating unavailable faces.
- Use `--text-base` as the reading baseline, `--text-xs` and `--text-sm` for metadata, and `--text-lg` through `--text-4xl` for increasingly prominent content.
- Use `--leading-body` for prose, `--leading-tight` for display text, and `--tracking-display` for the compressed heading character.

### Spacing and shape

- Use the `--space-1` through `--space-12` scale for recurring gaps and padding. Dense document rows may use the smaller steps; page sections use the larger steps.
- Use `--radius-sm` for buttons and fields, `--radius-md` for compact containers, and `--radius-lg` for standard cards and featured content.
- Reserve `--radius-pill` for tags, status labels, and compact segmented choices. General buttons remain compact rather than becoming oversized capsules.

### Depth and motion

- Use `--elev-flat` for text and page regions, `--elev-ring` for fine containment, and `--elev-raised` for cards or overlays that need gentle separation.
- Do not combine a strong border and a strong shadow on the same ordinary card. The system should feel embedded in the page rather than stacked above it.
- Use `--motion-fast` for hover, focus, and press feedback and `--motion-base` with `--ease-standard` for disclosure and overlays.
- Prefer color, underline, border, and shadow changes over large hover or press scaling. Controls should not jump or shrink during ordinary use.

## 4. Layout and responsive behavior

- Constrain primary page content with `--container-max` and use `--container-gutter-desktop`, `--container-gutter-tablet`, and `--container-gutter-phone` across widths.
- Use `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone` for major page rhythm. Document and workspace internals may be denser.
- Center focused reading experiences and use wider multi-column grids for collections, feature modules, or team workspaces.
- Alternate `--bg` and `--surface` when a long page needs chaptering; avoid inserting decorative separators between every section.
- Collapse card grids progressively and preserve content order. Sidebars should become drawers or ordered sections before they force the primary document into an unreadable width.
- Keep screenshots and diagrams within stable frames and maintain their aspect ratio. On small screens, prioritize legible detail over decorative cropping.

## 5. Components and interaction

| Component               | Visual treatment                                                     | Interaction                                                            |
| ----------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Primary action          | `--accent` fill, `--accent-on` content, `--radius-sm`                | Use the declared hover and active tokens without large scale changes   |
| Secondary action        | Quiet surface or transparent treatment with primary text             | Use border, fill, or underline changes to communicate state            |
| Document card           | `--bg` or `--surface`, `--border`, `--radius-lg`                     | Increase boundary or shadow subtly on hover; preserve stable geometry  |
| Field or editor control | Light canvas, whisper border, compact radius                         | Show focus, validation, disabled, read-only, and placeholder states    |
| Navigation              | Compact sans-serif labels on the canvas with a restrained active cue | Keep hierarchy shallow and make the current location explicit          |
| Tag or status           | Tinted semantic treatment with `--radius-pill`                       | Include a text label and support removal or selection when interactive |
| Menu or popover         | Warm contained surface with `--elev-raised`                          | Support keyboard traversal, selected state, and Escape                 |
| Dialog or sheet         | Clear title, content region, and ordered actions                     | Contain focus, support Escape, and restore focus on close              |

## 6. Accessibility

- Apply `--focus-ring` consistently and ensure it is visible against both `--bg` and `--surface`.
- Maintain readable contrast for body, muted, metadata, placeholder, and disabled text. Essential instructions should not rely on the lightest text tier.
- Keep pointer and touch targets operable for their context, density, and input methods, even when visible labels and icons remain compact.
- Pair semantic colors with text, icons, or patterns. Do not encode document status or selection through color alone.
- Respect reduced-motion preferences and remove nonessential transforms or spatial transitions.
- Preserve landmarks, heading order, document structure, control names, field labels, live status announcements, and logical keyboard order.

## 7. Implementation checklist

- The current literal values come from `tokens.css`; this document does not override them.
- Display and body typography use the declared sans-serif stacks and maintain clear weight and size hierarchy.
- Warm neutrals, whisper borders, and gentle elevation create structure without visual clutter.
- Blue remains limited to meaningful links, actions, focus, and selection.
- Controls use stable hover and press states without disruptive scaling.
- Responsive layouts preserve document readability, content order, navigation access, and action hierarchy.
- No Notion logo, proprietary font file, brand copy, character illustration, screenshot, or unlicensed asset has been copied.
