import { View } from "react-native";
import { Host, Button, RNHostView } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  animation,
  Animation,
  buttonBorderShape,
  buttonStyle,
  frame,
} from "@expo/ui/swift-ui/modifiers";
import { liquidGlassSupported } from "./glass";
import { useTheme } from "../theme/theme-context";
import {
  STATUS_PILL_HEIGHT,
  STATUS_PILL_INSET,
  STATUS_PILL_SPRING,
  type StatusPillProps,
} from "./StatusPill.types";

const GLASS_SPRING = Animation.spring({
  duration: STATUS_PILL_SPRING.duration / 1000,
  bounce: 1 - STATUS_PILL_SPRING.dampingRatio,
});

/**
 * The status pill in the same native SwiftUI chrome as `GlassIconButton`:
 * the glass button style on iOS 26, the bordered style before it, in
 * Stella's colour scheme. The capsule's width animates natively, so the
 * material never has to be faded or rebuilt while it grows.
 */
export function StatusPill({
  width,
  slotWidth,
  onPress,
  accessibilityLabel: label,
  children,
}: StatusPillProps) {
  const { isDark } = useTheme();
  return (
    <Host
      colorScheme={isDark ? "dark" : "light"}
      ignoreSafeArea="all"
      style={{ width: slotWidth, height: STATUS_PILL_HEIGHT }}
    >
      <Button
        onPress={onPress}
        modifiers={[
          buttonStyle(liquidGlassSupported ? "glass" : "bordered"),
          buttonBorderShape("capsule"),
          frame({ width, height: STATUS_PILL_HEIGHT }),
          animation(GLASS_SPRING, width),
          accessibilityLabel(label),
        ]}
      >
        <RNHostView matchContents>
          <View
            pointerEvents="none"
            style={{
              width: slotWidth - STATUS_PILL_INSET * 2,
              height: STATUS_PILL_HEIGHT - STATUS_PILL_INSET * 2,
            }}
          >
            {children}
          </View>
        </RNHostView>
      </Button>
    </Host>
  );
}
