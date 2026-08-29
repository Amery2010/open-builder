import type { ReactNode } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { AppLayoutMode } from "@/hooks/useAppLayout";

interface AppLayoutProps {
  layout: AppLayoutMode;
  chat: ReactNode;
  workspace: ReactNode;
}

export function AppLayout({ layout, chat, workspace }: AppLayoutProps) {
  if (layout === "mobile") {
    return (
      <div
        className="h-full w-full overflow-hidden bg-background"
        data-testid="mobile-layout"
      >
        {chat}
      </div>
    );
  }

  if (layout === "tablet") {
    return (
      <ResizablePanelGroup
        orientation="vertical"
        className="h-full w-full bg-background"
      >
        <ResizablePanel
          id="project-workspace"
          className="h-full w-full min-h-0 overflow-hidden"
          defaultSize="50%"
          minSize="30%"
          maxSize="70%"
        >
          {workspace}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id="chat-interface"
          className="h-full w-full min-h-0 overflow-hidden"
          defaultSize="50%"
          minSize="30%"
          maxSize="70%"
        >
          {chat}
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  return (
    <ResizablePanelGroup className="h-full w-full bg-background">
      <ResizablePanel
        id="chat-interface"
        className="h-full min-h-0 w-full shrink-0 overflow-hidden md:w-100 md:flex-1"
        defaultSize="30%"
        minSize={360}
        maxSize="50%"
      >
        {chat}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel
        id="project-workspace"
        className="flex h-full w-full min-w-0 overflow-hidden"
      >
        {workspace}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
