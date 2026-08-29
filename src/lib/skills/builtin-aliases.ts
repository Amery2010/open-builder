export const BUILTIN_SKILL_ID_ALIASES = {
  accessibility: "build-accessible-ui",
  debugging: "debug-web-app",
  "tailwind-helpers": "build-tailwind-ui",
  "typescript-patterns": "write-safe-typescript",
  "design-taste-frontend": "art-direct-web",
  "frontend-design": "design-product-ui",
  "code-review": "review-code",
  "code-simplifier": "simplify-code",
} as const;

export function resolveBuiltinSkillId(id: string): string {
  return (
    BUILTIN_SKILL_ID_ALIASES[id as keyof typeof BUILTIN_SKILL_ID_ALIASES] ?? id
  );
}
