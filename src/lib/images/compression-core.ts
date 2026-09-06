import imageCompression from "browser-image-compression";
import {
  inspectImageBlob,
  isCompressibleImageMimeType,
  type CompressibleImageMimeType,
} from "./formats";
import { normalizeImageCompressionQuality } from "./settings";

export type CompressionCoreResult =
  { status: "compressed"; file: File } | { status: "unchanged" };

export class ImageCompressionCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageCompressionCapabilityError";
  }
}

interface DecodedCanvas {
  image: ImageBitmap | HTMLImageElement;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;
}

type ImageCompressionRuntime = typeof imageCompression & {
  isAutoOrientationInBrowser?: () => Promise<boolean>;
};

function abortError(): DOMException {
  return new DOMException("Image compression was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function closeImage(image: ImageBitmap | HTMLImageElement): void {
  if ("close" in image && typeof image.close === "function") image.close();
}

function clearCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): void {
  canvas.width = 0;
  canvas.height = 0;
}

function createExactCanvas(
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas {
  if (
    typeof OffscreenCanvas === "function" &&
    typeof OffscreenCanvas.prototype.convertToBlob === "function"
  ) {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new ImageCompressionCapabilityError(
    "No canvas implementation is available.",
  );
}

async function decodeToCanvas(
  file: File,
  mimeType: CompressibleImageMimeType,
  exifOrientation: number,
): Promise<DecodedCanvas> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      let canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
      try {
        canvas = createExactCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d") as
          CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!context) {
          throw new ImageCompressionCapabilityError(
            "A 2D canvas context is unavailable.",
          );
        }
        context.drawImage(bitmap, 0, 0);
        return {
          image: bitmap,
          canvas,
          width: bitmap.width,
          height: bitmap.height,
        };
      } catch (error) {
        closeImage(bitmap);
        if (canvas) clearCanvas(canvas);
        throw error;
      }
    } catch (error) {
      if (error instanceof ImageCompressionCapabilityError) throw error;
      if (typeof document === "undefined") {
        throw new ImageCompressionCapabilityError(
          error instanceof Error ? error.message : "Image decoding failed.",
        );
      }
    }
  }

  if (typeof document === "undefined") {
    throw new ImageCompressionCapabilityError(
      "ImageBitmap is unavailable in this worker.",
    );
  }
  if (mimeType === "image/jpeg" && exifOrientation >= 2) {
    const orientationProbe = (imageCompression as ImageCompressionRuntime)
      .isAutoOrientationInBrowser;
    if (!orientationProbe || !(await orientationProbe())) {
      throw new ImageCompressionCapabilityError(
        "EXIF-aware image decoding is unavailable.",
      );
    }
  }

  const [image, canvas] = await imageCompression.drawFileInCanvas(file, {
    fileType: mimeType,
  });
  return {
    image,
    canvas,
    width: image.width,
    height: image.height,
  };
}

async function decodeDimensions(
  file: File,
  mimeType: CompressibleImageMimeType,
): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      try {
        return { width: bitmap.width, height: bitmap.height };
      } finally {
        bitmap.close();
      }
    } catch (error) {
      if (typeof document === "undefined") {
        throw new ImageCompressionCapabilityError(
          error instanceof Error ? error.message : "Image decoding failed.",
        );
      }
    }
  }

  if (typeof document === "undefined") {
    throw new ImageCompressionCapabilityError(
      "ImageBitmap is unavailable in this worker.",
    );
  }
  const [image, canvas] = await imageCompression.drawFileInCanvas(file, {
    fileType: mimeType,
  });
  try {
    if (canvas.width !== image.width || canvas.height !== image.height) {
      throw new ImageCompressionCapabilityError(
        "The browser reduced the image to fit its canvas limit.",
      );
    }
    return { width: image.width, height: image.height };
  } finally {
    closeImage(image);
    clearCanvas(canvas);
  }
}

function asFile(blob: Blob, source: File): File {
  return new File([blob], source.name, {
    type: source.type,
    lastModified: source.lastModified,
  });
}

export async function compressImageOnce(
  file: File,
  quality: number,
  signal?: AbortSignal,
): Promise<CompressionCoreResult> {
  throwIfAborted(signal);
  if (!isCompressibleImageMimeType(file.type)) return { status: "unchanged" };

  const sourceInspection = await inspectImageBlob(file);
  if (
    !sourceInspection ||
    sourceInspection.mimeType !== file.type ||
    sourceInspection.animated
  ) {
    return { status: "unchanged" };
  }

  const mimeType = sourceInspection.mimeType;
  let exifOrientation = -2;
  if (mimeType === "image/jpeg") {
    try {
      exifOrientation = await imageCompression.getExifOrientation(file);
    } catch {
      return { status: "unchanged" };
    }
    if (exifOrientation < -1 || exifOrientation > 8 || exifOrientation === 0) {
      return { status: "unchanged" };
    }
  }
  throwIfAborted(signal);

  let decoded: DecodedCanvas | undefined;
  try {
    decoded = await decodeToCanvas(file, mimeType, exifOrientation);
    if (
      decoded.width <= 0 ||
      decoded.height <= 0 ||
      decoded.canvas.width !== decoded.width ||
      decoded.canvas.height !== decoded.height
    ) {
      return { status: "unchanged" };
    }
    throwIfAborted(signal);

    const encoded = await imageCompression.canvasToFile(
      decoded.canvas as HTMLCanvasElement,
      mimeType,
      file.name,
      file.lastModified,
      normalizeImageCompressionQuality(quality),
    );
    throwIfAborted(signal);
    if (
      !(encoded instanceof Blob) ||
      encoded.size <= 0 ||
      encoded.size >= file.size
    ) {
      return { status: "unchanged" };
    }

    const compressed = asFile(encoded, file);
    const outputInspection = await inspectImageBlob(compressed);
    if (
      !outputInspection ||
      outputInspection.mimeType !== mimeType ||
      outputInspection.animated ||
      (mimeType === "image/jpeg" && outputInspection.hasExif)
    ) {
      return { status: "unchanged" };
    }

    const outputDimensions = await decodeDimensions(compressed, mimeType);
    throwIfAborted(signal);
    if (
      outputDimensions.width !== decoded.width ||
      outputDimensions.height !== decoded.height
    ) {
      return { status: "unchanged" };
    }
    return { status: "compressed", file: compressed };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    if (error instanceof ImageCompressionCapabilityError) throw error;
    return { status: "unchanged" };
  } finally {
    if (decoded) {
      closeImage(decoded.image);
      clearCanvas(decoded.canvas);
    }
  }
}
