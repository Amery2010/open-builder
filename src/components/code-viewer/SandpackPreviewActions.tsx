import { useEffect, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useSandpackNavigation } from "@codesandbox/sandpack-react";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";

interface SandpackActionButtonProps {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}

export function SandpackActionButton({
  label,
  pressed,
  onClick,
  children,
}: SandpackActionButtonProps) {
  return (
    <TooltipIconButton
      label={label}
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-pressed={pressed}
      data-active={pressed ? "true" : undefined}
      className="size-7 rounded-full border border-[var(--sp-colors-surface3)] bg-[var(--sp-colors-surface2)] p-1 text-[var(--sp-colors-clickable)] shadow-none hover:bg-[var(--sp-colors-surface3)] hover:text-[var(--sp-colors-hover)] data-[active=true]:bg-[var(--sp-colors-accent)] data-[active=true]:text-[var(--sp-colors-surface1)]"
      onClick={onClick}
    >
      {children}
    </TooltipIconButton>
  );
}

export function SandpackRefreshAction({
  label,
  onBeforeRefresh,
}: {
  label: string;
  onBeforeRefresh?: () => void;
}) {
  const { refresh } = useSandpackNavigation();

  return (
    <SandpackActionButton
      label={label}
      onClick={() => {
        onBeforeRefresh?.();
        refresh();
      }}
    >
      <RefreshCw size={16} />
    </SandpackActionButton>
  );
}

export function SandpackRefreshRegistration({
  onChange,
}: {
  onChange: (refresh: (() => void) | null) => void;
}) {
  const { refresh } = useSandpackNavigation();

  useEffect(() => {
    onChange(refresh);
    return () => onChange(null);
  }, [onChange, refresh]);

  return null;
}
