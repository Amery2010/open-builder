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
    template,
    setTemplate,
    sandpackKey,
    restartSandpack,
    isProjectInitialized,
    setIsProjectInitialized,
  } = useAppState();

  const { generate, stop, updateFiles } = useGenerator({
    settings,
    files,
    setMessages,
    setFiles,
    setIsGenerating,
    setTemplate,
    restartSandpack,
    setIsProjectInitialized,
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

      {isProjectInitialized ? (
        <div className="flex-1 h-full min-w-0">
          <CodeViewer
            files={files}
            currentFile={currentFile}
            onFileSelect={setCurrentFile}
            onFileChange={updateFiles}
            template={template}
            sandpackKey={sandpackKey}
          />
        </div>
      ) : (
        <div className="flex-1 h-full min-w-0 flex items-center justify-center bg-muted/30">
          <div className="text-center max-w-md px-6">
            <div className="text-5xl mb-6">🚀</div>
            <h2 className="text-xl font-semibold text-foreground mb-2">开始构建你的项目</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              在左侧对话框中描述你想要创建的应用，AI 将为你生成完整的项目代码。
            </p>
          </div>
        </div>
      )}

      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
      />
    </div>
  );
}
