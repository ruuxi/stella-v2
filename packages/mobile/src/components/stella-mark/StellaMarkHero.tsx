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
import { StellaFace } from "./StellaFace";
import {
  BREATHE_AMPLITUDE,
  CLOCK_SPAN_MS,
  breatheScale,
  voiceScale,
} from "./motion";
import { useAppVisible } from "../../lib/use-app-visible";

/**
 * The character mark at hero size: onboarding's welcome step and the realtime
 * voice overlay.
 *
 * With no `energy` it simply breathes. Passing a shared value hands the scale
 * over to live mic/output level, so the same rig serves as the voice
 * visualizer. `energy` stays a `SharedValue` rather than a prop so the audio
 * meter can drive it on the UI thread without re-rendering React at frame rate.
 *
 * A `faceColor` gives the character eyes, which idle, blink and look around.
 * Without one it stays a silhouette, which is what the voice overlay wants: the
 * mark is a level meter there, not a character.
 */
export function StellaMarkHero({
  size,
  energy,
  faceColor,
}: {
  size: number;
  energy?: SharedValue<number>;
  faceColor?: string;
}) {
  const reduceMotion = useReducedMotion();
  const appVisible = useAppVisible();
  // Gradient ids are per-instance: two marks sharing an id make the second
  // resolve against the first one's gradient (see StellaMark.tsx).
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
    // The breathe has no end of its own, so without this gate a backgrounded
    // app keeps the clock looping forever.
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
        {faceColor ? (
          <StellaFace
            size={size}
            color={faceColor}
            active={appVisible && !reduceMotion}
          />
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { ...StyleSheet.absoluteFill },
  viewport: { alignItems: "center", justifyContent: "center" },
});
