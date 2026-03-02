import { useEffect } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ChatInterface } from "./components/ChatInterface";
import { CodeViewer } from "./components/CodeViewer";
import { SettingsDialog } from "./components/SettingsDialog";
import { useAppState } from "./hooks/useAppState";
import { useGenerator } from "./hooks/useGenerator";
import { useIsMobile } from "./hooks/useIsMobile";
import { useTheme } from "./hooks/useTheme";
import { useConversationStore } from "./store/conversation";
import { useT } from "./i18n";

export default function App() {
  const t = useT();
  const activeId = useConversationStore((s) => s.activeId);
  const hasHydrated = useConversationStore((s) => s._hasHydrated);
  const conversations = useConversationStore((s) => s.conversations);
  const createConversation = useConversationStore((s) => s.createConversation);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const isMobile = useIsMobile();
  useTheme();

  // On hydration: ensure there's an active conversation
  useEffect(() => {
    if (!hasHydrated) return;
    if (!activeId || !conversations[activeId]) {
      const entries = Object.values(conversations);
      if (entries.length > 0) {
        const latest = entries.sort((a, b) => b.updatedAt - a.updatedAt)[0];
        switchConversation(latest.id);
      } else {
        createConversation();
      }
    }
  }, [hasHydrated]);

  const {
    files,
    setFiles,
    currentFile,
    setCurrentFile,
    messages,
    setMessages,
    isGenerating,
    setIsGenerating,
    settings,
    hasValidSettings,
    isSettingsOpen,
    setIsSettingsOpen,
    handleSaveSettings,
    webSearchSettings,
    handleSaveWebSearchSettings,
    systemSettings,
    handleSaveSystemSettings,
    template,
    setTemplate,
    sandpackKey,
    restartSandpack,
    isProjectInitialized,
    setIsProjectInitialized,
  } = useAppState();

  const {
    generate,
    stop,
    retry,
    continueTask,
    updateFiles,
    deleteFile,
    renameFile,
    moveFile,
    compressContext,
    review,
  } = useGenerator({
    settings,
    webSearchSettings,
    files,
    setMessages,
    setFiles,
    setIsGenerating,
    setTemplate,
    restartSandpack,
    setIsProjectInitialized,
  });

  // Reset ephemeral state on conversation switch
  useEffect(() => {
    // setCurrentFile("src/App.tsx");
    restartSandpack();
  }, [activeId]);

  if (!hasHydrated) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">{t.app.loading}</p>
      </div>
    );
  }

  return (
    <ResizablePanelGroup className="flex h-full w-full bg-background">
      <ResizablePanel
        className="h-full w-full md:w-100 md:flex-1 shrink-0 overflow-hidden"
        defaultSize="30%"
        minSize={360}
        maxSize={isMobile ? "100%" : "50%"}
      >
        <ChatInterface
          messages={messages}
          isGenerating={isGenerating}
          hasValidSettings={hasValidSettings}
          onGenerate={generate}
          onStop={stop}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onSetFiles={(f) => setFiles(f)}
          files={files}
          template={template}
          sandpackKey={sandpackKey}
          isProjectInitialized={isProjectInitialized}
          onCompressContext={compressContext}
          onRetry={retry}
          onContinue={continueTask}
          onReview={review}
        />
      </ResizablePanel>

      {!isMobile ? (
        <>
          <ResizableHandle className="hidden md:flex" />

          <ResizablePanel className="w-full h-full min-w-0 hidden md:flex overflow-hidden">
            {isProjectInitialized && !isMobile ? (
              <CodeViewer
                files={files}
                currentFile={currentFile}
                onFileSelect={setCurrentFile}
                onFileChange={updateFiles}
                onRenameFile={renameFile}
                onDeleteFile={deleteFile}
                onMoveFile={moveFile}
                template={template}
                sandpackKey={sandpackKey}
              />
            ) : (
              <div className="flex w-full h-full min-w-0 items-center justify-center bg-muted/30">
                <div className="text-center max-w-md px-6">
                  <div className="text-5xl mb-6">🚀</div>
                  <h2 className="text-xl font-semibold text-foreground mb-2">
                    {t.app.startBuilding}
                  </h2>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    {t.app.startBuildingDesc}
                  </p>
                </div>
              </div>
            )}
          </ResizablePanel>
        </>
      ) : null}

      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
        webSearchSettings={webSearchSettings}
        onSaveWebSearch={handleSaveWebSearchSettings}
        systemSettings={systemSettings}
        onSaveSystem={handleSaveSystemSettings}
      />
    </ResizablePanelGroup>
  );
}
