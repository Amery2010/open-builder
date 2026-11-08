import type { ReactElement } from "react";
import { Download, Package } from "lucide-react";
import { useT } from "../../i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "../ui/dropdown-menu";

export interface ProjectDownloadVersion {
  id: string;
  label: string;
  sourceDisabled?: boolean;
  sourceStatus?: string;
}

/** Both entry points share the same actions; history adds a version submenu. */
export function ProjectDownloadMenu({
  trigger,
  versions,
  onSource,
  onBuild,
  align = "end",
}: {
  trigger: ReactElement;
  versions: ProjectDownloadVersion[];
  onSource: (id: string) => void;
  onBuild: (id: string) => void;
  align?: "start" | "end";
}) {
  const t = useT().projectBuild;
  const actions = [
    { key: "source", label: t.source, icon: Download, select: onSource },
    { key: "build", label: t.deployment, icon: Package, select: onBuild },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {actions.map(({ key, label, icon: Icon, select }) =>
          versions.length > 1 ? (
            <DropdownMenuSub key={key}>
              <DropdownMenuSubTrigger>
                <Icon size={16} />
                {label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {versions.map((version) => (
                  <DropdownMenuItem
                    key={version.id}
                    disabled={key === "source" && version.sourceDisabled}
                    onSelect={() => select(version.id)}
                  >
                    <span className="min-w-0 truncate">{version.label}</span>
                    {key === "source" && version.sourceStatus && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {version.sourceStatus}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            <DropdownMenuItem
              key={key}
              disabled={
                !versions[0] || (key === "source" && versions[0].sourceDisabled)
              }
              onSelect={() => select(versions[0].id)}
            >
              <Icon size={16} />
              {label}
              {key === "source" && versions[0]?.sourceStatus && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {versions[0].sourceStatus}
                </span>
              )}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
