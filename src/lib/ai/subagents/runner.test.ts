import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAppGenerator } from "../generator";
import type { GeneratorEvents, GeneratorOptions } from "../generator-types";
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
  it("flushes received output on Stop and rejects output before the backend settles", async () => {
    const controller = new AbortController();
    let callbacks: GeneratorEvents;
    let finish = () => {};
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = runSubagent({
      ...options(),
      signal: controller.signal,
      createGenerator: (config, events) => {
        callbacks = events;
        const generator = new WebAppGenerator(config, events);
        vi.spyOn(generator, "generate").mockImplementation(async () => {
          events.onText?.("Received before Stop");
          started();
          await waiting;
          return {
            files: {},
            messages: [],
            text: "Received before Stop LATE",
            aborted: true,
            maxIterationsReached: false,
          };
        });
        return generator;
      },
    });
    await ready;
    controller.abort();
    const stopped = useSubagentStore.getState().progress["subagent-1"];
    expect(stopped.status).toBe("aborted");
    expect(stopped.text).toBe("Received before Stop");
    callbacks!.onText?.(" LATE");
    callbacks!.onToolCall?.("read_files", "late-tool");
    expect(useSubagentStore.getState().progress["subagent-1"]).toBe(stopped);
    finish();
    expect(JSON.parse((await run).text).text).toBe("Received before Stop");
  });
  it("persists an explicit completed state for a successful empty tool result", async () => {
    const result = await runSubagent({
      ...options(),
      createGenerator: (config, events) => {
        const generator = new WebAppGenerator(config, events);
        vi.spyOn(generator, "generate").mockImplementation(async () => {
          events.onToolCall?.("read_files", "read-empty");
          events.onToolResult?.(
            "read_files",
            { paths: ["empty.txt"] },
            "",
            "read-empty",
            { text: "", isError: false },
          );
          return {
            files: {},
            messages: [],
            text: "Finished",
            aborted: false,
            maxIterationsReached: false,
          };
        });
        return generator;
      },
    });
    expect(JSON.parse(result.text).events).toEqual([
      expect.objectContaining({
        toolCallId: "read-empty",
        status: "completed",
        resultPreview: "",
        finishedAt: expect.any(Number),
        toolOutput: { text: "", isError: false },
      }),
    ]);
  });

  it("closes unfinished nested events when a child is cancelled", async () => {
    const result = await runSubagent({
      ...options(),
      createGenerator: (config, events) => {
        const generator = new WebAppGenerator(config, events);
        vi.spyOn(generator, "generate").mockImplementation(async () => {
          events.onToolCall?.("read_files", "read-cancelled");
          return {
            files: {},
            messages: [],
            text: "",
            aborted: true,
            maxIterationsReached: false,
          };
        });
        return generator;
      },
    });
    expect(JSON.parse(result.text).events[0]).toMatchObject({
      status: "aborted",
      finishedAt: expect.any(Number),
    });
  });

  it("applies tool output retention before persisting child events", async () => {
    const result = await runSubagent({
      ...options(),
      createGenerator: (config, events) => {
        const generator = new WebAppGenerator(config, events);
        vi.spyOn(generator, "generate").mockImplementation(async () => {
          // Some providers send only the result event, without a start event.
          events.onToolResult?.(
            "read_files",
            {},
            "PRIVATE_RESULT",
            "retained",
            {
              text: "PRIVATE_RESULT",
              retention: "run-only",
              structuredContent: { secret: "PRIVATE_STRUCTURED" },
            },
          );
          return {
            files: {},
            messages: [],
            text: "Finished",
            aborted: false,
            maxIterationsReached: false,
          };
        });
        return generator;
      },
    });
    expect(result.text).not.toContain("PRIVATE");
    expect(JSON.parse(result.text).events[0]).toMatchObject({
      toolCallId: "retained",
      status: "completed",
    });
    const before = useSubagentStore.getState().progress["subagent-1"];
    useSubagentStore.getState().appendText("subagent-1", "late");
    useSubagentStore.getState().setToolResult("subagent-1", "retained", "late");
    expect(useSubagentStore.getState().progress["subagent-1"]).toBe(before);
  });

  it("streams public lifecycle callbacks into live progress and aligns final text", async () => {
    const result = await runSubagent({
      ...options(),
      createGenerator: (config, events) => {
        const generator = new WebAppGenerator(config, events);
        vi.spyOn(generator, "generate").mockImplementation(async () => {
          events.onThinking?.("Inspecting the project");
          events.onRetry?.(1, 2, new Error("temporary failure"));
          events.onLocalCliStatus?.({
            state: "streaming",
            message: "Output arrived",
          });
          events.onLocalCliWarning?.("The provider sent a delayed chunk.");
          return {
            files: {},
            messages: [],
            text: "Final text supplied by the generator.",
            aborted: false,
            maxIterationsReached: false,
          };
        });
        return generator;
      },
    });

    const progress = useSubagentStore.getState().progress["subagent-1"];
    expect(progress.text).toBe("Final text supplied by the generator.");
    expect(progress.status).toBe("done");
    expect(progress.activities.map((activity) => activity.kind)).toEqual([
      "thinking",
      "retry",
      "status",
      "warning",
      "output",
    ]);
    expect(JSON.parse(result.text)).toMatchObject({
      text: "Final text supplied by the generator.",
      events: [],
    });
    expect(JSON.stringify(JSON.parse(result.text))).not.toContain(
      "temporary failure",
    );
  });

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

