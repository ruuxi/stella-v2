import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useT } from "../../i18n";
import type { MainTabId } from "../../lib/last-main-tab";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import { useColors } from "../../theme/theme-context";
import { GlassSurface } from "../glass";
import { Icon, type IconName } from "../Icon";

/** The shell's destinations, top to bottom. Settings stays last. */
const NAV_ORDER: readonly MainTabId[] = [
  "chat",
  "schedule",
  "apps",
  "files",
  "settings",
];

const NAV_ICONS = {
  chat: "chat",
  schedule: "clock",
  apps: "apps",
  files: "artifacts",
  settings: "user",
} as const satisfies Record<MainTabId, IconName>;

const NAV_LABEL_KEYS: Record<MainTabId, string> = {
  chat: "mobile.nav.chat",
  schedule: "mobile.activityHub.tabs.schedule",
  apps: "mobile.nav.apps",
  files: "mobile.activityHub.tabs.files",
  settings: "mobile.nav.settings",
};

const ROW_HEIGHT = 44;
const CARD_PADDING = 4;
const CARD_RADIUS = (ROW_HEIGHT + CARD_PADDING * 2) / 2;

/**
 * The sidebar's navigation: one glass card listing every shell destination
 * with its icon and name, the current one on a soft lozenge. Liquid Glass on
 * iOS 26, the frosted fallback tint everywhere else.
 */
export function SidebarNav({
  value,
  onSelect,
}: {
  /** The destination on screen; `null` when none of them is. */
  value: MainTabId | null;
  /** Fires for every tap, including a tap on the current destination. */
  onSelect: (next: MainTabId) => void;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <GlassSurface
      glass="regular"
      radius={CARD_RADIUS}
      ringed
      fallbackColor={fadeHex(colors.surface, 0.94)}
      style={styles.card}
    >
      {NAV_ORDER.map((key) => {
        const active = key === value;
        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(key)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            testID={`mobile-sidebar-nav-${key}`}
          >
            {active ? (
              <View pointerEvents="none" style={styles.activeLozenge} />
            ) : null}
            <View style={styles.glyph}>
              <Icon
                name={NAV_ICONS[key]}
                size={19}
                color={active ? colors.text : colors.textMuted}
                weight={active ? "semibold" : "regular"}
              />
            </View>
            <Text
              style={[styles.label, active && styles.labelActive]}
              numberOfLines={1}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {t(NAV_LABEL_KEYS[key])}
            </Text>
          </Pressable>
        );
      })}
    </GlassSurface>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      padding: CARD_PADDING,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      height: ROW_HEIGHT,
      paddingHorizontal: 12,
    },
    pressed: {
      opacity: 0.7,
    },
    activeLozenge: {
      backgroundColor: fadeHex(colors.text, 0.08),
      borderRadius: ROW_HEIGHT / 2,
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    glyph: {
      alignItems: "center",
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    label: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    labelActive: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
    },
  });
