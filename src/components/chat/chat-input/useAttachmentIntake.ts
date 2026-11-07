import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useT, type Translations } from "../../../i18n";
import { useConversationStore } from "../../../store/conversation";
import { useSettingsStore } from "../../../store/settings";
import type { Attachment } from "../../../types";
import {
  captureConversationIdentity,
  isConversationIdentityCurrent,
} from "../../../lib/conversation/branches";
import {
  deleteAttachment,
  storeAttachmentFile,
} from "../../../lib/attachments/store";
import {
  compressLocalImage,
  type ImageCompressionSettings,
} from "../../../lib/images";
import {
  formatAttachmentBytes,
  isImageMime,
  validateAttachmentFile,
} from "../../../lib/utils/attachments";
import {
  useAttachmentIntakeRegistration,
  type AttachmentIntake,
  type AttachmentIntakeResult,
} from "./AttachmentIntakeContext";

function formatAttachmentError(
  validation: Extract<ReturnType<typeof validateAttachmentFile>, { ok: false }>,
  t: Translations,
): string {
  switch (validation.code) {
    case "max_count":
      return t.chat.attachmentErrors.maxCount.replace(
        "{count}",
        String(validation.limit ?? ""),
      );
    case "max_total_size":
      return t.chat.attachmentErrors.maxTotalSize.replace(
        "{size}",
        formatAttachmentBytes(validation.limit ?? 0),
      );
    case "max_image_size":
      return t.chat.attachmentErrors.maxImageSize.replace(
        "{size}",
        formatAttachmentBytes(validation.limit ?? 0),
      );
    case "max_file_size":
      return t.chat.attachmentErrors.maxFileSize.replace(
        "{size}",
        formatAttachmentBytes(validation.limit ?? 0),
      );
    case "unsupported_type":
      return t.chat.attachmentErrors.unsupportedType.replace(
        "{name}",
        validation.name ?? "unknown",
      );
    default:
      return validation.reason;
  }
}

async function releaseStoredAttachments(attachments: readonly Attachment[]) {
  await Promise.allSettled(
    attachments.map(async (attachment) => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      await deleteAttachment(attachment.id);
    }),
  );
}

interface IntakeOptions {
  attachments: Attachment[];
  onAttachmentsChange: (attachments: Attachment[]) => void;
  disabled: boolean;
}

interface PendingIntake {
  controller: AbortController;
  attachments: Attachment[];
  committed: boolean;
}

