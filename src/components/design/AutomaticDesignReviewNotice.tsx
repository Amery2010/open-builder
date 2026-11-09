import { useEffect, useId, useRef } from "react";
import { toast, type ExternalToast } from "sonner";
import { useT } from "../../i18n";
import type { AutomaticDesignReviewStage } from "../../lib/design/automatic-review";

export function AutomaticDesignReviewNotice({
  stage,
  visible,
  onOpen,
}: {
  stage: AutomaticDesignReviewStage;
  visible: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const toastId = useId();
  const dismissed = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(
    () => () => {
      toast.dismiss(toastId);
    },
    [toastId],
  );
  useEffect(() => {
    if (!visible || dismissed.current) {
      toast.dismiss(toastId);
      return;
    }
    const pending =
      stage === "capturing" ||
      stage === "reviewing" ||
      stage === "fixing" ||
      stage === "verifying" ||
      stage === "deferred";
    const dismiss = () => {
      if (visibleRef.current) dismissed.current = true;
    };
    const options: ExternalToast = {
      id: toastId,
      duration: pending ? Infinity : 8_000,
      onDismiss: dismiss,
      onAutoClose: dismiss,
      action:
        stage === "unavailable"
          ? {
              label: t.designReview.openWorkspace,
              onClick: () => {
                dismiss();
                onOpen();
              },
            }
          : undefined,
      cancel:
        stage === "unavailable"
          ? { label: t.designReview.dismissNotice, onClick: dismiss }
          : undefined,
    };
    const notify = pending
      ? toast.loading
      : stage === "complete"
        ? toast.success
        : stage === "unavailable"
          ? toast.error
          : toast.warning;
    notify(t.designReview.automaticStages[stage], options);
  }, [stage, visible, onOpen, t.designReview, toastId]);
  return null;
}
