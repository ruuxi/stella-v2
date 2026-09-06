import { ActivityIndicator, View } from "react-native";
import { Host, Button, RNHostView } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  disabled,
  frame,
} from "@expo/ui/swift-ui/modifiers";
import { Icon } from "./Icon";
import { liquidGlassSupported } from "./glass";
import { useColors, useTheme } from "../theme/theme-context";
import type { GlassIconButtonProps } from "./GlassIconButton";

/** Native SwiftUI glass chrome, using Stella's color scheme rather than the OS. */
export function GlassIconButton({
  icon,
  onPress,
  accessibilityLabel: label,
  size = 44,
  iconSize = 20,
  muted = false,
  dot,
  loading = false,
  disabled: isDisabled = false,
  style,
}: GlassIconButtonProps) {
  const colors = useColors();
  const { isDark } = useTheme();
  return (
    <Host
      colorScheme={isDark ? "dark" : "light"}
      ignoreSafeArea="all"
      style={[{ width: size, height: size }, style]}
    >
      <Button
        onPress={onPress}
        modifiers={[
          buttonStyle(liquidGlassSupported ? "glass" : "bordered"),
          buttonBorderShape("circle"),
          frame({ width: size, height: size }),
          accessibilityLabel(label),
          disabled(isDisabled),
        ]}
      >
        <RNHostView matchContents>
          <View
            pointerEvents="none"
            style={{
              width: size - 16,
              height: size - 16,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <Icon
                name={icon}
                size={iconSize}
                color={muted ? colors.textMuted : colors.text}
              />
            )}
            {dot ? (
              <View
                style={{
                  position: "absolute",
                  right: 1,
                  bottom: 2,
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: dot,
                  borderColor: colors.surface,
                  borderWidth: 1,
                }}
              />
            ) : null}
          </View>
        </RNHostView>
      </Button>
    </Host>
  );
}
