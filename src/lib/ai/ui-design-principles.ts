/**
 * Shared visual guidance for UI work.
 *
 * This is deliberately separate from DEFAULT_SYSTEM_PROMPT so it also applies
 * when a caller supplies a different base role (for example, code-writer).
 */
export const UI_DESIGN_PRINCIPLES = `
<ui_design_principles>
Apply these defaults only when the assigned task involves planning, implementing, or reviewing a user interface. They do not change the assigned role, tools, permissions, mode, selected-versus-applied Design-system contract, or required output format. Follow the existing instruction precedence and the user's explicit direction, mandatory skills, applicable project guidance, and applied visual system before these generic defaults. Do not impose a universal 44px minimum target size; judge controls by context, density, and operability.

- Read the existing surface, tokens, assets, content, and interaction patterns before choosing a direction. State the observed type hierarchy, color roles, spacing rhythm, shape language, density, and motion language before extending an existing UI.
- Commit to a small, coherent visual system before placing pixels. Reuse semantic tokens for type, color, spacing, shape, elevation, and motion; derive states from those roles instead of inventing unrelated literals.
- Let the content and task choose the composition. Use a distinctive layout when it communicates better, and do not add repeated card grids, icon bullets, decorative statistics, or empty sections merely to fill space.
- Use real, specific content and project-owned assets. If a meaningful image, icon, chart, logo, or proof artifact is unavailable, use an honest labeled placeholder or explain the gap; do not fabricate customer proof, metrics, product screenshots, or data. Do not use an SVG illustration or CSS ornament as a substitute for a real product photo, screenshot, portrait, or 3D asset; obtain the real material or label the placeholder.
- Use icons and decoration when they carry meaning. Preserve deliberate characteristics of an applied style, including gradients, pixel type, glass, maximalism, texture, or skeuomorphic material, while keeping the result readable, purposeful, and consistent.
- Give every interactive element a usable state model: default, hover, active, focus, disabled, loading, empty, error, and success where relevant. Preserve semantic HTML, keyboard paths, responsive order, visible focus, and reduced-motion behavior.
- Build for the project's supported browsers and stack. Prefer simple CSS and existing primitives; add motion only when it clarifies hierarchy, relationship, entry, or feedback, and keep content and actions available when motion is reduced or unavailable.
- Before finishing, inspect the result as a specific designed system. Remove anything added only because the layout felt sparse, and verify that visual choices support the user's goal rather than an inherited template.
</ui_design_principles>
`;
