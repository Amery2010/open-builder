import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import type { AutomaticDesignReviewStage } from "../../lib/design/automatic-review";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export function AutomaticDesignReviewNotice({
  stage,
  visible,
  className,
  onOpen,
}: {
  stage: AutomaticDesignReviewStage;
  visible: boolean;
  className?: string;
  onOpen: () => void;
}) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!visible || dismissed || stage !== "unavailable") return;
    const timer = window.setTimeout(() => setDismissed(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [visible, dismissed, stage]);
  if (!visible || dismissed) return null;
  return (
    <div
      role="status"
      className={cn(
        "absolute z-40 max-w-md rounded-lg border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur",
        className,
      )}
    >
      <p>{t.designReview.automaticStages[stage]}</p>
      {stage === "unavailable" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDismissed(true);
              onOpen();
            }}
          >
            {t.designReview.openWorkspace}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            {t.designReview.dismissNotice}
          </Button>
        </div>
      )}
    </div>
  );
}
