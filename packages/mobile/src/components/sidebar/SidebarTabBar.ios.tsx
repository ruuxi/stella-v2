import { useMemo } from "react";
import { StyleSheet } from "react-native";
import { Host, Picker, Text as SwiftText } from "@expo/ui/swift-ui";
import { font, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { applySegmentedControlAppearance } from "../../../modules/stella-segmented-appearance";
import { useColors, useTheme } from "../../theme/theme-context";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import type { SidebarTabBarProps } from "./sidebar-tab-bar-types";

/**
 * iOS tab bar: the system segmented control, hosted from SwiftUI. On iOS 26
 * it is Apple's own Liquid Glass selection: a glass lens sits on the chosen
 * segment, refracts the labels beneath, slides on tap and follows a drag.
 * Nothing built from separate glass views reproduces that, so this uses the
 * real control rather than imitating it.
 */
export function SidebarTabBar<K extends string>({
  tabs,
  value,
  onSelect,
  onHeight,
}: SidebarTabBarProps<K>) {
  const colors = useColors();
  const { isDark } = useTheme();
  // UIKit paints the control's track and selected lens with its own fills,
  // out of reach of SwiftUI modifiers, so the colours go through the
  // UIAppearance proxy instead. That only affects controls created
  // afterwards: the call happens during render, before this pass commits
  // its native views, and the Host is keyed by theme so a theme change
  // recreates the control under the new colours. Matched to the app's
  // regular-glass chrome (the header capsule, the top bar buttons).
  const themeKey = isDark ? "dark" : "light";
  useMemo(() => {
    applySegmentedControlAppearance({
      background: fadeHex(colors.surface, isDark ? 0.55 : 0.7),
      selected: fadeHex(colors.text, isDark ? 0.14 : 0.1),
    });
  }, [colors.surface, colors.text, isDark]);
  return (
    <Host
      key={themeKey}
      matchContents={{ vertical: true }}
      colorScheme={themeKey}
      style={styles.host}
      onLayoutContent={(event) => onHeight?.(event.nativeEvent.height)}
    >
      <Picker<K>
        label=""
        selection={value}
        onSelectionChange={onSelect}
        modifiers={[pickerStyle("segmented")]}
      >
        {tabs.map((item) => (
          <SwiftText
            key={item.key}
            modifiers={[
              tag(item.key),
              font({ family: fonts.sans.medium, size: 13 }),
            ]}
          >
            {item.label}
          </SwiftText>
        ))}
      </Picker>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    alignSelf: "stretch",
  },
});
