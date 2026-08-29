import type { Message } from "../../types";

const MAX_FALLBACK_TITLE_LENGTH = 30;
const LEGACY_ATTACHMENT_HEADER =
  /^\[File:\s*(.+?)(?:\s*\|\s*\d+)?\]\s*(?:\r?\n|$)/u;

function legacyAttachmentName(value: string): string {
  return LEGACY_ATTACHMENT_HEADER.exec(value)?.[1]?.trim() ?? "";
}

function firstTextContent(message: Message): string {
  if (typeof message.content === "string") {
    return legacyAttachmentName(message.content) ? "" : message.content;
  }
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part) =>
        part.type === "text" && !legacyAttachmentName(part.text.trimStart()),
    )
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[\s.!?。！？,:：;；，…]+$/u, "").trim();
}

function cleanFallbackText(value: string): string {
  return value
    .replace(/```[^\n]*\n?/gu, "\n")
    .replace(/^\[File:\s*.+?(?:\s*\|\s*\d+)?\]\s*$/gmu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^(?:\s{0,3}(?:#{1,6}|>|[-*+]\s|\d+[.)]\s))+/gmu, "")
    .replace(/[*_~`]+/gu, "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[^\S\r\n]+/gu, " ")
    .replace(/\s*\r?\n\s*/gu, "\n")
    .trim();
}

function firstSentence(value: string): string {
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";

  const boundary = /[。！？]|[.!?](?=\s|$)/u.exec(firstLine);
  return stripTrailingPunctuation(
    boundary ? firstLine.slice(0, boundary.index) : firstLine,
  );
}

function firstAttachmentName(message: Message): string {
  const storedName = message.metadata?.attachments?.[0]?.name?.trim();
  if (storedName) return storedName;
  if (typeof message.content === "string") {
    return legacyAttachmentName(message.content.trimStart());
  }
  if (!Array.isArray(message.content)) return "";
  const file = message.content.find((part) => part.type === "file");
  if (file?.type === "file") return file.file.filename.trim();
  const legacy = message.content.find(
    (part) =>
      part.type === "text" && legacyAttachmentName(part.text.trimStart()),
  );
  return legacy?.type === "text"
    ? legacyAttachmentName(legacy.text.trimStart())
    : "";
}

export function getTitleRequestText(message: Message): string {
  return firstTextContent(message) || firstAttachmentName(message);
}

export function deriveFallbackTitle(
  messages: readonly Message[],
): string | null {
  const firstRequest = messages.find(
    (message) =>
      message.role === "user" && message.metadata?.origin !== "auto_qa",
  );
  if (!firstRequest) return null;

  const text = firstSentence(cleanFallbackText(firstTextContent(firstRequest)));
  const fallback = text || firstAttachmentName(firstRequest);
  if (!fallback) return null;
  return Array.from(fallback)
    .slice(0, MAX_FALLBACK_TITLE_LENGTH)
    .join("")
    .trimEnd();
}
