// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compressionMocks = vi.hoisted(() => ({
  canvasToFile: vi.fn(),
  drawFileInCanvas: vi.fn(),
  getExifOrientation: vi.fn(),
}));

vi.mock("browser-image-compression", () => ({
  default: compressionMocks,
}));

import { compressImageOnce } from "./compression-core";
import { DEFAULT_IMAGE_COMPRESSION_QUALITY } from "./settings";

const encoder = new TextEncoder();

function be32(value: number): number[] {
  return [value >>> 24, value >>> 16, value >>> 8, value].map(
    (byte) => byte & 0xff,
  );
}

function chunk(type: string, data: readonly number[] = []): number[] {
  return [...be32(data.length), ...encoder.encode(type), ...data, 0, 0, 0, 0];
}

function pngBytes(extraBytes = 0): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", new Array(13).fill(0)),
    ...(extraBytes ? chunk("tEXt", new Array(extraBytes).fill(1)) : []),
    ...chunk("IDAT", [1]),
    ...chunk("IEND"),
  ]);
}

function pngFile(name: string, extraBytes = 0): File {
  return new File([pngBytes(extraBytes).buffer as ArrayBuffer], name, {
    type: "image/png",
    lastModified: 123,
  });
}

function jpegBytes(hasExif: boolean, padding = 0): Uint8Array {
  const segment = (marker: number, data: readonly number[]) => [
    0xff,
    marker,
    (data.length + 2) >>> 8,
    (data.length + 2) & 0xff,
    ...data,
  ];
  return Uint8Array.from([
    0xff,
    0xd8,
    ...(hasExif ? segment(0xe1, [...encoder.encode("Exif\u0000\u0000")]) : []),
    ...segment(0xe0, new Array(padding).fill(1)),
    0xff,
    0xd9,
  ]);
}

function canvas(width: number, height: number) {
  return { width, height } as HTMLCanvasElement;
}

function image(width: number, height: number) {
  return { width, height } as HTMLImageElement;
}

