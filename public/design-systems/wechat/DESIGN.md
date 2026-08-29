# WeChat-inspired Design Reference

This is an unofficial visual reference for creating original messaging and everyday-service interfaces. It constrains visual decisions only; it does not change product requirements, behavior, data, permissions, privacy obligations, or content strategy. Do not copy WeChat logos, proprietary typefaces, brand copy, chat content, stickers, icons, interface screenshots, or other protected assets. Use system fonts, original assets, and original content. `tokens.css` is the literal-value authority; this document defines how those values should be used.

## 1. Scope and intent

Use this reference for messaging, contacts, community, lightweight commerce, utilities, and mobile-first services that benefit from a familiar, calm, and efficient interface. The system uses a soft gray canvas, lightly lifted surfaces, dense but readable rows, compact typography, and one decisive green action color.

The experience should reduce friction rather than perform for attention. Familiar placement, explicit labels, predictable feedback, and content density matter more than decorative novelty. It is less suitable for luxury storytelling, experimental typography, cinematic launches, or products whose identity depends on large expressive imagery.

## 2. Visual identity

- Use `--bg` as the quiet gray application canvas and `--surface` for lists, sheets, cards, and primary work areas. `--surface-warm` provides a slightly softer raised layer without changing the neutral character.
- Reserve `--accent` for send, confirm, pay, active navigation, and other decisive actions. Avoid green page backgrounds and ornamental green borders.
- Favor clear rows, subtle dividers, restrained icons, compact labels, and direct state feedback. Content should feel organized, not boxed into repeated cards.
- Use system-native CJK-aware typography so Chinese and Latin text share a stable baseline and line rhythm. Do not bundle or imitate a proprietary font asset.
- Keep geometry practical: small radii for controls, moderate radii for sheets and media, and pills only for short functional chips or circular controls.

## 3. Foundations

### Color roles

`--fg` is the primary message, title, and control color; `--fg-2` supports emphasized secondary content. Use `--muted` for descriptions, placeholders, and inactive labels, and `--meta` for timestamps, counts, and tertiary status. `--border` defines rows and controls that need an explicit edge; `--border-soft` separates dense content without adding visual weight.

Primary controls use `--accent` with `--accent-on`, then `--accent-hover` and `--accent-active`. `--success` may share the green family but remains a semantic status. Use `--warn` and `--danger` only for meaningful caution, destructive action, failure, or attention.

### Typography

Use `--font-display` for page titles and short feature statements and `--font-body` for messages, lists, navigation, forms, and reading. Both rely on the same system-native multilingual stack to avoid script mismatch. Use `--font-mono` only for identifiers, verification codes, or aligned technical values.

`--text-xs` and `--text-sm` handle timestamps and metadata, `--text-base` and `--text-lg` handle messages and controls, and `--text-xl` through `--text-4xl` provide restrained title and campaign scale. Apply `--leading-body` to messages and explanatory text; use `--leading-tight` and `--tracking-display` only for short headings.

### Spacing and shape

Use `--space-1` through `--space-12`. Dense list rows rely on small internal gaps but retain comfortable vertical touch space. Cards, sheets, and form sections use larger values to keep related content readable without fragmenting the interface.

Use `--radius-sm` for inputs and compact buttons, `--radius-md` for cards and message-adjacent controls, and `--radius-lg` for sheets, large media, and prominent panels. Use `--radius-pill` for avatars, short filters, statuses, and circular icon actions only.

### Depth and motion

Most lists and pages use `--elev-flat` with borders or layer contrast. Use `--elev-ring` for explicit selection and `--elev-raised` for menus, sheets, and floating actions. Avoid deep shadows and stacks of nested elevated cards.

Use `--motion-fast` for pressed, hover, and selection feedback and `--motion-base` for message insertion, disclosure, and sheet transitions. Apply `--ease-standard` consistently. Motion should feel immediate and functional; do not animate routine navigation for spectacle.

## 4. Layout and responsive behavior

Use `--container-max` and the appropriate `--container-gutter-desktop`, `--container-gutter-tablet`, or `--container-gutter-phone`. Use `--section-y-desktop`, `--section-y-tablet`, and `--section-y-phone` for larger service or marketing pages; messaging and utility views use denser internal rhythm.

On desktop, messaging products may use a conversation list, active conversation, and optional detail panel. Each boundary must remain obvious without heavy card frames. Utility pages should align labels, values, and actions in stable rows and reserve wide space for actual content.

On phones, prioritize the active task, keep top-level navigation reachable, and move secondary detail into dedicated screens or sheets. Composer controls should remain visible when the keyboard appears, and message width should preserve readable line length. Maintain at least a 44px touch target, safe-area spacing, and reliable layout under larger text and localization.

## 5. Components and interaction

- Conversation rows combine avatar, title, one-line preview, timestamp, and unread state with a clear selected treatment.
- Message bubbles distinguish sender through position, surface, and accessible context rather than color alone. Long text, links, media, replies, and status indicators must wrap predictably.
- The composer provides an obvious text field, a decisive send action, keyboard-safe layout, and clear disabled, uploading, retry, and error states.
- Primary buttons use the full accent state sequence. Neutral and destructive actions remain visibly distinct.
- Forms use persistent labels, concise help, visible focus, specific validation, and confirmation for consequential actions.
- Tabs and bottom navigation show one unmistakable current destination. Icon-only controls require accessible names and must not depend on copied brand icons.
- Lists use alignment and separators instead of nested card containers. Swipe or context actions require a discoverable non-gesture alternative.
- Loading states preserve row geometry. Empty, offline, permission, and error states explain the condition and offer a useful next action.

## 6. Accessibility

Apply `--focus-ring` to every keyboard-focusable element. Verify contrast for muted timestamps, dividers, placeholders, green actions, disabled controls, and status colors. Do not communicate unread, delivery, payment, warning, or failure state through color alone.

Support keyboard operation for navigation, lists, composers, menus, dialogs, and forms. Announce incoming content and delivery changes without overwhelming assistive technology. Provide accessible names and text alternatives, logical focus movement, reduced-motion behavior, dynamic type or zoom reflow, and robust Chinese, Latin, mixed-script, and right-to-left content handling where the product requires it.

## 7. Implementation checklist

- Load `tokens.css` once and use its semantic values rather than adding near-duplicate greens or grays.
- Preserve the gray canvas, lifted neutral surfaces, compact multilingual type, and focused green action hierarchy.
- Use original icons, avatars, stickers, copy, and media; include no protected brand assets or proprietary font files.
- Verify message, delivery, unread, active, hover, focus, pressed, disabled, loading, empty, offline, permission, and error states.
- Test keyboard and touch input, virtual keyboards, long messages, mixed scripts, localization, zoom, contrast, and reduced motion.
- Confirm responsive layouts protect the active task, composer, navigation, safe areas, and 44px touch targets.
- Preserve application behavior, privacy, permissions, and data handling; this reference changes presentation only.
