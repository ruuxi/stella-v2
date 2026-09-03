import { useId, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  GlassEffectContainer,
  HStack,
  Host,
  Namespace,
  Text as SwiftText,
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
  glassEffectId,
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

/**
 * iOS tab bar built from Apple's Liquid Glass in SwiftUI, hosted through
 * @expo/ui. The track is a translucent wash of the theme (so it takes on
 * the backdrop exactly like the header capsule and the composer do), and
 * the selected segment carries a real regular-glass capsule, the same
 * material as those capsules. All three segments sit in one glass
 * container and share a glass id, so on selection the lens morphs across
 * to the tapped segment instead of appearing there.
 *
 * This replaced the system segmented control: that control paints its
 * own gray fill over any track colour, which never matched the glass
 * chrome on any theme. What it had that this does not is dragging the lens
 * with a finger; here it animates to the tapped segment.
 */
export function SidebarTabBar<K extends string>({
  tabs,
  value,
  onSelect,
  onHeight,
}: SidebarTabBarProps<K>) {
  const colors = useColors();
  const { isDark } = useTheme();
  const namespace = useId();
  const selectedIndex = tabs.findIndex((item) => item.key === value);
  // SwiftUI only sizes to what it is proposed, and the host proposes its
  // own measured width late, so the bar and its segments take explicit
  // widths from the React Native container instead.
  const [width, setWidth] = useState(0);
  const segmentWidth = (width - LENS_INSET * 2) / Math.max(1, tabs.length);
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
          <Namespace id={namespace}>
            <GlassEffectContainer spacing={0}>
              <HStack
                spacing={0}
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
                  animation(Animation.spring({ duration: 0.4 }), selectedIndex),
                ]}
              >
                {tabs.map((item) => {
                  const active = item.key === value;
                  return (
                    <Button
                      key={item.key}
                      onPress={() => onSelect(item.key)}
                      modifiers={[buttonStyle("plain")]}
                    >
                      <SwiftText
                        modifiers={[
                          font({ family: fonts.sans.medium, size: 14 }),
                          foregroundStyle(
                            active ? colors.text : colors.textMuted,
                          ),
                          // The label is the button's hit area, so it fills the
                          // segment; the glass lens is drawn on it as well.
                          frame({
                            width: segmentWidth,
                            height: BAR_HEIGHT - LENS_INSET * 2,
                          }),
                          ...(active
                            ? [
                                glassEffect({
                                  glass: {
                                    variant: "regular",
                                    interactive: true,
                                  },
                                  shape: "capsule",
                                }),
                                glassEffectId("lens", namespace),
                              ]
                            : []),
                        ]}
                      >
                        {item.label}
                      </SwiftText>
                    </Button>
                  );
                })}
              </HStack>
            </GlassEffectContainer>
          </Namespace>
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
