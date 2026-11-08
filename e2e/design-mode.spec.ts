import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { waitForAppReady } from "./helpers/app-ready";

const initialTokens = `:root {
  --bg: #ffffff;
  --surface: #f7f7f8;
  --fg: #161618;
  --muted: #68686f;
  --border: #dedee3;
  --accent: #6541f5;
  --accent-on: #ffffff;
  --success: #188038;
  --warn: #9a6700;
  --danger: #d1242f;
  --font-display: system-ui;
  --font-body: system-ui;
  --radius-md: 12px;
  --section-y-desktop: 96px;
  --container-max: 1120px;
  --motion-base: 180ms;
}`;

const projectFiles = {
  "index.html": `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/tokens.css" />
    <style>
      body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font-body); }
      main { min-height: 100vh; display: grid; place-items: center; }
      h1 { color: var(--accent); font: 700 56px/1 var(--font-display); }
      section { padding: 24px; }
      h2 { font: 600 24px/1.2 var(--font-display); }
      img { display: block; width: 48px; height: 48px; }
      button { border: 0; border-radius: var(--radius-md); padding: 12px 18px; background: var(--accent); color: var(--accent-on); }
    </style>
    <title>Design fixture</title>
  </head>
  <body>
    <main data-ob-id="hero">
      <section data-ob-id="hero-content">
        <h1 data-ob-id="hero-title">Hero title</h1>
        <h2 id="fine-grained-heading">Fine-grained heading</h2>
        <img id="fine-grained-image" alt="Independent preview" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48' fill='%236541f5'/%3E%3C/svg%3E" />
        <button data-ob-id="hero-cta" aria-label="Start building">Start building</button>
        <button data-ob-id="icon-action" aria-label="Icon action">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            <path id="decorative-icon-path" d="M4 12h16M12 4v16" fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
        </button>
      </section>
    </main>
  </body>
</html>`,
  "tokens.css": initialTokens,
};

async function seedDesignProject(
  page: import("@playwright/test").Page,
): Promise<string> {
  await page.goto("/");
  await waitForAppReady(page);
  const conversationId = await page.evaluate(
    async ({ files, tokens }) => {
      const conversationUrl = "/src/store/conversation.ts";
      const settingsUrl = "/src/store/settings/index.ts";
      const snapshotsUrl = "/src/store/snapshot.ts";
      const { useConversationStore } = await import(conversationUrl);
      const { useSettingsStore } = await import(settingsUrl);
      const { useSnapshotStore } = await import(snapshotsUrl);
      useSettingsStore.setState(
        (state: { system: Record<string, unknown> }) => ({
          system: { ...state.system, language: "en" },
        }),
      );
      const state = useConversationStore.getState();
      const id = state.activeId ?? state.createConversation();
      state.switchConversation(id);
      const replaced = state.replaceProject({
        files,
        template: "static",
        previewMode: "sandpack",
        activeFile: "index.html",
      });
      if (!replaced.ok) throw new Error(replaced.error);
      useConversationStore.getState().setWorkspaceMode("design");
      useConversationStore.getState().setDesignState({
        selectedSystem: {
          id: "stripe",
          name: "Stripe",
          source: "builtin",
          version: "e2e",
          digest: "a".repeat(64),
        },
        appliedSystem: {
          id: "stripe",
          name: "Stripe",
          source: "builtin",
          version: "e2e",
          digest: "a".repeat(64),
        },
      });
      useSnapshotStore.setState({ snapshots: {}, _hasHydrated: true });
      useSnapshotStore.getState().createSnapshot(id, "design-e2e-baseline", {
        ...files,
        "tokens.css": tokens,
      });
      return id;
    },
    { files: projectFiles, tokens: initialTokens },
  );
  await expect(page.getByTestId("design-canvas")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Preview", exact: true }),
  ).toBeVisible();
  return conversationId;
}

