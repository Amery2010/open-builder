import {
  Accessibility,
  Eye,
  FileKey,
  FilePen,
  FilePenLine,
  Files,
  FolderOpen,
  Globe,
  Image,
  KeyRound,
  Package,
  Package2,
  Palette,
  Play,
  ScanLine,
  ScrollText,
  Search,
  Terminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { Translations } from "../../i18n";
import { HOST_TOOL_RECORDS } from "./tools-schema";

export interface ToolMeta {
  iconComponent: LucideIcon;
  iconClass: string;
  /** Optional formatter for the tool-card title bar. Returning `undefined`
   * falls through to the localized tool name. */
  titleBuilder?: (
    args: Record<string, unknown>,
    t: Translations,
  ) => string | undefined;
}

type IconPresentation = Pick<ToolMeta, "iconComponent" | "iconClass">;

/** Icon keys are declared by HostToolRecord; this is only the UI adapter from
 * those stable keys to the current Lucide presentation. */
const ICON_PRESENTATION: Readonly<Record<string, IconPresentation>> = {
  builtin: { iconComponent: Wrench, iconClass: "text-slate-500" },
  project: { iconComponent: FilePen, iconClass: "text-green-500" },
  network: { iconComponent: Globe, iconClass: "text-purple-500" },
  provider: { iconComponent: Globe, iconClass: "text-purple-500" },
  mcp: { iconComponent: Globe, iconClass: "text-purple-500" },
  skill: { iconComponent: ScrollText, iconClass: "text-indigo-500" },
  registry: { iconComponent: Package2, iconClass: "text-violet-500" },
  "folder-open": { iconComponent: FolderOpen, iconClass: "text-yellow-500" },
  files: { iconComponent: Files, iconClass: "text-blue-400" },
  "file-pen": { iconComponent: FilePen, iconClass: "text-green-500" },
  patch: { iconComponent: Wrench, iconClass: "text-orange-400" },
  delete: { iconComponent: Trash2, iconClass: "text-red-400" },
  "project-search": { iconComponent: Search, iconClass: "text-amber-500" },
  "web-search": { iconComponent: Search, iconClass: "text-purple-500" },
  "web-reader": { iconComponent: Globe, iconClass: "text-teal-500" },
  "image-search": { iconComponent: Image, iconClass: "text-pink-500" },
  package: { iconComponent: Package, iconClass: "text-blue-500" },
  terminal: { iconComponent: Terminal, iconClass: "text-sky-500" },
  "skill-run": { iconComponent: Play, iconClass: "text-indigo-500" },
  "file-move": { iconComponent: FilePenLine, iconClass: "text-cyan-500" },
  component: { iconComponent: Package2, iconClass: "text-violet-500" },
  screenshot: { iconComponent: ScanLine, iconClass: "text-fuchsia-500" },
  "design-style": { iconComponent: Palette, iconClass: "text-rose-500" },
  design: { iconComponent: Palette, iconClass: "text-violet-500" },
  "design-contract": {
    iconComponent: ScrollText,
    iconClass: "text-violet-500",
  },
  preview: { iconComponent: Eye, iconClass: "text-sky-500" },
  evidence: { iconComponent: ScanLine, iconClass: "text-violet-500" },
  accessibility: {
    iconComponent: Accessibility,
    iconClass: "text-blue-500",
  },
  "env-read": { iconComponent: FileKey, iconClass: "text-amber-500" },
  "env-write": { iconComponent: KeyRound, iconClass: "text-amber-500" },
};

const FALLBACK_ICON: IconPresentation = {
  iconComponent: Wrench,
  iconClass: "text-slate-500",
};

const catalogMetadata: Record<string, ToolMeta> = Object.fromEntries(
  HOST_TOOL_RECORDS.map((record) => {
    const icon =
      ICON_PRESENTATION[record.presentation.iconKey] ?? FALLBACK_ICON;
    return [
      record.name,
      {
        ...icon,
        titleBuilder: (args: Record<string, unknown>, t: Translations) => {
          const summary = record.presentation.summarizeArguments(args);
          if (!summary) return undefined;
          const localized = (t.tool.names as Record<string, string>)[
            record.name
          ];
          return `${localized ?? record.presentation.name.en}: ${summary}`;
        },
      } satisfies ToolMeta,
    ];
  }),
);

/** Legacy presentation-only fallbacks keep historical cards readable without
 * reintroducing either tool into executable Catalog authority. */
const legacyMetadata: Record<string, ToolMeta> = {
  read_file: { iconComponent: Eye, iconClass: "text-blue-400" },
  apply_design_system: {
    iconComponent: Palette,
    iconClass: "text-violet-500",
    titleBuilder: (args, t) =>
      typeof args.system_id === "string"
        ? `${t.tool.names.apply_design_system}: ${args.system_id}`
        : undefined,
  },
};

export const TOOL_METADATA: Record<string, ToolMeta> = {
  ...catalogMetadata,
  ...legacyMetadata,
};
