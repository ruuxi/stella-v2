import { memo, useEffect, useRef } from "react";
import { useTheme } from "@/context/theme-context";
import { shouldUseLowPowerEffects } from "@/shared/lib/device-perf";
import {
  gradientBufferSize,
  planGradientFrame,
  renderGradientPixels,
  type Blob,
  type GradientColor,
  type GradientMode,
  type RGB,
} from "@stella/theme";
import { cn } from "@/shared/lib/utils";
import "./ShiftingGradient.css";

interface ShiftingGradientProps {
  className?: string;
  mode?: GradientMode;
  colorMode?: GradientColor;
  blurMultiplier?: number;
  scale?: number;
  lightweight?: boolean;
  /** When true, fills the nearest positioned ancestor instead of the viewport (for sidebars, etc.). */
  contained?: boolean;
}

// ─── Canvas rendering ───────────────────────────────────────────────────
// The blob palette, layout, and per-pixel blend live in `@stella/theme`
// (`planGradientFrame` / `renderGradientPixels`) so mobile paints the very
// same frame. This file only owns the canvas plumbing. The buffer renders at
// a fraction of the surface size; the browser's bilinear upscale adds free
// smoothing on top of the dithering.

function renderGradient(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bg: RGB,
  blobs: readonly Blob[],
) {
  const { w, h } = gradientBufferSize(width, height);
  if (w === 0 || h === 0) return;

  ctx.canvas.width = w;
  ctx.canvas.height = h;

  const imageData = ctx.createImageData(w, h);
  renderGradientPixels(imageData.data, w, h, bg, blobs);
  ctx.putImageData(imageData, 0, 0);
}

// ─── Component ──────────────────────────────────────────────────────────

export const ShiftingGradient = memo(function ShiftingGradient({
  className,
  mode = "soft",
  colorMode = "relative",
  lightweight: lightweightProp = false,
  contained = false,
}: ShiftingGradientProps) {
  // The canvas path runs a per-pixel CPU blend loop on the main thread at
  // paint time, so low-power devices always take the CSS-gradient path.
  const lightweight = lightweightProp || shouldUseLowPowerEffects();
  const { resolvedColorMode, theme, colors, flat } = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const frameRef = useRef<{ bg: RGB; blobs: Blob[] } | null>(null);
  const prevKeyRef = useRef("");
  // Whether renderGradient has actually painted at a non-zero size. A fresh
  // canvas reports the 300x150 default for width/height, so the dimensions
  // alone can't tell "painted" from "never painted" — and a gradient mounted
  // inside a display:none host (e.g. the right sidebar before the shell is
  // visible) measures 0x0 on the first settings pass.
  const paintedRef = useRef(false);

  // Render to canvas when settings change
  useEffect(() => {
    if (lightweight) {
      prevKeyRef.current = "";
      return;
    }

    // Include a palette signature: the Custom overlay keeps a constant
    // `theme.id` while its displayed base (and thus colors) changes, so the id
    // alone can't detect a base swap between two non-forced themes.
    const key = `${theme.id}-${resolvedColorMode}-${mode}-${colorMode}-${flat ? "flat" : ""}-${colors.background}-${colors.primary}-${colors.interactive}`;
    const settingsChanged = prevKeyRef.current !== key;

    if (!settingsChanged) {
      return;
    }

    prevKeyRef.current = key;

    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!ctxRef.current) {
      ctxRef.current = canvas.getContext("2d", { willReadFrequently: true });
    }
    const ctx = ctxRef.current;
    if (!ctx) return;

    // Flat themes (the stock Default, plus any forcedMode-pinned theme) want a
    // clean, flat single-color surface — no blob at all; planGradientFrame
    // returns zero blobs for them. The blob jitter is seeded by the theme id
    // so the layout is stable across launches and identical on mobile.
    const frame = planGradientFrame({
      colors,
      isDark: resolvedColorMode === "dark",
      mode,
      colorMode,
      flat,
      seedKey: theme.id,
    });
    frameRef.current = frame;

    const rect = canvas.parentElement?.getBoundingClientRect();
    const w = rect?.width ?? window.innerWidth;
    const h = rect?.height ?? window.innerHeight;

    renderGradient(ctx, w, h, frame.bg, frame.blobs);
    paintedRef.current = w > 0 && h > 0;
  }, [theme.id, resolvedColorMode, mode, colorMode, lightweight, colors, flat]);

  // First-render fallback only. We intentionally do NOT re-render on
  // window/parent resize: the blob positions are normalized fractions
  // of width/height with aspect-corrected radii, so any repaint at a
  // different size visibly slides them around — exactly the "blobs
  // move when I resize the window" behavior we want to avoid. CSS
  // (`.gradient-base { width: 100%; height: 100% }`) bilinearly
  // stretches the existing bitmap to fill the new size, which reads
  // as a stable soft gradient since blobs are already soft.
  //
  // The fallback below covers the case where the parent has zero
  // size at the time the settings effect first runs (pre-layout); we
  // observe until we see a non-zero size, render once at that size,
  // and disconnect.
  useEffect(() => {
    if (lightweight) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (paintedRef.current) return;

    const renderOnce = () => {
      const ctx = ctxRef.current;
      const frame = frameRef.current;
      // prevKeyRef doubles as "the settings effect has run": the frame alone
      // can't gate this because flat themes intentionally paint zero blobs.
      if (!ctx || !frame || prevKeyRef.current === "") return false;
      const rect = canvas.parentElement?.getBoundingClientRect();
      const w = rect?.width ?? 0;
      const h = rect?.height ?? 0;
      if (w === 0 || h === 0) return false;
      renderGradient(ctx, w, h, frame.bg, frame.blobs);
      paintedRef.current = true;
      return true;
    };

    if (typeof ResizeObserver === "undefined") {
      renderOnce();
      return;
    }

    const ro = new ResizeObserver(() => {
      if (renderOnce()) ro.disconnect();
    });
    const target = contained ? rootRef.current : canvas.parentElement;
    if (target) ro.observe(target);
    return () => {
      ro.disconnect();
    };
  }, [lightweight, colors, contained]);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={cn(
        "shifting-gradient",
        contained && "shifting-gradient--contained",
        className,
      )}
    >
      {lightweight ? (
        <div
          className="gradient-base"
          style={{
            // Flat themes (the stock Default, plus any forcedMode-pinned theme)
            // want a clean solid surface — no colored blobs. The canvas path
            // already drops the blobs for `flat`; the lightweight CSS path
            // (taken on low-power machines, including most ≤8GB Windows boxes)
            // has to do the same or the gradient bleeds through as color blobs.
            background: flat
              ? "var(--background)"
              : [
                  `radial-gradient(circle at 18% 20%, color-mix(in srgb, ${colors.primary} 12%, transparent) 0%, transparent 30%)`,
                  `radial-gradient(circle at 84% 18%, color-mix(in srgb, ${colors.interactive} 14%, transparent) 0%, transparent 32%)`,
                  `radial-gradient(circle at 50% 84%, color-mix(in srgb, ${colors.success} 10%, transparent) 0%, transparent 40%)`,
                  "var(--background)",
                ].join(", "),
          }}
        />
      ) : (
        <canvas
          ref={canvasRef}
          className="gradient-base"
          style={{
            imageRendering: "auto",
          }}
        />
      )}
    </div>
  );
});
