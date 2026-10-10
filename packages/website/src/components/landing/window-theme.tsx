"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import {
  deriveTokens,
  getThemeById,
  parseColor,
  planGradientFrame,
  renderGradientPixels,
  resolveThemeColors,
} from "@stella/theme";

export type WindowThemeKey = { id: string; dark: boolean };

const VARS = [
  ["--w-bg", "background"],
  ["--w-fg", "textStrong"],
  ["--w-sub", "textWeak"],
  ["--w-sub-strong", "textBase"],
  ["--w-me", "chatUserBubbleFill"],
  ["--w-me-fg", "chatUserBubbleText"],
  ["--w-her-top", "chatAssistantBubbleFillTop"],
  ["--w-her-bot", "chatAssistantBubbleFillBottom"],
  ["--w-composer-top", "panelSurfaceBgTop"],
  ["--w-composer-bot", "panelSurfaceBgBottom"],
  ["--w-line", "panelSurfaceBorder"],
  ["--w-highlight", "panelSurfaceHighlight"],
  ["--w-plus", "buttonSecondaryBase"],
  ["--w-send", "primary"],
  ["--w-edge", "borderBase"],
  ["--w-menu", "overlaySurface"],
  ["--w-check", "textWeak"],
] as const;

type Resolved = {
  vars: Record<string, string>;
  gradient: ReturnType<typeof planGradientFrame> | null;
  dark: boolean;
};

const cache = new Map<string, Resolved>();

export function resolveWindowTheme({ id, dark }: WindowThemeKey): Resolved {
  const key = `${id}:${dark ? "d" : "l"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const theme = getThemeById(id) ?? getThemeById("default")!;
  const resolved = resolveThemeColors(theme, dark);
  const isDark = resolved.forcedMode ? resolved.forcedMode === "dark" : dark;
  const tokens = deriveTokens(resolved.colors, isDark, { flat: resolved.flat });
  const vars: Record<string, string> = {};
  for (const [name, token] of VARS) vars[name] = tokens[token];
  const gradient = resolved.flat
    ? null
    : planGradientFrame({
        colors: resolved.colors,
        isDark,
        mode: "soft",
        colorMode: "strong",
        flat: false,
        seedKey: theme.id,
      });
  const out = { vars, gradient, dark: isDark };
  cache.set(key, out);
  return out;
}

export function windowThemeStyle(key: WindowThemeKey): CSSProperties {
  return resolveWindowTheme(key).vars as CSSProperties;
}

export function mixWindowVars(a: WindowThemeKey, b: WindowThemeKey, t: number) {
  const va = resolveWindowTheme(a).vars;
  const vb = resolveWindowTheme(b).vars;
  const out: Record<string, string> = {};
  for (const [name] of VARS) {
    const x = parseColor(va[name]);
    const y = parseColor(vb[name]);
    if (!x || !y) {
      out[name] = t < 0.5 ? va[name] : vb[name];
      continue;
    }
    const m = (p: number, q: number) => p + (q - p) * t;
    out[name] = `rgba(${Math.round(m(x.r, y.r))}, ${Math.round(m(x.g, y.g))}, ${Math.round(m(x.b, y.b))}, ${m(x.a, y.a).toFixed(3)})`;
  }
  return out;
}

export function ThemeGradient({
  theme,
  width = 240,
  height = 140,
  className,
  style,
  on,
}: {
  on?: boolean;
  theme: WindowThemeKey;
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { gradient } = resolveWindowTheme(theme);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !gradient) return;
    const image = ctx.createImageData(width, height);
    renderGradientPixels(image.data, width, height, gradient.bg, gradient.blobs);
    ctx.putImageData(image, 0, 0);
  }, [gradient, width, height]);

  if (!gradient) return null;
  return (
    <canvas
      ref={ref}
      className={className}
      width={width}
      height={height}
      aria-hidden="true"
      data-on={on === undefined ? undefined : on ? "1" : "0"}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", ...style }}
    />
  );
}
