import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MainTabId } from "../../lib/last-main-tab";
import type { Colors } from "../../theme/colors";
import { useColors } from "../../theme/theme-context";
import { SidebarNav } from "./SidebarNav";

/**
 * The left sidebar: the shell's destinations (Chat, Schedule, Apps, Files,
 * Settings) and nothing else.
 *
 * It used to carry the conversation's background work below the nav as well —
 * an agent row per task with its files nested underneath. That list said the
 * same thing the top bar's activity indicator already says, and the indicator
 * says it without opening a drawer, so the drawer is now purely navigation.
 * Files stay reachable through the Files destination, which is where a list of
 * them belongs.
 */
export function SidebarPanel({
  width,
  contentInsetRight = 0,
  activeTab,
  onSelectTab,
}: {
  width: number;
  /**
   * Portion of the panel the foreground still covers when the drawer is
   * open (the rounded content edge overlaps it). Content stays clear of it.
   */
  contentInsetRight?: number;
  activeTab: MainTabId | null;
  onSelectTab: (tab: MainTabId) => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={[styles.root, { width }]}>
      {/* The panel itself is deliberately NOT glass. Apple suppresses Liquid
          Glass layered over another glass surface (nested or merely beneath)
          and renders the upper one flat, so a glass panel would strip any
          glass above it of its material. A translucent surface tint over the
          app backdrop keeps the same legible look. */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.panelFill]}
      />
      <View
        style={[
          styles.body,
          { paddingRight: contentInsetRight, paddingTop: insets.top + 10 },
        ]}
      >
        <View style={styles.nav}>
          <SidebarNav value={activeTab} onSelect={onSelectTab} />
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      flex: 1,
    },
    panelFill: {
      // The drawer is the base surface, not a lifted one, and it reads that
      // way whether it is parked, mid-drag or open — its colour never tracks
      // open state. Separation from the content comes from the page lifting
      // as the drawer opens (see `foregroundScrim`), not from the drawer
      // sitting brighter than the page it covers.
      backgroundColor: colors.background,
    },
    body: {
      flex: 1,
      minHeight: 0,
    },
    nav: {
      paddingBottom: 10,
      paddingHorizontal: 8,
    },
  });
