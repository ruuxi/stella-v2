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

/**
 * Stella's working/thinking indicator: the character mark itself becomes the
 * middle dot of a three-dot thinking bounce, then unfolds back into the star
 * when the run settles.
 *
 * ACTIVE in `dots` mode: the star cross-fades into its fully inflated profile
 * (the orb) while shrinking to dot size, two sibling dots spread out from
 * underneath it with a staggered ease-out-back, and all three ride one
 * travelling Gaussian: rise, pop and tone. ACTIVE in `star` mode, and whenever
 * INACTIVE: the same morph runs backward to the resting star, which then holds
 * a slow ±1.3% breathe. `star` mode exists because the label carries the
 * meaning once there is one — bare dots while thinking, resting star plus the
 * tool label during tool work, matching the desktop rule. No face: at indicator
 * size the eyes would be sub-pixel, and the desktop rig hides them in dots mode
 * anyway.
 *
 * OTA-SAFE. Everything here is `react-native-svg` + `react-native-reanimated`,
 * both already in the bundle, so the indicator can be changed over the air —
 * unlike the SkSL shader it replaced, whose native dependency could only ship
 * in a fresh store build.
 *
 * PERFORMANCE. Two shared values drive everything: `clock` (a linear
 * millisecond ramp) and `morphT` (a linear 0..1 ramp whose critically damped
 * shape is applied in the worklet — see `motion.ts`). Every transform and
 * opacity is computed inside `useAnimatedStyle` worklets on the UI thread, on
 * plain `Animated.View`s, so no per-frame JS runs and React never re-renders
 * while the indicator animates. The clock is suspended outright while the app
 * is backgrounded or reduced motion is on, so a phone in a pocket with a run
 * still going animates nothing.
 *
 * The geometry (`geometry.ts`) is baked from the same source as the desktop
 * rig, and its viewBox is centred on the mark's own centre, so a View-level
 * transform is exactly a shape-centre transform.
 */

const DEFAULT_SIZE = 34;

/** The morph has to finish before the clock stops, or the mark would freeze
 *  mid-transition when the work ends. */
const STOP_GRACE_MS = 400;

export type StellaMarkMode = "dots" | "star";

export function StellaMarkIndicator({
  active,
  size = DEFAULT_SIZE,
  mode = "dots",
}: {
  /** True while a run is in flight — the mark runs the thinking bounce. */
  active: boolean;
  size?: number;
  /** `star` holds the resting mark while a label carries the meaning. */
  mode?: StellaMarkMode;
}) {
  const reduceMotion = useReducedMotion();
  const appVisible = useAppVisible();
  // Gradient ids are per-instance: two indicators sharing an id make the second
  // resolve against the first one's gradient (see StellaMark.tsx).
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");

  const layout = useMemo(() => stellaMarkLayout(size), [size]);
  const { dotPx, sideDotPx, pxPerUnit, spreadPx, zoom } = layout;

  /** Linear millisecond ramp; every periodic term derives from it. */
  const clock = useSharedValue(0);
  /** Linear 0..1 morph ramp — the spring shape is applied in the worklets. */
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
      // Park static: the resting star, no breathe, no bounce.
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
      // Reduced motion never leaves the resting star — the dots are the motion.
      morphT.value = 0;
      return;
    }
    morphT.value = withTiming(active && mode === "dots" ? 1 : 0, {
      duration: MORPH_MS,
      easing: Easing.linear,
    });
    return () => cancelAnimation(morphT);
  }, [active, mode, morphT, reduceMotion]);

  // The desktop rig suspends on window blur; this is its counterpart.
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

  /** Critically damped 0..1 morph envelope, shared by every layer below. */
  const envelope = useDerivedValue(() => morphEnvelope(morphT.value));

  // The stage only breathes. The dots state carries its zoom in the pixel sizes
  // `layout.ts` hands out, so nothing is left resampled once the morph settles.
  const stageStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const breathe =
      1 +
      BREATHE_AMPLITUDE *
        Math.sin((clock.value / BREATHE_MS) * 2 * Math.PI) *
        (1 - env);
    return { transform: [{ scale: breathe }] };
  });

  // The character, full size. It shrinks toward the middle dot's box and hands
  // over to it, so the two are one shape crossing the morph rather than two.
  const starStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const wave = dotWave(1, clock.value);
    return {
      opacity: (1 - env) * (1 - (1 - wave.opacity) * env),
      transform: [
        { translateY: -wave.liftUnits * pxPerUnit * zoom * env },
        { scale: morphShrink(env, zoom) * (1 + (wave.scale - 1) * env) },
      ],
    };
  });

  // Middle slot (index 1): the orb the character becomes, drawn at dot size.
  const middleStyle = useAnimatedStyle(() => {
    const env = envelope.value;
    const wave = dotWave(1, clock.value);
    return {
      opacity: env * (1 - (1 - wave.opacity) * env),
      transform: [
        { translateY: -wave.liftUnits * pxPerUnit * zoom * env },
        { scale: middleDotScale(env, layout) * (1 + (wave.scale - 1) * env) },
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
