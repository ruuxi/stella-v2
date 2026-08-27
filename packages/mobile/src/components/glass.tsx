import { useEffect, useRef } from "react";
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import {
  GlassView,
  isLiquidGlassAvailable,
  type GlassStyle,
} from "expo-glass-effect";
import { useColors, useTheme } from "../theme/theme-context";
import { fadeHex, hexToOklch } from "../theme/oklch";
import { tapLight } from "../lib/haptics";

export const liquidGlassSupported: boolean = (() => {
  try {
    return Platform.OS === "ios" && isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();

function useGlassScheme(): "light" | "dark" {
  const { isDark } = useTheme();
  return isDark ? "dark" : "light";
}

type GlassSurfaceProps = ViewProps & {

  glass?: GlassStyle;

  tintColor?: string;

  legible?: boolean;

  present?: boolean;

  interactive?: boolean;

  radius?: number;

  ringed?: boolean;

  fallbackColor?: string;
};

export function GlassSurface({
  glass = "regular",
  tintColor,
  legible = false,
  present = true,
  interactive = false,
  radius = 16,
  ringed = false,
  fallbackColor,
  style,
  children,
  ...rest
}: GlassSurfaceProps) {
  const colors = useColors();
  const { isDark } = useTheme();
  const scheme = useGlassScheme();

  const ring = ringed
    ? { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }
    : null;

  const resolvedTint =
    tintColor ?? (legible ? fadeHex(colors.surface, 0.78) : undefined);

  if (liquidGlassSupported) {
    return (
      <GlassView
        glassEffectStyle={{ style: present ? glass : "none", animate: true }}
        isInteractive={interactive}
        colorScheme={scheme}
        tintColor={resolvedTint}
        style={[{ borderRadius: radius, overflow: "hidden" }, ring, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  const fallback: ViewStyle = {
    backgroundColor:
      fallbackColor ??
      (legible
        ? colors.surface
        : isDark
          ? "rgba(255,255,255,0.06)"
          : "rgba(255,255,255,0.72)"),
    borderRadius: radius,
    overflow: "hidden",
  };

  return (
    <View style={[fallback, ring, style]} {...rest}>
      {tintColor ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: tintColor }]}
        />
      ) : null}
      {children}
    </View>
  );
}

type GlassCardProps = ViewProps & {
  intensity?: GlassStyle;
  ringed?: boolean;
  radius?: number;

  legible?: boolean;
};

export function GlassCard({
  intensity = "regular",
  ringed = false,
  radius = 16,
  ...rest
}: GlassCardProps) {
  return (
    <GlassSurface glass={intensity} ringed={ringed} radius={radius} {...rest} />
  );
}

const TOGGLE_WIDTH = 52;
const TOGGLE_HEIGHT = 32;
const TOGGLE_THUMB = 26;
const TOGGLE_PAD = (TOGGLE_HEIGHT - TOGGLE_THUMB) / 2;
const TOGGLE_TRAVEL = TOGGLE_WIDTH - TOGGLE_THUMB - TOGGLE_PAD * 2;

type GlassToggleProps = {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
};

export function GlassToggle({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
}: GlassToggleProps) {
  const colors = useColors();
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: value ? 1 : 0,
      damping: 18,
      stiffness: 240,
      mass: 0.7,
      useNativeDriver: true,
    }).start();
  }, [anim, value]);

  const thumbColor = value ? colors.accentForeground : "#ffffff";

  const accentIsLight = hexToOklch(colors.accent).l > 0.7;
  const offTrack = accentIsLight
    ? fadeHex(colors.text, 0.18)
    : fadeHex(colors.text, 0.14);

  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [TOGGLE_PAD, TOGGLE_PAD + TOGGLE_TRAVEL],
  });

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        tapLight();
        onValueChange(!value);
      }}
      style={[styles.toggleTrack, disabled && styles.toggleDisabled]}
    >
      <GlassSurface
        glass="clear"
        interactive
        radius={TOGGLE_HEIGHT / 2}
        fallbackColor={offTrack}
        style={StyleSheet.absoluteFill}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: colors.accent, opacity: anim },
          ]}
        />
      </GlassSurface>
      <Animated.View
        style={[
          styles.toggleThumb,
          { backgroundColor: thumbColor, transform: [{ translateX }] },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toggleTrack: {
    borderRadius: TOGGLE_HEIGHT / 2,
    height: TOGGLE_HEIGHT,
    justifyContent: "center",
    width: TOGGLE_WIDTH,
  },
  toggleDisabled: { opacity: 0.5 },
  toggleThumb: {
    borderColor: "rgba(0,0,0,0.06)",
    borderRadius: TOGGLE_THUMB / 2,
    borderWidth: StyleSheet.hairlineWidth,
    height: TOGGLE_THUMB,
    left: 0,
    position: "absolute",
    top: TOGGLE_PAD,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 2,
    elevation: 2,
    width: TOGGLE_THUMB,
  },
});
