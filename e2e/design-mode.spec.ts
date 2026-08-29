import { expect, test } from "@playwright/test";
import JSZip from "jszip";

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
      button { border: 0; border-radius: var(--radius-md); padding: 12px 18px; background: var(--accent); color: var(--accent-on); }
    </style>
    <title>Design fixture</title>
  </head>
  <body>
    <main data-ob-id="hero">
      <section data-ob-id="hero-content">
        <h1 data-ob-id="hero-title">Hero title</h1>
        <button data-ob-id="hero-cta" aria-label="Start building">Start building</button>
      </section>
    </main>
  </body>
</html>`,
  "tokens.css": initialTokens,
};

async function seedDesignProject(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(
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
  await expect(
    page.getByRole("button", { name: "Preview", exact: true }),
  ).toBeVisible();
}

test("point-selects a real Sandpack element, previews tokens, and keeps Bridge out of export", async ({
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

  await page.getByRole("button", { name: "Tablet" }).click();
  await expect(page.getByRole("button", { name: "Tablet" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Mobile" }).click();
  await expect(page.getByRole("button", { name: "Mobile" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Desktop" }).click();

  await page.getByRole("button", { name: "Edit design tokens" }).click();
  const accent = page.getByLabel("Accent", { exact: true });
  await accent.fill("#ff006e");
  await expect
    .poll(() => heading.evaluate((node) => getComputedStyle(node).color))
    .toBe("rgb(255, 0, 110)");
  const beforeSave = await page.evaluate(async () => {
    const url = "/src/store/conversation.ts";
    const { useConversationStore } = await import(url);
    const state = useConversationStore.getState();
    return state.conversations[state.activeId!].files["tokens.css"];
  });
  expect(beforeSave).toContain("--accent: #6541f5;");

  await page.getByRole("button", { name: "Save tokens" }).click();
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
  await page.getByRole("button", { name: "Download" }).click();
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
