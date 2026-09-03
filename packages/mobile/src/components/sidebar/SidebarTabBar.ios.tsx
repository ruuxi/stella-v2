import { StyleSheet } from "react-native";
import { Host, Picker, Text as SwiftText } from "@expo/ui/swift-ui";
import { font, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "../../theme/theme-context";
import { fonts } from "../../theme/fonts";
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
  const { isDark } = useTheme();
  return (
    <Host
      matchContents={{ vertical: true }}
      colorScheme={isDark ? "dark" : "light"}
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
