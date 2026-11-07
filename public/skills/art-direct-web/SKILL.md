---
name: art-direct-web
description: Art-direct marketing sites, landing pages, portfolios, editorial pages, and campaign experiences from a concrete brief. Use when visual narrative, composition, typography, imagery, and motion are central; use design-product-ui instead for routine application workflows.
version: 2.1.0
tags:
  - frontend
  - art-direction
  - marketing
  - editorial
---

# Art-direct the web

## Shared visual principles

Use these defaults when the task involves planning, implementing, or reviewing a UI. They do not change the existing instruction precedence, the user's direction, the applied Design system, project permissions, product contracts, or required output format. An applied system may intentionally use gradients, pixel type, glass, maximalism, texture, or skeuomorphic material; preserve those defining traits when they serve the brief. Do not impose a universal 44px target size. Judge controls by context, density, and operability. These principles are adapted from the [design principles reference](https://github.com/jiji262/claude-design-skill/blob/main/references/design-principles.md).

- Read the existing surface, content, tokens, assets, and interaction patterns before extending them. Record the observed type hierarchy, color roles, spacing rhythm, shape language, density, and motion language.
- Commit to a small visual system before placing pixels. Reuse semantic roles for typography, color, spacing, shape, elevation, and motion instead of inventing one-off decoration.
- Let the user's content and communication goal choose the composition. Give every section and visual a job; do not pad a page with repeated card grids, icon bullets, decorative numbers, or invented proof.
- Use real, specific copy and project-owned assets. When a meaningful image, logo, chart, screenshot, or testimonial is unavailable, mark the gap honestly instead of fabricating one. Do not use an SVG illustration or CSS ornament as a substitute for a real product photo, screenshot, portrait, or 3D asset.
- Give motion a clear narrative or feedback purpose. Keep navigation and actions operable without hover or animation, preserve content when motion is disabled, and respect reduced-motion preferences.
- Before finishing, remove anything added only because the page felt sparse. Check the result as a coherent authored system rather than a collection of familiar landing-page patterns.

Create a coherent visual experience for `persuade`, `read`, and `experience` surfaces: marketing, portfolio, editorial, cultural, or campaign work. Start from the user's content, audience, brand, conversion goal, and existing project—not from a generic visual trend. Use `design-product-ui` for `operate` surfaces such as dashboards, settings, forms, and multi-step workflows; load both for a genuinely mixed target.

In Design mode, the host prepares the Design run context and activates this built-in skill automatically. Inspect the active project and implement the current user request within its selected scope. Distinguish `create` (a new surface), `extend` (a bounded addition within the current visual language), and `migrate` (the applied Design system replaces conflicting visual Tokens, styles, component grammar, and layout expression inside the named target). An applied Design system is visually authoritative in that target. A selected-but-unapplied system is reference only and cannot authorize a restyle.

In every change mode, preserve product truth: routes, data and state ownership, information architecture, content, permissions, analytics hooks, integration selectors, accessibility semantics, and working interactions unless the user's request independently changes them. Migration replaces the visual world, not the product contract.

## Read before directing

Inspect the brief, existing pages, assets, copy, tokens, type, routes, components, and responsive behavior. Identify what must remain recognizable and which part the user asked to change. Existing brand assets, functionality, accessibility, and architectural contracts outrank aesthetic preference.

Summarize a compact design read before major UI work:

- page type and primary audience;
- one desired user action or communication goal;
- content hierarchy and available proof;
- visual direction in concrete material terms;
- constraints from the project and available assets.

Do not invent customer logos, awards, metrics, testimonials, product screenshots, or runtime evidence. When real imagery is important but unavailable, use a project-compatible treatment that remains honest rather than a fake proof artifact.

## Establish a concept spine

Choose one idea that can guide composition, typography, color, imagery, and motion. It may be restrained or expressive, but it must fit the subject. Translate the concept into a small system:

- a dominant compositional gesture;
- a display and reading typography relationship using available fonts;
- a controlled palette with one clear accent role;
- a shape, line, texture, or image treatment that can recur without becoming decoration;
- a motion principle tied to hierarchy or interaction.

Avoid combining several fashionable motifs with no narrative relationship. Distinction comes from a specific concept executed consistently, not from gradients, glass, noise, oversized type, or animation used by default.

## Compose a narrative page

Treat the page as a sequence rather than a stack of interchangeable cards. Establish why the next section follows the previous one. Vary scale and rhythm while keeping navigation and conversion understandable.

