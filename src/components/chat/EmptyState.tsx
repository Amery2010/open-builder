import { Button } from "@/components/ui/button";
import {
  BriefcaseBusiness,
  CheckCheck,
  Coffee,
  LayoutTemplate,
} from "lucide-react";
import { useT } from "../../i18n";
import { useProjectTemplateLibraryUi } from "../../store/project-template-library-ui";

interface EmptyStateProps {
  onSelectSuggestion: (text: string) => void;
}

export function EmptyState({ onSelectSuggestion }: EmptyStateProps) {
  const t = useT();
  const openLibrary = useProjectTemplateLibraryUi((state) => state.openLibrary);
  const suggestions = [
    { Icon: BriefcaseBusiness, ...t.empty.suggestions.portfolio },
    { Icon: CheckCheck, ...t.empty.suggestions.tasks },
    { Icon: Coffee, ...t.empty.suggestions.cafe },
  ];

  return (
    <div className="flex flex-1 flex-col justify-center py-8">
      <div className="mx-auto w-full max-w-xs space-y-4">
        <div className="space-y-2">
          <h2 className="text-base font-semibold text-balance">
            {t.empty.title}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground text-pretty">
            {t.empty.description}
          </p>
        </div>
        <div
          role="group"
          aria-label={t.empty.suggestionsLabel}
          className="w-full space-y-2"
        >
          {suggestions.map(({ Icon, title, description, prompt }) => (
            <Button
              key={title}
              type="button"
              variant="outline"
              className="h-auto w-full items-start justify-start gap-3 whitespace-normal px-3 py-3 text-left"
              onClick={() => onSelectSuggestion(prompt)}
            >
              <Icon
                size={16}
                className="mt-0.5 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 space-y-1">
                <span className="block text-sm font-medium">{title}</span>
                <span className="block text-xs font-normal leading-5 text-muted-foreground">
                  {description}
                </span>
              </span>
            </Button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          className="h-auto justify-start gap-2 px-0 text-sm text-muted-foreground"
          onClick={() => openLibrary()}
        >
          <LayoutTemplate size={16} aria-hidden="true" />
          {t.commandPalette.actions.openTemplates}
        </Button>
        <p className="text-xs leading-5 text-muted-foreground text-pretty">
          {t.empty.referenceHint}
        </p>
      </div>
    </div>
  );
}
