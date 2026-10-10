import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
} from "react-native-reanimated";
import { useT } from "../../i18n";
import { drawerProgress } from "../../lib/drawer";
import type { MainTabId } from "../../lib/last-main-tab";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { useColors } from "../../theme/theme-context";

export type SidebarPlace = Exclude<MainTabId, "settings">;

export const SIDEBAR_PLACES: readonly SidebarPlace[] = [
  "chat",
  "schedule",
  "apps",
  "files",
];

const PLACE_LABEL_KEYS: Record<SidebarPlace, string> = {
  chat: "mobile.nav.chat",
  schedule: "mobile.activityHub.tabs.schedule",
  apps: "mobile.nav.apps",
  files: "mobile.activityHub.tabs.files",
};

export function Rise({
  i,
  animated,
  children,
}: {
  i: number;
  animated: boolean;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const style = useAnimatedStyle(() => {
    if (!animated) return { opacity: 1, transform: [{ translateX: 0 }] };
    const v = Math.min(drawerProgress.value, 1);
    const from = Math.min(0.08 * i, 0.5);
    return {
      opacity: interpolate(v, [from, from + 0.5], [0, 1], Extrapolation.CLAMP),
      transform: [
        {
          translateX: reduce
            ? 0
            : interpolate(v, [0, 1], [-14 - i * 7, 0], Extrapolation.CLAMP),
        },
      ],
    };
  });
  return <Animated.View style={style}>{children}</Animated.View>;
}

export function SidebarPlaceRow({
  place,
  active,
  meta,
  onSelect,
}: {
  place: SidebarPlace;
  active: boolean;
  meta?: string;
  onSelect: (next: MainTabId) => void;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const label = t(PLACE_LABEL_KEYS[place]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={meta ? `${label}, ${meta}` : label}
      onPress={() => onSelect(place)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`mobile-sidebar-nav-${place}`}
    >
      <View style={styles.labelLine}>
        <Text
          style={styles.label}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {label}
        </Text>
        {active ? <View style={styles.current} /> : null}
      </View>
      {meta ? (
        <Text
          style={styles.meta}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {meta}
        </Text>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: {
      alignItems: "center",
      flexDirection: "row",
      height: 54,
    },
    pressed: {
      opacity: 0.55,
      transform: [{ scale: 0.98 }],
    },
    labelLine: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: 10,
      minWidth: 0,
    },
    label: {
      color: colors.text,
      flexShrink: 1,
      fontFamily: fonts.sans.bold,
      fontSize: 30,
      letterSpacing: -1,
      lineHeight: 38,
    },
    current: {
      backgroundColor: colors.accent,
      borderRadius: 4,
      height: 8,
      marginTop: 4,
      width: 8,
    },
    meta: {
      color: colors.textMuted,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
      fontVariant: ["tabular-nums"],
      marginLeft: 12,
    },
  });
