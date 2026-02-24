import { useState } from "react";
import { ChatInterface } from "./components/ChatInterface";
import { CodeViewer } from "./components/CodeViewer";
import { generateCode } from "./lib/gemini";

export default function App() {
  const [code, setCode] = useState(`export default function App() {
  const data = "world"

  return <h1>Hello {data}</h1>
}`);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerate = async (prompt: string) => {
    setIsGenerating(true);
    try {
      const newCode = await generateCode(prompt, code);
      if (newCode) {
        setCode(newCode);
      }
    } catch (error) {
      console.error("Error generating code:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex h-screen w-full bg-gray-50">
      {/* Left Panel - Chat */}
      <div className="w-[400px] shrink-0 h-full">
        <ChatInterface
          onGenerate={handleGenerate}
          isGenerating={isGenerating}
        />
      </div>

      {/* Right Panel - Code/Preview */}
      <div className="flex-1 h-full min-w-0">
        <CodeViewer code={code} onCodeChange={setCode} />
      </div>
    </div>
  );
}
