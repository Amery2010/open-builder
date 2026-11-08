/** Encode source pixels only; editor controls never cross this boundary. */
export async function encodePngCrop(
  image: HTMLImageElement,
  crop: { x: number; y: number; width: number; height: number } | null,
  signal: AbortSignal,
  draw?: (context: CanvasRenderingContext2D) => void,
): Promise<Blob> {
  signal.throwIfAborted();
  const region = crop ?? {
    x: 0,
    y: 0,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
  const canvas = document.createElement("canvas");
  canvas.width = region.width;
  canvas.height = region.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.translate(-region.x, -region.y);
    context.drawImage(image, 0, 0);
    draw?.(context);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error("Could not encode the image.")),
        "image/png",
      );
    });
    signal.throwIfAborted();
    return blob;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