test("point-selects a real Sandpack element, keeps token edits pending until saved, and keeps Bridge out of export", async ({
  page,
}) => {
  await seedDesignProject(page);
  const frame = page.frameLocator("iframe").first();
  const heading = frame.locator('[data-ob-id="hero-title"]');
  await expect(heading).toBeVisible({ timeout: 60_000 });

  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: {
          type: "open-builder:design-bridge-selection",
          version: 1,
          nonce: "forged",
          payload: {
            protocolVersion: 1,
            elementId: "forged",
            label: "Forged",
            tagName: "div",
            route: "/",
          },
        },
      }),
    );
  });
  await expect(page.getByLabel("Selected preview element")).toHaveCount(0);

  await page
    .getByRole("button", { name: "Select an element in the preview" })
    .click();
  await frame.locator("body").evaluate(() => {
    window.parent.postMessage(
      {
        type: "open-builder:design-bridge-selection",
        version: 1,
        nonce: "00000000000000000000000000000000",
        payload: {
          protocolVersion: 1,
          elementId: "forged-from-frame",
          label: "Forged from frame",
          tagName: "div",
          route: "/",
        },
      },
      "*",
    );
  });
  await expect(page.getByLabel("Selected preview element")).toHaveCount(0);
  await heading.click();
  await expect(page.getByLabel("Selected preview element")).toContainText(
    "Editing Hero title",
  );
  await expect(page.getByText("hero-title", { exact: true })).toBeVisible();

  await page
    .getByRole("button", { name: "Select an element in the preview" })
    .click();
  await frame.locator("#fine-grained-heading").click();
  await expect(page.getByLabel("Selected preview element")).toContainText(
    "Editing Fine-grained heading",
  );
  await expect(
    page.getByText("hero-content › h2:nth-of-type(1)", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Select an element in the preview" })
    .click();
  await frame.locator("#fine-grained-image").click();
  await expect(page.getByLabel("Selected preview element")).toContainText(
    "Editing Independent preview",
  );
  await expect(
    page.getByText("hero-content › img:nth-of-type(1)", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Select an element in the preview" })
    .click();
  await frame.locator("#decorative-icon-path").click();
  await expect(page.getByLabel("Selected preview element")).toContainText(
    "Editing Icon action",
  );
  await expect(page.getByText("icon-action", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Pad" }).click();
  await expect(page.getByRole("button", { name: "Pad" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Mobile" }).click();
  await expect(page.getByRole("button", { name: "Mobile" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Web" }).click();
  const initialHeadingColor = await heading.evaluate(
    (node) => getComputedStyle(node).color,
  );

  await expect(
    page.getByRole("button", { name: "Edit design tokens" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Code" }).click();
  await page.getByRole("button", { name: "Edit design tokens" }).click();
  const accent = page.getByLabel("Accent", { exact: true });
  await accent.fill("#ff006e");
  await expect
    .poll(() => heading.evaluate((node) => getComputedStyle(node).color))
    .toBe(initialHeadingColor);
  const beforeSave = await page.evaluate(async () => {
    const url = "/src/store/conversation.ts";
    const { useConversationStore } = await import(url);
    const state = useConversationStore.getState();
    return state.conversations[state.activeId!].files["tokens.css"];
  });
  expect(beforeSave).toContain("--accent: #6541f5;");

  await page.getByRole("button", { name: "Save tokens" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect
    .poll(() => heading.evaluate((node) => getComputedStyle(node).color))
    .toBe("rgb(255, 0, 110)");
  const saved = await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const snapshotsUrl = "/src/store/snapshot.ts";
    const { useConversationStore } = await import(conversationUrl);
    const { useSnapshotStore } = await import(snapshotsUrl);
    const state = useConversationStore.getState();
    const id = state.activeId!;
    return {
      tokens: state.conversations[id].files["tokens.css"],
      snapshots: useSnapshotStore.getState().snapshots[id],
    };
  });
  expect(saved.tokens).toContain("--accent: #ff006e;");
  expect(saved.snapshots).toHaveLength(2);
  expect(saved.snapshots[1].label).toBe("Design token update");

  await page.getByRole("button", { name: "Code" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download project", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Download source", exact: true })
    .click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const zip = await JSZip.loadAsync(
    await (await import("node:fs/promises")).readFile(path!),
  );
  const names = Object.keys(zip.files);
  expect(names).not.toContain("__open_builder_design_bridge__.js");
  const exportedIndex = await zip.file("index.html")!.async("string");
  expect(exportedIndex).not.toContain("open-builder-design-bridge");
});

test("keeps the project default separate from a manual override while token and evidence Host tools use the live preview", async ({
  page,
}) => {
  test.slow();
  const conversationId = await seedDesignProject(page);
  const frame = page.frameLocator("iframe").first();
  const heading = frame.locator('[data-ob-id="hero-title"]');
  await expect(heading).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Web" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "Pad" }).click();
  const preference = await page.evaluate(async (id) => {
    const preferenceUrl = "/src/lib/design/preview-preference.ts";
    const conversationUrl = "/src/store/conversation.ts";
    const { setConversationDefaultPreviewView } = await import(preferenceUrl);
    const { useConversationStore } = await import(conversationUrl);
    const result = setConversationDefaultPreviewView({
      conversationId: id,
      view: "mobile",
    });
    return {
      result,
      stored:
        useConversationStore.getState().conversations[id].defaultPreviewView,
    };
  }, conversationId);
  expect(preference).toMatchObject({
    result: { ok: true, status: "updated", view: "mobile" },
    stored: "mobile",
  });
  await expect(page.getByRole("button", { name: "Pad" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const tokenMutation = await page.evaluate(async (id) => {
    const mutationUrl = "/src/lib/design/token-mutation-host.ts";
    const snapshotsUrl = "/src/store/snapshot.ts";
    const { mutateConversationDesignTokens } = await import(mutationUrl);
    const { useSnapshotStore } = await import(snapshotsUrl);
    const result = await mutateConversationDesignTokens({
      conversationId: id,
      principal: "model",
      acceptedDesignContract: {
        surface_mode: "operate",
        change_mode: "extend",
        target: "Design fixture",
        audience: "Preview users",
        primary_goal: "Verify the semantic accent",
        concept: "A precise test fixture",
        system_id: "stripe",
        translation: {
          foundations: "Retain the semantic token contract.",
          composition: "Preserve the centered fixture.",
          components: "Use the accent token for the heading.",
        },
        preserve: ["Existing structure and behavior"],
        acceptance: ["The live preview uses the updated accent"],
      },
      changes: [{ token: "--accent", value: "#0f766e" }],
      snapshotLabel: "Design token update",
    });
    return {
      ok: result.ok,
      status: result.ok ? result.status : result.code,
      snapshotCount: useSnapshotStore.getState().getSnapshots(id).length,
    };
  }, conversationId);
  expect(tokenMutation).toEqual({
    ok: true,
    status: "updated",
    snapshotCount: 2,
  });
  await expect
    .poll(() => heading.evaluate((node) => getComputedStyle(node).color))
    .toBe("rgb(15, 118, 110)");

  const evidence = await page.evaluate(async (id) => {
    const conversationUrl = "/src/store/conversation.ts";
    const evidenceUrl = "/src/lib/design/preview-evidence.ts";
    const diagnosticsUrl = "/src/lib/design/diagnostics.ts";
    const securityUrl = "/src/lib/utils/message-security.ts";
    const { useConversationStore } = await import(conversationUrl);
    const { capturePreviewEvidence } = await import(evidenceUrl);
    const { executeDesignDiagnostic } = await import(diagnosticsUrl);
    const { sanitizeToolExecutionOutputForHistory } = await import(securityUrl);
    const conversation = useConversationStore.getState().conversations[id];
    const output = await capturePreviewEvidence({
      conversationId: id,
      files: conversation.files,
      template: conversation.template,
      previewMode: conversation.previewMode ?? "sandpack",
      viewports: ["mobile", "desktop"],
    });
    const persisted = sanitizeToolExecutionOutputForHistory(
      "capture_preview_evidence",
      { viewports: ["mobile", "desktop"] },
      output,
    );
    const summary = output.structuredContent as {
      status: string;
      evidence: Array<{
        view: string;
        viewport: { width: number; height: number };
      }>;
    };
    const rawSemantic = output.content?.find((part) => part.type === "text");
    const persistedJson = JSON.stringify(persisted);
    const diagnosticContext = {
      conversationId: id,
      files: conversation.files,
      beforeFiles: conversation.files,
      template: conversation.template,
      previewMode: conversation.previewMode ?? "sandpack",
      designState: conversation.designState,
    };
    const consistency = await executeDesignDiagnostic(
      "inspect_design_consistency",
      {},
      diagnosticContext,
    );
    const layout = await executeDesignDiagnostic(
      "measure_preview_layout",
      { viewports: ["mobile"] },
      diagnosticContext,
    );
    const accessibility = await executeDesignDiagnostic(
      "audit_accessibility_tree",
      { viewports: ["mobile"] },
      diagnosticContext,
    );
    const comparison = await executeDesignDiagnostic(
      "compare_preview_states",
      { viewports: ["mobile"] },
      {
        ...diagnosticContext,
        history: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "e2e-baseline",
                type: "function",
                function: {
                  name: "capture_preview_evidence",
                  arguments: '{"viewports":["mobile","desktop"]}',
                },
              },
            ],
          },
          {
            role: "tool",
            content: persisted?.text ?? "",
            tool_call_id: "e2e-baseline",
            toolOutput: persisted,
          },
        ],
      },
    );
    const provenance = await executeDesignDiagnostic(
      "trace_design_provenance",
      {},
      diagnosticContext,
    );
    const diagnosticJson = JSON.stringify({
      consistency: consistency.structuredContent,
      layout: layout.structuredContent,
      accessibility: accessibility.structuredContent,
      comparison: comparison.structuredContent,
      provenance: provenance.structuredContent,
    });
    return {
      isError: output.isError === true,
      contentTypes: output.content?.map((part) => part.type),
      status: summary.status,
      evidence: summary.evidence.map((item) => ({
        view: item.view,
        width: item.viewport.width,
        height: item.viewport.height,
      })),
      rawSemanticIncludesHeading:
        rawSemantic?.type === "text" && rawSemantic.text.includes("Hero title"),
      persistedHasImageBlock: persistedJson.includes('"type":"image"'),
      persistedIncludesHeading: persistedJson.includes("Hero title"),
      persistedPlaceholderCount: persisted?.content?.filter(
        (part) => part.type === "placeholder",
      ).length,
      storedDefault:
        useConversationStore.getState().conversations[id].defaultPreviewView,
      diagnostics: {
        consistencyKind: (consistency.structuredContent as { kind?: string })
          ?.kind,
        layoutStatus: (layout.structuredContent as { status?: string })?.status,
        accessibilityStatus: (
          accessibility.structuredContent as { status?: string }
        )?.status,
        accessibilityConformance: (
          accessibility.structuredContent as { conformance?: string }
        )?.conformance,
        comparisonSucceeded: ["same", "changed"].includes(
          (comparison.structuredContent as { status?: string })?.status ?? "",
        ),
        provenanceKind: (provenance.structuredContent as { kind?: string })
          ?.kind,
        containsBase64: diagnosticJson.includes("data:image"),
      },
    };
  }, conversationId);
  expect(evidence).toEqual({
    isError: false,
    contentTypes: ["text", "image", "image"],
    status: "complete",
    evidence: [
      { view: "mobile", width: 375, height: 667 },
      { view: "desktop", width: 1440, height: 900 },
    ],
    rawSemanticIncludesHeading: true,
    persistedHasImageBlock: false,
    persistedIncludesHeading: false,
    persistedPlaceholderCount: 2,
    storedDefault: "mobile",
    diagnostics: {
      consistencyKind: "design_consistency_v1",
      layoutStatus: "complete",
      accessibilityStatus: "complete",
      accessibilityConformance: "not_assessed",
      comparisonSucceeded: true,
      provenanceKind: "design_provenance_v1",
      containsBase64: false,
    },
  });
  await expect(page.getByRole("button", { name: "Pad" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const otherConversationId = await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const { useConversationStore } = await import(conversationUrl);
    const state = useConversationStore.getState();
    const id = state.createConversation();
    state.switchConversation(id);
    return id;
  });
  expect(otherConversationId).not.toBe(conversationId);
  await expect(
    page.getByRole("button", { name: "Canvas", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(async (id) => {
    const conversationUrl = "/src/store/conversation.ts";
    const { useConversationStore } = await import(conversationUrl);
    useConversationStore.getState().switchConversation(id);
  }, conversationId);
  await expect(page.getByTestId("design-canvas")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mobile" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.evaluate(async (id) => {
    const preferenceUrl = "/src/lib/design/preview-preference.ts";
    const { setConversationDefaultPreviewView } = await import(preferenceUrl);
    setConversationDefaultPreviewView({ conversationId: id, view: "desktop" });
  }, conversationId);
  await expect(page.getByRole("button", { name: "Web" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("keeps Design Review read-only until selected fixes are explicitly applied", async ({
  page,
}) => {
  await seedDesignProject(page);
  await page.getByRole("button", { name: "Review design" }).click();
  await expect(
    page.getByRole("heading", { name: "Review design" }),
  ).toBeVisible();

  const beforeReview = await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const snapshotsUrl = "/src/store/snapshot.ts";
    const { useConversationStore } = await import(conversationUrl);
    const { useSnapshotStore } = await import(snapshotsUrl);
    const state = useConversationStore.getState();
    const id = state.activeId!;
    return {
      files: state.conversations[id].files,
      snapshotCount: (useSnapshotStore.getState().snapshots[id] ?? []).length,
    };
  });
  await page.evaluate(async () => {
    const reviewUrl = "/src/store/design-review.ts";
    const { useDesignReviewStore } = await import(reviewUrl);
    useDesignReviewStore.getState().complete({
      overview: "One source-backed issue.",
      findings: [
        {
          id: "hero-copy-specificity",
          priority: "P2",
          dimension: "copy_specificity",
          title: "Hero copy is generic",
          evidence: "The headline says only Hero title.",
          recommendation: "Name the concrete product outcome.",
        },
      ],
    });
  });
  await expect(page.getByText("Hero copy is generic")).toBeVisible();

  const afterReview = await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const snapshotsUrl = "/src/store/snapshot.ts";
    const { useConversationStore } = await import(conversationUrl);
    const { useSnapshotStore } = await import(snapshotsUrl);
    const state = useConversationStore.getState();
    const id = state.activeId!;
    return {
      files: state.conversations[id].files,
      snapshotCount: (useSnapshotStore.getState().snapshots[id] ?? []).length,
    };
  });
  expect(afterReview).toEqual(beforeReview);

  await page.getByRole("checkbox", { name: /Hero copy is generic/ }).check();
  await page.getByRole("button", { name: "Apply 1 selected fixes" }).click();
  await expect(
    page.getByRole("heading", { name: "Review design" }),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const url = "/src/store/conversation.ts";
        const { useConversationStore } = await import(url);
        const state = useConversationStore.getState();
        return state.conversations[state.activeId!].messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.startsWith("Apply only the explicitly selected"),
        );
      }),
    )
    .toBe(true);
});
