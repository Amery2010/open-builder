import { useState } from "react";
import { Download } from "lucide-react";
import type { ProjectAssets, ProjectFiles } from "../../types";
import { useT } from "../../i18n";
import { useConversationStore } from "../../store/conversation";
import type { ProjectBuildTarget } from "../../lib/project-build/target";
import { Button } from "../ui/button";
import { ProjectDownloadMenu } from "./ProjectDownloadMenu";
import { ProjectBuildDialog } from "./ProjectBuildDialog";

interface ProjectBuildDownloadProps {
  files: ProjectFiles;
  assets: ProjectAssets;
  isGenerating: boolean;
  onDownloadSource: () => Promise<void>;
}

export function ProjectBuildDownload({
  isGenerating,
  onDownloadSource,
}: ProjectBuildDownloadProps) {
  const t = useT().projectBuild;
  const conversationId = useConversationStore((state) => state.activeId);
  const [target, setTarget] = useState<ProjectBuildTarget | null>(null);
  const [sourceError, setSourceError] = useState("");
  return (
    <>
      <ProjectDownloadMenu
        trigger={
          <Button size="icon-sm" variant="ghost" aria-label={t.download}>
            <Download size={16} />
          </Button>
        }
        versions={[{ id: conversationId ?? "", label: t.download }]}
        onSource={() => {
          setSourceError("");
          void onDownloadSource().catch((reason: unknown) => {
            setSourceError(
              `${t.downloadFailed}: ${reason instanceof Error ? reason.message : String(reason)}`,
            );
          });
        }}
        onBuild={() => {
          if (conversationId) setTarget({ kind: "current", conversationId });
        }}
      />
      {sourceError && (
        <p role="alert" className="text-xs text-destructive">
          {sourceError}
        </p>
      )}
      {target && (
        <ProjectBuildDialog
          target={target}
          isGenerating={isGenerating}
          onClose={() => setTarget(null)}
        />
      )}
    </>
  );
}
