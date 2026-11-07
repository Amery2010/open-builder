import { describe, expect, it } from "vitest";
import { WebAppGenerator } from "./generator";
import { UI_DESIGN_PRINCIPLES } from "./ui-design-principles";

function generator(
  options: Partial<ConstructorParameters<typeof WebAppGenerator>[0]> = {},
) {
  return new WebAppGenerator({
    apiBaseUrl: "https://example.test/v1",
    apiKey: "test",
    model: "test",
    tools: {},
    ...options,
  });
}

describe("shared UI design principles", () => {
  it("is included exactly once for default and caller-supplied base prompts", () => {
    for (const systemPrompt of [undefined, "[custom base role]"]) {
      const instance = generator({ systemPrompt });
      instance.setSystemPromptSuffix("[run suffix]");
      const content = instance.getSystemContent();

      expect(content).toContain(UI_DESIGN_PRINCIPLES.trim());
      expect(content.match(/<ui_design_principles>/g)).toHaveLength(1);
      expect(content).toContain("[run suffix]");
      if (systemPrompt) expect(content).toContain(systemPrompt);

      instance.setSystemPromptSuffix("[refreshed plan suffix]");
      const refreshed = instance.getSystemContent();
      expect(refreshed).toContain("[refreshed plan suffix]");
      expect(refreshed).not.toContain("[run suffix]");
      expect(refreshed.match(/<ui_design_principles>/g)).toHaveLength(1);
    }
  });

  it("keeps the shared principles on an isolated subagent base role", () => {
    const content = generator({
      executionMode: "subagent",
      systemPrompt: "[code writer role]",
      subagentWritePaths: ["src/App.tsx"],
    }).getSystemContent();

    expect(content).toContain("[code writer role]");
    expect(content).toContain("<ui_design_principles>");
    expect(content).toContain(
      "Do not impose a universal 44px minimum target size",
    );
    expect(content).toContain("Do not use an SVG illustration or CSS ornament");
  });

  it("keeps a read-only subagent role when no write scope is supplied", () => {
    const content = generator({
      executionMode: "subagent",
      systemPrompt: "[read only reviewer role]",
    }).getSystemContent();

    expect(content).toContain("[read only reviewer role]");
    expect(content).toContain("<ui_design_principles>");
  });
});