/** The single intake path for files, clipboard images and preview annotations. */
export function useAttachmentIntake(options: IntakeOptions) {
  const t = useT();
  const register = useAttachmentIntakeRegistration();
  const activeId = useConversationStore((state) => state.activeId);
  const conversation = useConversationStore((state) =>
    state.activeId ? state.conversations[state.activeId] : undefined,
  );
  const identity = conversation
    ? captureConversationIdentity(conversation)
    : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ ...options, t, identity, activeId });
  const pending = useRef<PendingIntake | null>(null);
  const awaitingCommit = useRef(false);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.controller.abort();
    };
  }, []);

  useLayoutEffect(() => {
    latest.current = { ...options, t, identity, activeId };
    awaitingCommit.current = false;
    const operation = pending.current;
    if (
      operation &&
      !operation.committed &&
      (options.disabled || operation.attachments !== options.attachments)
    ) {
      operation.controller.abort();
      setError(t.chat.attachmentErrors.staleDraft);
    }
  });

  const intake = useCallback<AttachmentIntake>(
    async (files, requestedIdentity, signal) => {
      const start = latest.current;
      const fail = (message: string): AttachmentIntakeResult => {
        if (mounted.current) setError(message);
        return { ok: false, error: message };
      };
      if (!mounted.current || start.disabled || !files.length)
        return fail(start.t.chat.attachmentErrors.unavailable);
      if (pending.current || awaitingCommit.current)
        return fail(start.t.chat.attachmentErrors.busy);

      const identity = start.identity;
      const identityIsCurrent = () => {
        const current = useConversationStore.getState();
        return identity
          ? current.activeId === identity.conversationId &&
              isConversationIdentityCurrent(
                identity,
                current.conversations[identity.conversationId],
              )
          : current.activeId === start.activeId;
      };
      if (
        signal?.aborted ||
        !identityIsCurrent() ||
        (requestedIdentity &&
          (!identity ||
            requestedIdentity.conversationId !== identity.conversationId ||
            requestedIdentity.branchId !== identity.branchId ||
            requestedIdentity.checkoutEpoch !== identity.checkoutEpoch))
      )
        return fail(start.t.chat.attachmentErrors.staleDraft);

      const controller = new AbortController();
      const operation: PendingIntake = {
        controller,
        attachments: start.attachments,
        committed: false,
      };
      pending.current = operation;
      setBusy(true);
      setError(null);
      const cancelled = () => {
        if (pending.current === operation) {
          pending.current = null;
          if (mounted.current) setBusy(false);
        }
      };
      controller.signal.addEventListener("abort", cancelled, { once: true });
      const relayAbort = () => controller.abort();
      signal?.addEventListener("abort", relayAbort, { once: true });
      // Subscribe synchronously: switching away and back in a single React batch
      // must still permanently cancel the old intake.
      const unsubscribe = useConversationStore.subscribe(() => {
        if (!identityIsCurrent()) controller.abort();
      });
      const assertCurrent = () => {
        if (
          !mounted.current ||
          !identityIsCurrent() ||
          latest.current.attachments !== start.attachments ||
          latest.current.disabled
        )
          controller.abort();
        controller.signal.throwIfAborted();
      };
      const system = useSettingsStore.getState().system;
      const compression: ImageCompressionSettings = {
        enabled: system.imageCompressionEnabled,
        quality: system.imageCompressionQuality,
      };
      const accepted: Attachment[] = [];
      const errors: string[] = [];
      let validationNext = [...start.attachments];

      try {
        for (const file of files) {
          assertCurrent();
          const validation = validateAttachmentFile(file, validationNext);
          if (!validation.ok) {
            errors.push(formatAttachmentError(validation, start.t));
            continue;
          }
          try {
            const image = isImageMime(file.type);
            let storedFile = file;
            if (image) {
              try {
                storedFile = await compressLocalImage(
                  file,
                  compression,
                  controller.signal,
                );
              } catch (error) {
                if (
                  controller.signal.aborted ||
                  (error instanceof Error && error.name === "AbortError")
                )
                  throw error;
                // Compression is optional; retain the validated original bytes.
              }
            }
            assertCurrent();
            const attachment = await storeAttachmentFile(
              storedFile,
              image ? "image" : "file",
            );
            accepted.push(attachment);
            assertCurrent();
            // Validate a batch against original sizes, before optional compression.
            validationNext = [
              ...validationNext,
              { ...attachment, size: file.size },
            ];
          } catch (error) {
            if (
              controller.signal.aborted ||
              (error instanceof Error && error.name === "AbortError")
            )
              throw error;
            errors.push(
              start.t.chat.attachmentErrors.readFailed.replace(
                "{name}",
                file.name || "file",
              ),
            );
          }
        }
        assertCurrent();
        if (accepted.length) {
          operation.committed = true;
          // React may batch the draft update beyond this promise. Until that
          // commit, another caller must not append to the old attachment array.
          awaitingCommit.current = true;
          start.onAttachmentsChange([...start.attachments, ...accepted]);
        }
        setError(errors[0] ?? null);
        return errors.length ? { ok: false, error: errors[0] } : { ok: true };
      } catch {
        const message = controller.signal.aborted
          ? start.t.chat.attachmentErrors.staleDraft
          : start.t.chat.attachmentErrors.readFailed.replace("{name}", "file");
        if (
          !controller.signal.aborted &&
          mounted.current &&
          identityIsCurrent()
        )
          setError(message);
        return { ok: false, error: message };
      } finally {
        unsubscribe();
        signal?.removeEventListener("abort", relayAbort);
        controller.signal.removeEventListener("abort", cancelled);
        if (!operation.committed) await releaseStoredAttachments(accepted);
        if (pending.current === operation) {
          pending.current = null;
          if (mounted.current) setBusy(false);
        }
      }
    },
    [],
  );

  const available = !!conversation && !options.disabled;
  useLayoutEffect(
    () => register?.({ intake, busy, available }),
    [register, intake, busy, available],
  );

  return { intake, busy, error };
}
