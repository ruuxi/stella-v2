import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import { findNodeHandle, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Host, Spacer, TabView } from "@expo/ui/swift-ui";
import { tabViewStyle } from "@expo/ui/swift-ui/modifiers";
import { applyTabBarChrome } from "../../../modules/stella-tab-bar-chrome";
import { useColors, useTheme } from "../../theme/theme-context";
import { liquidGlassSupported } from "../glass";
import type { IconName } from "../Icon";
import { ShellTabBarFallback } from "./ShellTabBarFallback";
import {
  shellTabBarBase,
  type ShellTabBarProps,
} from "./shell-tab-bar-types";

/**
 * Height given to the hosted tab view. The bar floats at its bottom edge;
 * the strip above it is the (empty, transparent) tab content.
 */
const HOST_HEIGHT = 72;
/**
 * The floating platter is the host width minus a fixed margin per side,
 * so the host reaches past the screen gutter to make the bar wider.
 */
const HOST_OVERHANG = 10;
/** How far the host's bottom edge sits below the bar's base line. */
const HOST_DROP = 20;

type Symbol = NonNullable<ComponentProps<typeof TabView.Tab>["systemImage"]>;
/** PostScript name of the app's medium sans, as UIKit registers it. */
const TAB_TITLE_FONT = "Manrope-Medium";

/** The app's icon names mapped to SF Symbols for the system tab bar. */
const SYMBOLS: Partial<Record<IconName, Symbol>> = {
  chat: "bubble.left",
  clock: "clock",
  apps: "circle.grid.2x2",
  artifacts: "photo.on.rectangle.angled",
  user: "person.crop.circle",
};

/**
 * iOS tab bar. On iOS 26 this is the system tab bar itself, hosted as a
 * SwiftUI `TabView` with empty pages: the floating Liquid Glass bar with the
 * real selection lens (press-and-hold lifts it, it follows a drag across the
 * tabs, and it refracts what it passes over). Its material is the same glass
 * as the rest of the chrome, so it follows the theme the way the header
 * buttons and the composer do.
 *
 * Before iOS 26 the system bar is the old full-width opaque strip, which
 * would sit under the floating composer like a toolbar, so those devices get
 * the same floating pill as Android instead.
 *
 * What SwiftUI cannot do for us, a small native module does after layout:
 * clear the page background UIKit paints behind the bar, and put the titles
 * in the app font.
 */
export function ShellTabBar<K extends string>(props: ShellTabBarProps<K>) {
  if (!liquidGlassSupported) return <ShellTabBarFallback {...props} />;
  return <SystemTabBar {...props} />;
}

function SystemTabBar<K extends string>({
  tabs,
  value,
  onSelect,
}: ShellTabBarProps<K>) {
  const colors = useColors();
  const { isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const hostRef = useRef<View>(null);
  const applyChrome = useCallback(() => {
    applyTabBarChrome({
      viewTag: findNodeHandle(hostRef.current),
      // UIKit knows the font by its PostScript name, not the Expo alias.
      titleFontFamily: TAB_TITLE_FONT,
      titleSize: 10,
      iconPointSize: 0,
      scale: 1,
    });
  }, []);
  // Selection re-creates the bar's labels, so re-apply after it settles.
  useEffect(() => {
    const handle = setTimeout(applyChrome, 50);
    return () => clearTimeout(handle);
  }, [value, applyChrome]);
  return (
    <View
      ref={hostRef}
      collapsable={false}
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: shellTabBarBase(insets.bottom) - HOST_DROP }]}
    >
      <Host
        colorScheme={isDark ? "dark" : "light"}
        seedColor={colors.text}
        ignoreSafeArea="all"
        style={styles.host}
        onLayoutContent={applyChrome}
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
              // Icons only: an empty title lets the bar lay the symbol out
              // alone. The name still reaches VoiceOver via the symbol.
              label=""
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
    height: HOST_HEIGHT,
    left: -HOST_OVERHANG,
    position: "absolute",
    right: -HOST_OVERHANG,
  },
  host: {
    flex: 1,
  },
});
