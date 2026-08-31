import { describe, expect, it } from "vitest";
import type { Conversation, ProjectTemplate } from "../../types";
import { inspectDesignTokenContract } from "../design/tokens";
import {
  PROJECT_TEMPLATE_LIMITS,
  createConversationFromProjectTemplate,
  getProjectTemplateUsability,
  getProjectTemplateAnalysis,
  getProjectTemplateStats,
  isProjectTemplateUsable,
  normalizeTemplateTags,
  prepareProjectTemplateUpgrade,
  prepareProjectTemplateFromConversation,
  sanitizeTemplateName,
  validateProjectTemplateFiles,
} from "./project-templates";

const conversation: Conversation = {
  id: "conv-1",
  title: "Portfolio",
  messages: [{ role: "user", content: "Build a portfolio" }],
  files: {
    "src/App.tsx": "export function App() { return <main />; }",
    "README.md": "你好",
  },
  template: "vite-react-ts",
  isProjectInitialized: true,
  createdAt: 1,
  updatedAt: 2,
};

describe("project template utilities", () => {
  it("prepares a safe deterministic copy before the template is persisted", async () => {
    const prepared = await prepareProjectTemplateFromConversation(
      {
        ...conversation,
        files: {
          ...conversation.files,
          ".env.production": "API_KEY=never-copy-this",
          ".env.example": "API_KEY=your_api_key",
          "src/config.ts": 'export const api_key = "abcdefgh-secret";',
          "src/auth.ts": `
            const token = "abcdefgh-token";
            const headers = { Authorization: "Bearer abcdefgh-token" };
          `,
          "src/App.test.tsx": "it('renders', () => {});",
          "package.json": JSON.stringify({
            dependencies: { react: "19.0.0" },
            devDependencies: { vite: "4.2.0", vitest: "4.0.0" },
          }),
        },
        activeFile: "src/App.tsx",
      },
      {
        id: "template-safe",
        name: "Safe React",
        tags: ["starter"],
        now: 12,
      },
    );

    expect(prepared.report).toEqual({
      excludedPaths: [".env.production"],
      redactedPaths: ["src/auth.ts", "src/config.ts"],
    });
    expect(prepared.template.files[".env.production"]).toBeUndefined();
    expect(prepared.template.files[".env.example"]).toBe(
      "API_KEY=your_api_key",
    );
    expect(prepared.template.files["src/config.ts"]).toContain("[REDACTED]");
    expect(prepared.template.files["src/auth.ts"]).not.toContain(
      "abcdefgh-token",
    );
    expect(prepared.template).toMatchObject({
      schemaVersion: 2,
      activeFile: "src/App.tsx",
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      safety: {
        status: "safe",
        excludedPaths: [".env.production"],
        redactedPaths: ["src/auth.ts", "src/config.ts"],
        preparedAt: 12,
      },
      analysis: {
        framework: "React",
        language: "TypeScript",
        tests: ["Vitest"],
        autoTags: ["react", "typescript", "vitest"],
      },
    });
  });

  it("rejects prototype properties as unsupported runtimes", async () => {
    await expect(
      prepareProjectTemplateFromConversation(
        { ...conversation, template: "constructor" },
        { id: "prototype-runtime", name: "Unsafe", now: 1 },
      ),
    ).rejects.toThrow(/unsupported project runtime/i);
  });

  it("rejects empty project starters", async () => {
    await expect(
      prepareProjectTemplateFromConversation(
        { ...conversation, files: {}, isProjectInitialized: false },
        { id: "template-1", name: "Empty", now: 10 },
      ),
    ).rejects.toThrow("Cannot create a template from an empty project.");
  });

  it("rejects project templates that exceed storage budgets", async () => {
    expect(
      validateProjectTemplateFiles({
        "src/large.ts": "x".repeat(PROJECT_TEMPLATE_LIMITS.maxFileBytes + 1),
      }),
    ).toEqual({
      ok: false,
      error: `Project template file "src/large.ts" is too large (max ${PROJECT_TEMPLATE_LIMITS.maxFileBytes} bytes).`,
    });

    await expect(
      prepareProjectTemplateFromConversation(
        {
          ...conversation,
          files: {
            "src/large.ts": "x".repeat(
              PROJECT_TEMPLATE_LIMITS.maxFileBytes + 1,
            ),
          },
        },
        { id: "template-1", name: "Large", now: 10 },
      ),
    ).rejects.toThrow("too large");
  });

  it("creates a new initialized conversation from a template", async () => {
    const { template } = await prepareProjectTemplateFromConversation(
      { ...conversation, files: { "src/App.tsx": "dashboard" } },
      { id: "template-1", name: "Dashboard", now: 1 },
    );

    const next = await createConversationFromProjectTemplate(template, {
      id: "conv-2",
      now: 20,
    });

    expect(next).toMatchObject({
      id: "conv-2",
      title: "Dashboard",
      messages: [],
      template: "vite-react-ts",
      isProjectInitialized: true,
      createdAt: 20,
      updatedAt: 20,
    });
    expect(next.files).toEqual(template.files);
    expect(next.files).not.toBe(template.files);
  });

  it("materializes only project authority and verified applied Design state", async () => {
    const designSystem = {
      id: "graphite",
      name: "Graphite",
      source: "builtin" as const,
      version: "2.0.0",
      digest: "b".repeat(64),
    };
    const tokens = `:root {
  --bg: #fff; --surface: #fff; --fg: #111; --muted: #666;
  --border: #ddd; --accent: #6541f5; --accent-on: #fff;
  --success: #188038; --warn: #9a6700; --danger: #d1242f;
  --font-display: system-ui; --font-body: system-ui; --radius-md: 8px;
  --section-y-desktop: 96px; --container-max: 1200px; --motion-base: 180ms;
}`;
    const prepared = await prepareProjectTemplateFromConversation(
      {
        ...conversation,
        files: { ...conversation.files, "tokens.css": tokens },
        activeFile: "src/App.tsx",
        compressedContext: { summary: "private context", fromIndex: 1 },
        localAgentSessions: {
          codex: {
            provider: "codex",
            sessionId: "thread-private",
            transcriptFingerprint: "fp",
            cliVersion: "1",
            updatedAt: 1,
          },
        },
        designState: {
          selectedSystem: designSystem,
          appliedSystem: designSystem,
          recommendation: {
            systemId: "other",
            reason: "temporary",
            createdAt: 1,
          },
          autoSelectionError: true,
        },
      },
      { id: "verified", name: "Verified", now: 20 },
    );

    const next = await createConversationFromProjectTemplate(
      prepared.template,
      {
        id: "new-conversation",
        now: 30,
      },
    );

    expect(next).toMatchObject({
      activeFile: "src/App.tsx",
      workspaceMode: "auto",
      messages: [],
      designState: {
        selectedSystem: designSystem,
        appliedSystem: designSystem,
      },
      templateOrigin: {
        templateId: "verified",
        templateName: "Verified",
        contentDigest: prepared.template.contentDigest,
        createdAt: 30,
      },
    });
    expect(next.designState).not.toHaveProperty("recommendation");
    expect(next.designState).not.toHaveProperty("autoSelectionError");
    expect(next).not.toHaveProperty("compressedContext");
    expect(next).not.toHaveProperty("localAgentSessions");
    expect(
      inspectDesignTokenContract(next.files, next.designState).status,
    ).toBe("ready");
    expect(isProjectTemplateUsable(prepared.template)).toBe(true);
    expect(
      isProjectTemplateUsable({
        ...prepared.template,
        schemaVersion: 1,
        safety: { ...prepared.template.safety!, status: "pending-upgrade" },
      }),
    ).toBe(false);
  });

  it("rejects legacy and digest-tampered templates at materialization", async () => {
    const prepared = await prepareProjectTemplateFromConversation(
      conversation,
      { id: "safe", name: "Safe", now: 10 },
    );

    await expect(
      createConversationFromProjectTemplate(
        {
          ...prepared.template,
          files: { ...prepared.template.files, "src/App.tsx": "tampered" },
        },
        { id: "tampered", now: 20 },
      ),
    ).rejects.toThrow(/digest/i);
    await expect(
      createConversationFromProjectTemplate(
        {
          ...prepared.template,
          schemaVersion: 1,
          safety: { ...prepared.template.safety!, status: "pending-upgrade" },
        },
        { id: "legacy", now: 20 },
      ),
    ).rejects.toThrow(/upgrade/i);
  });

  it("rechecks sensitive paths and credentials even when a v2 record claims to be safe", async () => {
    const prepared = await prepareProjectTemplateFromConversation(
      conversation,
      { id: "safe", name: "Safe", now: 10 },
    );
    const forged = {
      ...prepared.template,
      files: {
        ...prepared.template.files,
        ".env.local": "API_KEY=abcdefgh-secret",
      },
    };

    expect(getProjectTemplateUsability(forged)).toEqual({
      ok: false,
      reason: "sensitive-content",
    });
    await expect(
      createConversationFromProjectTemplate(forged, {
        id: "forged",
        now: 20,
      }),
    ).rejects.toThrow(/safely upgraded/i);
  });

  it("upgrades a retained v1 starter from its own files without using the current project", async () => {
    const legacy: ProjectTemplate = {
      id: "legacy-safe-runtime",
      name: "Legacy starter",
      description: "Keep this metadata",
      files: {
        "src/App.tsx": "legacy app",
        ".env.local": "API_KEY=abcdefgh-secret",
      },
      template: "vite-react-ts",
      tags: ["legacy"],
      schemaVersion: 1,
      safety: {
        status: "pending-upgrade",
        excludedPaths: [],
        redactedPaths: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };

    const upgraded = await prepareProjectTemplateUpgrade(legacy, 30);

    expect(upgraded.template).toMatchObject({
      id: legacy.id,
      name: legacy.name,
      description: legacy.description,
      files: { "src/App.tsx": "legacy app" },
      schemaVersion: 2,
      safety: { status: "safe", excludedPaths: [".env.local"] },
    });
    expect(isProjectTemplateUsable(upgraded.template)).toBe(true);
  });

  it("digests identical files independently of insertion order", async () => {
    const first = await prepareProjectTemplateFromConversation(
      {
        ...conversation,
        files: { "z.ts": "z", "A.ts": "a", "ä.ts": "umlaut" },
      },
      { id: "first", name: "First", now: 1 },
    );
    const second = await prepareProjectTemplateFromConversation(
      {
        ...conversation,
        files: { "ä.ts": "umlaut", "A.ts": "a", "z.ts": "z" },
      },
      { id: "second", name: "Second", now: 2 },
    );

    expect(second.template.contentDigest).toBe(first.template.contentDigest);
  });

  it("normalizes labels and reports template stats", () => {
    expect(sanitizeTemplateName("   ")).toBe("Untitled Template");
    expect(
      normalizeTemplateTags([" admin ", "admin", "", "crm  tool"]),
    ).toEqual(["admin", "crm tool"]);
    expect(getProjectTemplateStats({ files: conversation.files })).toEqual({
      fileCount: 2,
      totalBytes: 48,
    });
  });

  it("analyzes retained v1 templates lazily without changing their files", () => {
    const legacy: ProjectTemplate = {
      id: "legacy",
      name: "Legacy Vue",
      files: {
        "package.json": JSON.stringify({ dependencies: { vue: "3.0.0" } }),
        "src/App.vue": "<template />",
      },
      template: "vite-vue",
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };

    expect(getProjectTemplateAnalysis(legacy)).toMatchObject({
      framework: "Vue",
      language: "HTML/CSS",
      autoTags: ["vue", "html/css"],
    });
    expect(legacy.analysis).toBeUndefined();
  });
});
