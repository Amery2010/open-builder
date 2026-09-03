import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../../i18n";

export type LocalCliStatusNoticeKind =
  "hostUnsupported" | "setupRequired" | "notFound" | "unavailable";

export interface LocalCliStatusNoticeValue {
  providerName: string;
  kind: LocalCliStatusNoticeKind;
}

interface LocalCliStatusNoticeProps {
  notice: LocalCliStatusNoticeValue;
  onOpenSettings: () => void;
}

export function LocalCliStatusNotice({
  notice,
  onOpenSettings,
}: LocalCliStatusNoticeProps) {
  const t = useT();
  const copy = t.settings.localCli.chatNotice;

  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5"
      role="status"
      aria-live="polite"
    >
      <AlertTriangle
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {copy.title.replace("{provider}", notice.providerName)}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {copy[notice.kind]}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2.5 h-8"
          onClick={onOpenSettings}
        >
          {copy.openSettings}
        </Button>
      </div>
    </div>
  );
}
