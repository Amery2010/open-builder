import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import "./scroll-area.css";

interface ScrollAreaProps extends React.ComponentProps<"div"> {
  dir?: "ltr" | "rtl";
  orientation?: "vertical" | "horizontal" | "both";
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportProps?: Omit<
    React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>,
    "children" | "ref" | "onScroll"
  > & { "data-slot"?: string; "data-testid"?: string };
  contentClassName?: string;
}

/** Layout props belong to the root; scroll refs and events belong to the viewport. */
function ScrollArea({
  className,
  children,
  orientation = "vertical",
  viewportRef,
  viewportProps,
  contentClassName,
  onScroll,
  ...props
}: ScrollAreaProps) {
  const {
    className: viewportClassName,
    style,
    ...restViewportProps
  } = viewportProps ?? {};

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      data-scroll-orientation={orientation}
      type="auto"
      className={cn("app-scroll-area", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        tabIndex={0}
        {...restViewportProps}
        ref={viewportRef}
        className={cn("app-scroll-area-viewport", viewportClassName)}
        onScroll={onScroll}
        style={{
          overflowX: orientation === "vertical" ? "hidden" : "auto",
          overflowY: orientation === "horizontal" ? "hidden" : "auto",
          ...style,
        }}
      >
        <div className={contentClassName}>{children}</div>
      </ScrollAreaPrimitive.Viewport>
      {orientation !== "horizontal" && <ScrollBar orientation="vertical" />}
      {orientation !== "vertical" && <ScrollBar orientation="horizontal" />}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  orientation,
}: {
  orientation: "vertical" | "horizontal";
}) {
  const [dragging, setDragging] = React.useState(false);

  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-dragging={dragging || undefined}
      orientation={orientation}
      className="app-scroll-area-bar"
      onPointerDown={() => setDragging(true)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onLostPointerCapture={() => setDragging(false)}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="app-scroll-area-thumb"
      >
        <span className="app-scroll-area-thumb-visual" />
      </ScrollAreaPrimitive.Thumb>
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea };
export type { ScrollAreaProps };
