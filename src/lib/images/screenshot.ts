import type { CompressibleImageMimeType } from "./formats";
import { DEFAULT_IMAGE_COMPRESSION_QUALITY } from "./settings";

/** Screenshot metadata is a hint; the returned bytes determine the format. */
export function readScreenshotImage(dataUrl: string): {
  dataUrl: string;
  mimeType: CompressibleImageMimeType;
  base64: string;
  bytes: Uint8Array<ArrayBuffer>;
} {
  const match = /^data:[^;,]*;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw new Error("Screenshot did not contain image data.");
  const bytes = Uint8Array.from(atob(match[1]), (character) =>
    character.charCodeAt(0),
  );
  let mimeType: CompressibleImageMimeType;
  if (
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    )
  ) {
    mimeType = "image/png";
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    mimeType = "image/jpeg";
  } else if (
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    mimeType = "image/webp";
  } else {
    throw new Error("Screenshot did not contain image data.");
  }
  return {
    dataUrl: `data:${mimeType};base64,${match[1]}`,
    mimeType,
    base64: match[1],
    bytes,
  };
}

/** Always attempt compression before sending, retaining a usable original on failure. */
export async function prepareScreenshot(
  dataUrl: string,
  name = "screenshot",
  signal?: AbortSignal,
): Promise<{
  dataUrl: string;
  mimeType: CompressibleImageMimeType;
  name: string;
}> {
  signal?.throwIfAborted();
  let image = readScreenshotImage(dataUrl);
  try {
    const { default: imageCompression } =
      await import("browser-image-compression");
    signal?.throwIfAborted();
    const file = new File([image.bytes], name, { type: image.mimeType });
    const compressed = await imageCompression(file, {
      initialQuality: DEFAULT_IMAGE_COMPRESSION_QUALITY,
      alwaysKeepResolution: true,
      // Use the bundled library; its default worker loads a remote CDN script.
      useWebWorker: false,
      signal,
    });
    signal?.throwIfAborted();
    if (compressed.size > 0 && compressed.size < file.size) {
      const candidate = readScreenshotImage(
        await imageCompression.getDataUrlFromFile(compressed),
      );
      if (candidate.bytes.length < image.bytes.length) image = candidate;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as { name?: string })?.name === "AbortError") throw error;
  }
  signal?.throwIfAborted();
  return {
    dataUrl: image.dataUrl,
    mimeType: image.mimeType,
    name: `${name.replace(/\.[^/.]*$/, "")}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice(6)}`,
  };
}
