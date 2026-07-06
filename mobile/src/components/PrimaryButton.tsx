import { useMemo } from "react";
import { Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

/**
 * The app's accent CTA pill ("Pair phone", "Scan QR code", "Sign in", …).
 * One canonical implementation so the primary-button look can't drift
 * between screens.
 */
export function PrimaryButton({
  label,
  onPress,
  disabled,
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** Layout-only adjustments (margins, alignSelf); the pill look is fixed. */
  style?: ViewStyle;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.button,
        style,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    button: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 22,
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 24,
      paddingVertical: 12,
    },
    pressed: {
      opacity: 0.8,
    },
    disabled: {
      opacity: 0.65,
    },
    label: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.3,
    },
  });
