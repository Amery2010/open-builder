// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PROJECT_DESIGN_SCHEMA_VERSION } from "../../lib/design/project-design";
import type { ProjectDesign } from "../../lib/design/project-design";
import { ProjectDesignOutlineDialog } from "./ProjectDesignOutlineDialog";

const design: ProjectDesign = {
  schemaVersion: PROJECT_DESIGN_SCHEMA_VERSION,
  productGoal: "Manage customer work",
  audience: "Operations teams",
  revision: 1,
  pages: [
    {
      id: "dashboard",
      name: "Dashboard",
      responsibility: "Summarize active work",
      route: "/dashboard",
      kind: "dashboard",
      defaultScenario: "default",
      parentId: null,
      layoutId: null,
      filePaths: ["src/pages/Dashboard.tsx"],
      sharedUiRefs: [],
      flowIds: [],
      scenarioIds: ["default"],
    },
  ],
  layouts: [],
  sharedUiRefs: [],
  flows: [],
  scenarios: [{ id: "default", name: "Default", kind: "default" }],
  buildProgress: {
    status: "in-progress",
    percent: 25,
    completedPageIds: [],
    completedFlowIds: [],
    checkpoints: [],
  },
};

describe("ProjectDesignOutlineDialog", () => {
  it("saves light outline edits with an advanced revision", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ProjectDesignOutlineDialog
        open
        design={design}
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );

    const pageName = screen.getByLabelText("Page name");
    await user.clear(pageName);
    await user.type(pageName, "Workspace overview");
    await user.click(screen.getByRole("button", { name: "Save outline" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      revision: 2,
      pages: [{ id: "dashboard", name: "Workspace overview" }],
    });
  });
});
