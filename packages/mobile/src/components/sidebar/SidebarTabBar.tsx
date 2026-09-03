import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GlassGroup, GlassSurface } from "../glass";
import { Icon } from "../Icon";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import type { Colors } from "../../theme/colors";
import { useColors } from "../../theme/theme-context";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import {
  SIDEBAR_TAB_BAR_HEIGHT,
  type SidebarTabBarProps,
} from "./sidebar-tab-bar-types";

/**
 * How far apart sibling glass buttons may be and still fuse. The buttons
 * abut with square inner edges, so this only needs to melt the shared seam;
 * anything larger bulges the blend into blobs.
 */
const GLASS_MERGE_DISTANCE = 12;

/**
 * Fallback tab bar (Android, and iOS before 26): one pill of tinted
 * segments with the selected one on a soft lozenge. On iOS the `.ios.tsx`
 * sibling replaces this with the system segmented control, whose Liquid
 * Glass selection lens slides and follows a drag.
 */
export function SidebarTabBar<K extends string>({
  tabs,
  value,
  onSelect,
  onHeight,
}: SidebarTabBarProps<K>) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <GlassGroup
      spacing={GLASS_MERGE_DISTANCE}
      style={styles.bar}
      onLayout={(event) => onHeight?.(event.nativeEvent.layout.height)}
    >
      {tabs.map((item, index) => {
        const active = item.key === value;
        const first = index === 0;
        const last = index === tabs.length - 1;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={item.accessibilityLabel}
            onPress={() => onSelect(item.key)}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            <GlassSurface
              glass="regular"
              interactive
              radius={0}
              fallbackColor={colors.surface}
              style={[
                styles.glass,
                first && styles.capStart,
                last && styles.capEnd,
              ]}
            >
              {active ? (
                <View pointerEvents="none" style={styles.activeLozenge} />
              ) : null}
              <Icon
                name={item.icon}
                size={14}
                color={active ? colors.text : colors.textMuted}
                weight={active ? "semibold" : "medium"}
              />
              <Text
                style={[styles.label, active && styles.labelActive]}
                numberOfLines={1}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {item.label}
              </Text>
            </GlassSurface>
          </Pressable>
        );
      })}
    </GlassGroup>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    bar: {
      alignItems: "center",
      flexDirection: "row",
      height: SIDEBAR_TAB_BAR_HEIGHT,
    },
    item: {
      flex: 1,
      height: SIDEBAR_TAB_BAR_HEIGHT,
    },
    pressed: {
      opacity: 0.7,
    },
    glass: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: 5,
      justifyContent: "center",
      overflow: "hidden",
      paddingHorizontal: 6,
    },
    // Segments round only their outer ends and abut square, so the group's
    // union is one clean pill with nothing to pinch.
    capStart: {
      borderBottomStartRadius: SIDEBAR_TAB_BAR_HEIGHT / 2,
      borderTopStartRadius: SIDEBAR_TAB_BAR_HEIGHT / 2,
    },
    capEnd: {
      borderBottomEndRadius: SIDEBAR_TAB_BAR_HEIGHT / 2,
      borderTopEndRadius: SIDEBAR_TAB_BAR_HEIGHT / 2,
    },
    activeLozenge: {
      backgroundColor: fadeHex(colors.text, 0.1),
      borderRadius: (SIDEBAR_TAB_BAR_HEIGHT - 8) / 2,
      bottom: 4,
      left: 4,
      position: "absolute",
      right: 4,
      top: 4,
    },
    label: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
    },
    labelActive: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
    },
  });
