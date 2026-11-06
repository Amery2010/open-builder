import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ compress: vi.fn(), dataUrl: vi.fn() }));
vi.mock("browser-image-compression", () => ({
  default: Object.assign(mocks.compress, { getDataUrlFromFile: mocks.dataUrl }),
}));

import { prepareScreenshot, readScreenshotImage } from "./screenshot";

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
const url = (bytes: Uint8Array, mime = "image/webp") =>
  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

describe("screenshot preparation", () => {
  beforeEach(() => {
    mocks.compress.mockReset().mockImplementation(async (file: File) => file);
    mocks.dataUrl.mockReset();
  });

  it("uses actual image bytes even when the declared MIME is wrong or absent", () => {
    for (const mime of ["image/webp", "application/octet-stream", ""]) {
      expect(readScreenshotImage(url(png, mime))).toMatchObject({
        mimeType: "image/png",
        dataUrl: url(png, "image/png"),
      });
    }
    expect(() =>
      readScreenshotImage("data:image/png;base64,bm90IGFuIGltYWdl"),
    ).toThrow();
  });

  it("compresses with the library and accepts an output format different from the input", async () => {
    mocks.compress.mockResolvedValue(
      new File([jpeg], "result.webp", { type: "image/webp" }),
    );
    mocks.dataUrl.mockResolvedValue(url(jpeg));
    const result = await prepareScreenshot(url(png), "preview.webp");
    expect(mocks.compress).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/png" }),
      expect.objectContaining({
        initialQuality: 0.85,
        alwaysKeepResolution: true,
        useWebWorker: false,
      }),
    );
    expect(result).toEqual({
      dataUrl: url(jpeg, "image/jpeg"),
      mimeType: "image/jpeg",
      name: "preview.jpg",
    });
  });

  it.each(["failure", "empty", "larger", "invalid"])(
    "retains the normalized image after %s compression",
    async (mode) => {
      if (mode === "failure")
        mocks.compress.mockRejectedValue(new Error("unsupported encoder"));
      if (mode === "empty")
        mocks.compress.mockResolvedValue(new File([], "empty"));
      if (mode === "larger")
        mocks.compress.mockResolvedValue(
          new File([new Uint8Array(200)], "larger"),
        );
      if (mode === "invalid") {
        mocks.compress.mockResolvedValue(new File(["invalid"], "invalid"));
        mocks.dataUrl.mockResolvedValue("data:image/png;base64,aW52YWxpZA==");
      }
      await expect(prepareScreenshot(url(png))).resolves.toMatchObject({
        dataUrl: url(png, "image/png"),
        mimeType: "image/png",
      });
    },
  );

  it("does not turn cancellation into an original-image fallback", async () => {
    const controller = new AbortController();
    mocks.compress.mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      prepareScreenshot(url(png), undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
