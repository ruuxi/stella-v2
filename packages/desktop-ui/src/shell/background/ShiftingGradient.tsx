import {
  memo,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { useTheme } from "@/context/theme-context";
import { shouldUseLowPowerEffects } from "@/shared/lib/device-perf";
import {
  BASE_POSITIONS,
  FALLBACK_BACKGROUND,
  buildGradientPalette,
  parseThemeColor,
  type GradientColor,
  type GradientMode,
  type RGB,
} from "@/shared/theme/gradient-palette";
import { cn } from "@/shared/lib/utils";
import "./ShiftingGradient.css";

interface Blob {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  color: RGB;
}

interface ShiftingGradientProps {
  className?: string;
  mode?: GradientMode;
  colorMode?: GradientColor;
  blurMultiplier?: number;
  scale?: number;
  lightweight?: boolean;

  contained?: boolean;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function generateBlueNoise(size: number): Float32Array {

  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {

      data[y * size + x] = (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1)) % 1;
    }
  }
  return data;
}

const NOISE_SIZE = 64;
const blueNoise = generateBlueNoise(NOISE_SIZE);

function generateBlobs(colors: RGB[], mode: GradientMode = "soft"): Blob[] {
  if (mode === "flat") {

    const color = colors[0];
    return [{ x: 0.5, y: 0.5, radius: 3, alpha: 0.5, color }];
  }

  return BASE_POSITIONS.map((base, index) => ({
    x: rand(base.x - 0.04, base.x + 0.04),
    y: rand(base.y - 0.04, base.y + 0.04),
    radius: rand(0.7, 0.95) * 0.65,
    alpha: rand(0.25, 0.4),
    color: colors[index % colors.length],
  }));
}

const RENDER_SCALE = 0.6;

function renderGradient(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bg: RGB,
  blobs: Blob[],
  overlayAlpha: number,
) {
  const w = Math.round(width * RENDER_SCALE);
  const h = Math.round(height * RENDER_SCALE);

  if (w === 0 || h === 0) return;

  ctx.canvas.width = w;
  ctx.canvas.height = h;

  const imageData = ctx.createImageData(w, h);
  const pixels = imageData.data;
  const maxDim = Math.max(w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {

      let r = bg.r;
      let g = bg.g;
      let b = bg.b;

      for (let i = 0; i < blobs.length; i++) {
        const blob = blobs[i];
        const dx = x / w - blob.x;
        const dy = y / h - blob.y;

        const dist = Math.sqrt(dx * dx + dy * dy);
        const radius = blob.radius * (maxDim / w);

        if (dist >= radius) continue;

        const t = dist / radius;
        const falloff = 1 - t * t * t * (t * (t * 6 - 15) + 10);
        const strength = falloff * blob.alpha;

        r = r + (blob.color.r - r) * strength;
        g = g + (blob.color.g - g) * strength;
        b = b + (blob.color.b - b) * strength;
      }

      r = r + (bg.r - r) * overlayAlpha;
      g = g + (bg.g - g) * overlayAlpha;
      b = b + (bg.b - b) * overlayAlpha;

      const noise = blueNoise[(y % NOISE_SIZE) * NOISE_SIZE + (x % NOISE_SIZE)];
      const dither = (noise - 0.5) * (1.5 / 255);

      const idx = (y * w + x) * 4;
      pixels[idx] = Math.max(0, Math.min(255, Math.round(r + dither * 255)));
      pixels[idx + 1] = Math.max(0, Math.min(255, Math.round(g + dither * 255)));
      pixels[idx + 2] = Math.max(0, Math.min(255, Math.round(b + dither * 255)));
      pixels[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

export const ShiftingGradient = memo(function ShiftingGradient({
  className,
  mode = "soft",
  colorMode = "relative",
  lightweight: lightweightProp = false,
  contained = false,
}: ShiftingGradientProps) {

  const lightweight = lightweightProp || shouldUseLowPowerEffects();
  const { resolvedColorMode, theme, colors, flat } = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const blobsRef = useRef<Blob[]>([]);
  const prevKeyRef = useRef("");

  const paintedRef = useRef(false);

  const getPalette = useCallback(
    (): RGB[] =>
      buildGradientPalette(colors, resolvedColorMode === "dark", colorMode),
    [resolvedColorMode, colorMode, colors],
  );

  useEffect(() => {
    if (lightweight) {
      prevKeyRef.current = "";
      return;
    }

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

    const palette = getPalette();

    const blobs = flat ? [] : generateBlobs(palette, mode);
    blobsRef.current = blobs;

    const bg = parseThemeColor(colors.background) ?? FALLBACK_BACKGROUND;
    const rect = canvas.parentElement?.getBoundingClientRect();
    const w = rect?.width ?? window.innerWidth;
    const h = rect?.height ?? window.innerHeight;

    renderGradient(ctx, w, h, bg, blobs, 0.25);
    paintedRef.current = w > 0 && h > 0;

  }, [theme.id, resolvedColorMode, mode, colorMode, getPalette, lightweight, colors, flat]);

  useEffect(() => {
    if (lightweight) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (paintedRef.current) return;

    const renderOnce = () => {
      const ctx = ctxRef.current;

      if (!ctx || prevKeyRef.current === "") return false;
      const bg = parseThemeColor(colors.background) ?? FALLBACK_BACKGROUND;
      const rect = canvas.parentElement?.getBoundingClientRect();
      const w = rect?.width ?? 0;
      const h = rect?.height ?? 0;
      if (w === 0 || h === 0) return false;
      renderGradient(ctx, w, h, bg, blobsRef.current, 0.25);
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
