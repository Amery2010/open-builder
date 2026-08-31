import { describe, expect, it, vi } from "vitest";
import { getSandpackFileContentToCommit } from "../CodeViewer";

vi.mock("localforage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    createInstance: () => ({
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

describe("CodeViewer Sandpack file changes", () => {
  it("does not commit an unchanged ordinary project file", () => {
    const content = "export default function App() { return <main />; }";

    expect(getSandpackFileContentToCommit(content, content)).toBeUndefined();
  });

  it("does not commit an injected bridge when the canonical file is unchanged", () => {
    const canonicalContent = "<body>Preview\n</body>";
    const injectedContent =
      '<body>Preview\n<!-- open-builder-design-bridge:start -->\n<script src="/_open-builder/design-bridge.js" data-ob-design-bridge></script>\n<!-- open-builder-design-bridge:end -->\n</body>';

    expect(
      getSandpackFileContentToCommit(canonicalContent, injectedContent),
    ).toBeUndefined();
  });

  it("returns stripped content when the canonical file really changed", () => {
    const canonicalContent = "<body>Preview\n</body>";
    const injectedContent =
      '<body>Updated preview\n<!-- open-builder-design-bridge:start -->\n<script src="/_open-builder/design-bridge.js" data-ob-design-bridge></script>\n<!-- open-builder-design-bridge:end -->\n</body>';

    expect(
      getSandpackFileContentToCommit(canonicalContent, injectedContent),
    ).toBe("<body>Updated preview\n</body>");
  });

  it("keeps a newly created file even when its stripped content is empty", () => {
    expect(getSandpackFileContentToCommit(undefined, "")).toBe("");
  });
});