describe("developer subagent completion", () => {
  it("keeps successful work provisional until its parent commits it", async () => {
    const authorizeWrite = vi.fn(async () => {});
    const result = await runSubagent({
      ...options(),
      name: "code-writer",
      writePaths: ["src/feature.ts"],
      authorizeWrite,
      createGenerator: (config, events) => {
        expect(config.executionMode).toBe("subagent");
        expect(config.subagentWritePaths).toEqual(["src/feature.ts"]);
        const generator = new WebAppGenerator(config, events);
        vi.spyOn(generator, "generate").mockImplementation(async () => {
          (generator as unknown as { ctrl: AbortController }).ctrl =
            new AbortController();
          const output = await generator.executeToolCall({
            id: "write-owned",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "src/feature.ts",
                content: "export const enabled = true;",
              }),
            },
          });
          expect(output.result.isError).not.toBe(true);
          return {
            files: generator.getFiles(),
            messages: [],
            text: "Implemented",
            aborted: false,
            maxIterationsReached: false,
          };
        });
        return generator;
      },
    });
    expect(authorizeWrite).toHaveBeenCalledTimes(2);
    expect(result.edits).toEqual([
      {
        path: "src/feature.ts",
        before: undefined,
        content: "export const enabled = true;",
      },
    ]);
    expect(useSubagentStore.getState().progress["subagent-1"].status).toBe(
      "running",
    );
    const final = JSON.parse(result.complete!());
    expect(final).toMatchObject({ ok: true, status: "done" });
    expect(final.text).toContain("src/feature.ts");
    expect(useSubagentStore.getState().progress["subagent-1"].status).toBe(
      "done",
    );
  });
  it.each(["budget", "unowned", "deleted"])(
    "discards %s work",
    async (failure) => {
      const result = await runSubagent({
        ...options(),
        name: "code-writer",
        writePaths: ["src/feature.ts"],
        authorizeWrite: async () => {},
        createGenerator: (config, events) => {
          const generator = new WebAppGenerator(config, events);
          vi.spyOn(generator, "generate").mockImplementation(async () => {
            if (failure === "deleted") generator.setFiles({});
            else
              generator.setFiles({
                ...config.initialFiles,
                [failure === "unowned" ? "src/other.ts" : "src/feature.ts"]:
                  "changed",
              });
            return {
              files: generator.getFiles(),
              messages: [],
              text: "Partial",
              aborted: false,
              maxIterationsReached: failure === "budget",
            };
          });
          return generator;
        },
      });
      expect(JSON.parse(result.text)).toMatchObject({
        ok: false,
        status: "failed",
      });
      expect(result.edits).toBeUndefined();
      expect(useSubagentStore.getState().progress["subagent-1"].status).toBe(
        "failed",
      );
    },
  );
});
