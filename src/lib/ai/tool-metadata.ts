import {
  FolderOpen,
  Eye,
  Files,
  FilePen,
  FilePenLine,
  FolderInput,
  Wrench,
  Trash2,
  Search,
  Globe,
  Terminal,
  Image,
  Package,
  Package2,
  ScrollText,
  Play,
  ScanLine,
  FileKey,
  KeyRound,
  Palette,
  type LucideIcon,
} from "lucide-react";
import type { Translations } from "../../i18n";
import { basename } from "../tools/file-refs";

export interface ToolMeta {
  iconComponent: LucideIcon;
  iconClass: string;
  /** Optional formatter for the tool-card title bar. Returning `undefined`
   *  falls through to the default (`t.tool.names[name]`). */
  titleBuilder?: (
    args: Record<string, unknown>,
    t: Translations,
  ) => string | undefined;
}

export const TOOL_METADATA: Record<string, ToolMeta> = {
  list_files: { iconComponent: FolderOpen, iconClass: "text-yellow-500" },
  read_file: { iconComponent: Eye, iconClass: "text-blue-400" },
  read_files: { iconComponent: Files, iconClass: "text-blue-400" },
  write_file: { iconComponent: FilePen, iconClass: "text-green-500" },
  patch_file: { iconComponent: Wrench, iconClass: "text-orange-400" },
  delete_file: { iconComponent: Trash2, iconClass: "text-red-400" },
  search_in_files: { iconComponent: Search, iconClass: "text-amber-500" },
  web_search: { iconComponent: Search, iconClass: "text-purple-500" },
  web_reader: { iconComponent: Globe, iconClass: "text-teal-500" },
  image_search: { iconComponent: Image, iconClass: "text-pink-500" },
  search_npm_packages: { iconComponent: Package, iconClass: "text-blue-500" },
  get_npm_package_detail: {
    iconComponent: Package,
    iconClass: "text-blue-500",
  },
  get_console_logs: { iconComponent: Terminal, iconClass: "text-sky-500" },
  list_skills: { iconComponent: ScrollText, iconClass: "text-indigo-500" },
  read_skill: {
    iconComponent: ScrollText,
    iconClass: "text-indigo-500",
  },
  execute_skill_script: { iconComponent: Play, iconClass: "text-indigo-500" },

  rename_file: {
    iconComponent: FilePenLine,
    iconClass: "text-cyan-500",
    titleBuilder: (args) => {
      if (
        typeof args.old_path !== "string" ||
        typeof args.new_path !== "string"
      ) {
        return undefined;
      }
      return `${basename(args.old_path)} → ${basename(args.new_path)}`;
    },
  },
  move_file: {
    iconComponent: FolderInput,
    iconClass: "text-cyan-500",
    titleBuilder: (args, t) => {
      if (typeof args.path !== "string") return undefined;
      const dir =
        typeof args.target_dir === "string" && args.target_dir
          ? args.target_dir
          : t.tool.projectRoot;
      return `${basename(args.path)} → ${dir}`;
    },
  },
  install_component: {
    iconComponent: Package2,
    iconClass: "text-violet-500",
    titleBuilder: (args, t) => {
      if (typeof args.name !== "string") return undefined;
      return `${t.tool.names.install_component}: ${args.name}`;
    },
  },
  screenshot_to_code: {
    iconComponent: ScanLine,
    iconClass: "text-fuchsia-500",
  },
  apply_design_style: {
    iconComponent: Palette,
    iconClass: "text-rose-500",
    titleBuilder: (args, t) =>
      typeof args.style === "string"
        ? `${t.tool.names.apply_design_style}: ${args.style}`
        : undefined,
  },
  apply_design_system: {
    iconComponent: Palette,
    iconClass: "text-violet-500",
    titleBuilder: (args, t) =>
      typeof args.system_id === "string"
        ? `${t.tool.names.apply_design_system}: ${args.system_id}`
        : undefined,
  },
  submit_design_review: {
    iconComponent: Palette,
    iconClass: "text-violet-500",
  },
  read_env_schema: { iconComponent: FileKey, iconClass: "text-amber-500" },
  manage_env: {
    iconComponent: KeyRound,
    iconClass: "text-amber-500",
    titleBuilder: (args, t) => {
      const n = Array.isArray(args.operations) ? args.operations.length : 0;
      return `${t.tool.names.manage_env}: ${n} ${t.tool.envOps}`;
    },
  },
};
