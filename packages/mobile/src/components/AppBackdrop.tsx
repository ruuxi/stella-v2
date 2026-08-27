import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useColors, useTheme } from "../theme/theme-context";
import { soften } from "../theme/oklch";

export const TOP_BAR_BAR_HEIGHT = 36;

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
