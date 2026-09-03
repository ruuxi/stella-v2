import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import { findNodeHandle, StyleSheet, View } from "react-native";
import { Host, Spacer, TabView } from "@expo/ui/swift-ui";
import { tabViewStyle } from "@expo/ui/swift-ui/modifiers";
import { applyTabBarChrome } from "../../../modules/stella-tab-bar-chrome";
import { useColors, useTheme } from "../../theme/theme-context";
import type { IconName } from "../Icon";
import type { SidebarTabBarProps } from "./sidebar-tab-bar-types";

/**
 * Height given to the hosted tab view. The bar floats at its bottom edge;
 * the strip above it is the (empty, transparent) tab content.
 */
const HOST_HEIGHT = 72;
/**
 * The floating platter is the host width minus a fixed margin per side,
 * so the host reaches past the dock to make the bar wider.
 */
const HOST_OVERHANG = 18;
/** The system bar is a little tall for the dock; shrunk about its bottom edge. */
const BAR_SCALE = 0.9;
/** Pulls the bar down past the dock's bottom edge. */
const HOST_DROP = 22;

type Symbol = NonNullable<ComponentProps<typeof TabView.Tab>["systemImage"]>;
/** PostScript name of the app's medium sans, as UIKit registers it. */
const TAB_TITLE_FONT = "Manrope-Medium";

/** The app's icon names mapped to SF Symbols for the system tab bar. */
const SYMBOLS: Partial<Record<IconName, Symbol>> = {
  waveform: "waveform",
  clock: "clock",
  search: "magnifyingglass",
};

/**
 * iOS tab bar: the system tab bar itself, hosted as a SwiftUI `TabView`
 * with empty pages. On iOS 26 that is the floating Liquid Glass bar with
 * the real selection lens: press-and-hold lifts it, it follows a drag
 * across the tabs, and it refracts what it passes over. Its material is
 * the same glass as the rest of the chrome, so it follows the theme the
 * way the header capsule and the composer do.
 *
 * Neither a segmented control nor anything assembled from glass views
 * gives this: the segmented control paints its own gray fill over the
 * track, and hand-built glass only has the ordinary button response.
 *
 * What SwiftUI cannot do for us, a small native module does after layout:
 * clear the page background UIKit paints behind the bar, and put the
 * titles in the app font.
 */
export function SidebarTabBar<K extends string>({
  tabs,
  value,
  onSelect,
  onHeight,
}: SidebarTabBarProps<K>) {
  const colors = useColors();
  const { isDark } = useTheme();
  const hostRef = useRef<View>(null);
  const applyChrome = useCallback(() => {
    applyTabBarChrome({
      viewTag: findNodeHandle(hostRef.current),
      // UIKit knows the font by its PostScript name, not the Expo alias.
      titleFontFamily: TAB_TITLE_FONT,
      titleSize: 10,
      iconPointSize: 20,
      scale: BAR_SCALE,
    });
  }, []);
  // Selection re-creates the bar's labels, so re-apply after it settles.
  useEffect(() => {
    const handle = setTimeout(applyChrome, 50);
    return () => clearTimeout(handle);
  }, [value, applyChrome]);
  return (
    <View ref={hostRef} collapsable={false} style={styles.wrap}>
      <Host
        colorScheme={isDark ? "dark" : "light"}
        seedColor={colors.text}
        ignoreSafeArea="all"
        style={styles.host}
        onLayoutContent={() => {
          onHeight?.(HOST_HEIGHT);
          applyChrome();
        }}
      >
        <TabView
          selection={value}
          onSelectionChange={(next) => onSelect(next as K)}
          modifiers={[tabViewStyle({ type: "automatic" })]}
        >
          {tabs.map((item) => (
            <TabView.Tab
              key={item.key}
              value={item.key}
              label={item.label}
              systemImage={SYMBOLS[item.icon]}
            >
              <Spacer />
            </TabView.Tab>
          ))}
        </TabView>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: "stretch",
    height: HOST_HEIGHT,
    marginBottom: -HOST_DROP,
    marginHorizontal: -HOST_OVERHANG,
  },
  host: {
    flex: 1,
  },
});
