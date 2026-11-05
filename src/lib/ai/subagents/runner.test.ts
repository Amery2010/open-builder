import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAppGenerator } from "../generator";
import type { GeneratorOptions } from "../generator-types";
import { runSubagent, type RunSubagentOpts } from "./runner";
import * as registry from "./registry";
import { useSubagentStore } from "../../../store/subagent";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

function streamParts(parts: readonly unknown[]) {
  return {
    stream: (async function* () {
      for (const part of parts) yield part;
    })(),
  };
}

function options(): RunSubagentOpts {
  return {
    name: "code-explorer",
    task: "Inspect the project",
    files: { "index.html": "<h1>Project</h1>" },
    signal: new AbortController().signal,
    toolCallId: "subagent-1",
    parentApiConfig: {
      apiType: "openai-compatible",
      apiBaseUrl: "https://example.test/v1",
      apiKey: "test",
      model: "test",
    },
    parentCustomToolSet: {},
    parentCombinedToolHandler: vi.fn(),
    parentCustomSystemPrompt: "",
    parentForcedSkillsPrompt: "",
    parentSkillContext: null,
    additionalToolNames: new Set(),
  };
}

beforeEach(() => {
  useSubagentStore.setState({ progress: {} });
});
afterEach(() => {
  streamTextMock.mockReset();
  vi.restoreAllMocks();
});

describe("subagent iteration policy", () => {
  it("closes progress when the asynchronous generator factory fails", async () => {
    const result = await runSubagent({
      ...options(),
      createGenerator: async () => {
        throw new Error("Generator preparation failed");
      },
    });
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      status: "failed",
      error: "Generator preparation failed",
    });
    expect(useSubagentStore.getState().progress["subagent-1"].status).toBe(
      "failed",
    );
  });

  it("does not start a child when the parent stops during generator preparation", async () => {
    const controller = new AbortController();
    const result = await runSubagent({
      ...options(),
      signal: controller.signal,
      createGenerator: async (config, events) => {
        controller.abort();
        return new WebAppGenerator(config, events);
      },
    });
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      status: "aborted",
    });
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("lets a default subagent finish beyond ten model iterations", async () => {
    let requests = 0;
    let receivedOptions: GeneratorOptions | undefined;
    streamTextMock.mockImplementation(() => {
      requests += 1;
      return requests <= 12
        ? streamParts([
            {
              type: "tool-call",
              toolCallId: `read-${requests}`,
              toolName: "list_files",
              input: {},
            },
          ])
        : streamParts([{ type: "text-delta", text: "Inspection finished." }]);
    });
    const result = await runSubagent({
      ...options(),
      createGenerator: (config, events) => {
        receivedOptions = config;
        return new WebAppGenerator(config, events);
      },
    });

    expect(receivedOptions?.maxIterations).toBeUndefined();
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      status: "done",
      text: "Inspection finished.",
    });
    expect(streamTextMock).toHaveBeenCalledTimes(13);
    expect(useSubagentStore.getState().progress["subagent-1"].status).toBe(
      "done",
    );
  });

  it("reports an explicitly bounded subagent as unfinished when it reaches that budget", async () => {
    const definition = registry.getSubagentByName("code-explorer")!;
    vi.spyOn(registry, "getSubagentByName").mockReturnValue({
      ...definition,
      maxIterations: 1,
    });
    streamTextMock.mockReturnValue(
      streamParts([
        { type: "text-delta", text: "Partial inspection." },
        {
          type: "tool-call",
          toolCallId: "read-1",
          toolName: "list_files",
          input: {},
        },
      ]),
    );

    const result = await runSubagent(options());

    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      status: "failed",
      text: "Partial inspection.",
      error: expect.stringContaining("iteration limit"),
    });
    expect(useSubagentStore.getState().progress["subagent-1"].status).toBe(
      "failed",
    );
    expect(streamTextMock).toHaveBeenCalledOnce();
  });
});
