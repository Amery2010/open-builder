import { describe, expect, it, vi } from "vitest";
import { WebAppGenerator } from "../generator";
import { BUILTIN_TOOLS } from "../tools-schema";
import { DISPATCH_SUBAGENT_TOOL } from "../../tools/subagent-tool";

const authorityPaths = [
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  "src/Agents.MD",
  "src/features/ClAuDe.Md",
  "jsconfig.json",
  "JSCONFIG.JSON",
  "jsconfig.app.json",
  "src/jsconfig.test.json",
  "src/JsConfig.build.test.JSON",
];

describe("delegated instruction and shared configuration protection", () => {
  it.each(authorityPaths)(
    "rejects ownership of %s at Host dispatch without changing the parent",
    async (path) => {
      const initialFiles = {
        [path]: "Original authority",
        "src/App.tsx": "original",
      };
      const dispatchSubagent = vi.fn();
      const commitDelegatedProjectFiles = vi.fn();
      const instance = new WebAppGenerator({
        apiBaseUrl: "https://test.invalid",
        apiKey: "test",
        model: "test",
        tools: { ...BUILTIN_TOOLS, ...DISPATCH_SUBAGENT_TOOL },
        initialFiles,
        dispatchSubagent,
        commitDelegatedProjectFiles,
      });
      (instance as unknown as { ctrl: AbortController }).ctrl =
        new AbortController();
      const outcome = await instance.executeToolCall({
        id: "authority-write",
        type: "function",
        function: {
          name: "dispatch_subagent",
          arguments: JSON.stringify({
            subagent: "code-writer",
            task: "Change project instructions",
            writePaths: [path],
          }),
        },
      });
      expect(outcome.result.isError).toBe(true);
      expect(outcome.result.text).toContain("protected file");
      expect(dispatchSubagent).not.toHaveBeenCalled();
      expect(commitDelegatedProjectFiles).not.toHaveBeenCalled();
      expect(instance.getFiles()).toEqual(initialFiles);
    },
  );
});
