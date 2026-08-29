---
name: build-tailwind-ui
description: Build and refine interfaces in projects that already use Tailwind CSS. Use for responsive layout, project tokens, state variants, dark mode, shadcn-style components, and maintainable class composition; do not use to choose the product's overall art direction.
version: 2.0.0
tags:
  - tailwind
  - css
  - ui
  - responsive
---

# Build Tailwind UI

Implement the requested interface with the Tailwind version, tokens, utilities, component primitives, and conventions already present in the project. This skill governs CSS implementation, not product scope or art direction. Pair it with the relevant product or marketing design guidance when visual decisions are part of the request.

## Inspect the Tailwind contract

Before editing, determine:

- the installed Tailwind major version and build integration;
- where theme tokens and CSS variables are defined;
- whether dark mode follows media, a class, or a data attribute;
- the class merge or variant utilities in use;
- whether shared primitives such as shadcn components own spacing and states;
- the project's breakpoints, container rules, typography, animation, and focus conventions.

Do not paste configuration or syntax from a different Tailwind version. Tailwind 4 CSS-first tokens, Tailwind 3 configuration files, and project-specific plugins are not interchangeable. Reuse semantic classes such as `bg-background`, `text-muted-foreground`, and `border-border` when the project defines them; avoid bypassing the theme with arbitrary values unless the design genuinely requires a one-off measurement.

## Compose layout deliberately

Write base styles for the smallest supported viewport, then add only the breakpoint changes required as space opens. Prefer layout primitives that express the relationship directly:

- flex for one-dimensional alignment and toolbars;
- grid for repeated columns or explicit two-dimensional structure;
- `min-w-0`, `min-h-0`, and bounded overflow where nested flex or grid children must shrink;
- `max-w-*`, container rules, and readable line lengths for content surfaces;
- `aspect-*` and object-fit utilities for predictable media.

Avoid compensating margins, fixed viewport heights without safe overflow, and breakpoint chains that undo one another. Check narrow phones, intermediate tablet widths, ordinary laptops, and wide screens according to the product's supported layout—not only framework defaults.

For dense tools, protect the primary work area and keep controls compact but operable. For reading or marketing surfaces, use whitespace and rhythm intentionally. Density is a product decision, not a reason to shrink text or pointer targets below usability.

## Use tokens and variants

Express color and state through the project's semantic tokens. A component should remain coherent in light, dark, high-contrast, selected, disabled, error, and loading states without duplicating theme logic inside every call site.

Prefer an established variant helper for a reusable component with meaningful variants. Use a simple `cn()` or equivalent merge for local conditional states. Introduce a new abstraction only when several consumers share the same behavior; a one-off class list does not need a new variant system.

Keep dynamic class names statically discoverable by Tailwind. Do not build utility names through string interpolation such as ``bg-${color}-500`` unless the project explicitly safelists them. Map domain values to complete class strings instead.

Use arbitrary values sparingly and document the underlying design reason through a token or nearby context when the measurement is repeated. Repeated raw colors or spacing values should become a semantic token rather than proliferate.

## Interaction states

Style the complete behavior, not only the resting frame:

- hover where a pointer is present;
- visible `focus-visible` treatment for keyboard operation;
- active, selected, expanded, checked, and current states;
- disabled appearance that matches actual disabled semantics;
- loading, empty, success, warning, and error feedback;
- reduced-motion alternatives for nonessential transitions.

Use native radio and checkbox controls when their semantics match the interaction. Styling may refine their accent and spacing, but it should not replace their behavior with generic pressed buttons. Do not make color the only indication of state.

## Component-library integration

When using existing primitives, preserve their accessibility and behavior. Extend through documented props and class merging rather than copying the component into a local fork for a minor style change. Keep dialog close, Escape, focus, tooltip, menu, and portal behavior intact.

Avoid nested cards and borders that obscure hierarchy. One structural container, clear internal spacing, and a small number of state surfaces usually communicate more than several layers of rounded panels. Match the repository's established radius and shadow vocabulary.

## Maintainable class usage

- Keep classes near the element they style unless a shared component owns the pattern.
- Group conditional classes by state and use the project's formatter ordering if configured.
- Remove utilities made redundant by the change, but do not reformat unrelated class lists.
- Prefer CSS for complex keyframes, browser-specific selectors, or reusable pseudo-element behavior when a long utility string would be less clear.
- Preserve class names and selectors used by tests, automation, or integrations.

## Verification

Run the component tests and project checks relevant to the edited surface. When browser verification is authorized, inspect supported widths, themes, zoom, overflow, keyboard focus, and reduced motion. Static class presence does not prove the rendered layout.

Before finishing, confirm that the implementation uses the current Tailwind contract, reuses semantic tokens, has intentional responsive behavior, exposes complete interaction states, preserves component semantics, and introduces no unrelated framework or design-system migration.
