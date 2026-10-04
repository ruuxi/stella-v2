/**
 * The surfaces every onboarding card is built from: the card itself, its
 * settled one-line summary, and the two button weights.
 *
 * Cards arrive under an assistant message with a spring that animates
 * opacity, so they are opaque theme surfaces rather than glass (glass never
 * sits under an animated-opacity ancestor).
 */
import { useMemo, type ReactNode } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated from "react-native-reanimated";
import { Icon, type IconName } from "../Icon";
import { type Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import { useColors } from "../../theme/theme-context";
import { fadeEntering, springLayout, SpringPressable } from "./motion";

export const CARD_RADIUS = 24;
export const CARD_PADDING = 18;

export function useCardStyles() {
  const colors = useColors();
  return useMemo(() => makeCardStyles(colors), [colors]);
}

export function OnboardingCard({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useCardStyles();
  return (
    <Animated.View layout={springLayout} style={[styles.card, style]}>
      {children}
    </Animated.View>
  );
}

/**
 * What a card collapses to once its step is answered: one quiet row that
 * still says what was chosen, so scrolling back reads like a transcript.
 */
export function SettledCard({
  icon,
  leading,
  title,
  description,
  tone = "neutral",
}: {
  icon?: IconName;
  /** Custom leading visual in place of the icon (a theme swatch, say). */
  leading?: ReactNode;
  title: string;
  description?: string;
  tone?: "neutral" | "success";
}) {
  const colors = useColors();
  const styles = useCardStyles();
  return (
    <Animated.View
      layout={springLayout}
      entering={fadeEntering(0, 260)}
      style={[styles.card, styles.settled]}
    >
      {leading ?? (
        <View
          style={[
            styles.settledIcon,
            tone === "success" && styles.settledIconSuccess,
          ]}
        >
          {icon ? (
            <Icon
              name={icon}
              size={15}
              color={tone === "success" ? colors.ok : colors.text}
              weight="semibold"
            />
          ) : null}
        </View>
      )}
      <View style={styles.settledText}>
        <Text style={styles.settledTitle} numberOfLines={1}>
          {title}
        </Text>
        {description ? (
          <Text style={styles.settledDesc} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

export function PrimaryAction({
  label,
  onPress,
  disabled,
  busy,
  icon,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const styles = useCardStyles();
  return (
    <SpringPressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || busy), busy }}
      containerStyle={style}
      style={[styles.primary, (disabled || busy) && styles.dimmed]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.accentForeground} />
      ) : (
        <>
          {icon ? (
            <Icon
              name={icon}
              size={15}
              color={colors.accentForeground}
              weight="semibold"
            />
          ) : null}
          <Text style={styles.primaryLabel} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </SpringPressable>
  );
}

export function SecondaryAction({
  label,
  onPress,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useCardStyles();
  return (
    <SpringPressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      containerStyle={style}
      style={[styles.secondary, disabled && styles.dimmed]}
    >
      <Text style={styles.secondaryLabel} numberOfLines={1}>
        {label}
      </Text>
    </SpringPressable>
  );
}

export const makeCardStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderCurve: "continuous",
      borderRadius: CARD_RADIUS,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 14,
      padding: CARD_PADDING,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.07,
      shadowRadius: 24,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.35,
      lineHeight: 22,
    },
    body: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14.5,
      letterSpacing: -0.1,
      lineHeight: 21,
    },
    label: {
      color: colors.textMuted,
      fontFamily: fonts.sans.semiBold,
      fontSize: 11.5,
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },
    actions: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
    },
    primary: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderCurve: "continuous",
      borderRadius: 22,
      flexDirection: "row",
      gap: 7,
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 20,
    },
    primaryLabel: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.3,
    },
    secondary: {
      alignItems: "center",
      borderColor: colors.border,
      borderCurve: "continuous",
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 18,
    },
    secondaryLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.25,
    },
    dimmed: {
      opacity: 0.5,
    },
    settled: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingVertical: 12,
      shadowOpacity: 0.04,
    },
    settledIcon: {
      alignItems: "center",
      backgroundColor: colors.muted,
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    settledIconSuccess: {
      backgroundColor: fadeHex(colors.ok, 0.14),
    },
    settledText: {
      flex: 1,
      gap: 1,
      minWidth: 0,
    },
    settledTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14.5,
      letterSpacing: -0.2,
    },
    settledDesc: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
      lineHeight: 18,
    },
  });

export type CardStyles = ReturnType<typeof makeCardStyles>;
