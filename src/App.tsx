import { ChatInterface } from "./components/ChatInterface";
import { CodeViewer } from "./components/CodeViewer";
import { SettingsDialog } from "./components/SettingsDialog";
import { useAppState } from "./hooks/useAppState";
import { useGenerator } from "./hooks/useGenerator";

export default function App() {
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
  } = useAppState();

  const { generate, stop, updateFiles } = useGenerator({
    settings,
    files,
    setMessages,
    setFiles,
    setIsGenerating,
  });

  return (
    <div className="flex h-screen w-full bg-background">
      <div className="w-100 shrink-0 h-full">
        <ChatInterface
          messages={messages}
          isGenerating={isGenerating}
          hasValidSettings={hasValidSettings}
          onGenerate={generate}
          onStop={stop}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />
      </div>

      <div className="flex-1 h-full min-w-0">
        <CodeViewer
          files={files}
          currentFile={currentFile}
          onFileSelect={setCurrentFile}
          onFileChange={updateFiles}
        />
      </div>

      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
      />
    </div>
  );
}
