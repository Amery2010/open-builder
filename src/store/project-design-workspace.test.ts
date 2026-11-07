import { beforeEach, describe, expect, it } from "vitest";
import { useProjectDesignWorkspaceStore } from "./project-design-workspace";

describe("project design workspace selection", () => {
  beforeEach(() => useProjectDesignWorkspaceStore.setState({ selections: {} }));

  it("keeps one page selection per conversation", () => {
    const store = useProjectDesignWorkspaceStore.getState();
    store.setSelection("project-a", {
      pageId: "details",
    });
    store.setSelection("project-b", {
      pageId: "settings",
    });

    expect(
      useProjectDesignWorkspaceStore.getState().selections["project-a"],
    ).toEqual({ pageId: "details" });
    store.clearSelection("project-a");
    expect(
      useProjectDesignWorkspaceStore.getState().selections["project-a"],
    ).toBeUndefined();
    expect(
      useProjectDesignWorkspaceStore.getState().selections["project-b"],
    ).toBeDefined();
  });
});
