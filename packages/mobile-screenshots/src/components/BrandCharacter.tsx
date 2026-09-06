"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createStellaMark } from "../../../desktop-ui/src/ui/stella-character/rig";

export type BrandCharacterShape = "blob" | "cursor";

export interface BrandCharacterProps {
  shape?: BrandCharacterShape;
  className?: string;
  /** Match the scene surface, as in the desktop working indicator. */
  eyeColor?: string;
}

/**
 * Original Stella artwork, held still for store-image export.
 * Blob: the exact shipping desktop working-indicator rig and default star.
 * Cursor: the SVG from global/onboarding/demo/DemoScenes.tsx, unchanged.
 * The parent supplies dimensions through className. Export waits for
 * [data-brand-ready="true"] so the imperative SVG has painted its first frame.
 */
export function BrandCharacter({
  shape = "blob",
  className,
  eyeColor = "var(--stella-mark-bg, #f0ede6)",
}: BrandCharacterProps) {
  const host = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    if (shape !== "blob" || !host.current) return;
    setReady(false);
    const mark = createStellaMark(host.current, {
      size: null,
      shape: "star",
      state: "idle",
      ink: "aurora",
      eyeColor,
      glow: false,
      paused: true,
      interactive: false,
      followPointer: false,
      visibilityGate: false,
    });
    // createStellaMark queues its first paint before this callback and then
    // suspends. Do not start an animation or capture an empty host.
    const frame = requestAnimationFrame(() => setReady(true));
    return () => {
      cancelAnimationFrame(frame);
      mark.destroy();
    };
  }, [shape, eyeColor]);

  return (
    <span
      ref={host}
      className={className}
      data-brand-shape={shape}
      data-brand-ready={shape === "cursor" || ready ? "true" : "false"}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {shape === "cursor" && (
        <svg viewBox="0 0 16 18" fill="none"
          style={{ display: "block", width: "100%", height: "100%" }}>
          <path
            d="M1.5 1.5v13.2l3.6-3.2 2.3 4.9 2.7-1.3-2.3-4.7h4.8z"
            fill="#fff"
            stroke="#111"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}
