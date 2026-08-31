import { expect, test, type Locator, type Page } from "@playwright/test";

const baseFiles = {
  "index.html": `<!doctype html><html><body><main data-ob-id="app"><h1>Dialog fixture</h1></main></body></html>`,
  "src/App.tsx": "export function App() { return <main>Starter</main>; }",
  "package.json": JSON.stringify({
    scripts: { dev: "vite" },
    dependencies: { react: "19.0.0" },
    devDependencies: { vite: "7.0.0", vitest: "4.0.0" },
  }),
};

async function seedProject(page: Page) {
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const url = "/src/store/conversation.ts";
        const { useConversationStore } = await import(url);
        return useConversationStore.getState()._hasHydrated;
      }),
    )
    .toBe(true);
  await page.evaluate(async (files) => {
    const conversationUrl = "/src/store/conversation.ts";
    const settingsUrl = "/src/store/settings/index.ts";
    const snapshotsUrl = "/src/store/snapshot.ts";
    const { useConversationStore } = await import(conversationUrl);
    const { useSettingsStore } = await import(settingsUrl);
    const { useSnapshotStore } = await import(snapshotsUrl);
    useSettingsStore.setState((state: { system: Record<string, unknown> }) => ({
      system: { ...state.system, language: "en" },
    }));
    const state = useConversationStore.getState();
    const id = state.activeId ?? state.createConversation();
    state.switchConversation(id);
    const replaced = state.replaceProject({
      files,
      template: "vite-react-ts",
      previewMode: "sandpack",
      activeFile: "src/App.tsx",
    });
    if (!replaced.ok) throw new Error(replaced.error);
    useConversationStore.setState({ _hasHydrated: true });
    useSnapshotStore.setState({ snapshots: {}, _hasHydrated: true });
    for (let index = 0; index < 16; index += 1) {
      useSnapshotStore.getState().createSnapshot(id, `snapshot-${index}`, {
        ...files,
        "src/App.tsx": `export const version = ${index};`,
      });
    }
  }, baseFiles);
}

async function expectSingleScrollableBody(
  dialog: Locator,
  options: { footer?: boolean } = {},
) {
  await dialog.evaluate(
    () => new Promise<void>((resolve) => window.setTimeout(resolve, 250)),
  );
  const bodies = dialog.locator('[data-slot="dialog-body"]');
  await expect(bodies).toHaveCount(1);
  const body = bodies.first();
  await expect
    .poll(() =>
      body.evaluate(
        (node) =>
          node.scrollHeight > node.clientHeight &&
          getComputedStyle(node).overflowY === "auto",
      ),
    )
    .toBe(true);

  const header = dialog.locator('[data-slot="dialog-header"]');
  const headerBefore = await header.boundingBox();
  const footer = options.footer
    ? dialog.locator('[data-slot="dialog-footer"]')
    : null;
  const footerBefore = footer ? await footer.boundingBox() : null;
  await body.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(() => body.evaluate((node) => node.scrollTop > 0))
    .toBe(true);
  const headerAfter = await header.boundingBox();
  expect(Math.abs((headerAfter?.y ?? 0) - (headerBefore?.y ?? 0))).toBeLessThan(
    1,
  );
  if (footer) {
    const footerAfter = await footer.boundingBox();
    expect(
      Math.abs((footerAfter?.y ?? 0) - (footerBefore?.y ?? 0)),
    ).toBeLessThan(1);
  }
}

async function closeDialog(dialog: Locator) {
  await dialog.locator('[data-slot="dialog-close"]').click();
  await expect(dialog).toHaveCount(0);
}

test("keeps affected dialogs usable in a short desktop viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 980, height: 320 });
  await seedProject(page);

  await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const { useConversationStore } = await import(conversationUrl);
    useConversationStore.getState().setWorkspaceMode("design");
  });

  await page.getByRole("button", { name: "Review design" }).click();
  await page.evaluate(async () => {
    const reviewUrl = "/src/store/design-review.ts";
    const { useDesignReviewStore } = await import(reviewUrl);
    useDesignReviewStore.getState().complete({
      overview: "Short-window dialog verification.",
      findings: Array.from({ length: 18 }, (_, index) => ({
        id: `finding-${index}`,
        priority: "P2" as const,
        dimension: "copy_specificity" as const,
        title: `Finding ${index + 1}`,
        evidence: "Evidence that makes this review item long enough to scroll.",
        recommendation: "Apply a focused correction.",
      })),
    });
  });
  let dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Review design" }),
  ).toBeVisible();
  await expectSingleScrollableBody(dialog, { footer: true });
  await closeDialog(dialog);

  await page.getByRole("button", { name: "Edit design tokens" }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Design Tokens" }),
  ).toBeVisible();
  await expectSingleScrollableBody(dialog, { footer: true });
  await closeDialog(dialog);

  await page.getByRole("button", { name: "Open snapshot history" }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Snapshot History" }),
  ).toBeVisible();
  await expectSingleScrollableBody(dialog);
  await closeDialog(dialog);

  await page.setViewportSize({ width: 980, height: 240 });
  await page.getByRole("button", { name: "Add attachment" }).click();
  await page.getByRole("menuitem", { name: "Upload project" }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Upload Project" }),
  ).toBeVisible();
  await expectSingleScrollableBody(dialog, { footer: true });
  await closeDialog(dialog);

  await page.setViewportSize({ width: 980, height: 320 });
  await page.getByRole("button", { name: "Skills" }).click();
  await page.getByRole("menuitem", { name: "Manage skills..." }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Skills" })).toBeVisible();
  await expectSingleScrollableBody(dialog);
  await closeDialog(dialog);
});

