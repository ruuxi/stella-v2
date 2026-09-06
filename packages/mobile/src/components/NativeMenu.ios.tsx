import { Fragment } from "react";
import { View } from "react-native";
import { Host, Menu, Button, Divider, RNHostView } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  disabled,
  frame,
  menuIndicator,
  menuStyle,
} from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "../theme/theme-context";
import { liquidGlassSupported } from "./glass";
import type { NativeMenuProps } from "./NativeMenu.types";

/** SwiftUI owns the menu presentation and its native iOS 26 glass transition. */
export function NativeMenu(props: NativeMenuProps) {
  const { isDark } = useTheme();
  return (
    <Host
      colorScheme={isDark ? "dark" : "light"}
      ignoreSafeArea="all"
      style={{ width: props.width, height: props.height }}
    >
      <Menu
        label={
          <RNHostView matchContents>
            <View
              style={{
                width: props.width - 16,
                height: props.height - 16,
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <View pointerEvents="none">{props.label}</View>
            </View>
          </RNHostView>
        }
        modifiers={[
          menuStyle("button"),
          menuIndicator("hidden"),
          buttonStyle(liquidGlassSupported ? "glass" : "bordered"),
          buttonBorderShape(props.circular ? "circle" : "roundedRectangle", 14),
          frame({ width: props.width, height: props.height }),
          accessibilityLabel(props.accessibilityLabel),
          disabled(props.disabled ?? false),
        ]}
      >
        {props.items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore ? <Divider /> : null}
            <Button
              label={item.title}
              systemImage={item.selected ? "checkmark" : item.systemImage}
              onPress={item.onPress}
              modifiers={[disabled(item.disabled ?? false)]}
            />
          </Fragment>
        ))}
      </Menu>
    </Host>
  );
}
