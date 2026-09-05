import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../ai/generator-types";
import { TOOL_POLICY_VERSION } from "../../ai/tool-policy-version";
import { createSkillActiveContext } from "../../skills/active-context";
import { useMcpStore } from "../../../store/mcp";
import { AGNES_TOOL_ALIASES } from "./aliases";
import { AgnesMcpService } from "./service";
import {
  AGNES_MCP_SERVER_ID,
  createDefaultAgnesMcpSettings,
  type AgnesToolName,
} from "./types";

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  createVideo: vi.fn(),
  getVideoStatus: vi.fn(),
  registerVideo: vi.fn(),
  applyManualResult: vi.fn(),
}));

vi.mock("localforage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    createInstance: () => ({
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    }),
  },
}));

vi.mock("./client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./client")>();
  return {
    ...original,
    generateAgnesImage: mocks.generateImage,
    createAgnesVideo: mocks.createVideo,
    getAgnesVideoStatus: mocks.getVideoStatus,
  };
});

vi.mock("./video-task-manager", () => ({
  getAgnesVideoTaskManager: () => ({
    register: mocks.registerVideo,
    applyManualResult: mocks.applyManualResult,
    stopAll: vi.fn(),
  }),
}));

function context(
  mode: ToolExecutionContext["run"]["mode"],
  toolName: AgnesToolName,
): ToolExecutionContext {
  const alias = AGNES_TOOL_ALIASES[toolName];
  return {
    signal: new AbortController().signal,
    toolCallId: `call-${toolName}`,
    skillContext: createSkillActiveContext(),
    run: {
      runId: "run-1",
      conversationId: "conversation-1",
      mode,
      platform: "web",
      runtime: "api",
      allowedMcpAliases: new Set([alias]),
      activeSkillIds: new Set(),
      approvedSkillScriptHashes: new Set(),
      policyVersion: TOOL_POLICY_VERSION,
    },
  };
}

function configure(...enabledTools: AgnesToolName[]) {
  const agnes = createDefaultAgnesMcpSettings(10);
  agnes.enabled = true;
  agnes.apiKey = "agnes-secret";
  for (const name of enabledTools) agnes.tools[name].enabled = true;
  useMcpStore.setState({ globalEnabled: true, agnes });
  return agnes;
}

describe("managed Agnes MCP service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateImage.mockResolvedValue({
      urls: ["https://cdn.example.com/generated.png"],
      retried: false,
      duplicatePossible: false,
    });
    mocks.createVideo.mockResolvedValue({
      videoId: "video_1",
      taskId: "task-1",
      status: "queued",
      progress: 0,
      seconds: "5",
      size: "720P",
      retried: false,
      duplicatePossible: false,
    });
  });

  it("uses 1K and 1:1 image defaults and returns persistable media output", async () => {
    configure("generate_image");
    const service = new AgnesMcpService();
    const output = await service.callTool(
      AGNES_MCP_SERVER_ID,
      "generate_image",
      { prompt: "A paper-cut mountain" },
      context("chat", "generate_image"),
    );

    expect(mocks.generateImage).toHaveBeenCalledWith(
      {
        prompt: "A paper-cut mountain",
        size: "1K",
        ratio: "1:1",
        images: [],
      },
      expect.objectContaining({ apiKey: "agnes-secret" }),
    );
    expect(output).toMatchObject({
      isError: false,
      structuredContent: {
        kind: "agnes_media_v1",
        operation: "generate_image",
        status: "completed",
        urls: ["https://cdn.example.com/generated.png"],
      },
      source: {
        serverId: AGNES_MCP_SERVER_ID,
        toolName: "generate_image",
      },
    });
    expect(JSON.stringify(output)).not.toContain("agnes-secret");
  });

  it("grants subagents only separately approved image generation without attachment IDs", async () => {
    const agnes = configure("generate_image", "create_video");
    agnes.tools.generate_image.allowForSubagents = true;
    agnes.tools.generate_image.subagentPolicyVersion = TOOL_POLICY_VERSION;
    useMcpStore.setState({ agnes });
    const service = new AgnesMcpService();

    await expect(
      service.callTool(
        AGNES_MCP_SERVER_ID,
        "generate_image",
        { prompt: "Reference", attachment_ids: ["current"] },
        context("subagent", "generate_image"),
      ),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        mediaType: "image",
        status: "failed",
      },
    });
    expect(mocks.generateImage).not.toHaveBeenCalled();

    await expect(
      service.callTool(
        AGNES_MCP_SERVER_ID,
        "generate_image",
        {
          prompt: "Public reference",
          image_urls: ["https://cdn.example.com/reference.png"],
        },
        context("subagent", "generate_image"),
      ),
    ).resolves.toMatchObject({ isError: false });
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);

    await expect(
      service.callTool(
        AGNES_MCP_SERVER_ID,
        "create_video",
        { prompt: "Not allowed" },
        context("subagent", "create_video"),
      ),
    ).resolves.toMatchObject({ isError: true });
    expect(mocks.createVideo).not.toHaveBeenCalled();
  });

  it("uses 5-second 720P 16:9 video defaults and registers one origin task", async () => {
    configure("create_video");
    const service = new AgnesMcpService();
    const output = await service.callTool(
      AGNES_MCP_SERVER_ID,
      "create_video",
      { prompt: "Wind across a field" },
      context("chat", "create_video"),
    );

    expect(mocks.createVideo).toHaveBeenCalledWith(
      {
        prompt: "Wind across a field",
        seconds: 5,
        aspectRatio: "16:9",
      },
      expect.objectContaining({ apiKey: "agnes-secret" }),
    );
    expect(output).toMatchObject({
      structuredContent: {
        operation: "create_video",
        status: "queued",
        videoId: "video_1",
        ratio: "16:9",
      },
    });
    expect(mocks.registerVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        toolCallId: "call-create_video",
        videoId: "video_1",
      }),
    );
  });

  it("does not publish a subagent image after that grant is revoked", async () => {
    const agnes = configure("generate_image");
    agnes.tools.generate_image.allowForSubagents = true;
    agnes.tools.generate_image.subagentPolicyVersion = TOOL_POLICY_VERSION;
    useMcpStore.setState({ agnes });
    let resolveImage!: (value: {
      urls: string[];
      retried: boolean;
      duplicatePossible: boolean;
    }) => void;
    mocks.generateImage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveImage = resolve;
      }),
    );
    const service = new AgnesMcpService();
    const pending = service.callTool(
      AGNES_MCP_SERVER_ID,
      "generate_image",
      { prompt: "Revoked" },
      context("subagent", "generate_image"),
    );
    await vi.waitFor(() => expect(mocks.generateImage).toHaveBeenCalledOnce());

    useMcpStore.setState({
      agnes: {
        ...agnes,
        updatedAt: agnes.updatedAt + 1,
        tools: {
          ...agnes.tools,
          generate_image: {
            ...agnes.tools.generate_image,
            allowForSubagents: false,
            subagentPolicyVersion: undefined,
          },
        },
      },
    });
    resolveImage({
      urls: ["https://cdn.example.com/late.png"],
      retried: false,
      duplicatePossible: false,
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails closed when the run alias or managed server identity is wrong", async () => {
    configure("generate_image");
    const service = new AgnesMcpService();
    const baseContext = context("chat", "generate_image");
    const deniedContext: ToolExecutionContext = {
      ...baseContext,
      run: { ...baseContext.run, allowedMcpAliases: new Set() },
    };

    await expect(
      service.callTool(
        "external",
        "generate_image",
        { prompt: "Denied" },
        deniedContext,
      ),
    ).resolves.toMatchObject({ isError: true });
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });
});