test("shows mode-aware composer focus and creates from the mobile starter library", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 520 });
  await seedProject(page);
  await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const templatesUrl = "/src/store/project-templates.ts";
    const templateUtilsUrl = "/src/lib/utils/project-templates.ts";
    const templateUiUrl = "/src/hooks/useProjectTemplateController.ts";
    const { useConversationStore } = await import(conversationUrl);
    const { useProjectTemplateStore } = await import(templatesUrl);
    const { prepareProjectTemplateFromConversation } = await import(
      templateUtilsUrl
    );
    const { useProjectTemplateLibraryUi } = await import(templateUiUrl);
    const state = useConversationStore.getState();
    const source = state.conversations[state.activeId!];
    const templates: Record<string, unknown> = {};
    for (let index = 0; index < 8; index += 1) {
      const prepared = await prepareProjectTemplateFromConversation(
        {
          ...source,
          files: {
            ...source.files,
            "src/App.tsx": `export const starter = ${index};`,
          },
        },
        {
          id: `starter-${index}`,
          name: `Starter ${index + 1}`,
          description: "A deterministic local project starter.",
          tags: ["mobile", `variant-${index + 1}`],
          now: index + 1,
        },
      );
      templates[prepared.template.id] = prepared.template;
    }
    useProjectTemplateStore.setState({
      templates,
      _hasHydrated: true,
    });
    useProjectTemplateLibraryUi.getState().openLibrary(source.id);
  });

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Project Starters" }),
  ).toBeVisible();
  await expectSingleScrollableBody(dialog, { footer: true });
  const cards = dialog.locator("article");
  await expect(cards).toHaveCount(8);
  const firstBox = await cards.nth(0).boundingBox();
  const secondBox = await cards.nth(1).boundingBox();
  expect(firstBox?.x).toBe(secondBox?.x);
  await cards
    .filter({ hasText: "Starter 8" })
    .getByRole("button", { name: "Use starter" })
    .click();
  await expect(dialog).toHaveCount(0);
  const materialized = await page.evaluate(async () => {
    const url = "/src/store/conversation.ts";
    const { useConversationStore } = await import(url);
    const state = useConversationStore.getState();
    const active = state.conversations[state.activeId!];
    return {
      title: active.title,
      source: active.templateOrigin,
      app: active.files["src/App.tsx"],
      messages: active.messages.length,
    };
  });
  expect(materialized).toMatchObject({
    title: "Starter 8",
    source: { templateId: "starter-7", templateName: "Starter 8" },
    app: "export const starter = 7;",
    messages: 0,
  });

  const textarea = page.getByPlaceholder("Describe the app you want...");
  await textarea.focus();
  const composer = page.locator('[data-workspace-mode="auto"]');
  const readFocusStyle = () =>
    composer.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });
  const autoStyle = await readFocusStyle();
  expect(autoStyle.outlineWidth).toBe("2px");
  expect(autoStyle.outlineStyle).toBe("solid");
  expect(autoStyle.boxShadow).not.toBe("none");

  await page.evaluate(async () => {
    const url = "/src/store/conversation.ts";
    const { useConversationStore } = await import(url);
    useConversationStore.getState().setWorkspaceMode("plan");
  });
  const planComposer = page.locator('[data-workspace-mode="plan"]');
  await expect(planComposer).toBeVisible();
  await expect
    .poll(() =>
      planComposer.evaluate((node) => getComputedStyle(node).outlineColor),
    )
    .not.toBe(autoStyle.outlineColor);
  const planColor = await planComposer.evaluate(
    (node) => getComputedStyle(node).outlineColor,
  );

  await page.evaluate(async () => {
    const url = "/src/store/conversation.ts";
    const { useConversationStore } = await import(url);
    useConversationStore.getState().setWorkspaceMode("design");
    document.documentElement.classList.add("dark");
  });
  const designComposer = page.locator('[data-workspace-mode="design"]');
  await expect(designComposer).toBeVisible();
  await expect
    .poll(() =>
      designComposer.evaluate((node) => getComputedStyle(node).outlineColor),
    )
    .not.toBe(planColor);
  const designStyle = await designComposer.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
  expect(designStyle.outlineWidth).toBe("2px");
  expect(designStyle.boxShadow).not.toBe("none");
});
