import { useEffect, useState } from "react";
import type { ProjectAssets } from "../../types";
import { getProjectAssetBlob } from "../../lib/project-assets/core";
import { useT } from "../../i18n";

interface ProjectAssetListProps {
  assets: ProjectAssets;
}

export function ProjectAssetList({ assets }: ProjectAssetListProps) {
  const t = useT();
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    void Promise.all(
      Object.values(assets).map(async (asset) => {
        const blob = await getProjectAssetBlob(asset.blobRef);
        if (!blob || cancelled) return undefined;
        const url = URL.createObjectURL(blob);
        created.push(url);
        return [asset.path, url] as const;
      }),
    ).then(
      (entries) => {
        if (!cancelled) {
          setUrls(
            Object.fromEntries(entries.filter((entry) => entry !== undefined)),
          );
        }
      },
      () => {
        if (!cancelled) setUrls({});
      },
    );
    return () => {
      cancelled = true;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [assets]);

  const entries = Object.values(assets);
  if (entries.length === 0) return null;

  return (
    <section
      aria-label={t.explorer.assets}
      className="max-h-36 shrink-0 overflow-y-auto border-b bg-background p-2"
    >
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t.explorer.assets}
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {entries.map((asset) => (
          <figure key={asset.path} className="min-w-0">
            <div className="flex h-14 items-center justify-center overflow-hidden rounded border bg-muted/40">
              {urls[asset.path] ? (
                <img
                  src={urls[asset.path]}
                  alt=""
                  className="size-full object-contain"
                />
              ) : (
                <span className="text-[10px] text-muted-foreground">
                  {t.explorer.image}
                </span>
              )}
            </div>
            <figcaption className="mt-1 truncate text-[10px] text-muted-foreground">
              {asset.path.split("/").pop()}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
