import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  compress: vi.fn(),
  dataUrl: vi.fn(),
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: mocks.generate,
}));
vi.mock("../ai/provider", () => ({ getProviderModel: () => ({}) }));
vi.mock("browser-image-compression", () => ({
  default: Object.assign(mocks.compress, { getDataUrlFromFile: mocks.dataUrl }),
}));

import { createScreenshotToCodeHandler } from "./screenshot-to-code";

const png = Uint8Array.from([
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
  ...Array(100).fill(0),
]);
const jpeg = Uint8Array.from([255, 216, 255, 192, 0, 0, 255, 217]);
const compressedUrl = `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;

describe("screenshot-to-code image preparation", () => {
  beforeEach(() => {
    mocks.generate
      .mockReset()
      .mockResolvedValue({
        text: "export default function Page() { return null; }",
      });
    mocks.compress
      .mockReset()
      .mockResolvedValue(
        new File([jpeg], "screenshot.jpg", { type: "image/jpeg" }),
      );
    mocks.dataUrl.mockReset().mockResolvedValue(compressedUrl);
  });
  afterEach(() => vi.unstubAllGlobals());

  const handler = (onFilesChanged = vi.fn()) =>
    createScreenshotToCodeHandler({
      apiConfig: {
        apiType: "openai",
        apiBaseUrl: "https://example.test",
        apiKey: "key",
        model: "vision",
      },
      getFiles: () => ({}),
      onFilesChanged,
    });

  it.each(["data", "http"])(
    "compresses %s screenshots before the vision request",
    async (source) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(png, { headers: { "content-type": "image/webp" } }),
        );
      vi.stubGlobal("fetch", fetch);
      const input =
        source === "data"
          ? `data:image/webp;base64,${Buffer.from(png).toString("base64")}`
          : "https://example.test/screenshot";
      const result = JSON.parse(
        await handler()("screenshot_to_code", { image_url: input }),
      );
      expect(result.ok).toBe(true);
      expect(mocks.compress).toHaveBeenCalledOnce();
      expect(mocks.generate.mock.calls[0][0].messages[0].content[1]).toEqual({
        type: "image",
        image: compressedUrl,
        mediaType: "image/jpeg",
      });
      if (source === "http")
        expect(fetch).toHaveBeenCalledWith(
          input,
          expect.objectContaining({ credentials: "omit" }),
        );
      else expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not send non-image or oversized remote data to the model", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("not an image", {
          headers: { "content-type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(png, { headers: { "content-length": "6000000" } }),
      );
    vi.stubGlobal("fetch", fetch);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = JSON.parse(
        await handler()("screenshot_to_code", {
          image_url: "https://example.test/image",
        }),
      );
      expect(result.ok).toBe(false);
    }
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
