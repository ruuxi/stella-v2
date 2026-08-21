import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { fadeHex } from "../theme/oklch";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";

const DEFAULT_DURATION_MS = 1600;
// Strip is wider than the text so the bright peak fully exits before looping.
const GRADIENT_MULTIPLIER = 3;
// Trough almost vanishes; peak is fully opaque — a clearly visible sweep.
const DEFAULT_DIM_ALPHA = 0.15;
const PEAK_ALPHA = 1;

/**
 * A single line of text with a left→right sweep, mirroring the desktop
 * `TextShimmer` (masked gradient over the glyphs). Used for live /
 * in-progress labels. When `active` is false it renders as plain text, so the
 * same node can settle without remounting.
 *
 * Two polarities:
 *   - `"trough"` (default): bright resting text with a dim band sweeping
 *     across it — the original treatment.
 *   - `"highlight"`: INVERTED — the resting glyphs sit dimmed (at `dimAlpha`
 *     of `color`) and the moving band brightens them up to full strength as
 *     it passes, reading as a light sweeping across dim text. Used by the
 *     minimal agent activity rows (matches desktop's inverted shimmer).
 */
export function ShimmerText({
  text,
  active,
  color,
  textStyle,
  durationMs = DEFAULT_DURATION_MS,
  dimAlpha = DEFAULT_DIM_ALPHA,
  variant = "trough",
}: {
  text: string;
  active: boolean;
  /** Base text color the sweep brightens/dims around. */
  color: string;
  textStyle: TextStyle | TextStyle[];
  durationMs?: number;
  dimAlpha?: number;
  /** Sweep polarity — see the component doc. */
  variant?: "trough" | "highlight";
}) {
  const shimmer = useRef(new Animated.Value(0)).current;
  const [size, setSize] = useState({ width: 0, height: 0 });

  // Re-measure when the text changes so the mask tracks the new glyph run.
  useEffect(() => {
    setSize({ width: 0, height: 0 });
  }, [text]);

  useEffect(() => {
    if (!active || size.width === 0) {
      shimmer.stopAnimation();
      shimmer.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: durationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, durationMs, shimmer, size.width]);

  const gradientWidth = Math.max(1, size.width * GRADIENT_MULTIPLIER);
  // Slide the wide strip so its dim trough crosses the visible glyphs exactly
  // once per loop, left → right.
  const translate = useMemo(
    () =>
      shimmer.interpolate({
        inputRange: [0, 1],
        outputRange: [-(gradientWidth - size.width), 0],
      }),
    [gradientWidth, shimmer, size.width],
  );

  // Plain text when idle — settles without a remount.
  if (!active) {
    return (
      <Text style={textStyle} numberOfLines={1} maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}>
        {text}
      </Text>
    );
  }

  // Active but unmeasured: render once invisibly so `onLayout` can size the mask.
  if (size.width === 0) {
    return (
      <Text
        style={[textStyle, styles.measure]}
        numberOfLines={1}
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        onLayout={(e) =>
          setSize({
            width: e.nativeEvent.layout.width,
            height: e.nativeEvent.layout.height,
          })
        }
      >
        {text}
      </Text>
    );
  }

  const dim = fadeHex(color, dimAlpha);
  const peak = fadeHex(color, PEAK_ALPHA);
  // Trough: a dim band crosses bright resting text. Highlight: inverted —
  // dim resting text with a bright peak sweeping across it.
  const band: [string, string, string, string, string] =
    variant === "highlight"
      ? [dim, dim, peak, dim, dim]
      : [peak, peak, dim, peak, peak];

  return (
    <MaskedView
      style={{ width: size.width, height: size.height }}
      maskElement={
        <Text style={textStyle} numberOfLines={1} maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}>
          {text}
        </Text>
      }
    >
      <Animated.View
        pointerEvents="none"
        style={{
          width: gradientWidth,
          height: size.height,
          transform: [{ translateX: translate }],
        }}
      >
        <LinearGradient
          colors={band}
          locations={[0, 0.4, 0.5, 0.6, 1]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </MaskedView>
  );
}

const styles = StyleSheet.create({
  // Invisible measurement copy — must render so onLayout fires.
  measure: { opacity: 0 },
});
