import { useEffect, useId, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { STELLA_MARK_CENTER, STELLA_ORB_PATH, STELLA_STAR_PATH } from "./geometry";
import { MarkLayer, VIEWBOX_SPAN } from "./MarkLayer";
import {
  BREATHE_AMPLITUDE,
  BREATHE_MS,
  CLOCK_SPAN_MS,
  DOT_RADIUS_UNITS,
  DOT_SPREAD_UNITS,
  MORPH_MS,
  SIDE_DOT_SCALE,
  dotEntrance,
  dotWave,
  easeOutBack,
  easeOutCubic,
  morphEnvelope,
} from "./motion";

const DEFAULT_SIZE = 34;

const DOT_SCALE = DOT_RADIUS_UNITS / STELLA_MARK_CENTER;

const SMALL_SIZE_THRESHOLD = 44;
const DOTS_ZOOM = 1.5;

export type StellaMarkMode = "dots" | "star";

export function StellaMarkIndicator({
  active,
  size = DEFAULT_SIZE,
  mode = "dots",
}: {

  active: boolean;
  size?: number;
  mode?: StellaMarkMode;
}) {
  const reduceMotion = useReducedMotion();

  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");

  const pxPerUnit = size / VIEWBOX_SPAN;
  const spreadPx = DOT_SPREAD_UNITS * pxPerUnit;
  const zoom = size < SMALL_SIZE_THRESHOLD ? DOTS_ZOOM : 1;

  const clock = useSharedValue(0);

  const morphT = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(clock);
    if (reduceMotion) {

      clock.value = 0;
      return;
    }
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
  }, [clock, reduceMotion]);

  useEffect(() => {
    cancelAnimation(morphT);
    if (reduceMotion) {

      morphT.value = 0;
      return;
    }
    morphT.value = withTiming(active && mode === "dots" ? 1 : 0, {
      duration: MORPH_MS,
      easing: Easing.linear,
    });
    return () => cancelAnimation(morphT);
  }, [active, mode, morphT, reduceMotion]);

  const envelope = useDerivedValue(() => morphEnvelope(morphT.value));

  const stageStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const breathe =
      1 +
      BREATHE_AMPLITUDE *
        Math.sin((clock.value / BREATHE_MS) * 2 * Math.PI) *
        (1 - env);
    return { transform: [{ scale: (1 + (zoom - 1) * env) * breathe }] };
  });

  const middleStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const wave = dotWave(1, clock.value);
    const base = 1 + (DOT_SCALE - 1) * env;
    const pop = 1 + (wave.scale - 1) * env;
    return {
      opacity: 1 - (1 - wave.opacity) * env,
      transform: [
        { translateY: -wave.liftUnits * pxPerUnit * env },
        { scale: base * pop },
      ],
    };
  });
  const starStyle = useAnimatedStyle(() => ({ opacity: 1 - envelope.value }));
  const orbStyle = useAnimatedStyle(() => ({ opacity: envelope.value }));

  const leftStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const wave = dotWave(0, clock.value);
    const entrance = dotEntrance(0, env);
    return {
      opacity: wave.opacity * easeOutCubic(entrance),
      transform: [
        { translateX: -spreadPx * easeOutBack(entrance) },
        { translateY: -wave.liftUnits * pxPerUnit * env },
        { scale: DOT_SCALE * SIDE_DOT_SCALE * wave.scale },
      ],
    };
  });

  const rightStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const wave = dotWave(2, clock.value);
    const entrance = dotEntrance(2, env);
    return {
      opacity: wave.opacity * easeOutCubic(entrance),
      transform: [
        { translateX: spreadPx * easeOutBack(entrance) },
        { translateY: -wave.liftUnits * pxPerUnit * env },
        { scale: DOT_SCALE * SIDE_DOT_SCALE * wave.scale },
      ],
    };
  });

  const viewport = useMemo(
    () => [styles.viewport, { width: size, height: size }],
    [size],
  );

  return (
    <View style={viewport} pointerEvents="none">
      <Animated.View style={[styles.stage, stageStyle]}>
        <Animated.View style={[styles.layer, leftStyle]}>
          <MarkLayer
            d={STELLA_ORB_PATH}
            size={size}
            gradientId={`${uid}-left`}
          />
        </Animated.View>
        <Animated.View style={[styles.layer, rightStyle]}>
          <MarkLayer
            d={STELLA_ORB_PATH}
            size={size}
            gradientId={`${uid}-right`}
          />
        </Animated.View>
        <Animated.View style={[styles.layer, middleStyle]}>
          <Animated.View style={[styles.layer, starStyle]}>
            <MarkLayer
              d={STELLA_STAR_PATH}
              size={size}
              gradientId={`${uid}-star`}
            />
          </Animated.View>
          <Animated.View style={[styles.layer, orbStyle]}>
            <MarkLayer
              d={STELLA_ORB_PATH}
              size={size}
              gradientId={`${uid}-orb`}
            />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFillObject },
  stage: { ...StyleSheet.absoluteFillObject },
  viewport: { alignItems: "center", justifyContent: "center" },
});
