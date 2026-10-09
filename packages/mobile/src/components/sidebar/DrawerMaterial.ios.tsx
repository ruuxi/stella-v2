import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import { Host, Rectangle } from "@expo/ui/swift-ui";
import { foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "../../theme/theme-context";
import type { DrawerMaterialProps } from "./DrawerMaterial.types";

export function DrawerMaterial({ material, style }: DrawerMaterialProps) {
  const { isDark } = useTheme();
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, style as StyleProp<ViewStyle>]}
    >
      <Host
        colorScheme={isDark ? "dark" : "light"}
        ignoreSafeArea="all"
        style={StyleSheet.absoluteFill}
      >
        <Rectangle
          modifiers={[foregroundStyle({ type: "material", material })]}
        />
      </Host>
    </Animated.View>
  );
}

export const drawerMaterialSupported = true;
