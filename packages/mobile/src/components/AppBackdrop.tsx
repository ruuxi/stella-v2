import { useMemo } from "react";
import {
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import { renderGradientImage } from "@stella/theme";
import { useColors, useTheme } from "../theme/theme-context";

/** Height of the top-bar row itself (added on top of the safe-area inset). */
export const TOP_BAR_BAR_HEIGHT = 42;

/**
 * Buffer resolution as a fraction of the window's logical size. Desktop
 * renders at 0.6; the blobs are smooth enough that 0.25 upscaled bilinearly
 * is indistinguishable at phone size, and it keeps the per-pixel loop (which
 * runs on the JS thread in Hermes) to a few tens of thousands of pixels.
 */
const MOBILE_RENDER_SCALE = 0.25;

const imageCache = new Map<string, string>();

/**
 * The app's canvas backdrop: the same five-blob frame desktop paints, from
 * the shared renderer in `@stella/theme`. In flat mode (a flat theme, or the
 * Gradient → Flat setting) it paints the plain theme surface / single tint
 * exactly as desktop does. Rendered as an absolute fill so it can sit behind
 * any layer and be reused anywhere the same canvas must show through.
 */
export function AppBackdrop({ style }: { style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const { theme, palette, isDark, flat, gradientMode, gradientColor } =
    useTheme();
  const { width, height } = useWindowDimensions();

  const uri = useMemo(() => {
    if (flat) return null;
    const w = Math.round(width);
    const h = Math.round(height);
    const key = `${theme.id}|${isDark ? "d" : "l"}|${gradientMode}|${gradientColor}|${palette.background}|${palette.primary}|${palette.interactive}|${w}x${h}`;
    const cached = imageCache.get(key);
    if (cached) return cached;
    const image = renderGradientImage(
      {
        colors: palette,
        isDark,
        mode: gradientMode,
        colorMode: gradientColor,
        flat,
        seedKey: theme.id,
      },
      w,
      h,
      MOBILE_RENDER_SCALE,
    );
    imageCache.set(key, image.uri);
    return image.uri;
  }, [
    flat,
    width,
    height,
    theme.id,
    isDark,
    gradientMode,
    gradientColor,
    palette,
  ]);

  if (!uri) {
    return (
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: colors.background },
          style,
        ]}
      />
    );
  }

  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: colors.background, overflow: "hidden" },
        style,
      ]}
    >
      {/* Sized to the window so every mount shows the same canvas. */}
      <Image
        source={{ uri }}
        style={{ position: "absolute", top: 0, left: 0, width, height }}
        contentFit="fill"
        cachePolicy="none"
        transition={0}
      />
    </View>
  );
}
