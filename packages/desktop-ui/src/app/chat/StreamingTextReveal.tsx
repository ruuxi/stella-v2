/**
 * Stable wrapper for streamed assistant text.
 *
 * Text cadence is handled by useStreamTextAnimation. The old implementation
 * ran another 60fps animation here which recursively walked the Streamdown DOM
 * and synchronously called Range/getBoundingClientRect every frame. On long
 * markdown that forced layout continuously. ResizeObserver already runs after
 * layout, so use it only to coalesce scroll-follow notifications when the
 * committed markdown's size actually changes; there are no geometry reads or
 * per-frame masks on the streaming path.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { notifyAssistantScrollFollowLayoutChange } from "@/shell/chat-scroll-follow";

type StreamingTextRevealProps = {
  active: boolean;
  children: ReactNode;
};

export function StreamingTextReveal({
  active,
  children,
}: StreamingTextRevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof ResizeObserver === "undefined") return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        notifyAssistantScrollFollowLayoutChange();
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [active]);

  return <div ref={ref}>{children}</div>;
}