describe("single-pass image compression core", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    compressionMocks.canvasToFile.mockReset();
    compressionMocks.drawFileInCanvas.mockReset();
    compressionMocks.getExifOrientation.mockReset();
    compressionMocks.drawFileInCanvas.mockImplementation(async () => [
      image(12, 8),
      canvas(12, 8),
    ]);
    compressionMocks.canvasToFile.mockImplementation(
      async (_canvas, type: string, name: string, lastModified: number) =>
        new File([pngBytes().buffer as ArrayBuffer], name, {
          type,
          lastModified,
        }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("encodes exactly once at the requested quality without resizing", async () => {
    const source = pngFile("source.png", 200);
    const result = await compressImageOnce(source, 0.85);

    expect(result.status).toBe("compressed");
    expect(compressionMocks.canvasToFile).toHaveBeenCalledOnce();
    expect(compressionMocks.canvasToFile.mock.calls[0].slice(1)).toEqual([
      "image/png",
      "source.png",
      123,
      0.85,
    ]);
    expect(compressionMocks.drawFileInCanvas).toHaveBeenCalledTimes(2);
  });

  it("normalizes invalid quality to 0.85", async () => {
    await compressImageOnce(pngFile("source.png", 200), Number.NaN);

    expect(compressionMocks.canvasToFile.mock.calls[0][4]).toBe(
      DEFAULT_IMAGE_COMPRESSION_QUALITY,
    );
  });

  it("returns unchanged when the browser shrinks either decode", async () => {
    const source = pngFile("source.png", 200);
    compressionMocks.drawFileInCanvas.mockResolvedValueOnce([
      image(12, 8),
      canvas(11, 8),
    ]);
    await expect(compressImageOnce(source, 0.85)).resolves.toEqual({
      status: "unchanged",
    });
    expect(compressionMocks.canvasToFile).not.toHaveBeenCalled();

    compressionMocks.drawFileInCanvas
      .mockResolvedValueOnce([image(12, 8), canvas(12, 8)])
      .mockResolvedValueOnce([image(11, 8), canvas(11, 8)]);
    await expect(compressImageOnce(source, 0.85)).resolves.toEqual({
      status: "unchanged",
    });
  });

  it("returns unchanged for a non-smaller output or an encoding error", async () => {
    const source = pngFile("source.png", 20);
    compressionMocks.canvasToFile.mockResolvedValueOnce(
      new File([new Uint8Array(source.size)], source.name, {
        type: source.type,
      }),
    );
    await expect(compressImageOnce(source, 0.85)).resolves.toEqual({
      status: "unchanged",
    });

    compressionMocks.canvasToFile.mockRejectedValueOnce(new Error("encode"));
    await expect(compressImageOnce(source, 0.85)).resolves.toEqual({
      status: "unchanged",
    });
  });

  it("returns unchanged when encoding changes the file signature", async () => {
    const source = pngFile("source.png", 200);
    compressionMocks.canvasToFile.mockResolvedValueOnce(
      new File([jpegBytes(false).buffer as ArrayBuffer], source.name, {
        type: source.type,
      }),
    );

    await expect(compressImageOnce(source, 0.85)).resolves.toEqual({
      status: "unchanged",
    });
  });

  it("does not encode animated PNG input", async () => {
    const animated = Uint8Array.from([
      ...pngBytes().slice(0, -12),
      ...chunk("acTL", new Array(8).fill(0)),
      ...chunk("IEND"),
    ]);
    const source = new File([animated.buffer as ArrayBuffer], "animated.png", {
      type: "image/png",
    });

    await expect(compressImageOnce(source, 0.85)).resolves.toEqual({
      status: "unchanged",
    });
    expect(compressionMocks.canvasToFile).not.toHaveBeenCalled();
  });

  it("propagates cancellation as AbortError and still clears the canvas", async () => {
    const source = pngFile("source.png", 200);
    const controller = new AbortController();
    const sourceCanvas = canvas(12, 8);
    compressionMocks.drawFileInCanvas.mockResolvedValueOnce([
      image(12, 8),
      sourceCanvas,
    ]);
    compressionMocks.canvasToFile.mockImplementationOnce(async () => {
      controller.abort();
      return new File([pngBytes().buffer as ArrayBuffer], source.name, {
        type: source.type,
      });
    });

    await expect(
      compressImageOnce(source, 0.85, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sourceCanvas.width).toBe(0);
    expect(sourceCanvas.height).toBe(0);
  });

  it("uses explicit from-image decoding and does not flatten PNG alpha", async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const close = vi.fn();
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage, fillRect };
      }
      async convertToBlob() {
        return new Blob();
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const createImageBitmap = vi
      .fn()
      .mockResolvedValue({ width: 12, height: 8, close });
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const result = await compressImageOnce(pngFile("alpha.png", 200), 0.85);

    expect(result.status).toBe("compressed");
    expect(createImageBitmap).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ imageOrientation: "from-image" }),
    );
    expect(drawImage).toHaveBeenCalledOnce();
    expect(fillRect).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("normalizes JPEG EXIF orientation into pixels and emits no EXIF", async () => {
    const drawImage = vi.fn();
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage };
      }
      async convertToBlob() {
        return new Blob();
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const createImageBitmap = vi.fn().mockResolvedValue({
      width: 8,
      height: 12,
      close: vi.fn(),
    });
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    compressionMocks.getExifOrientation.mockResolvedValue(6);
    compressionMocks.canvasToFile.mockResolvedValue(
      new File([jpegBytes(false).buffer as ArrayBuffer], "portrait.jpg", {
        type: "image/jpeg",
      }),
    );
    const source = new File(
      [jpegBytes(true, 200).buffer as ArrayBuffer],
      "portrait.jpg",
      { type: "image/jpeg", lastModified: 123 },
    );

    const result = await compressImageOnce(source, 0.85);

    expect(result.status).toBe("compressed");
    expect(compressionMocks.getExifOrientation).toHaveBeenCalledWith(source);
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    expect(createImageBitmap).toHaveBeenNthCalledWith(
      1,
      source,
      expect.objectContaining({ imageOrientation: "from-image" }),
    );
    expect(compressionMocks.canvasToFile).toHaveBeenCalledOnce();
  });

  it("uses the library HTML decoder when createImageBitmap rejects", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockRejectedValue(new Error("unsupported")),
    );

    const result = await compressImageOnce(pngFile("fallback.png", 200), 0.85);

    expect(result.status).toBe("compressed");
    expect(compressionMocks.drawFileInCanvas).toHaveBeenCalledTimes(2);
  });
});
