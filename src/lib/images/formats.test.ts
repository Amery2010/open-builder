import { describe, expect, it } from "vitest";
import { inspectImageBytes } from "./formats";

const encoder = new TextEncoder();

function be32(value: number): number[] {
  return [value >>> 24, value >>> 16, value >>> 8, value].map(
    (byte) => byte & 0xff,
  );
}

function le32(value: number): number[] {
  return [value, value >>> 8, value >>> 16, value >>> 24].map(
    (byte) => byte & 0xff,
  );
}

function pngChunk(type: string, data: readonly number[] = []): number[] {
  return [...be32(data.length), ...encoder.encode(type), ...data, 0, 0, 0, 0];
}

function png(animated = false): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk("IHDR", new Array(13).fill(0)),
    ...(animated ? pngChunk("acTL", new Array(8).fill(0)) : []),
    ...pngChunk("IDAT", [1, 2, 3]),
    ...pngChunk("IEND"),
  ]);
}

function webpChunk(type: string, data: readonly number[]): number[] {
  return [
    ...encoder.encode(type),
    ...le32(data.length),
    ...data,
    ...(data.length % 2 ? [0] : []),
  ];
}

function webp(chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  return Uint8Array.from([
    ...encoder.encode("RIFF"),
    ...le32(body.length + 4),
    ...encoder.encode("WEBP"),
    ...body,
  ]);
}

describe("static image format inspection", () => {
  it("accepts complete static PNG, JPEG, and WebP containers", () => {
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xd9,
    ]);
    const staticWebp = webp([webpChunk("VP8 ", [1, 2, 3, 4])]);

    expect(inspectImageBytes(png())).toEqual({
      mimeType: "image/png",
      animated: false,
      hasExif: false,
    });
    expect(inspectImageBytes(jpeg)).toEqual({
      mimeType: "image/jpeg",
      animated: false,
      hasExif: false,
    });
    expect(inspectImageBytes(staticWebp)).toEqual({
      mimeType: "image/webp",
      animated: false,
      hasExif: false,
    });
  });

  it("detects PNG and WebP animation chunks without scanning payload text", () => {
    const animatedWebp = webp([
      webpChunk("VP8X", [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
    ]);
    const textOnly = pngChunk("tEXt", [...encoder.encode("acTL")]);
    const staticWithText = Uint8Array.from([
      ...png().slice(0, -12),
      ...textOnly,
      ...pngChunk("IEND"),
    ]);

    expect(inspectImageBytes(png(true))?.animated).toBe(true);
    expect(inspectImageBytes(animatedWebp)?.animated).toBe(true);
    expect(inspectImageBytes(staticWithText)?.animated).toBe(false);
  });

  it("finds JPEG EXIF and rejects truncated or trailing containers", () => {
    const jpegWithExif = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe1,
      0,
      8,
      ...encoder.encode("Exif\u0000\u0000"),
      0xff,
      0xd9,
    ]);
    const trailingPng = Uint8Array.from([...png(), 0]);
    const badWebp = webp([webpChunk("VP8 ", [1, 2, 3, 4])]);
    badWebp[4] = 0;

    expect(inspectImageBytes(jpegWithExif)?.hasExif).toBe(true);
    expect(inspectImageBytes(trailingPng)).toBeNull();
    expect(inspectImageBytes(badWebp)).toBeNull();
    expect(inspectImageBytes(Uint8Array.from([1, 2, 3]))).toBeNull();
  });
});
