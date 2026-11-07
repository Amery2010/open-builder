import { useId, useState } from "react";
import { Check } from "lucide-react";
import { Popover } from "radix-ui";
import { useT } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const COLORS = [
  ["red", "#ef4444"],
  ["orange", "#f97316"],
  ["yellow", "#eab308"],
  ["green", "#22c55e"],
  ["blue", "#3b82f6"],
  ["purple", "#a855f7"],
  ["black", "#171717"],
  ["white", "#ffffff"],
] as const;

export function AnnotationColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const t = useT().annotation;
  const id = useId();
  const [draft, setDraft] = useState(value);
  const valid = /^#[a-f\d]{6}$/i.test(draft);

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) setDraft(value);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label={t.color}
              disabled={disabled}
            >
              <span
                aria-hidden="true"
                className="size-4 rounded-full border border-black/15"
                style={{ backgroundColor: value }}
              />
            </Button>
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent>{t.color}</TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t.color}
          className="z-50 w-56 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md outline-none"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <p className="mb-3 text-sm font-medium">{t.color}</p>
          <div
            role="group"
            aria-label={t.presetColors}
            className="grid grid-cols-4 gap-2"
          >
            {COLORS.map(([name, color]) => (
              <Button
                key={color}
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t.colors[name]}
                aria-pressed={value.toLowerCase() === color}
                disabled={disabled}
                className="w-full"
                onClick={() => {
                  setDraft(color);
                  onChange(color);
                }}
              >
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border border-black/15",
                    value.toLowerCase() === color &&
                      "ring-2 ring-ring ring-offset-2 ring-offset-popover",
                  )}
                  style={{ backgroundColor: color }}
                >
                  {value.toLowerCase() === color && (
                    <Check
                      aria-hidden="true"
                      className={
                        name === "yellow" || name === "white"
                          ? "text-black"
                          : "text-white"
                      }
                      size={14}
                    />
                  )}
                </span>
              </Button>
            ))}
          </div>
          <label
            htmlFor={id}
            className="mt-3 mb-1.5 block text-xs font-medium text-muted-foreground"
          >
            {t.customColor}
          </label>
          <Input
            id={id}
            aria-label={t.hexColor}
            aria-invalid={!valid}
            aria-describedby={!valid ? `${id}-error` : undefined}
            value={draft}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            maxLength={7}
            className="h-8 font-mono text-sm"
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              if (/^#[a-f\d]{6}$/i.test(next)) onChange(next.toLowerCase());
            }}
          />
          {!valid && (
            <p id={`${id}-error`} className="mt-1.5 text-xs text-destructive">
              {t.invalidColor}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
