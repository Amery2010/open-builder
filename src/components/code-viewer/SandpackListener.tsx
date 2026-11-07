import { useEffect, useRef, useState } from "react";
import { useSandpack, useSandpackConsole } from "@codesandbox/sandpack-react";
import {
  normalizeConsoleLogs,
  useSandpackStore,
  type ConsoleLogData,
} from "@/store/sandpack";
import { createSandpackFileChangeScheduler } from "./sandpack-file-changes";

interface SandpackListenerProps {
  conversationId: string;
  requestedActiveFile: string;
  onFileChange: (conversationId: string, path: string, content: string) => void;
}

export function SandpackListener({
  conversationId,
  requestedActiveFile,
  onFileChange,
}: SandpackListenerProps) {
  const { sandpack, listen } = useSandpack();
  const { files, activeFile, setActiveFile } = sandpack;
  const code = files[activeFile]?.code;
  const { logs } = useSandpackConsole({
    resetOnPreviewRestart: true,
    showSyntaxError: true,
  });
  const setConsoleLogs = useSandpackStore((s) => s.setConsoleLogs);
  const [serverLogs, setServerLogs] = useState<ConsoleLogData[]>([]);
  const serverLogId = useRef(0);
  const logOrder = useRef(new Map<string, number>());
  const nextLogOrder = useRef(0);
  const onFileChangeRef = useRef(onFileChange);
  const schedulerRef = useRef<
    ReturnType<typeof createSandpackFileChangeScheduler> | undefined
  >(undefined);
  schedulerRef.current ??= createSandpackFileChangeScheduler();

  useEffect(() => {
    onFileChangeRef.current = onFileChange;
  }, [onFileChange]);

  useEffect(() => {
    if (!requestedActiveFile) return;
    const normalizedRequestedFile = requestedActiveFile.startsWith("/")
      ? requestedActiveFile
      : `/${requestedActiveFile}`;
    if (!normalizedRequestedFile || normalizedRequestedFile === activeFile) {
      return;
    }
    setActiveFile(normalizedRequestedFile);
  }, [activeFile, requestedActiveFile, setActiveFile]);

  useEffect(() => {
    if (!activeFile || code === undefined) {
      schedulerRef.current?.flush();
      return;
    }
    const normalizedPath = activeFile.startsWith("/")
      ? activeFile.slice(1)
      : activeFile;
    schedulerRef.current?.schedule({
      conversationId,
      path: normalizedPath,
      content: code,
      // Capture this edit's callback and canonical baseline. A later Host
      // update must not reinterpret pending editor content as a new edit.
      commit: onFileChangeRef.current,
    });
  }, [code, activeFile, conversationId]);

  useEffect(
    () => () => {
      schedulerRef.current?.dispose();
      schedulerRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    setServerLogs([]);
    return listen((message) => {
      if (message.type === "start" || message.type === "shell/restart") {
        setServerLogs([]);
        return;
      }
      let method = "log";
      let text: string | undefined;
      if (message.type === "stdout") {
        text = message.payload.data;
        method = message.payload.type === "err" ? "error" : "log";
      } else if (
        message.type === "action" &&
        message.action === "notification" &&
        message.notificationType === "error"
      ) {
        text = message.title;
        method = "error";
      }
      if (!text?.trim()) return;
      const log = {
        id: `server_${serverLogId.current++}`,
        method,
        data: [`[server] ${text}`],
        timestamp: Date.now(),
      };
      logOrder.current.set(log.id, nextLogOrder.current++);
      setServerLogs((current) => normalizeConsoleLogs([...current, log]));
    });
  }, [conversationId, listen]);

  useEffect(() => {
    // Sandpack's console hook only includes iframe console events. Nodebox
    // compiler stderr and process failures must also reach health/AI tools.
    const combined = [
      ...normalizeConsoleLogs(logs as ConsoleLogData[]),
      ...serverLogs,
    ];
    const ids = new Set(combined.map((log) => log.id));
    for (const id of logOrder.current.keys()) {
      if (!ids.has(id)) logOrder.current.delete(id);
    }
    for (const log of combined) {
      if (!logOrder.current.has(log.id))
        logOrder.current.set(log.id, nextLogOrder.current++);
    }
    combined.sort(
      (left, right) =>
        logOrder.current.get(left.id)! - logOrder.current.get(right.id)!,
    );
    setConsoleLogs(combined);
  }, [logs, serverLogs, setConsoleLogs]);

  return null;
}
