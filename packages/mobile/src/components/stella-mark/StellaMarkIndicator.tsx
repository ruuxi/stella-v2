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
import {
  STELLA_MARK_CENTER,
  STELLA_ORB_PATH,
  STELLA_STAR_PATH,
} from "./geometry";
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
 * tool label during tool work, matching the desktop rule. No face: at 34px the
 * eyes would be sub-pixel, and the desktop rig hides them in dots mode anyway.
 *
 * OTA-SAFE. This replaces the previous `WorkingStarSkia`, whose SkSL shader ran
 * through `@shopify/react-native-skia` — native code, so any change to it could
 * only ship in a fresh store build. Everything here is `react-native-svg` +
 * `react-native-reanimated`, both already in the bundle, so the indicator can
 * be changed over the air.
 *
 * PERFORMANCE. Two shared values drive everything: `clock` (a linear
 * millisecond ramp) and `morphT` (a linear 0..1 ramp whose critically damped
 * shape is applied in the worklet — see `motion.ts`). Every transform and
 * opacity is computed inside `useAnimatedStyle` worklets on the UI thread, on
 * plain `Animated.View`s, so no per-frame JS runs and React never re-renders
 * while the indicator animates. Both animations are cancelled — and the clock
 * parked — when the indicator unmounts or reduced motion is on, so no work
 * lingers.
 *
 * The geometry (`geometry.ts`) is baked from the same source as the desktop
 * rig, and its viewBox is centred on the mark's own centre, so a View-level
 * transform is exactly a shape-centre transform.
 */

const DEFAULT_SIZE = 34;
/** Scale that takes the full-size mark down to a thinking dot. */
const DOT_SCALE = DOT_RADIUS_UNITS / STELLA_MARK_CENTER;
/** Three dots at 34px are tiny; the desktop rig zooms the group under 44px. */
const SMALL_SIZE_THRESHOLD = 44;
const DOTS_ZOOM = 1.5;

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
  // Gradient ids are per-instance: two indicators sharing an id make the second
  // resolve against the first one's gradient (see StellaMark.tsx).
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");

  const pxPerUnit = size / VIEWBOX_SPAN;
  const spreadPx = DOT_SPREAD_UNITS * pxPerUnit;
  const zoom = size < SMALL_SIZE_THRESHOLD ? DOTS_ZOOM : 1;

  /** Linear millisecond ramp; every periodic term derives from it. */
  const clock = useSharedValue(0);
  /** Linear 0..1 morph ramp — the spring shape is applied in the worklets. */
  const morphT = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(clock);
    if (reduceMotion) {
      // Park static: the resting star, no breathe, no bounce.
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

  /** Critically damped 0..1 morph envelope, shared by every layer below. */
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

  // Middle slot (index 1): the character itself. It shrinks from full size to a
  // dot while the star cross-fades into the orb, then joins the bounce.
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
