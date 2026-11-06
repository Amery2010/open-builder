import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

const OpenContext = createContext(true);

function Collapsible({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  const [uncontrolledOpen, setOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  return (
    <OpenContext value={open}>
      <CollapsiblePrimitive.Root
        data-slot="collapsible"
        {...props}
        open={open}
        onOpenChange={(nextOpen) => {
          if (controlledOpen === undefined) setOpen(nextOpen);
          onOpenChange?.(nextOpen);
        }}
      />
    </OpenContext>
  );
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

function CollapsibleContent({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  const open = useContext(OpenContext);
  const contentRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!open && content?.contains(document.activeElement)) {
      content
        .closest('[data-slot="collapsible"]')
        ?.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')
        ?.focus();
    }
  }, [open]);
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
      className={cn("chat-collapsible-content", className)}
      inert={open ? undefined : true}
      aria-hidden={open ? undefined : true}
      ref={(node) => {
        contentRef.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
      }}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
