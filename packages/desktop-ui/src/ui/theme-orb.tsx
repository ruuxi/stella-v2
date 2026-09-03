import { useMemo } from "react";
import { cn } from "@/shared/lib/utils";
import {
  BASE_POSITIONS,
  FALLBACK_BACKGROUND,
  buildGradientPalette,
  parseThemeColor,
  resolveThemeColors,
  rgbToCss,
  type GradientColor,
  type Theme,
} from "@stella/theme";

/**
 * How hard the swatch leans on its blobs.
 *
 * The real background spreads five blobs across a whole window at alpha
 * 0.25–0.4, which at swatch size collapses into a flat disc — in dark mode
 * every theme would come out as the same near-black circle, which is the
 * opposite of what a picker is for. The swatch keeps the palette exactly (same
 * colours, same five positions, same background) and only raises the blob
 * opacity, so it reads as a saturated portrait of the surface rather than a
 * literal thumbnail.
 */
const ORB_BLOB_ALPHA = 0.92;
const ORB_BLOB_EXTENT = 62;

/**
 * Swatches always use the `strong` palette, never the user's Gradient Color.
 *
 * `relative` — the default — spreads five semantic hues at low strength, which
 * is right for a full window and useless at 38px: rendered that way Amber,
 * Autumn and Cocoa are three identical brown discs and Amethyst, Orchid, Rosé
 * and Velvet are four identical grey-purple ones. `strong` is the same theme's
 * own palette at high strength, and separates every option cleanly.
 */
const ORB_GRADIENT_COLOR: GradientColor = "strong";

/** The `background` shorthand a theme's swatch paints. Exported so it can be
 *  rendered outside React without a second copy of the layout. */
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
    // A forced-mode theme paints itself in its own appearance no matter what
    // the Light/Dark toggle says, and `resolveThemeColors` has already picked
    // those colours — so the palette has to be generated for the same mode or
    // the scales come out inverted.
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

/**
 * A theme rendered as the background it produces: the shifting-gradient blob
 * palette laid out at the same five positions, over the theme's own
 * background.
 *
 * Flat themes (the stock Default, and anything with `forcedMode`) suppress the
 * blobs in the real background, so their swatch is the bare surface colour —
 * which is exactly what picking them looks like.
 *
 * Renders only the fill; it absolutely positions itself inside whatever
 * element wraps it, so each surface keeps its own hit target, sizing and
 * selected state instead of inheriting a picker's.
 */
export function ThemeOrb({ theme, isDark, className }: ThemeOrbProps) {
  const background = useMemo(
    () => themeOrbBackground(theme, isDark),
    [theme, isDark],
  );

  return <span className={cn("theme-orb", className)} style={{ background }} />;
}
