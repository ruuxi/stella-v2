import { useEffect, useId, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { STELLA_STAR_PATH } from "./geometry";
import { MarkLayer } from "./MarkLayer";
import {
  BREATHE_AMPLITUDE,
  CLOCK_SPAN_MS,
  breatheScale,
  voiceScale,
} from "./motion";
import { useAppVisible } from "../../lib/use-app-visible";

export function StellaMarkHero({
  size,
  energy,
}: {
  size: number;
  energy?: SharedValue<number>;
}) {
  const reduceMotion = useReducedMotion();
  const appVisible = useAppVisible();
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");

  const clock = useSharedValue(0);
  const fallbackEnergy = useSharedValue(0);
  const level = energy ?? fallbackEnergy;
  const driven = energy !== undefined;

  useEffect(() => {
    cancelAnimation(clock);
    if (reduceMotion) {
      clock.value = 0;
      return;
    }
    if (!appVisible) return;
    clock.value = 0;
    clock.value = withRepeat(
      withTiming(CLOCK_SPAN_MS, {
        duration: CLOCK_SPAN_MS,
        easing: Easing.linear,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(clock);
  }, [appVisible, clock, reduceMotion]);

  const stageStyle = useAnimatedStyle(() => {
    if (reduceMotion) {
      return { transform: [{ scale: 1 }] };
    }
    const scale = driven
      ? voiceScale(level.value, clock.value)
      : breatheScale(clock.value, BREATHE_AMPLITUDE);
    return { transform: [{ scale }] };
  });

  const viewport = useMemo(
    () => [styles.viewport, { width: size, height: size }],
    [size],
  );

  return (
    <View style={viewport} pointerEvents="none">
      <Animated.View style={[styles.stage, stageStyle]}>
        <MarkLayer
          d={STELLA_STAR_PATH}
          size={size}
          gradientId={`${uid}-hero`}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { ...StyleSheet.absoluteFillObject },
  viewport: { alignItems: "center", justifyContent: "center" },
});
