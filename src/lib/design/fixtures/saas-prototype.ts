export const SAAS_PROTOTYPE_BLUEPRINT_FIXTURE = {
  schemaVersion: "open-builder-design-project/v1",
  productGoal:
    "Let a support team manage customer requests from intake to resolution.",
  audience: "Support operations teams",
  revision: 4,
  pages: [
    ["login", "Login", "Authenticate a prototype user", "/login", "auth"],
    ["overview", "Overview", "Summarize team workload", "/", "dashboard"],
    ["requests", "Requests", "Filter and browse requests", "/requests", "list"],
    [
      "request-detail",
      "Request detail",
      "Inspect one request",
      "/requests/detail",
      "detail",
    ],
    [
      "request-editor",
      "Request editor",
      "Create or edit a request",
      "/requests/edit",
      "form",
    ],
    [
      "settings",
      "Settings",
      "Manage workspace preferences",
      "/settings",
      "settings",
    ],
  ].map(([id, name, responsibility, route, kind], index) => ({
    id,
    name,
    responsibility,
    route,
    kind,
    defaultScenario: "default",
    parentId: index > 1 ? "overview" : null,
    layoutId: id === "login" ? null : "app-shell",
    filePaths: [`src/pages/${id}.tsx`],
    sharedUiRefs: id === "login" ? [] : ["primary-navigation"],
    flowIds: id === "login" ? ["sign-in"] : ["manage-requests"],
    scenarioIds:
      id === "requests"
        ? ["default", "loading", "empty", "error"]
        : id === "request-editor"
          ? ["default", "validation", "success"]
          : ["default"],
  })),
  layouts: [
    {
      id: "app-shell",
      name: "Application shell",
      kind: "app-shell",
      filePaths: ["src/layouts/AppShell.tsx"],
      pageIds: [
        "overview",
        "requests",
        "request-detail",
        "request-editor",
        "settings",
      ],
      sharedUiRefs: ["primary-navigation"],
    },
  ],
  sharedUiRefs: [
    {
      id: "primary-navigation",
      name: "Primary navigation",
      kind: "navigation",
      filePaths: ["src/components/PrimaryNavigation.tsx"],
    },
  ],
  flows: [
    {
      id: "sign-in",
      name: "Sign in",
      pageIds: ["login", "overview"],
      scenarioIds: ["default"],
    },
    {
      id: "manage-requests",
      name: "Manage requests",
      pageIds: ["overview", "requests", "request-detail", "request-editor"],
      scenarioIds: ["default", "validation", "success"],
    },
  ],
  scenarios: [
    { id: "default", name: "Default", kind: "default" },
    { id: "loading", name: "Loading", kind: "loading" },
    { id: "empty", name: "Empty", kind: "empty" },
    { id: "error", name: "Load failed", kind: "error" },
    { id: "validation", name: "Validation errors", kind: "validation" },
    { id: "success", name: "Saved", kind: "success" },
  ],
  buildProgress: {
    status: "complete",
    percent: 100,
    completedPageIds: [
      "login",
      "overview",
      "requests",
      "request-detail",
      "request-editor",
      "settings",
    ],
    completedFlowIds: ["sign-in", "manage-requests"],
    checkpoints: [
      "foundation",
      "core_flow",
      "remaining_flows",
      "final_review",
    ].map((phase) => ({
      phase,
      status: "completed",
      pageIds: [],
      flowIds: [],
      artifactPaths: ["src/App.tsx"],
      validation: { status: "passed", summary: `${phase} fixture passed` },
      recordedAt: "2026-09-05T12:00:00.000Z",
    })),
  },
} as const;
