import { describe, expect, it } from "vitest";
import type { ResolvedAttachment } from "../../ai/generator-types";
import {
  AGNES_REFERENCE_LIMITS,
  formatAgnesAttachmentManifest,
  registerAgnesRunAttachments,
  resolveAgnesImageReferences,
} from "./attachments";

function image(
  id: string,
  content = "data:image/png;base64,AQID",
): ResolvedAttachment {
  return {
    id,
    type: "image",
    name: `${id}\nunsafe.png`,
    mimeType: "image/png",
    size: 1,
    content,
  };
}

describe("Agnes current-message image references", () => {
  it("exposes opaque IDs in the model manifest and resolves only the active run", () => {
    const attachment = image("current-image");
    const manifest = formatAgnesAttachmentManifest([attachment]);
    expect(manifest).toContain('id="current-image"');
    expect(manifest).not.toContain(attachment.content);
    expect(manifest).not.toContain("\nunsafe.png");

    const clear = registerAgnesRunAttachments("conversation-1", [attachment]);
    expect(
      resolveAgnesImageReferences({
        conversationId: "conversation-1",
        attachmentIds: [attachment.id],
      }),
    ).toEqual([attachment.content]);
    expect(() =>
      resolveAgnesImageReferences({
        conversationId: "conversation-2",
        attachmentIds: [attachment.id],
      }),
    ).toThrow(/current message/i);
    clear();
    expect(() =>
      resolveAgnesImageReferences({
        conversationId: "conversation-1",
        attachmentIds: [attachment.id],
      }),
    ).toThrow(/current message/i);
  });

  it("uses token-safe cleanup when a newer run replaces a registration", () => {
    const clearFirst = registerAgnesRunAttachments("conversation-1", [
      image("first"),
    ]);
    const clearSecond = registerAgnesRunAttachments("conversation-1", [
      image("second"),
    ]);
    clearFirst();

    expect(
      resolveAgnesImageReferences({
        conversationId: "conversation-1",
        attachmentIds: ["second"],
      }),
    ).toHaveLength(1);
    clearSecond();
  });

  it("accepts only public HTTPS URLs and five combined references", () => {
    expect(
      resolveAgnesImageReferences({
        imageUrls: ["https://cdn.example.com/reference.png#fragment"],
      }),
    ).toEqual(["https://cdn.example.com/reference.png"]);

    for (const url of [
      "http://cdn.example.com/a.png",
      "https://localhost/a.png",
      "https://localhost./a.png",
      "https://127.0.0.1/a.png",
      "https://10.0.0.1/a.png",
      "https://192.168.1.1/a.png",
      "https://[::1]/a.png",
      "https://[::ffff:127.0.0.1]/a.png",
      "https://100.64.0.1/a.png",
      "https://203.0.113.1/a.png",
    ]) {
      expect(() => resolveAgnesImageReferences({ imageUrls: [url] })).toThrow(
        /public|HTTPS/i,
      );
    }

    expect(() =>
      resolveAgnesImageReferences({
        imageUrls: Array.from(
          { length: AGNES_REFERENCE_LIMITS.maxImages + 1 },
          (_, index) => `https://cdn.example.com/${index}.png`,
        ),
      }),
    ).toThrow(/at most 5/i);
  });

  it("checks decoded attachment bytes instead of trusting metadata", () => {
    const encoded = "A".repeat(
      Math.ceil(((AGNES_REFERENCE_LIMITS.maxImageBytes + 1) * 4) / 3),
    );
    const oversized = image("oversized", `data:image/png;base64,${encoded}`);
    const clear = registerAgnesRunAttachments("conversation-1", [oversized]);
    expect(() =>
      resolveAgnesImageReferences({
        conversationId: "conversation-1",
        attachmentIds: [oversized.id],
      }),
    ).toThrow(/per-image attachment limit/i);
    clear();
  });
});
