import { describe, expect, it, vi } from "vitest";
import { WebAppGenerator } from "./generator";
import { BUILTIN_TOOLS } from "./tools-schema";
import { DISPATCH_SUBAGENT_TOOL } from "../tools/subagent-tool";
import type {
  DispatchSubagentResult,
  GeneratorOptions,
  ProjectFiles,
  ToolCall,
} from "./generator-types";
import { collectDelegatedEdits } from "./subagents/delegated-edits";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function call(
  name: string,
  input: unknown,
  id: string = crypto.randomUUID(),
): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}
function dispatch(path: string, id: string = crypto.randomUUID()): ToolCall {
  return call(
    "dispatch_subagent",
    { subagent: "code-writer", task: "Implement", writePaths: [path] },
    id,
  );
}
function result(
  files: ProjectFiles,
  path: string,
  content: string,
): DispatchSubagentResult {
  return {
    text: JSON.stringify({ ok: true, status: "done" }),
    edits: collectDelegatedEdits(files, { ...files, [path]: content }, [path]),
  };
}
function generator(options: Partial<GeneratorOptions> = {}) {
  const instance = new WebAppGenerator({
    apiBaseUrl: "https://test.invalid",
    apiKey: "test",
    model: "test",
    tools: { ...BUILTIN_TOOLS, ...DISPATCH_SUBAGENT_TOOL },
    ...options,
  });
  const controller = new AbortController();
  (instance as unknown as { ctrl: AbortController }).ctrl = controller;
  return {
    instance,
    controller,
    execute: (tool: ToolCall) => instance.executeToolCall(tool),
  };
}

