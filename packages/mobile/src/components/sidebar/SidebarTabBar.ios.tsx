import { useMemo } from "react";
import { StyleSheet } from "react-native";
import { Host, Picker, Text as SwiftText } from "@expo/ui/swift-ui";
import { frame, font, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { applySegmentedControlAppearance } from "../../../modules/stella-segmented-appearance";
import { useColors, useTheme } from "../../theme/theme-context";
import { fonts } from "../../theme/fonts";
import { soften } from "../../theme/oklch";
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
  // recreates the control under the new colours. iOS 26 still lays its own
  // thin light system fill over the track (clearing the track artwork does
  // not remove it) and blends the lens with the glass, so these are set by
  // measurement rather than copied: pure black under that fill is the
  // darkest track possible and lands within a few units of the top bar's
  // buttons and the header capsule; the lens stays in that same dark
  // family, only a shade lighter than the track, rather than the system's
  // bright gray.
  const themeKey = isDark ? "dark" : "light";
  useMemo(() => {
    applySegmentedControlAppearance({
      background: isDark ? "#000000" : colors.background,
      selected: soften(colors.text, colors.background, isDark ? 0.18 : 0.14),
    });
  }, [colors.background, colors.text, isDark]);
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
        // Taller than the control's default so it sits at the same weight
        // as the header capsule and the composer.
        modifiers={[pickerStyle("segmented"), frame({ height: TAB_BAR_HEIGHT })]}
      >
        {tabs.map((item) => (
          <SwiftText
            key={item.key}
            modifiers={[
              tag(item.key),
              font({ family: fonts.sans.medium, size: 14 }),
            ]}
          >
            {item.label}
          </SwiftText>
        ))}
      </Picker>
    </Host>
  );
}

/** Track height; the segmented control scales its lens to fill it. */
const TAB_BAR_HEIGHT = 44;

const styles = StyleSheet.create({
  host: {
    alignSelf: "stretch",
  },
});
