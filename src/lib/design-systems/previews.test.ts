import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_DESIGN_SYSTEMS,
  CUSTOM_DESIGN_SYSTEM_PREVIEW_PATH,
} from "./catalog";

function readLosslessWebpHeader(publicPath: string) {
  const bytes = readFileSync(join(process.cwd(), "public", publicPath));
  const dimensions = bytes.readUInt32LE(21);
  return {
    riff: bytes.subarray(0, 4).toString("ascii"),
    format: bytes.subarray(8, 12).toString("ascii"),
    chunk: bytes.subarray(12, 16).toString("ascii"),
    losslessSignature: bytes[20],
    width: (dimensions & 0x3fff) + 1,
    height: ((dimensions >>> 14) & 0x3fff) + 1,
  };
}

describe("design-system preview assets", () => {
  it("maps every bundled system to a unique 640x480 WebP", () => {
    const paths = BUNDLED_DESIGN_SYSTEMS.map((entry) => entry.previewPath);
    expect(paths).toHaveLength(36);
    expect(new Set(paths).size).toBe(36);

    for (const path of [...paths, CUSTOM_DESIGN_SYSTEM_PREVIEW_PATH]) {
      expect(path).toMatch(/^\/design-systems\/previews\/.+\.webp$/);
      expect(readLosslessWebpHeader(path.slice(1))).toEqual({
        riff: "RIFF",
        format: "WEBP",
        chunk: "VP8L",
        losslessSignature: 0x2f,
        width: 640,
        height: 480,
      });
    }
    expect(
      readdirSync(
        join(process.cwd(), "public", "design-systems", "previews"),
      ).filter((name) => name.endsWith(".png")),
    ).toEqual([]);
  });
});
