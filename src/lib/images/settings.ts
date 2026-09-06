export const DEFAULT_IMAGE_COMPRESSION_QUALITY = 0.85;

export function normalizeImageCompressionQuality(value: number): number {
  return Number.isFinite(value) && value >= 0.01 && value <= 1
    ? value
    : DEFAULT_IMAGE_COMPRESSION_QUALITY;
}
