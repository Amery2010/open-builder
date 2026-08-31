import { useMemo } from "react";
import { useT } from "../i18n";
import { useSettingsStore } from "../store/settings";
import { SHORTCUT_LABELS } from "./useGlobalShortcuts";
import { useProjectTemplateLibraryUi } from "../store/project-template-library-ui";
import type { CommandAction } from "../components/command-palette/CommandPalette";

interface UseCommandPaletteActionsArgs {
  createConversation: () => void;
  openSettings: () => void;
  isGenerating: boolean;
  stop: () => void;
  compressContext: () => void | Promise<unknown>;
  messagesEmpty: boolean;
}

export function useCommandPaletteActions({
  createConversation,
  openSettings,
  isGenerating,
  stop,
  compressContext,
  messagesEmpty,
}: UseCommandPaletteActionsArgs): CommandAction[] {
  const t = useT();
  const setSystem = useSettingsStore((s) => s.setSystem);
  const systemSettingsLive = useSettingsStore((s) => s.system);
  const openProjectTemplates = useProjectTemplateLibraryUi(
    (state) => state.openLibrary,
  );

  return useMemo<CommandAction[]>(() => {
    const cycleTheme = () => {
      const order = ["system", "light", "dark"] as const;
      const idx = order.indexOf(systemSettingsLive.theme);
      const next = order[(idx + 1) % order.length];
      setSystem({ ...systemSettingsLive, theme: next });
    };
    return [
      {
        id: "new-conversation",
        label: t.commandPalette.actions.newConversation,
        group: t.commandPalette.groups.session,
        shortcut: SHORTCUT_LABELS.newConversation,
        run: () => createConversation(),
      },
      {
        id: "open-templates",
        label: t.commandPalette.actions.openTemplates,
        group: t.commandPalette.groups.session,
        run: () => openProjectTemplates(),
      },
      {
        id: "compress-context",
        label: t.commandPalette.actions.compressContext,
        group: t.commandPalette.groups.session,
        hidden: messagesEmpty,
        run: () => void compressContext(),
      },
      {
        id: "stop-generating",
        label: t.commandPalette.actions.stopGenerating,
        group: t.commandPalette.groups.session,
        shortcut: SHORTCUT_LABELS.stopGenerating,
        hidden: !isGenerating,
        run: () => stop(),
      },
      {
        id: "open-settings",
        label: t.commandPalette.actions.openSettings,
        group: t.commandPalette.groups.settings,
        shortcut: SHORTCUT_LABELS.openSettings,
        run: openSettings,
      },
      {
        id: "toggle-theme",
        label: t.commandPalette.actions.toggleTheme,
        group: t.commandPalette.groups.settings,
        run: cycleTheme,
      },
    ];
  }, [
    t,
    createConversation,
    openProjectTemplates,
    openSettings,
    messagesEmpty,
    compressContext,
    isGenerating,
    stop,
    systemSettingsLive,
    setSystem,
  ]);
}
