import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassSurface } from "../glass";
import { Icon } from "../Icon";
import type { Colors } from "../../theme/colors";
import { useColors } from "../../theme/theme-context";
import { fadeHex } from "../../theme/oklch";
import {
  SHELL_TAB_BAR_HEIGHT,
  SHELL_TAB_BAR_RESERVE,
  shellTabBarBase,
  type ShellTabBarProps,
} from "./shell-tab-bar-types";

/** Side gutter between the platter and the screen edges. */
const GUTTER = 16;

/**
 * Fallback tab bar (Android, and iOS before 26): one floating pill shaped
 * like the iOS 26 bar, one icon per tab (the name is spoken, not shown),
 * with the selected tab on a soft lozenge. It floats in the same band the
 * system bar does, so routes pad for it identically on every platform.
 */
export function ShellTabBarFallback<K extends string>({
  tabs,
  value,
  onSelect,
}: ShellTabBarProps<K>) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Top edge level with the system bar's, just under the composer's rest line.
  const bottom =
    shellTabBarBase(insets.bottom) +
    SHELL_TAB_BAR_RESERVE -
    SHELL_TAB_BAR_HEIGHT -
    1;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom }]}
      accessibilityRole="tablist"
    >
      <GlassSurface
        glass="regular"
        radius={SHELL_TAB_BAR_HEIGHT / 2}
        ringed
        fallbackColor={fadeHex(colors.surface, 0.94)}
        style={styles.bar}
      >
        {tabs.map((item) => {
          const active = item.key === value;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={item.label}
              onPress={() => onSelect(item.key)}
              style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            >
              {active ? (
                <View pointerEvents="none" style={styles.activeLozenge} />
              ) : null}
              <Icon
                name={item.icon}
                size={22}
                color={active ? colors.text : colors.textMuted}
                weight={active ? "semibold" : "regular"}
              />
            </Pressable>
          );
        })}
      </GlassSurface>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: {
      left: GUTTER,
      position: "absolute",
      right: GUTTER,
      // The platter floats over scrolling content; lift it off the page.
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 14,
      elevation: 8,
    },
    bar: {
      alignItems: "center",
      flexDirection: "row",
      height: SHELL_TAB_BAR_HEIGHT,
      paddingHorizontal: 4,
    },
    item: {
      alignItems: "center",
      flex: 1,
      height: SHELL_TAB_BAR_HEIGHT - 8,
      justifyContent: "center",
    },
    pressed: {
      opacity: 0.7,
    },
    activeLozenge: {
      backgroundColor: fadeHex(colors.text, 0.08),
      borderRadius: (SHELL_TAB_BAR_HEIGHT - 8) / 2,
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
  });
