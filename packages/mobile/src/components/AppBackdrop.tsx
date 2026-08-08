import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useColors, useTheme } from "../theme/theme-context";
import { soften } from "../theme/oklch";

/** Height of the top-bar row itself (added on top of the safe-area inset). */
export const TOP_BAR_BAR_HEIGHT = 36;

/**
 * The app's canvas backdrop. In flat mode (or a forced-mode theme like
 * Pearl/Noir) it paints the plain theme background; in soft mode it paints the
 * diagonal accent → background → ok blob, matching the desktop Gradient → Flat
 * setting. Rendered as an absolute fill so it can sit behind any layer and be
 * reused anywhere the same canvas must show through (shell, foreground, and the
 * chat top taper) without drifting between surfaces.
 */
export function AppBackdrop({ style }: { style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const { isDark, gradientMode } = useTheme();

  if (gradientMode === "flat") {
    return (
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: colors.background },
          style,
        ]}
      />
    );
  }

  return (
    <LinearGradient
      colors={[
        soften(colors.accent, colors.background, isDark ? 0.1 : 0.14),
        colors.background,
        soften(colors.ok, colors.background, isDark ? 0.07 : 0.1),
      ]}
      locations={[0, 0.5, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[StyleSheet.absoluteFill, style]}
    />
  );
}
