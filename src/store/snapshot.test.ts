import { createPatch } from "diff";
import { describe, expect, it } from "vitest";
import {
  rebuildSnapshotChainWithoutSnapshot,
  replaySnapshotAssets,
  replaySnapshots,
} from "./snapshot-replay";
import type { ProjectSnapshot } from "../types";

describe("replaySnapshots", () => {
  it("restores asset references without embedding image bytes", () => {
    const asset = {
      path: "public/generated/hero.png",
      blobRef: `sha256:${"a".repeat(64)}`,
      mimeType: "image/png" as const,
      size: 9,
      digest: "a".repeat(64),
      modulePath: "src/generated-assets/hero-aaaaaaaa.js",
      publicPath: "/generated/hero.png",
    };
    const snapshot: ProjectSnapshot = {
      id: "assets",
      conversationId: "conv-1",
      messageId: "assistant-assets",
      patches: {},
      addedFiles: {},
      deletedFiles: [],
      assets: { [asset.path]: asset },
      createdAt: 1,
    };

    expect(replaySnapshotAssets([snapshot], snapshot.id)).toEqual({
      [asset.path]: asset,
    });
    expect(JSON.stringify(snapshot)).not.toContain("data:image");
  });

  it("reconstructs files from the nearest checkpoint to the requested snapshot", () => {
    const chain: ProjectSnapshot[] = [
      {
        id: "initial",
        conversationId: "conv-1",
        messageId: "assistant-0",
        patches: {},
        addedFiles: { "src/App.tsx": "old app\n", "README.md": "readme\n" },
        deletedFiles: [],
        createdAt: 1,
        kind: "checkpoint",
        fullFiles: { "src/App.tsx": "old app\n", "README.md": "readme\n" },
      },
      {
        id: "change",
        conversationId: "conv-1",
        messageId: "assistant-1",
        patches: {
          "src/App.tsx": createPatch("src/App.tsx", "old app\n", "new app\n"),
        },
        addedFiles: { "src/main.tsx": "mount();\n" },
        deletedFiles: ["README.md"],
        createdAt: 2,
        kind: "patch",
      },
    ];

    expect(replaySnapshots(chain, "change")).toEqual({
      "src/App.tsx": "new app\n",
      "src/main.tsx": "mount();\n",
    });
  });

  it("restores design-project.json with the same snapshot chain as source files", () => {
    const first =
      '{"schemaVersion":"open-builder-design-project/v1","revision":1}\n';
    const second =
      '{"schemaVersion":"open-builder-design-project/v1","revision":2}\n';
    const chain: ProjectSnapshot[] = [
      {
        id: "initial",
        conversationId: "conv-design",
        messageId: "assistant-0",
        patches: {},
        addedFiles: { "design-project.json": first, "src/App.tsx": "one\n" },
        deletedFiles: [],
        createdAt: 1,
        kind: "checkpoint",
        fullFiles: {
          "design-project.json": first,
          "src/App.tsx": "one\n",
        },
      },
      {
        id: "updated",
        conversationId: "conv-design",
        messageId: "assistant-1",
        patches: {
          "design-project.json": createPatch(
            "design-project.json",
            first,
            second,
          ),
        },
        addedFiles: {},
        deletedFiles: [],
        createdAt: 2,
        kind: "patch",
      },
    ];

    expect(replaySnapshots(chain, "updated")).toMatchObject({
      "design-project.json": second,
      "src/App.tsx": "one\n",
    });
  });

  it("rejects unknown targets instead of returning the latest version", () => {
    const chain: ProjectSnapshot[] = [
      {
        id: "one",
        conversationId: "conv-1",
        messageId: "assistant-0",
        patches: {},
        addedFiles: { "a.txt": "A\n" },
        deletedFiles: [],
        createdAt: 1,
      },
      {
        id: "two",
        conversationId: "conv-1",
        messageId: "assistant-1",
        patches: { "a.txt": createPatch("a.txt", "A\n", "B\n") },
        addedFiles: {},
        deletedFiles: [],
        createdAt: 2,
      },
    ];

    expect(() => replaySnapshots(chain, "missing")).toThrow(/does not exist/);
  });

  it("rebuilds the patch chain when deleting a middle snapshot", () => {
    const chain: ProjectSnapshot[] = [
      {
        id: "one",
        conversationId: "conv-1",
        messageId: "assistant-0",
        patches: {},
        addedFiles: { "a.txt": "A\n" },
        deletedFiles: [],
        createdAt: 1,
        kind: "checkpoint",
        fullFiles: { "a.txt": "A\n" },
      },
      {
        id: "two",
        conversationId: "conv-1",
        messageId: "assistant-1",
        patches: { "a.txt": createPatch("a.txt", "A\n", "B\n") },
        addedFiles: {},
        deletedFiles: [],
        createdAt: 2,
        kind: "patch",
      },
      {
        id: "three",
        conversationId: "conv-1",
        messageId: "assistant-2",
        patches: { "a.txt": createPatch("a.txt", "B\n", "C\n") },
        addedFiles: { "b.txt": "B file\n" },
        deletedFiles: [],
        createdAt: 3,
        kind: "patch",
      },
    ];

    const rebuilt = rebuildSnapshotChainWithoutSnapshot(chain, "two");

    expect(rebuilt.map((snapshot) => snapshot.id)).toEqual(["one", "three"]);
    expect(replaySnapshots(rebuilt, "three")).toEqual({
      "a.txt": "C\n",
      "b.txt": "B file\n",
    });
  });
});
