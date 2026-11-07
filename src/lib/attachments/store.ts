import localforage from "localforage";
import type {
  AttachmentRef,
  ContentPart,
  Message,
  ResolvedAttachment,
} from "../ai/generator-types";
import type { Attachment } from "../../types";
import {
  attachmentPartsForModel,
  legacyAttachmentTextForModel,
  unavailableAttachmentPartForModel,
} from "./model-context";

export const ATTACHMENT_STORAGE_DOMAIN = "open-builder-attachments";

const attachmentBlobs = localforage.createInstance({
  name: "open-builder",
  storeName: "attachments",
  description: "User-selected local attachment blobs",
});

function createId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function blobToDataUrl(blob: Blob, mediaType = blob.type): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read attachment blob."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to read attachment blob."));
        return;
      }
      resolve(
        mediaType
          ? reader.result.replace(/^data:[^;,]*;/, `data:${mediaType};`)
          : reader.result,
      );
    };
    reader.readAsDataURL(blob);
  });
}

function attachmentMimeType(file: File): string {
  if (
    file.name.toLowerCase().endsWith(".pdf") &&
    (!file.type || file.type === "application/octet-stream")
  ) {
    return "application/pdf";
  }
  return file.type || "application/octet-stream";
}

export async function storeAttachmentFile(
  file: File,
  type: AttachmentRef["type"],
): Promise<Attachment> {
  return storeAttachmentBlob(file, type, file.name);
}

export async function storeAttachmentBlob(
  blob: Blob,
  type: AttachmentRef["type"],
  name: string,
  options: { createPreviewUrl?: boolean } = {},
): Promise<Attachment> {
  const id = createId();
  // Materialize File bytes before IndexedDB storage. WebKit can reject File
  // backing data even when it accepts an equivalent in-memory Blob.
  const storedBlob =
    blob instanceof File
      ? new Blob([await blob.arrayBuffer()], { type: blob.type })
      : blob;
  await attachmentBlobs.setItem(id, storedBlob);
  return {
    id,
    type,
    name: name || (type === "image" ? "pasted-image" : "pasted-file"),
    mimeType:
      blob instanceof File
        ? attachmentMimeType(blob)
        : blob.type || "application/octet-stream",
    size: blob.size,
    previewUrl:
      type === "image" && options.createPreviewUrl !== false
        ? URL.createObjectURL(storedBlob)
        : undefined,
  };
}

export function toAttachmentRef(attachment: Attachment): AttachmentRef {
  return {
    id: attachment.id,
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

export async function getAttachmentBlob(id: string): Promise<Blob | null> {
  return attachmentBlobs.getItem<Blob>(id);
}

export async function resolveAttachmentForModel(
  attachment: AttachmentRef | Attachment,
): Promise<ResolvedAttachment> {
  const legacy = "content" in attachment ? attachment.content : undefined;
  if (legacy)
    return { ...toAttachmentRef(attachment as Attachment), content: legacy };
  const blob = await getAttachmentBlob(attachment.id);
  if (!blob) {
    throw new Error(
      `Attachment "${attachment.name}" is no longer available locally.`,
    );
  }
  let content: string;
  if (
    attachment.type === "image" ||
    attachment.mimeType === "application/pdf"
  ) {
    content = await blobToDataUrl(blob, attachment.mimeType);
  } else {
    content = await blob.text();
  }
  return { ...attachment, content };
}

export async function resolveAttachmentsForModel(
  attachments: readonly (AttachmentRef | Attachment)[],
): Promise<ResolvedAttachment[]> {
  return Promise.all(attachments.map(resolveAttachmentForModel));
}

export async function hydrateMessageAttachments(
  messages: readonly Message[],
): Promise<Message[]> {
  return Promise.all(
    messages.map(async (message) => {
      const refs = message.metadata?.attachments;
      if (message.role !== "user") return message;
      const parts: ContentPart[] = [];
      let wrappedLegacyAttachment = false;
      if (typeof message.content === "string" && message.content) {
        const legacy = legacyAttachmentTextForModel(message.content);
        parts.push({ type: "text", text: legacy ?? message.content });
        wrappedLegacyAttachment = legacy !== null;
      } else if (Array.isArray(message.content)) {
        parts.push(
          ...message.content.map((part) => {
            if (part.type !== "text") return part;
            const legacy = legacyAttachmentTextForModel(part.text);
            if (!legacy) return part;
            wrappedLegacyAttachment = true;
            return { type: "text" as const, text: legacy };
          }),
        );
      }
      if (!refs?.length && !wrappedLegacyAttachment) return message;
      for (const ref of refs ?? []) {
        try {
          const attachment = await resolveAttachmentForModel(ref);
          parts.push(...attachmentPartsForModel(attachment));
        } catch {
          parts.push(unavailableAttachmentPartForModel(ref));
        }
      }
      return { ...message, content: parts };
    }),
  );
}

export async function deleteAttachment(id: string): Promise<void> {
  await attachmentBlobs.removeItem(id);
}

export async function deleteAttachmentsForMessages(
  messages: readonly Message[],
  retainedMessages: readonly Message[] = [],
): Promise<void> {
  const ids = getUnreferencedAttachmentIds(messages, retainedMessages);
  await Promise.all(ids.map(deleteAttachment));
}

export function collectAttachmentIds(
  messages: readonly Message[],
): Set<string> {
  return new Set(
    messages.flatMap((message) => [
      ...(message.metadata?.attachments ?? []).map(
        (attachment) => attachment.id,
      ),
      ...(message.toolOutput?.content ?? []).flatMap((part) =>
        part.type === "local_image" ? [part.id] : [],
      ),
    ]),
  );
}

export function getUnreferencedAttachmentIds(
  messages: readonly Message[],
  retainedMessages: readonly Message[],
): string[] {
  const retainedIds = collectAttachmentIds(retainedMessages);
  return [...collectAttachmentIds(messages)].filter(
    (id) => !retainedIds.has(id),
  );
}

export async function clearAttachmentStorage(): Promise<void> {
  await attachmentBlobs.clear();
}

export async function estimateAttachmentStorage(): Promise<{
  count: number;
  bytes: number;
}> {
  let count = 0;
  let bytes = 0;
  await attachmentBlobs.iterate<Blob, void>((blob) => {
    count += 1;
    bytes += blob.size;
  });
  return { count, bytes };
}
