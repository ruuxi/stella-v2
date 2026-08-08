import { useMemo } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { GlassSurface } from "./glass";
import { Icon } from "./Icon";
import { ShimmerText } from "./ShimmerText";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import type { MobileTask } from "../types";

const SHIMMER_MS = 1900;

// Stepped bar heights for the level-meter glyph. Uneven, frozen heights read
// as a live activity meter (signal / processing) rather than a chart, without
// any motion that would distract.
const ACTIVITY_BAR_HEIGHTS = [6, 11, 8];

const runningCountOf = (tasks: readonly MobileTask[]) =>
  tasks.reduce((n, task) => (task.status === "running" ? n + 1 : n), 0);

/**
 * Floating activity pill — sits to the left of the floating settings button
 * with the same glass language and visibility rules (mobile take on the
 * desktop `ComposerActivityPill`). Always present while the floating controls
 * are: idle it reads "Search" (the entry point to the activity hub's search),
 * and while background work runs it shimmers the running count. Tapping it in
 * any state opens the activity hub sheet.
 */
export function ActivityPill({
  tasks,
  colors,
  onPress,
  present,
  contentOpacity,
  style,
}: {
  tasks: readonly MobileTask[];
  colors: Colors;
  onPress: () => void;
  /** Materialize/dissolve the glass with the sibling floating controls. */
  present: boolean;
  /**
   * Shared fade (the floating controls' show/hide anim) applied to the label
   * and hairline ring — never to the glass itself (see ScrollToBottomFab:
   * fading a Liquid Glass ancestor's opacity drops the material).
   */
  contentOpacity: Animated.Value | Animated.AnimatedInterpolation<number>;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const running = runningCountOf(tasks);
  const label =
    running === 0
      ? "Search"
      : running === 1
        ? "1 in progress"
        : `${running} in progress`;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        running === 0 ? "Search activity and files" : "Open activity"
      }
      hitSlop={6}
      style={({ pressed }) => [
        styles.pressable,
        style,
        pressed && styles.pressed,
      ]}
    >
      <GlassSurface
        glass="clear"
        interactive
        present={present}
        radius={20}
        fallbackColor={colors.surface}
        style={styles.glass}
      >
        {/* Fading border overlay so the hairline dissolves with the glass
            instead of lingering as an outline when hidden. */}
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.ring,
            { opacity: contentOpacity },
          ]}
        />
        <Animated.View style={[styles.content, { opacity: contentOpacity }]}>
          {running === 0 ? (
            <>
              <Icon
                name="search"
                size={14}
                color={colors.textMuted}
                weight="semibold"
              />
              <Text
                style={styles.idleLabel}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                Search
              </Text>
            </>
          ) : (
            <>
              <View style={styles.glyph}>
                {ACTIVITY_BAR_HEIGHTS.map((height, index) => (
                  <View key={index} style={[styles.glyphBar, { height }]} />
                ))}
              </View>
              <ShimmerText
                text={label}
                active
                color={colors.text}
                textStyle={styles.label}
                durationMs={SHIMMER_MS}
                dimAlpha={0.3}
              />
            </>
          )}
        </Animated.View>
      </GlassSurface>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pressable: {
      height: 40,
    },
    pressed: {
      opacity: 0.88,
    },
    glass: {
      alignItems: "center",
      borderRadius: 20,
      flex: 1,
      justifyContent: "center",
      overflow: "hidden",
      paddingHorizontal: 14,
    },
    ring: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
    },
    content: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
    },
    idleLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    label: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    glyph: {
      alignItems: "flex-end",
      flexDirection: "row",
      // Fixed footprint so the pill never reflows as bars/labels change.
      gap: 2.5,
      height: 11,
    },
    glyphBar: {
      backgroundColor: colors.accent,
      borderRadius: 1.5,
      width: 2.5,
    },
  });
