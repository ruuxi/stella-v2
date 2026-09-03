import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  HStack,
  Host,
  Text as SwiftText,
  ZStack,
} from "@expo/ui/swift-ui";
import {
  Animation,
  animation,
  background,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  offset,
  opacity,
  padding,
  shapes,
  strokeBorder,
} from "@expo/ui/swift-ui/modifiers";
import { useColors, useTheme } from "../../theme/theme-context";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import type { SidebarTabBarProps } from "./sidebar-tab-bar-types";

/** Track height, matched to the header capsule and the composer. */
const BAR_HEIGHT = 44;
/** Inset of the selection lens from the track edge. */
const LENS_INSET = 3;
const LENS_HEIGHT = BAR_HEIGHT - LENS_INSET * 2;

/**
 * iOS tab bar built from Apple's Liquid Glass in SwiftUI, hosted through
 * @expo/ui. The track is a translucent wash of the theme (so it takes on
 * the backdrop exactly like the header capsule and the composer do), and
 * the selection lens is a real regular-glass capsule, the same material as
 * those capsules.
 *
 * The lens is one view that stays mounted and slides to the selected
 * segment by offset. Mounting a glass view per segment and relying on the
 * glass-id morph does not animate here: React Native mounts and unmounts
 * children in a separate pass from the animated value, so SwiftUI never
 * sees the transition. Offset and the animation trigger arrive together, so
 * the slide animates, and the lens refracts the labels it passes over on
 * the way, which is the effect the system control has.
 *
 * This replaced the system segmented control: that control paints its own
 * gray fill over any track colour, which never matched the glass chrome on
 * any theme. What it had that this does not is dragging the lens with a
 * finger; here it animates to the tapped segment.
 */
export function SidebarTabBar<K extends string>({
  tabs,
  value,
  onSelect,
  onHeight,
}: SidebarTabBarProps<K>) {
  const colors = useColors();
  const { isDark } = useTheme();
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((item) => item.key === value),
  );
  // SwiftUI only sizes to what it is proposed, and the host proposes its
  // own measured width late, so the bar and its segments take explicit
  // widths from the React Native container instead.
  const [width, setWidth] = useState(0);
  const innerWidth = width - LENS_INSET * 2;
  const segmentWidth = innerWidth / Math.max(1, tabs.length);
  const slide = animation(Animation.spring({ duration: 0.4 }), selectedIndex);
  return (
    <View
      style={styles.host}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width > 0 ? (
        <Host
          matchContents={{ vertical: true }}
          colorScheme={isDark ? "dark" : "light"}
          style={styles.host}
          onLayoutContent={(event) => onHeight?.(event.nativeEvent.height)}
        >
          <ZStack
            alignment="leading"
            modifiers={[
              padding({ all: LENS_INSET }),
              frame({ width, height: BAR_HEIGHT }),
              background(
                fadeHex(colors.text, isDark ? 0.06 : 0.05),
                shapes.capsule(),
              ),
              strokeBorder({
                color: fadeHex(colors.border, 0.6),
                shape: "capsule",
              }),
            ]}
          >
            <HStack spacing={0}>
              {tabs.map((item, index) => (
                <Button
                  key={item.key}
                  onPress={() => onSelect(item.key)}
                  modifiers={[buttonStyle("plain")]}
                >
                  <SwiftText
                    modifiers={[
                      font({ family: fonts.sans.medium, size: 14 }),
                      foregroundStyle(colors.textMuted),
                      // The label is the button's hit area, so it fills
                      // the segment. It fades out as the lens, which
                      // carries its own copy of the label, arrives.
                      frame({ width: segmentWidth, height: LENS_HEIGHT }),
                      opacity(index === selectedIndex ? 0 : 1),
                      slide,
                    ]}
                  >
                    {item.label}
                  </SwiftText>
                </Button>
              ))}
            </HStack>
            <SwiftText
              modifiers={[
                font({ family: fonts.sans.medium, size: 14 }),
                foregroundStyle(colors.text),
                frame({ width: segmentWidth, height: LENS_HEIGHT }),
                glassEffect({
                  glass: { variant: "regular", interactive: true },
                  shape: "capsule",
                }),
                offset({ x: selectedIndex * segmentWidth }),
                slide,
              ]}
            >
              {tabs[selectedIndex]?.label ?? ""}
            </SwiftText>
          </ZStack>
        </Host>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    alignSelf: "stretch",
  },
});
