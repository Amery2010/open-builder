export const COMPRESSIBLE_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type CompressibleImageMimeType =
  (typeof COMPRESSIBLE_IMAGE_MIME_TYPES)[number];

export interface StaticImageInspection {
  mimeType: CompressibleImageMimeType;
  animated: boolean;
  hasExif: boolean;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytesEqual(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function inspectPng(bytes: Uint8Array): StaticImageInspection | null {
  if (
    bytes.length < PNG_SIGNATURE.length + 12 ||
    !bytesEqual(bytes, 0, PNG_SIGNATURE)
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let firstChunk = true;
  let animated = false;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    if (firstChunk && (type !== "IHDR" || length !== 13)) return null;
    firstChunk = false;
    if (type === "acTL") animated = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length) return null;
      return { mimeType: "image/png", animated, hasExif: false };
    }
    offset = end;
  }

  return null;
}

function inspectJpeg(bytes: Uint8Array): StaticImageInspection | null {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    return null;
  }

  let hasExif = false;
  let offset = 2;
  while (offset + 1 < bytes.length - 2) {
    if (bytes[offset] !== 0xff) break;
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      marker === 0xe1 &&
      length >= 8 &&
      ascii(bytes, offset + 2, 6) === "Exif\u0000\u0000"
    ) {
      hasExif = true;
    }
    offset += length;
  }

  return { mimeType: "image/jpeg", animated: false, hasExif };
}

function inspectWebp(bytes: Uint8Array): StaticImageInspection | null {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return null;

  let offset = 12;
  let animated = false;
  let imageChunkFound = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const paddedEnd = dataOffset + length + (length % 2);
    if (paddedEnd > bytes.length) return null;
    if (type === "VP8 " || type === "VP8L" || type === "VP8X") {
      imageChunkFound = true;
    }
    if (type === "ANIM" || type === "ANMF") animated = true;
    if (type === "VP8X" && length >= 1 && (bytes[dataOffset] & 0x02) !== 0) {
      animated = true;
    }
    offset = paddedEnd;
  }

  if (offset !== bytes.length || !imageChunkFound) return null;
  return { mimeType: "image/webp", animated, hasExif: false };
}

export function inspectImageBytes(
  bytes: Uint8Array,
): StaticImageInspection | null {
  return inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
}

export async function inspectImageBlob(
  blob: Blob,
): Promise<StaticImageInspection | null> {
  return inspectImageBytes(new Uint8Array(await blob.arrayBuffer()));
}

export function isCompressibleImageMimeType(
  value: string,
): value is CompressibleImageMimeType {
  return (COMPRESSIBLE_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}
