import { describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, Blob>());
vi.mock("localforage", () => ({
  default: {
    createInstance: () => ({
      setItem: async (id: string, value: Blob) => {
        if (value instanceof File) {
          throw new DOMException(
            "Error preparing Blob/File data to be stored in object store",
            "UnknownError",
          );
        }
        storage.set(id, value);
      },
      getItem: async (id: string) => storage.get(id) ?? null,
    }),
  },
}));

import { getAttachmentBlob, storeAttachmentFile } from "./store";

describe("attachment File persistence", () => {
  it("stores materialized Blob bytes while retaining file name and MIME metadata", async () => {
    const file = new File(["annotation bytes"], "preview-annotation.png", {
      type: "image/png",
    });
    const attachment = await storeAttachmentFile(file, "image");
    try {
      const stored = await getAttachmentBlob(attachment.id);
      expect(stored).not.toBeInstanceOf(File);
      expect(await stored!.text()).toBe("annotation bytes");
      expect(attachment).toMatchObject({
        name: file.name,
        mimeType: file.type,
        size: file.size,
      });
    } finally {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  });

  it("preserves MIME fallback for a PDF File with no reported type", async () => {
    const attachment = await storeAttachmentFile(
      new File(["%PDF"], "notes.pdf"),
      "file",
    );
    expect(attachment.mimeType).toBe("application/pdf");
    expect(await (await getAttachmentBlob(attachment.id))!.text()).toBe("%PDF");
  });
});
