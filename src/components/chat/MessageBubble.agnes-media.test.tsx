// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { useInteractiveStore } from "../../store/interactive";
import type { MergedMessage, ToolBlock } from "../../types";
import { AGNES_TOOL_ALIASES } from "../../lib/mcp/agnes/aliases";
import {
  AGNES_MCP_SERVER_ID,
  AGNES_MCP_SERVER_NAME,
} from "../../lib/mcp/agnes/types";
import { MessageBubble } from "./MessageBubble";

vi.mock("./ToolCallCard", () => ({
  ToolCallCard: () => <div data-testid="generic-tool-card" />,
}));

function message(block: ToolBlock): MergedMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    blocks: [block],
  };
}

function imageBlock(overrides: Partial<ToolBlock> = {}): ToolBlock {
  return {
    id: "tool-image",
    type: "tool",
    toolName: AGNES_TOOL_ALIASES.generate_image,
    title: "Agnes AI · Generate image",
    path: "",
    result: "",
    toolCallId: "call-image",
    rawArgs: { prompt: "A paper garden", ratio: "1:1" },
    ...overrides,
  };
}

describe("Agnes direct conversation media", () => {
  beforeEach(() => {
    useInteractiveStore.setState({ pending: [] });
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
  });

  it("renders a direct placeholder instead of ToolCallCard while generating", () => {
    render(<MessageBubble message={message(imageBlock())} />);

    expect(screen.getByText("Generating image...")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveStyle({ aspectRatio: "1 / 1" });
    expect(screen.queryByTestId("generic-tool-card")).not.toBeInTheDocument();
  });

  it("replaces the placeholder with the remote image in the same block", () => {
    render(
      <MessageBubble
        message={message(
          imageBlock({
            result: "completed",
            toolOutput: {
              text: "completed",
              structuredContent: {
                kind: "agnes_media_v1",
                operation: "generate_image",
                mediaType: "image",
                status: "completed",
                urls: ["https://cdn.example.com/generated.png"],
                ratio: "1:1",
              },
              source: {
                kind: "mcp",
                serverId: AGNES_MCP_SERVER_ID,
                serverName: AGNES_MCP_SERVER_NAME,
                toolName: "generate_image",
                toolTitle: "Generate image",
                alias: AGNES_TOOL_ALIASES.generate_image,
              },
            },
          }),
        )}
      />,
    );

    const image = screen.getByRole("img", { name: "Generated image 1" });
    expect(image).toHaveAttribute(
      "src",
      "https://cdn.example.com/generated.png",
    );
    expect(screen.queryByText("Generating image...")).not.toBeInTheDocument();
    expect(screen.queryByTestId("generic-tool-card")).not.toBeInTheDocument();
  });

  it("does not treat an external MCP identity as Agnes even if history uses its alias", () => {
    render(
      <MessageBubble
        message={message(
          imageBlock({
            toolOutput: {
              text: "external",
              source: {
                kind: "mcp",
                serverId: "external",
                serverName: "External",
                toolName: "generate_image",
                alias: AGNES_TOOL_ALIASES.generate_image,
              },
            },
          }),
        )}
      />,
    );

    expect(screen.getByTestId("generic-tool-card")).toBeInTheDocument();
    expect(screen.queryByText("Generating image...")).not.toBeInTheDocument();
  });

  it("does not present a persisted video task as actively polling after restart", () => {
    render(
      <MessageBubble
        message={message({
          id: "tool-video",
          type: "tool",
          toolName: AGNES_TOOL_ALIASES.create_video,
          title: "Agnes AI · Create video",
          path: "",
          result: "queued",
          toolCallId: "call-video",
          rawArgs: { prompt: "A paper garden", aspect_ratio: "16:9" },
          toolOutput: {
            text: "queued",
            structuredContent: {
              kind: "agnes_media_v1",
              operation: "create_video",
              mediaType: "video",
              status: "queued",
              videoId: "video_1",
              progress: 0,
              pollingState: "active",
              pollingSessionId: "previous-app-session",
            },
            source: {
              kind: "mcp",
              serverId: AGNES_MCP_SERVER_ID,
              serverName: AGNES_MCP_SERVER_NAME,
              toolName: "create_video",
              toolTitle: "Create video",
              alias: AGNES_TOOL_ALIASES.create_video,
            },
          },
        })}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Automatic status checks do not resume after restart",
    );
    expect(status).toHaveAttribute("aria-busy", "false");
  });

  it("renders an approved subagent image event directly instead of using its inner ToolCallCard", async () => {
    const user = userEvent.setup();
    render(
      <MessageBubble
        message={message({
          id: "tool-subagent",
          type: "tool",
          toolName: "dispatch_subagent",
          title: "Code Explorer",
          path: "",
          result: JSON.stringify({
            ok: true,
            subagent: "code-explorer",
            task: "Generate a reference image",
            status: "done",
            text: "",
            durationMs: 10,
            events: [
              {
                name: AGNES_TOOL_ALIASES.generate_image,
                toolCallId: "inner-image",
                resultPreview: JSON.stringify({
                  provider: "Agnes AI",
                  operation: "generate_image",
                  status: "completed",
                  urls: ["https://cdn.example.com/subagent.png"],
                }),
              },
            ],
          }),
          toolCallId: "call-subagent",
          rawArgs: {
            subagent: "code-explorer",
            task: "Generate a reference image",
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Code Explorer/ }));
    expect(
      screen.getByRole("img", { name: "Generated image 1" }),
    ).toHaveAttribute("src", "https://cdn.example.com/subagent.png");
    expect(screen.queryByTestId("generic-tool-card")).not.toBeInTheDocument();
  });
});