describe("scoped delegated writes", () => {
  it("rejects a failed canonical compare-and-set without advancing the parent", async () => {
    const initial = { "src/a.ts": "initial" };
    const commit = vi.fn(() => false);
    const { execute, instance } = generator({
      initialFiles: initial,
      getCurrentProjectFiles: () => initial,
      commitDelegatedProjectFiles: commit,
      dispatchSubagent: async (_n, _t, files) =>
        result(files, "src/a.ts", "bad"),
    });
    expect((await execute(dispatch("src/a.ts"))).result.text).toContain(
      "before delegated edits could commit",
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(instance.getFiles()).toEqual(initial);
  });

  it("merges three simultaneous tasks without overwriting siblings", async () => {
    const started = [deferred(), deferred(), deferred()];
    const finish = [deferred(), deferred(), deferred()];
    let canonical: ProjectFiles = {
      "src/a.ts": "a",
      "src/b.ts": "b",
      "src/c.ts": "c",
    };
    const { execute, instance } = generator({
      initialFiles: canonical,
      getCurrentProjectFiles: () => canonical,
      commitDelegatedProjectFiles: (expected, next) => {
        expect(canonical).toBe(expected);
        canonical = next;
        return true;
      },
      dispatchSubagent: async (
        _name,
        _task,
        files,
        _signal,
        id,
        _conversation,
        paths,
      ) => {
        const i = Number(id);
        started[i].resolve();
        await finish[i].promise;
        return result(files, paths![0], `new${i}`);
      },
    });
    const tasks = ["src/a.ts", "src/b.ts", "src/c.ts"].map((path, i) =>
      execute(dispatch(path, String(i))),
    );
    await Promise.all(started.map((s) => s.promise));
    finish[2].resolve();
    await tasks[2];
    finish[0].resolve();
    await tasks[0];
    finish[1].resolve();
    await tasks[1];
    expect(canonical).toEqual({
      "src/a.ts": "new0",
      "src/b.ts": "new1",
      "src/c.ts": "new2",
    });
    expect(instance.getFiles()).toEqual(canonical);
  });
  it("queues overlapping owners and captures their baseline when they start", async () => {
    const start = deferred();
    const finish = deferred();
    const snapshots: string[] = [];
    const { execute, instance } = generator({
      initialFiles: { "src/a.ts": "initial" },
      dispatchSubagent: async (_n, _t, files, _s, id) => {
        snapshots.push(files["src/a.ts"]);
        if (id === "first") {
          start.resolve();
          await finish.promise;
        }
        return result(files, "src/a.ts", id);
      },
    });
    const first = execute(dispatch("src/a.ts", "first"));
    await start.promise;
    const second = execute(dispatch("src/a.ts", "second"));
    await Promise.resolve();
    expect(snapshots).toEqual(["initial"]);
    finish.resolve();
    await Promise.all([first, second]);
    expect(snapshots).toEqual(["initial", "first"]);
    expect(instance.getFiles()["src/a.ts"]).toBe("second");
  });
  it("rejects an entire conflicting task and preserves user edits", async () => {
    const start = deferred();
    const finish = deferred();
    const complete = vi.fn();
    let canonical = { "src/a.ts": "initial", "src/b.ts": "initial" };
    const commit = vi.fn(() => true);
    const { execute } = generator({
      initialFiles: canonical,
      getCurrentProjectFiles: () => canonical,
      commitDelegatedProjectFiles: commit,
      dispatchSubagent: async (_n, _t, files) => {
        start.resolve();
        await finish.promise;
        return {
          text: JSON.stringify({ ok: true, status: "done" }),
          edits: collectDelegatedEdits(
            files,
            { "src/a.ts": "agent", "src/b.ts": "agent" },
            ["src/a.ts", "src/b.ts"],
          ),
          complete,
        };
      },
    });
    const task = execute(
      call("dispatch_subagent", {
        subagent: "code-writer",
        task: "Implement",
        writePaths: ["src/a.ts", "src/b.ts"],
      }),
    );
    await start.promise;
    canonical = { ...canonical, "src/a.ts": "user" };
    finish.resolve();
    expect((await task).result.text).toContain("conflict");
    expect(commit).not.toHaveBeenCalled();
    expect(canonical).toEqual({ "src/a.ts": "user", "src/b.ts": "initial" });
    expect(complete).toHaveBeenCalledOnce();
  });
  it.each([
    "package.json",
    "tokens.css",
    "design-project.json",
    "src/generated-assets/test.js",
    ".env",
    "../other.ts",
  ])("rejects protected ownership %s before dispatch", async (path) => {
    const run = vi.fn();
    const { execute } = generator({ dispatchSubagent: run });
    expect((await execute(dispatch(path))).result.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it("keeps Plan and unscoped subagent runs read-only", async () => {
    const run = vi.fn();
    expect(
      (
        await generator({
          executionMode: "plan",
          dispatchSubagent: run,
        }).execute(dispatch("src/a.ts"))
      ).result.isError,
    ).toBe(true);
    expect(
      (
        await generator({ executionMode: "subagent" }).execute(
          call("write_file", { path: "src/a.ts", content: "bad" }),
        )
      ).result.isError,
    ).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it("enforces each inner write and restricts destructive tools", async () => {
    const { execute, instance } = generator({
      executionMode: "subagent",
      subagentWritePaths: ["src/a.ts"],
    });
    expect(
      (await execute(call("write_file", { path: "src/b.ts", content: "bad" })))
        .result.isError,
    ).toBe(true);
    expect(
      (await execute(call("write_file", { path: "src/a.ts", content: "good" })))
        .result.isError,
    ).not.toBe(true);
    expect(
      (await execute(call("delete_file", { path: "src/a.ts" }))).result.isError,
    ).toBe(true);
    expect(instance.getFiles()).toEqual({ "src/a.ts": "good" });
  });
  it.each(["failed", "aborted"])(
    "does not merge edits from a %s task",
    async (status) => {
      const { execute, instance } = generator({
        initialFiles: { "src/a.ts": "initial" },
        dispatchSubagent: async (_n, _t, files) => ({
          ...result(files, "src/a.ts", "bad"),
          text: JSON.stringify({ ok: false, status }),
        }),
      });
      await execute(dispatch("src/a.ts"));
      expect(instance.getFiles()["src/a.ts"]).toBe("initial");
    },
  );
  it.each(["stop", "authority"])(
    "rejects late edits after %s",
    async (action) => {
      const start = deferred();
      const finish = deferred();
      const complete = vi.fn();
      const { execute, instance, controller } = generator({
        initialFiles: { "src/a.ts": "initial" },
        dispatchSubagent: async (_n, _t, files) => {
          start.resolve();
          await finish.promise;
          return { ...result(files, "src/a.ts", "late"), complete };
        },
      });
      const task = execute(dispatch("src/a.ts"));
      const outcome = task.catch((error) => error);
      await start.promise;
      if (action === "stop") controller.abort();
      else instance.rotateProjectPermissionAuthority();
      finish.resolve();
      await outcome;
      expect(instance.getFiles()["src/a.ts"]).toBe("initial");
      expect(complete).toHaveBeenCalledOnce();
    },
  );
  it("checks current parent authorization again immediately before merge", async () => {
    let denied = false;
    const { execute, instance } = generator({
      initialFiles: { "src/a.ts": "initial" },
      authorizeToolCall: () => (denied ? "Design contract changed" : undefined),
      dispatchSubagent: async (_n, _t, files) => {
        denied = true;
        return result(files, "src/a.ts", "bad");
      },
    });
    expect((await execute(dispatch("src/a.ts"))).result.text).toContain(
      "Design contract changed",
    );
    expect(instance.getFiles()["src/a.ts"]).toBe("initial");
  });
});
