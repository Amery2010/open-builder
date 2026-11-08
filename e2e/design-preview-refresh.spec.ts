import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

test("refreshes canvas pictures and retains a retryable automatic capture failure", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const { useConversationStore } = await import("/src/store/conversation.ts");
    const { useSettingsStore } = await import("/src/store/settings/index.ts");
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en", autoQaEnabled: true },
    }));
    const store = useConversationStore.getState();
    const replaced = store.replaceProject({
      template: "static",
      previewMode: "sandpack",
      activeFile: "index.html",
      files: {
        "design-project.json": JSON.stringify({
          schemaVersion: "open-builder-design-project/v3",
          revision: 1,
          pages: [
            { id: "home", name: "Home", route: "/", filePaths: ["index.html"] },
            { id: "draft", name: "Draft" },
          ],
        }),
        "index.html":
          "<html><head><style>body{margin:0;background:#eef2ff;color:#25304b;font:24px system-ui}main{padding:64px;min-height:1000px}</style></head><body><main><h1>Before refresh</h1><p>Canvas refresh fixture</p></main></body></html>",
      },
    });
    if (!replaced.ok) throw new Error(replaced.error);
    useConversationStore.getState().setWorkspaceMode("design");
  });
  const canvas = page.getByTestId("design-canvas");
  const picture = canvas.getByRole("img");
  await expect(picture).toBeVisible({ timeout: 60_000 });
  const initial = await picture.getAttribute("src");
  await page.evaluate(async () => {
    const { useConversationStore } = await import("/src/store/conversation.ts");
    const state = useConversationStore.getState();
    const files = state.conversations[state.activeId!].files;
    state.setFiles({
      ...files,
      "index.html": files["index.html"].replace(
        "Before refresh",
        "After refresh",
      ),
    });
  });
  await expect(picture).toHaveAttribute("src", initial!);
  await expect(canvas.getByText("Updating page preview")).toBeVisible();
  await expect
    .poll(() => picture.getAttribute("src"), { timeout: 45_000 })
    .not.toBe(initial);
  await expect(canvas.locator('[data-preview-status="ready"]')).toHaveCount(1);

  // Disable only the fixture's bridge to exercise the real capture timeout.
  // No model request can start without a screenshot.
  await page
    .frameLocator("iframe")
    .first()
    .locator("body")
    .evaluate(() => {
      const bridge = (
        window as unknown as Record<string, { dispose: () => void }>
      ).__OPEN_BUILDER_DESIGN_BRIDGE_V1__;
      if (!bridge) throw new Error("Fixture bridge was not installed.");
      bridge.dispose();
    });
  await page.evaluate(async () => {
    const { useConversationStore } = await import("/src/store/conversation.ts");
    const { useDesignReviewStore } =
      await import("/src/store/design-review.ts");
    const { computeDesignReviewSourceDigest } =
      await import("/src/lib/design/review-jobs/digest.ts");
    const state = useConversationStore.getState();
    const conversationId = state.activeId!;
    const files = state.conversations[conversationId].files;
    const contract = {
      surface_mode: "operate",
      change_mode: "extend",
      target: "Fixture page",
      audience: "Test users",
      primary_goal: "Read the page",
      concept: "Simple page",
      system_id: null,
      translation: {
        foundations: "Existing tokens",
        composition: "Existing layout",
        components: "Existing elements",
      },
      preserve: ["Page content"],
      acceptance: ["Current screenshot"],
    };
    const requestId = "capture-failure-fixture";
    state.setMessagesForConversation(conversationId, (messages) => [
      ...messages,
      {
        role: "user",
        content: "",
        metadata: {
          origin: "design_review",
          reviewJobId: requestId,
          reviewSummary: { status: "capturing" },
        },
      },
    ]);
    useDesignReviewStore.getState().requestAutomaticCapture({
      requestId,
      conversationId,
      contract,
      phase: "initial",
      originalRequest: "Review the fixture",
      appliedSystem: null,
      sourceDigest: await computeDesignReviewSourceDigest({
        files,
        designSystem: null,
        designContract: contract,
      }),
      designReport: {
        ok: true,
        issues: [],
        changedUiPaths: ["index.html"],
        summary: { errors: 0, warnings: 0, totalIssues: 0 },
        tokenUsage: {
          color: [],
          typography: [],
          shape: [],
          layout: [],
          motion: [],
        },
      },
      healthReport: {
        ok: true,
        issues: [],
        summary: {
          files: 1,
          dependencies: 0,
          errors: 0,
          warnings: 0,
          info: 0,
          totalIssues: 0,
        },
      },
    });
  });
  const notice = page.getByText(
    "Automatic Design review could not produce a current report; review the error and retry.",
  );
  await expect(notice).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const activity = page.getByRole("region", {
    name: "Automatic Design Review",
  });
  await expect(activity).not.toContainText("Waiting for the next review event");
  await expect(notice).not.toBeVisible({ timeout: 10_000 });
  const failed = await page.evaluate(async () => {
    const { useDesignReviewStore } =
      await import("/src/store/design-review.ts");
    return Object.values(useDesignReviewStore.getState().runsByConversation)
      .flat()
      .find((run) => run.id === "capture-failure-fixture");
  });
  expect(failed?.status).toBe("failed");
  expect(failed?.error).toContain("Preview bridge");
  expect(failed).not.toHaveProperty("screenshots");

  // Reload restores the real bridge and checks that the failure survives reload.
  await page.reload();
  await waitForAppReady(page);
  await expect(picture).toBeVisible({ timeout: 60_000 });
  await page.evaluate(async () => {
    const { designReviewJobRunner } =
      await import("/src/lib/design/review-jobs/runner.ts");
    const { useDesignReviewStore } =
      await import("/src/store/design-review.ts");
    // Substitute only model execution; the retry still recaptures real images.
    designReviewJobRunner.start = (input) => {
      const store = useDesignReviewStore.getState();
      const run = store.createRun({
        conversationId: input.conversationId,
        kind: input.kind,
        sourceDigest: input.sourceDigest,
        sourceProjectDigest: input.sourceProjectDigest,
        provider: { runtime: "api", provider: "fixture", model: "fixture" },
        retryOf: input.retryOf,
        capturedCount: input.screenshots.length,
      });
      if (!run) throw new Error("Retry did not create a run.");
      store.completeRun(run.id, {
        overview: "Fixture review completed.",
        findings: [],
      });
      return useDesignReviewStore
        .getState()
        .runsByConversation[input.conversationId].find(
          (candidate) => candidate.id === run.id,
        )!;
    };
  });
  await page
    .getByRole("button", { name: "Review design", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(failed!.error!);
  await page
    .getByRole("button", { name: "Recapture & retry" })
    .click({ timeout: 10_000 });
  await expect(page.getByRole("dialog")).toContainText(
    "Fixture review completed.",
    { timeout: 60_000 },
  );
  const retry = await page.evaluate(async () => {
    const { useDesignReviewStore } =
      await import("/src/store/design-review.ts");
    return Object.values(useDesignReviewStore.getState().runsByConversation)
      .flat()
      .find((run) => run.retryOf === "capture-failure-fixture");
  });
  expect(retry?.status).toBe("succeeded");
  expect(retry?.logs[0].count).toBe(3);
});
