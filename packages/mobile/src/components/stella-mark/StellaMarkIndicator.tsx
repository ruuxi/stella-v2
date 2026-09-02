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
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { STELLA_ORB_PATH, STELLA_STAR_PATH } from "./geometry";
import {
  middleDotScale,
  morphShrink,
  sideDotScale,
  stellaMarkLayout,
} from "./layout";
import { MarkLayer } from "./MarkLayer";
import { StellaFace } from "./StellaFace";
import { shouldRunContinuousAnimation } from "../../lib/continuous-animation";
import { useAppVisible } from "../../lib/use-app-visible";
import type { WorkingIndicatorCharacterState } from "../working-indicator-character";
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
  orbitMarkMotion,
  toolCharacterMotion,
} from "./motion";

/**
 * Stella's working/thinking indicator: the character mark itself becomes the
 * middle dot of a three-dot thinking bounce, then unfolds back into the star
 * when the run settles.
 *
 * ACTIVE while `thinking`: the star cross-fades into its fully inflated profile
 * (the orb) while shrinking to dot size, two sibling dots spread out from
 * underneath it with a staggered ease-out-back, and all three ride one
 * travelling Gaussian: rise, pop and tone. Tool states run the desktop-matched
 * character poses instead: working and writing reshape and bob the body, while
 * searching and reading add orbiting marks around a smaller character. The
 * face follows the same state-specific expressions and blink cadence as the
 * desktop rig. The face stays hidden in thinking mode, matching desktop.
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

const ORBIT_MARK_COUNT = 4;
const ORBIT_RADIUS_X = 11.5;
const ORBIT_RADIUS_Y = 5.5;
const ORBIT_MARK_SIZE = 5;

function OrbitMark() {
  return (
    <Svg
      viewBox="-1.1 -1.1 2.2 2.2"
      width={ORBIT_MARK_SIZE}
      height={ORBIT_MARK_SIZE}
    >
      <Path
        d="M0 -1 C0.09 -0.31 0.31 -0.09 1 0 C0.31 0.09 0.09 0.31 0 1 C-0.09 0.31 -0.31 0.09 -1 0 C-0.31 -0.09 -0.09 -0.31 0 -1Z"
        fill="#4878db"
      />
    </Svg>
  );
}

function OrbitingMark({
  index,
  clock,
}: {
  index: number;
  clock: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const frame = orbitMarkMotion(index, clock.value);
    return {
      opacity: frame.opacity,
      transform: [
        { translateX: frame.translateX * ORBIT_RADIUS_X },
        { translateY: frame.translateY * ORBIT_RADIUS_Y },
        { rotate: `${frame.rotationDeg}deg` },
        { scale: frame.scale },
      ],
    };
  });
  return (
    <Animated.View style={[styles.orbitMark, style]}>
      <OrbitMark />
    </Animated.View>
  );
}

export function StellaMarkIndicator({
  active,
  size = DEFAULT_SIZE,
  state = "thinking",
  faceColor,
}: {
  /** True while a run is in flight — the mark runs the thinking bounce. */
  active: boolean;
  size?: number;
  state?: WorkingIndicatorCharacterState;
  /** The bubble fill, used to punch the character's eyes through the mark. */
  faceColor?: string;
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
    morphT.value = withTiming(active && state === "thinking" ? 1 : 0, {
      duration: MORPH_MS,
      easing: Easing.linear,
    });
    return () => cancelAnimation(morphT);
  }, [active, morphT, reduceMotion, state]);

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

  // The dots state carries its zoom in the pixel sizes `layout.ts` hands out,
  // so nothing is left resampled once the morph settles. Tool states animate
  // the body itself below and must not receive a second breathe here.
  const stageStyle = useAnimatedStyle(() => {
    if (state !== "thinking") {
      return { transform: [{ scale: 1 }] };
    }
    const env = envelope.value;
    const breathe =
      1 +
      BREATHE_AMPLITUDE *
        Math.sin((clock.value / BREATHE_MS) * 2 * Math.PI) *
        (1 - env);
    return { transform: [{ scale: breathe }] };
  });

  const toolState = state === "thinking" ? "working" : state;
  const bodyStyle = useAnimatedStyle(() => {
    if (state === "thinking" || reduceMotion) return {};
    const frame = toolCharacterMotion(toolState, clock.value);
    return {
      transform: [
        { translateX: frame.translateX },
        { translateY: frame.translateY },
        { rotate: `${frame.rotationDeg}deg` },
        { scaleX: frame.scaleX },
        { scaleY: frame.scaleY },
      ],
    };
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
        {!reduceMotion && (state === "searching" || state === "reading")
          ? Array.from({ length: ORBIT_MARK_COUNT }, (_, index) => (
              <OrbitingMark key={index} index={index} clock={clock} />
            ))
          : null}
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
        <Animated.View style={[styles.layer, starStyle, bodyStyle]}>
          <MarkLayer
            d={STELLA_STAR_PATH}
            size={size}
            gradientId={`${uid}-star`}
          />
          {faceColor && state !== "thinking" ? (
            <StellaFace
              size={size}
              color={faceColor}
              state={state}
              active={running && appVisible && !reduceMotion}
            />
          ) : null}
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
  layer: { ...StyleSheet.absoluteFill },
  orbitMark: {
    height: ORBIT_MARK_SIZE,
    left: "50%",
    marginLeft: -ORBIT_MARK_SIZE / 2,
    marginTop: -ORBIT_MARK_SIZE / 2,
    position: "absolute",
    top: "50%",
    width: ORBIT_MARK_SIZE,
  },
  stage: { ...StyleSheet.absoluteFill },
  viewport: { alignItems: "center", justifyContent: "center" },
});
