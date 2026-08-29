import { useEffect, useId, useMemo, useState } from "react";
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
import { STELLA_ORB_PATH, STELLA_STAR_PATH } from "./geometry";
import {
  middleDotScale,
  morphShrink,
  sideDotScale,
  stellaMarkLayout,
} from "./layout";
import { MarkLayer } from "./MarkLayer";
import { shouldRunContinuousAnimation } from "../../lib/continuous-animation";
import { useAppVisible } from "../../lib/use-app-visible";
import {
  BREATHE_AMPLITUDE,
  BREATHE_MS,
  CLOCK_SPAN_MS,
  MORPH_MS,
  dotEntrance,
  dotWave,
  easeOutBack,
  easeOutCubic,
  morphEnvelope,
} from "./motion";

const DEFAULT_SIZE = 34;

// Let the morph finish before the shared clock stops, so the mark does not
// freeze mid-transition when the work ends.
const STOP_GRACE_MS = 400;

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
  const appVisible = useAppVisible();
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");

  const layout = useMemo(() => stellaMarkLayout(size), [size]);
  const { dotPx, sideDotPx, pxPerUnit, spreadPx, zoom } = layout;

  const clock = useSharedValue(0);

  const morphT = useSharedValue(0);
  const [running, setRunning] = useState(() =>
    shouldRunContinuousAnimation({
      logicalActive: active,
      appVisible,
      reducedMotion: reduceMotion,
    }),
  );

  useEffect(() => {
    cancelAnimation(clock);
    if (reduceMotion) {
      clock.value = 0;
      return;
    }
    if (!running) return;
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
  }, [clock, reduceMotion, running]);

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

  useEffect(() => {
    if (reduceMotion || !appVisible) {
      setRunning(false);
      return;
    }
    if (active) {
      setRunning(true);
      return;
    }
    const timer = setTimeout(() => setRunning(false), MORPH_MS + STOP_GRACE_MS);
    return () => clearTimeout(timer);
  }, [active, appVisible, reduceMotion]);

  const envelope = useDerivedValue(() => morphEnvelope(morphT.value));

  // The stage only breathes: the dots state carries its own zoom in the pixel
  // sizes below, so nothing is left resampled once the morph settles.
  const stageStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const breathe =
      1 +
      BREATHE_AMPLITUDE *
        Math.sin((clock.value / BREATHE_MS) * 2 * Math.PI) *
        (1 - env);
    return { transform: [{ scale: breathe }] };
  });

  const starStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const wave = dotWave(1, clock.value);
    return {
      opacity: (1 - env) * (1 - (1 - wave.opacity) * env),
      transform: [
        { translateY: -wave.liftUnits * pxPerUnit * zoom * env },
        {
          scale: morphShrink(env, zoom) * (1 + (wave.scale - 1) * env),
        },
      ],
    };
  });

  const middleStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const wave = dotWave(1, clock.value);
    return {
      opacity: env * (1 - (1 - wave.opacity) * env),
      transform: [
        { translateY: -wave.liftUnits * pxPerUnit * zoom * env },
        {
          scale: middleDotScale(env, layout) * (1 + (wave.scale - 1) * env),
        },
      ],
    };
  });

  const leftStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const wave = dotWave(0, clock.value);
    const entrance = dotEntrance(0, env);
    return {
      opacity: wave.opacity * easeOutCubic(entrance),
      transform: [
        { translateX: -spreadPx * easeOutBack(entrance) },
        { translateY: -wave.liftUnits * pxPerUnit * zoom * env },
        { scale: sideDotScale(env, zoom) * wave.scale },
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
        { translateY: -wave.liftUnits * pxPerUnit * zoom * env },
        { scale: sideDotScale(env, zoom) * wave.scale },
      ],
    };
  });

  const viewport = useMemo(
    () => [styles.viewport, { width: size, height: size }],
    [size],
  );
  const dotBox = useMemo(
    () => ({
      height: dotPx,
      left: (size - dotPx) / 2,
      position: "absolute" as const,
      top: (size - dotPx) / 2,
      width: dotPx,
    }),
    [dotPx, size],
  );
  const sideDotBox = useMemo(
    () => ({
      height: sideDotPx,
      left: (size - sideDotPx) / 2,
      position: "absolute" as const,
      top: (size - sideDotPx) / 2,
      width: sideDotPx,
    }),
    [sideDotPx, size],
  );

  return (
    <View style={viewport} pointerEvents="none">
      <Animated.View style={[styles.stage, stageStyle]}>
        <Animated.View style={[sideDotBox, leftStyle]}>
          <MarkLayer
            d={STELLA_ORB_PATH}
            size={sideDotPx}
            gradientId={`${uid}-left`}
          />
        </Animated.View>
        <Animated.View style={[sideDotBox, rightStyle]}>
          <MarkLayer
            d={STELLA_ORB_PATH}
            size={sideDotPx}
            gradientId={`${uid}-right`}
          />
        </Animated.View>
        <Animated.View style={[styles.layer, starStyle]}>
          <MarkLayer
            d={STELLA_STAR_PATH}
            size={size}
            gradientId={`${uid}-star`}
          />
        </Animated.View>
        <Animated.View style={[dotBox, middleStyle]}>
          <MarkLayer
            d={STELLA_ORB_PATH}
            size={dotPx}
            gradientId={`${uid}-orb`}
          />
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