The hero should communicate subject, value, and next action within an ordinary laptop viewport. Keep its primary copy readable and protect it from decorative competition. A product or campaign with a strong image may use image-led composition; a text-led editorial piece may let typography and pacing carry the first impression.

Use sections only when they advance the narrative: context, problem, proof, mechanism, work, comparison, story, invitation, or conversion. Do not force every section into a centered heading plus three equal cards. Alternate composition through crop, alignment, density, background, typographic scale, or editorial sequencing while preserving a coherent grid.

Primary and secondary calls to action must reflect real destinations or actions. Keep labels specific. Repetition is useful when the user's readiness changes; repeating identical button clusters after every section is noise.

## Typography

Use the project's existing family when brand continuity matters. If the brief authorizes a new type direction, select fonts that are actually available and licensed for the project. Do not reference an external font without integrating a reliable loading or fallback strategy.

Define a small, responsive type scale with intentional line height, measure, weight, and contrast. Large display text must still fit translated copy and smaller laptops. Body copy should remain comfortable to scan. Use uppercase, italics, condensed faces, or extreme tracking only where the concept and language support them.

Hierarchy should remain clear without relying on font size alone. Kicker, heading, summary, proof, metadata, and action text need distinct roles. Preserve semantic heading order independently from styling.

## Color, surface, and imagery

Give each color a job: canvas, elevated surface, text, muted text, border, accent, success, warning, or destructive state. Test the system in every supported theme. Avoid distributing many accent colors evenly or using low-contrast muted text as a substitute for hierarchy.

Background texture, gradients, illustration, photography, diagrams, and decorative geometry should reinforce the concept or content. Protect copy from busy regions with deliberate crop, overlay, contrast, or separate composition. Do not ship placeholder image boxes, fabricated UI screenshots, or decorative assets that imply unavailable functionality.

Reuse and classify existing assets before creating or sourcing new ones. Respect their aspect ratio, subject direction, transparency, and focal point. Optimize shipped assets according to project conventions without degrading the visual anchor.

## Motion and interaction

Motion should clarify entry, hierarchy, relationship, or feedback. Prefer a few coordinated moments over unrelated effects on every element. Navigation, calls to action, galleries, accordions, and media controls must remain real and operable.

- Keep transitions short enough that repeated use stays efficient.
- Preserve content and actions when animation is disabled.
- Respect reduced-motion preferences.
- Avoid scroll hijacking, custom cursors, essential hover-only content, or pointer effects that obscure text and controls.
- Do not add a motion library for effects that the existing stack or CSS handles clearly.

## Responsive art direction

Responsive work is recomposition, not uniform shrinking. Decide what leads at narrow widths, how imagery crops, where type wraps, which overlaps must become ordinary flow, and how navigation remains operable. Check small phones, intermediate widths, ordinary laptops, and wide displays relevant to the project.

Keep the hero visible and comprehensible without requiring an initial scroll on a small laptop. Prevent display type, fixed art, and full-viewport sections from clipping translated content. Maintain touch targets, keyboard focus, readable text, and sensible document order.

## Existing-project redesigns

Audit before changing. For `extend`, preserve the established visual language outside changed UI and avoid cleaning unrelated historical debt. For `migrate`, preserve working behavior, routes, analytics hooks, selectors, content contracts, and accessibility while replacing conflicting visual Tokens, styling, component grammar, and layout expression throughout the accepted target. Identify the smallest system-level changes that make the applied Design system coherent: type scale, spacing rhythm, palette roles, shape, media treatment, section composition, or motion language.

Do not restyle every surface merely because one page is being redesigned. Reuse shared primitives where the new direction genuinely applies, and isolate campaign-specific expression where product UI must remain stable.

## Preflight

Before finishing, verify:

1. the page communicates its subject and primary action quickly;
2. one concept connects type, composition, color, imagery, and motion;
3. sections form a narrative rather than a template inventory;
4. copy and proof are specific and honest;
5. primary navigation and interactions work;
6. responsive layouts are intentionally recomposed;
7. keyboard, focus, contrast, semantics, and reduced motion are preserved;
8. no asset, dependency, or external action was invented or added without need;
9. checks and preview evidence reported were actually run.

Run the project health check and report build/runtime and `design_system` findings with their actual evidence. Fix in-scope implementation errors; a visual check is advisory and does not block saving or further editing. Trace root `tokens.css` into the active runtime style entry and prove that changed UI consumes semantic color, typography, shape, and layout roles; use motion and easing roles when interaction or animation is present. Use browser or screenshot validation only when it is available and authorized, and distinguish it from source-based review. The host may follow with a non-blocking visual report. Apply review fixes when the user requests them, using the current project and the reported scope.
