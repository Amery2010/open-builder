// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { projectStaticPreview } from "./sandpack-static-preview";

const html =
  '<!doctype html><html><head><style>h1 { color: rgb(255, 0, 0); }</style><link rel="stylesheet" href="/app.css"></head><body><main><h1>Original</h1></main></body></html>';
// This is the body extraction used by Sandpack's desktop Parcel renderer.
function parcelBody(source: string): string {
  const match = source.match(/<body.*>([\s\S]*)<\/body>/m);
  return match?.[1] || source;
}

describe("desktop static preview projection", () => {
  it("preserves single-line content and head styles through Parcel without changing canonical files", () => {
    const canonical = {
      "index.html": html,
      "app.css": "main { padding: 20px; }",
    };
    const projection = projectStaticPreview(canonical);
    expect(canonical["index.html"]).toBe(html);
    expect(
      projection.restore("index.html", projection.files["index.html"]),
    ).toBe(html);
    const body = parcelBody(projection.files["index.html"]);
    expect(body).toContain("<main><h1>Original</h1></main>");
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    try {
      frame.contentDocument!.body.innerHTML = body;
      const heading = frame.contentDocument!.querySelector("h1")!;
      expect(frame.contentWindow!.getComputedStyle(heading).color).toBe(
        "rgb(255, 0, 0)",
      );
      expect(
        frame
          .contentDocument!.querySelector('link[rel="stylesheet"]')
          ?.getAttribute("href"),
      ).toBe("/app.css");
    } finally {
      frame.remove();
    }
  });
  it("restores real edits while discarding only its own generated styles", () => {
    const projection = projectStaticPreview({ "index.html": html });
    const edited = projection.files["index.html"].replace("Original", "Edited");
    expect(projection.restore("index.html", edited)).toBe(
      html.replace("Original", "Edited"),
    );
    expect(projection.restore("app.css", "body { color: blue; }")).toBe(
      "body { color: blue; }",
    );
  });
  it("does not match body text in scripts, comments or templates", () => {
    const source = html.replace(
      "<head>",
      '<head><script>const tag="<body>";</script><!-- <body> --><template><body></body></template>',
    );
    const projection = projectStaticPreview({ "index.html": source });
    expect(
      projection.restore("index.html", projection.files["index.html"]),
    ).toBe(source);
    expect(parcelBody(projection.files["index.html"])).toContain(
      "<h1>Original</h1>",
    );
  });
  it.each([
    '<body class="preview"><h1>Attributed</h1></body>',
    "<main><h1>Fragment</h1></main>",
  ])("keeps existing handling for %s", (source) => {
    const files = { "index.html": source };
    expect(projectStaticPreview(files).files).toBe(files);
  });
});
