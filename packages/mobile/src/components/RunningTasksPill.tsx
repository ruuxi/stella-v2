import { useMemo } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { GlassSurface } from "./glass";
import { ShimmerText } from "./ShimmerText";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { useT, useTPlural } from "../i18n";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import type { MobileTask } from "../types";

const SHIMMER_MS = 1900;

// Stepped bar heights for the level-meter glyph. Uneven, frozen heights read
// as a live activity meter (signal / processing) rather than a chart, without
// any motion that would distract.
const ACTIVITY_BAR_HEIGHTS = [6, 11, 8];

export const runningTaskCount = (tasks: readonly MobileTask[]) =>
  tasks.reduce((n, task) => (task.status === "running" ? n + 1 : n), 0);

/**
 * Floating "N in progress" pill — the chat's only trace of background work.
 * It appears while something runs and is gone otherwise; the activity itself
 * lives in the sidebar, which tapping the pill reveals.
 */
export function RunningTasksPill({
  running,
  colors,
  onPress,
  present,
  contentOpacity,
  style,
}: {
  running: number;
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
  const t = useT();
  const tPlural = useTPlural();
  const label = tPlural("mobile.activity.inProgress", running);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.activity.openLabel")}
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
    label: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
      maxFontSizeMultiplier: CONTENT_MAX_FONT_SCALE,
    } as never,
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
