import { useMemo } from "react";
import { cn } from "@/shared/lib/utils";
import { resolveThemeColors, type Theme } from "@/shared/theme/themes";
import {
  BASE_POSITIONS,
  FALLBACK_BACKGROUND,
  buildGradientPalette,
  parseThemeColor,
  rgbToCss,
  type GradientColor,
} from "@/shared/theme/gradient-palette";

const ORB_BLOB_ALPHA = 0.92;
const ORB_BLOB_EXTENT = 62;

const ORB_GRADIENT_COLOR: GradientColor = "strong";

export function themeOrbBackground(
  theme: Theme,
  isDark: boolean,
  gradientColor: GradientColor = ORB_GRADIENT_COLOR,
): string {
  const { colors, flat } = resolveThemeColors(theme, isDark);
  const bg = rgbToCss(
    parseThemeColor(colors.background) ?? FALLBACK_BACKGROUND,
  );

  if (flat) return bg;

  const palette = buildGradientPalette(
    colors,

    theme.forcedMode ? theme.forcedMode === "dark" : isDark,
    gradientColor,
  );

  const layers = BASE_POSITIONS.map((pos, index) => {
    const { r, g, b } = palette[index % palette.length];
    return `radial-gradient(circle at ${pos.x * 100}% ${pos.y * 100}%, rgba(${r}, ${g}, ${b}, ${ORB_BLOB_ALPHA}) 0%, rgba(${r}, ${g}, ${b}, 0) ${ORB_BLOB_EXTENT}%)`;
  });

  return `${layers.join(", ")}, ${bg}`;
}

type ThemeOrbProps = {
  theme: Theme;
  isDark: boolean;
  className?: string;
};

export function ThemeOrb({ theme, isDark, className }: ThemeOrbProps) {
  const background = useMemo(
    () => themeOrbBackground(theme, isDark),
    [theme, isDark],
  );

  return <span className={cn("theme-orb", className)} style={{ background }} />;
}
