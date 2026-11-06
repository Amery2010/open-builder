// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollText } from "lucide-react";
import { useSettingsStore } from "../../store/settings";
import { TOOL_METADATA } from "../../lib/ai/tool-metadata";
import { ToolCallCard } from "./ToolCallCard";
import * as attachmentStore from "../../lib/attachments/store";

const originalSystem = useSettingsStore.getState().system;

describe("ToolCallCard UI", () => {
  afterEach(() => {
    useSettingsStore.getState().setSystem(originalSystem);
    vi.restoreAllMocks();
  });

  it.each(["host", "codex"])(
    "shows %s search sources after expansion",
    async (shape) => {
      const user = userEvent.setup();
      const results = [
        {
          title: "Codex documentation",
          url: "https://openai.com/codex",
          snippet: "Search documentation",
        },
        { title: "Unsafe link", url: "javascript:alert(1)" },
      ];
      render(
        <ToolCallCard
          toolName="web_search"
          title="Web search"
          path=""
          toolCallId="search"
          result={JSON.stringify(
            shape === "codex" ? results : { ok: true, results },
          )}
        />,
      );
      const trigger = screen.getByRole("button", {
        name: /Web search.*2 results.*Completed/,
      });
      expect(screen.queryByRole("link")).toBeNull();
      await user.click(trigger);
      const source = screen.getByRole("link", { name: /Codex documentation/ });
      expect(source).toHaveAttribute("href", "https://openai.com/codex");
      expect(source).toHaveAttribute("rel", "noopener noreferrer");
      expect(screen.getAllByRole("link")).toHaveLength(1);
      expect(screen.getByText("Search documentation")).toBeInTheDocument();
      expect(screen.queryByText(/Failed:/)).toBeNull();
    },
  );

  it.each([{ results: null }, { results: [] }])(
    "does not report missing native search details $results as zero results or failure",
    async ({ results }) => {
      const user = userEvent.setup();
      render(
        <ToolCallCard
          toolName="web_search"
          title="Web search"
          path=""
          toolCallId="search"
          result={JSON.stringify({ ok: true, results })}
        />,
      );
      await user.click(
        screen.getByRole("button", { name: /Web search.*Completed/ }),
      );
      expect(
        screen.getByText(
          "Search completed. No displayable source details were returned.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/0 results|Failed:/)).toBeNull();
    },
  );

  it("shows zero only for a confirmed empty Host search response", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallCard
        toolName="web_search"
        title="Web search"
        path=""
        toolCallId="host-empty-search"
        result={JSON.stringify({
          ok: true,
          results: [],
          meta: { engine: "tavily" },
        })}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Web search.*0 results.*Completed/ }),
    );
    expect(screen.getByText("Found 0 search results")).toBeInTheDocument();
    expect(screen.queryByText(/No displayable source details/)).toBeNull();
  });

  it("adds a localized accessible status without changing result payloads", () => {
    useSettingsStore.getState().setSystem({
      ...originalSystem,
      language: "zh",
    });

    render(
      <ToolCallCard
        toolName="image_search"
        title="搜索图片"
        path=""
        result={'{"ok":false,"error":"provider unavailable"}'}
        toolCallId="image-search"
      />,
    );

    expect(
      screen.getByRole("button", { name: /搜索图片.*失败/ }),
    ).toBeInTheDocument();
  });

  it("keeps compact file context badges separate from the tool title", () => {
    render(
      <ToolCallCard
        toolName="patch_file"
        title="Patch File"
        path="src/components/App.tsx"
        result="OK"
        toolCallId="patch-file"
      />,
    );

    expect(screen.getByText("Patch File")).toBeInTheDocument();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.queryByText(/path=/)).not.toBeInTheDocument();
  });

  it("shows npm package names, versions and descriptions only after expansion", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallCard
        toolName="search_npm_packages"
        title="Search NPM Packages"
        path=""
        toolCallId="npm-search"
        result={JSON.stringify({
          success: true,
          data: [
            {
              name: "@tanstack/react-query",
              version: "5.0.0",
              description: "Async state management",
            },
            { name: "zod", version: "4.0.0" },
          ],
        })}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /Search NPM Packages.*2 packages/,
    });
    expect(screen.queryByText("@tanstack/react-query")).toBeNull();
    await user.click(trigger);
    expect(screen.getByText("@tanstack/react-query")).toBeInTheDocument();
    expect(screen.getByText("5.0.0")).toBeInTheDocument();
    expect(screen.getByText("Async state management")).toBeInTheDocument();
    expect(screen.getByText("zod")).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.queryByText("zod")).toBeNull();
  });

  it.each([
    ['{"success":true,"data":[]}', "Found 0 npm packages"],
    [
      '{"success":false,"error":"registry unavailable"}',
      "registry unavailable",
    ],
  ])(
    "keeps npm empty and failed results readable: %s",
    async (result, text) => {
      const user = userEvent.setup();
      render(
        <ToolCallCard
          toolName="search_npm_packages"
          title="Search NPM Packages"
          path=""
          toolCallId="npm-search"
          result={result}
        />,
      );
      await user.click(
        screen.getByRole("button", { name: /Search NPM Packages/ }),
      );
      expect(screen.getByText(text, { exact: false })).toBeInTheDocument();
      expect(screen.queryByRole("list")).toBeNull();
    },
  );

  it("localizes MCP result chrome while preserving third-party content", async () => {
    useSettingsStore.getState().setSystem({
      ...originalSystem,
      language: "zh",
    });
    const user = userEvent.setup();

    render(
      <ToolCallCard
        toolName="mcp_demo_lookup_abc123"
        title="Demo Server · Lookup Records"
        path=""
        result="third-party result"
        toolCallId="mcp-call"
        toolOutput={{
          text: "third-party result",
          structuredContent: { count: 1 },
          content: [
            {
              type: "image",
              data: "iVBORw0KGgo=",
              mimeType: "image/png",
            },
          ],
          source: {
            kind: "mcp",
            serverId: "demo",
            serverName: "Demo Server",
            toolName: "lookup",
            toolTitle: "Lookup Records",
            alias: "mcp_demo_lookup_abc123",
          },
        }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Demo Server.*已完成/ }),
    );
    expect(screen.getByText("结构化内容")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "MCP 工具结果" }),
    ).toBeInTheDocument();
  });

  it("loads persisted generated images without embedding bytes in history", async () => {
    const user = userEvent.setup();
    vi.spyOn(attachmentStore, "getAttachmentBlob").mockResolvedValue(
      new Blob(["image"], { type: "image/png" }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:generated-image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    render(
      <ToolCallCard
        toolName="generate_image"
        title="Generate image"
        path=""
        result="Generated image: result.png"
        toolCallId="generate-image"
        toolOutput={{
          text: "Generated image: result.png",
          content: [
            {
              type: "local_image",
              id: "generated-image",
              name: "result.png",
              mimeType: "image/png",
              size: 5,
            },
          ],
        }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Generate image.*Completed/ }),
    );
    expect(
      await screen.findByRole("img", { name: "result.png" }),
    ).toHaveAttribute("src", "blob:generated-image");
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "download",
      "result.png",
    );
  });

  it("keeps successful Skill loads expandable without exposing instructions", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallCard
        toolName="read_skill"
        title="Code review"
        path=""
        result="# Skill: Code review\n\nPrivate full instructions"
        rawArgs={{ name: "Code review" }}
        toolCallId="read-skill"
      />,
    );

    expect(screen.getByText("Code review")).toBeInTheDocument();
    expect(screen.queryByText(/Private full instructions/)).toBeNull();
    const trigger = screen.getByRole("button", {
      name: /Code review.*Completed/,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Code review")).toHaveLength(2);
    expect(screen.queryByText(/Private full instructions/)).toBeNull();
  });

  it("keeps failed read_skill results expandable for diagnosis", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallCard
        toolName="read_skill"
        title="Code review"
        path=""
        result='Error: skill "Code review" not found or not enabled.'
        rawArgs={{ name: "Code review" }}
        toolCallId="read-skill-failed"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Code review.*Failed/ }),
    );
    expect(screen.getByText(/not found or not enabled/)).toBeInTheDocument();
  });

  it("renders one expandable partial Skill-load summary", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallCard
        toolName="read_skill"
        title="Load Skills"
        path=""
        result=""
        toolCallId="skills"
        skillLoads={[
          {
            name: "review-code",
            referencePaths: ["security.md"],
            status: "completed",
          },
          {
            name: "design-product-ui",
            status: "failed",
            error: "Error: unavailable",
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /Load Skills.*Needs attention/,
    });
    await user.click(trigger);
    expect(screen.getByText("review-code")).toBeInTheDocument();
    expect(screen.getByText("security.md")).toBeInTheDocument();
    expect(screen.getByText("design-product-ui")).toBeInTheDocument();
    expect(screen.getByText("Error: unavailable")).toBeInTheDocument();
  });

  it("uses the same ScrollText icon for listing and loading Skills", () => {
    expect(TOOL_METADATA.list_skills.iconComponent).toBe(ScrollText);
    expect(TOOL_METADATA.read_skill.iconComponent).toBe(ScrollText);
  });
});
