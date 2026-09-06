import { beforeEach, describe, expect, it } from "vitest";
import { useProjectDesignWorkspaceStore } from "./project-design-workspace";

describe("project design workspace selection", () => {
  beforeEach(() => useProjectDesignWorkspaceStore.setState({ selections: {} }));

  it("keeps one page and scenario selection per conversation", () => {
    const store = useProjectDesignWorkspaceStore.getState();
    store.setSelection("project-a", {
      pageId: "details",
      scenarioId: "empty",
    });
    store.setSelection("project-b", {
      pageId: "settings",
      scenarioId: "default",
    });

    expect(
      useProjectDesignWorkspaceStore.getState().selections["project-a"],
    ).toEqual({ pageId: "details", scenarioId: "empty" });
    store.clearSelection("project-a");
    expect(
      useProjectDesignWorkspaceStore.getState().selections["project-a"],
    ).toBeUndefined();
    expect(
      useProjectDesignWorkspaceStore.getState().selections["project-b"],
    ).toBeDefined();
  });
});
