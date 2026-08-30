import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message } from "../ai/generator-types";
import { en } from "../../i18n/en";
import { zh } from "../../i18n/zh";
import type { ThinkingBlock } from "../../types";
import { TOOL_CAPABILITY_REGISTRY } from "../ai/tools-schema";
import { AGNES_TOOL_ALIASES } from "../mcp/agnes/aliases";
import { AGNES_MCP_SERVER_ID, AGNES_MCP_SERVER_NAME } from "../mcp/agnes/types";

function createStorageStub(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("mergeMessages", () => {
  beforeAll(() => {
    vi.stubGlobal("localStorage", createStorageStub());
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("groups user attachments and hides background memory tool calls", async () => {
    const { mergeMessages } = await import("./merge-messages");
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Build a dashboard" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,abc" },
          },
          { type: "text", text: "[File: spec.txt | 12]\nHello world!" },
        ],
      },
      {
        role: "assistant",
        content: "I'll update the files.",
        tool_calls: [
          {
            id: "call-memory",
            type: "function",
            function: {
              name: "manage_memories",
              arguments: '{"operations":[]}',
            },
          },
          {
            id: "call-patch",
            type: "function",
            function: {
              name: "patch_file",
              arguments: '{"path":"src/App.tsx","patches":[]}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-memory",
        content: "OK",
      },
      {
        role: "tool",
        tool_call_id: "call-patch",
        content: "OK — modified: src/App.tsx",
      },
    ];

    const merged = mergeMessages(messages);

    expect(merged).toHaveLength(2);
    expect(merged[0].role).toBe("user");
    expect(merged[0].blocks.map((b) => b.type)).toEqual([
      "text",
      "image",
      "file",
    ]);
    expect(merged[1].role).toBe("assistant");
    expect(
      merged[1].blocks.some(
        (block) =>
          block.type === "tool" && block.toolName === "manage_memories",
      ),
    ).toBe(false);
    expect(
      merged[1].blocks.some(
        (block) => block.type === "tool" && block.toolName === "patch_file",
      ),
    ).toBe(true);
  });

  it("keeps each assistant thinking phase in its original tool-loop position", async () => {
    const { mergeMessages } = await import("./merge-messages");
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        thinking: "Inspect the current implementation.",
        tool_calls: [
          {
            id: "read-current",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"src/App.tsx"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "read-current",
        content: "export default function App() {}",
      },
      {
        role: "assistant",
        content: "The implementation is ready.",
        thinking: "Verify the focused change.",
      },
    ];

    const blocks = mergeMessages(messages, en)[0].blocks;

    expect(blocks.map((block) => block.type)).toEqual([
      "thinking",
      "tool",
      "thinking",
      "text",
    ]);
    expect(
      blocks
        .filter((block): block is ThinkingBlock => block.type === "thinking")
        .map((block) => ({ id: block.id, content: block.content })),
    ).toEqual([
      {
        id: "thinking-0",
        content: "Inspect the current implementation.",
      },
      { id: "thinking-2", content: "Verify the focused change." },
    ]);
  });

  it("covers every registered visible tool and local-provider tool with both locales", () => {
    const registeredVisibleTools = Object.keys(TOOL_CAPABILITY_REGISTRY).filter(
      // `memory` is the known policy-name mismatch; the real
      // `manage_memories` call remains intentionally hidden in this UI.
      (name) => name !== "memory",
    );
    const providerAndLegacyTools = [
      "read_file",
      "read_attachment",
      "WebSearch",
      "WebFetch",
    ];

    for (const name of [...registeredVisibleTools, ...providerAndLegacyTools]) {
      expect(zh.tool.names).toHaveProperty(name);
      expect(en.tool.names).toHaveProperty(name);
    }
  });

  it("localizes known, pending MCP and unknown tool titles without losing identifiers", async () => {
    const { mergeMessages } = await import("./merge-messages");
    const toolCalls = [
      ["health", "project_health_check", "{}"],
      ["openai-search", "web_search_preview", '{"query":"React 19"}'],
      ["google-search", "google_search", "{}"],
      ["legacy-read", "read_file", '{"path":"src/App.tsx"}'],
      ["attachment", "read_attachment", "{}"],
      ["claude-search", "WebSearch", '{"query":"release notes"}'],
      ["claude-fetch", "WebFetch", "{}"],
      ["pending-mcp", "mcp_demo_lookup_abc123", "{}"],
      ["unknown", "future_tool", '{"query":"diagnostics"}'],
    ] as const;
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map(([id, name, args]) => ({
          id,
          type: "function" as const,
          function: { name, arguments: args },
        })),
      },
    ];

    const titlesFor = (translations: typeof zh) =>
      mergeMessages(messages, translations)[0]
        .blocks.filter((block) => block.type === "tool")
        .map((block) => block.title);

    expect(titlesFor(zh)).toEqual([
      "检查项目健康状态",
      "搜索网络: React 19",
      "Google 搜索",
      "读取文件",
      "读取附件",
      "搜索网络: release notes",
      "读取网页",
      "MCP 工具",
      "未知工具 · future_tool: diagnostics",
    ]);
    expect(titlesFor(en)).toEqual([
      "Check Project Health",
      "Web Search: React 19",
      "Google Search",
      "Read File",
      "Read Attachment",
      "Web Search: release notes",
      "Read Web Page",
      "MCP Tool",
      "Unknown Tool · future_tool: diagnostics",
    ]);
  });

  it("uses completed MCP identity from rich output", async () => {
    const { mergeMessages } = await import("./merge-messages");
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "mcp-call",
            type: "function",
            function: { name: "mcp_demo_lookup_abc123", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "mcp-call",
        content: "done",
        toolOutput: {
          text: "done",
          source: {
            kind: "mcp",
            serverId: "demo",
            serverName: "Demo Server",
            toolName: "lookup",
            toolTitle: "Lookup Records",
            alias: "mcp_demo_lookup_abc123",
          },
        },
      },
    ];

    const block = mergeMessages(messages, zh)[0].blocks.find(
      (candidate) => candidate.type === "tool",
    );
    expect(block).toMatchObject({ title: "Demo Server · Lookup Records" });
  });

  it("summarizes read_skill without exposing the loaded instructions", async () => {
    const { mergeMessages } = await import("./merge-messages");
    const fullResult =
      "# Skill: Code review\n\nFull instructions sent back to the model.";
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read-skill-main",
            type: "function",
            function: {
              name: "read_skill",
              arguments: JSON.stringify({ name: "Code review" }),
            },
          },
          {
            id: "read-skill",
            type: "function",
            function: {
              name: "read_skill",
              arguments: JSON.stringify({
                name: "Code review",
                reference_path: "references/security.md",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "read-skill-main",
        content: "# Skill: Code review\n\nPrivate main instructions",
      },
      {
        role: "tool",
        tool_call_id: "read-skill",
        content: fullResult,
      },
    ];

    const block = mergeMessages(messages, zh)[0].blocks.find(
      (candidate) => candidate.type === "tool",
    );
    expect(block).toMatchObject({
      title: "加载技能",
      result: "",
      skillLoads: [
        {
          name: "Code review",
          referencePaths: ["references/security.md"],
          status: "completed",
        },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("Private main instructions");
  });

  it("merges list_skills and multiple reads at the first Skill-call position", async () => {
    const { mergeMessages } = await import("./merge-messages");
    const messages: Message[] = [
      {
        role: "assistant",
        content: "Preparing guidance.",
        tool_calls: [
          {
            id: "list-skills",
            type: "function",
            function: { name: "list_skills", arguments: "{}" },
          },
          {
            id: "read-review",
            type: "function",
            function: {
              name: "read_skill",
              arguments: JSON.stringify({ name: "review-code" }),
            },
          },
          {
            id: "read-design",
            type: "function",
            function: {
              name: "read_skill",
              arguments: JSON.stringify({ name: "design-product-ui" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "list-skills",
        content: "Enabled skills",
      },
      {
        role: "tool",
        tool_call_id: "read-review",
        content: "# Skill: review-code\n\nPrivate review instructions",
      },
      {
        role: "tool",
        tool_call_id: "read-design",
        content: 'Error: skill "design-product-ui" not found.',
      },
    ];

    const blocks = mergeMessages(messages, en)[0].blocks;
    expect(blocks.map((block) => block.type)).toEqual(["text", "tool"]);
    expect(blocks[1]).toMatchObject({
      type: "tool",
      toolName: "read_skill",
      title: "Load Skills",
      skillLoads: [
        { name: "review-code", status: "completed" },
        {
          name: "design-product-ui",
          status: "failed",
          error: 'Error: skill "design-product-ui" not found.',
        },
      ],
    });
    expect(JSON.stringify(blocks)).not.toContain("Private review instructions");
  });

  it("keeps one Agnes video block when a manual status call updates its origin", async () => {
    const { mergeMessages } = await import("./merge-messages");
    const source = (toolName: "create_video" | "get_video_status") => ({
      kind: "mcp" as const,
      serverId: AGNES_MCP_SERVER_ID,
      serverName: AGNES_MCP_SERVER_NAME,
      toolName,
      toolTitle:
        toolName === "create_video" ? "Create video" : "Get video status",
      alias: AGNES_TOOL_ALIASES[toolName],
    });
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "create-call",
            type: "function",
            function: {
              name: AGNES_TOOL_ALIASES.create_video,
              arguments: '{"prompt":"A lake"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "create-call",
        content: "completed",
        toolOutput: {
          text: "completed",
          structuredContent: {
            kind: "agnes_media_v1",
            operation: "create_video",
            mediaType: "video",
            status: "completed",
            videoId: "video_1",
            progress: 100,
            urls: ["https://cdn.example.com/video.mp4"],
          },
          source: source("create_video"),
        },
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "status-call",
            type: "function",
            function: {
              name: AGNES_TOOL_ALIASES.get_video_status,
              arguments: '{"video_id":"video_1"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "status-call",
        content: "completed",
        toolOutput: {
          text: "completed",
          structuredContent: {
            kind: "agnes_media_v1",
            operation: "get_video_status",
            mediaType: "video",
            status: "completed",
            videoId: "video_1",
            progress: 100,
            urls: ["https://cdn.example.com/video.mp4"],
          },
          source: source("get_video_status"),
        },
      },
    ];

    const toolBlocks = mergeMessages(messages, en).flatMap((message) =>
      message.blocks.filter((block) => block.type === "tool"),
    );
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({
      toolCallId: "create-call",
      toolName: AGNES_TOOL_ALIASES.create_video,
    });
  });
});
