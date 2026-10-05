import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { GlassSurface } from "./glass";
import type { Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fadeHex } from "../theme/oklch";
import {
  STATUS_PILL_HEIGHT,
  STATUS_PILL_INSET,
  STATUS_PILL_SPRING,
  type StatusPillProps,
} from "./StatusPill.types";

export type { StatusPillProps } from "./StatusPill.types";

const RADIUS = STATUS_PILL_HEIGHT / 2;

/**
 * The status pill in the same chrome as `GlassIconButton` off iOS: clear
 * glass where Liquid Glass exists, the theme surface with a hairline ring
 * where it does not. Width springs between the circle and the capsule.
 */
export function StatusPill({
  width,
  slotWidth,
  onPress,
  accessibilityLabel,
  children,
}: StatusPillProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const animatedWidth = useSharedValue(width);
  useEffect(() => {
    animatedWidth.value = withSpring(width, STATUS_PILL_SPRING);
  }, [animatedWidth, width]);
  const widthStyle = useAnimatedStyle(() => ({ width: animatedWidth.value }));

  return (
    <View style={[styles.slot, { width: slotWidth }]}>
      <Animated.View style={[styles.frame, widthStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          hitSlop={6}
          onPress={onPress}
          style={({ pressed }) => [styles.press, pressed && styles.pressed]}
        >
          <GlassSurface
            glass="clear"
            interactive
            radius={RADIUS}
            fallbackColor={colors.surface}
            style={styles.glass}
          >
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.ring]} />
            <View
              pointerEvents="none"
              style={{
                width: slotWidth - STATUS_PILL_INSET * 2,
                height: STATUS_PILL_HEIGHT - STATUS_PILL_INSET * 2,
              }}
            >
              {children}
            </View>
          </GlassSurface>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    slot: {
      alignItems: "center",
      height: STATUS_PILL_HEIGHT,
      justifyContent: "center",
    },
    frame: { height: STATUS_PILL_HEIGHT },
    press: { flex: 1 },
    pressed: { opacity: 0.88 },
    glass: {
      alignItems: "center",
      borderRadius: RADIUS,
      flex: 1,
      justifyContent: "center",
      overflow: "hidden",
    },
    ring: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: RADIUS,
      borderWidth: StyleSheet.hairlineWidth,
    },
  });
