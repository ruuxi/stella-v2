import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { WORKING_INDICATOR_HANDOFF_MS } from "@/features/chat/working-indicator-state";
type Source = { element: HTMLElement; hide: () => void };
type Morph = { source: Source | null };
const BubbleMorphContext = createContext<Morph | null>(null);

/** One source per visible timeline, never shared with another chat or focus view. */
export function BubbleMorphProvider({ children }: { children: ReactNode }) {
  const [morph] = useState<Morph>(() => ({ source: null }));
  return (
    <BubbleMorphContext.Provider value={morph}>
      {children}
    </BubbleMorphContext.Provider>
  );
}

export function useBubbleMorphSource() {
  return useContext(BubbleMorphContext);
}

/** Lay out markdown once. Only the separate surface changes shape. */
export function AssistantBubble({
  children,
  animate,
}: {
  children: ReactNode;
  animate: boolean;
}) {
  const morph = useContext(BubbleMorphContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const playedRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => cleanupRef.current?.(), []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const surface = surfaceRef.current;
    const text = textRef.current;
    if (
      !animate ||
      playedRef.current ||
      !root ||
      !surface ||
      !text ||
      !morph?.source
    )
      return;
    playedRef.current = true;
    const source = morph.source;
    morph.source = null;
    if (!source.element.isConnected) return;
    const sourceSize = source.element.getBoundingClientRect();
    source.hide();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedMotion.matches || !surface.animate) return;

    const row = root.closest(".event-item.assistant");
    row?.classList.add("assistant-morphing");
    const target = root.getBoundingClientRect();
    // Avoid growing a tiny mark into a page-sized slab or animating offscreen history.
    if (
      target.width <= 0 ||
      target.height <= 0 ||
      target.bottom < 0 ||
      target.top > window.innerHeight ||
      target.height > window.innerHeight * 0.65
    ) {
      row?.classList.remove("assistant-morphing");
      return;
    }
    if (sourceSize.width <= 0 || sourceSize.height <= 0) {
      row?.classList.remove("assistant-morphing");
      return;
    }
    const sx = Math.min(sourceSize.width / target.width, 1);
    const sy = Math.min(sourceSize.height / target.height, 1);
    const style = getComputedStyle(root);
    const radii = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ].map((value) => parseFloat(value) || 0);
    const startRadius =
      radii.map((r) => `${r / sx}px`).join(" ") +
      " / " +
      radii.map((r) => `${r / sy}px`).join(" ");
    root.dataset.morphing = "true";
    const timing = {
      duration: WORKING_INDICATOR_HANDOFF_MS,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "both",
    } satisfies KeyframeAnimationOptions;
    const shape = surface.animate(
      [
        { transform: `scale(${sx}, ${sy})`, borderRadius: startRadius },
        { transform: "scale(1, 1)", borderRadius: style.borderRadius },
      ],
      timing,
    );
    const reveal = text.animate(
      [{ opacity: 0 }, { opacity: 0, offset: 0.2 }, { opacity: 1 }],
      timing,
    );
    const observer = new ResizeObserver((entries) => {
      const size = entries[0]?.borderBoxSize[0];
      if (
        size &&
        (Math.abs(size.inlineSize - target.width) > 1 ||
          Math.abs(size.blockSize - target.height) > 1)
      )
        finish();
    });
    const finish = () => {
      observer.disconnect();
      reducedMotion.removeEventListener?.("change", finish);
      delete root.dataset.morphing;

      shape.cancel();
      reveal.cancel();
    };
    observer.observe(root);
    reducedMotion.addEventListener?.("change", finish);
    shape.onfinish = finish;
    cleanupRef.current = finish;
  }, [animate, morph]);

  return (
    <div ref={rootRef} className="assistant-message-text chat-bubble-text">
      <div
        ref={surfaceRef}
        className="assistant-bubble-morph-surface"
        aria-hidden="true"
      />
      <div ref={textRef}>{children}</div>
    </div>
  );
}
