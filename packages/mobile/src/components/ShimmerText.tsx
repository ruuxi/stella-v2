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

const GRADIENT_MULTIPLIER = 3;

const DEFAULT_DIM_ALPHA = 0.15;
const PEAK_ALPHA = 1;

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

  color: string;
  textStyle: TextStyle | TextStyle[];
  durationMs?: number;
  dimAlpha?: number;

  variant?: "trough" | "highlight";
}) {
  const shimmer = useRef(new Animated.Value(0)).current;
  const [size, setSize] = useState({ width: 0, height: 0 });

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

  const translate = useMemo(
    () =>
      shimmer.interpolate({
        inputRange: [0, 1],
        outputRange: [-(gradientWidth - size.width), 0],
      }),
    [gradientWidth, shimmer, size.width],
  );

  if (!active) {
    return (
      <Text style={textStyle} numberOfLines={1} maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}>
        {text}
      </Text>
    );
  }

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

  const band: [string, string, string, string, string] =
    variant === "highlight"
      ? [dim, dim, peak, dim, dim]
      : [peak, peak, dim, peak, peak];
  const bandLocations: [number, number, number, number, number] =
    variant === "highlight" ? [0, 0.22, 0.5, 0.78, 1] : [0, 0.4, 0.5, 0.6, 1];

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
          locations={bandLocations}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </MaskedView>
  );
}

const styles = StyleSheet.create({

  measure: { opacity: 0 },
});
