import { cssToRgb } from "@/shared/lib/color";
import { generateGradientTokens } from "@/shared/theme/color";
import type { ThemeColors } from "@/shared/theme/themes";

export type RGB = { r: number; g: number; b: number };

export type GradientMode = "soft" | "flat";
export type GradientColor = "relative" | "strong";

export const BASE_POSITIONS = [
  { x: 0.16, y: 0.14 },
  { x: 0.86, y: 0.16 },
  { x: 0.18, y: 0.88 },
  { x: 0.88, y: 0.88 },
  { x: 0.52, y: 0.54 },
] as const;

export const FALLBACK_BACKGROUND: RGB = { r: 248, g: 247, b: 247 };

const FALLBACK_BLOB: RGB = { r: 120, g: 120, b: 120 };

export function parseThemeColor(color: string): RGB | null {
  if (!color || color === "transparent") return null;

  try {
    const [r, g, b] = cssToRgb(color);
    return { r, g, b };
  } catch {
    return null;
  }
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r * (1 - t) + b.r * t),
    g: Math.round(a.g * (1 - t) + b.g * t),
    b: Math.round(a.b * (1 - t) + b.b * t),
  };
}

export const rgbToCss = ({ r, g, b }: RGB) => `rgb(${r}, ${g}, ${b})`;

export function buildGradientPalette(
  colors: ThemeColors,
  isDark: boolean,
  colorMode: GradientColor,
): RGB[] {
  const tokens = generateGradientTokens(
    {
      primary: colors.primary,
      success: colors.success,
      warning: colors.warning,
      info: colors.info,
      interactive: colors.interactive,
    },
    isDark,
  );

  const bg = parseThemeColor(colors.background) ?? FALLBACK_BACKGROUND;

  if (colorMode === "relative") {
    const tokenColors = [
      tokens.textInteractive,
      tokens.surfaceInfoStrong,
      tokens.surfaceSuccessStrong,
      tokens.surfaceWarningStrong,
      tokens.surfaceBrandBase,
    ];
    const strength = isDark ? 0.32 : 0.5;
    return tokenColors.map((token) =>
      mixRgb(bg, parseThemeColor(token) ?? FALLBACK_BLOB, strength),
    );
  }

  const brandColor =
    parseThemeColor(tokens.surfaceBrandBase) ??
    parseThemeColor(colors.primary) ??
    FALLBACK_BLOB;
  const accentColor =
    parseThemeColor(tokens.textInteractive) ??
    parseThemeColor(colors.interactive) ??
    brandColor;
  const strength = isDark ? 0.55 : 0.85;

  return [
    mixRgb(bg, brandColor, strength),
    mixRgb(bg, accentColor, strength),
    mixRgb(bg, brandColor, strength * 0.85),
    mixRgb(bg, accentColor, strength * 0.88),
    mixRgb(bg, brandColor, strength * 0.9),
  ];
}
