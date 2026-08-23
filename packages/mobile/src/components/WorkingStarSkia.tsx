import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import {
  Canvas,
  Fill,
  Shader,
  Skia,
} from "@shopify/react-native-skia";
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  STAR_CYCLE_SECONDS,
  STAR_REST_TIME,
  WORKING_STAR_SKSL,
} from "./working-star-shader";

/**
 * Stella's branded working/thinking indicator, rendered as a real
 * `react-native-skia` fragment shader (SkSL). It is a direct port of the desktop
 * WebGL "star-spin" indicator, so unlike the previous SVG `WorkingStar` it
 * carries the desktop shader's own glow, aurora bloom and pseudo-3D
 * vertical-axis turn rather than a flat silhouette on a static gradient. The
 * geometry, gradient stops and 3.2 s drift -> wind-up -> whip -> spring cadence
 * still match the approved preview.
 *
 * NATIVE MODULE: `@shopify/react-native-skia` is native code. Adding it changes
 * the runtime fingerprint, so this ships only in a fresh App Store / Google Play
 * build — it cannot be delivered over the air.
 *
 * The whole animation is one Reanimated shared value (`clock`, in seconds)
 * feeding the shader's `uTime` on the UI thread — no per-frame JS. The clock is
 * cancelled and parked at the resting pose whenever the indicator is inactive,
 * reduced-motion is on, or the component unmounts, so no GPU work lingers (the
 * reason for leaving expo-gl).
 */

const DEFAULT_SIZE = 34;

/**
 * The clock climbs monotonically so the shader's own `fract(t / cycle)` keeps
 * the turn periodic; wrapping on an exact multiple of the cycle makes the reset
 * seamless for the staged turn. At 1000 cycles the noise field's slow drift only
 * resets roughly every 53 minutes, far outside any visible session.
 */
const LOOP_CYCLES = 1000;
const LOOP_SECONDS = LOOP_CYCLES * STAR_CYCLE_SECONDS;

const effect = Skia.RuntimeEffect.Make(WORKING_STAR_SKSL);
if (!effect) {
  // Compilation is deterministic, so a failure here is a shader-source bug we
  // want surfaced loudly rather than silently swallowed into a blank canvas.
  console.error("[WorkingStarSkia] failed to compile star-spin SkSL");
}

export function WorkingStarSkia({
  active,
  size = DEFAULT_SIZE,
}: {
  /** When true, the star runs the staged turn. When false, it parks idle. */
  active: boolean;
  size?: number;
}) {
  const reduceMotion = useReducedMotion();
  const clock = useSharedValue(STAR_REST_TIME);

  useEffect(() => {
    cancelAnimation(clock);
    if (!active || reduceMotion || !effect) {
      // Reduced motion / idle both fall back to the static resting pose rather
      // than any spinning.
      clock.value = STAR_REST_TIME;
      return;
    }
    clock.value = 0;
    clock.value = withRepeat(
      withTiming(LOOP_SECONDS, {
        duration: LOOP_SECONDS * 1000,
        easing: Easing.linear,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(clock);
  }, [active, reduceMotion, clock]);

  const uniforms = useDerivedValue(
    () => ({
      uTime: clock.value,
      uResolution: [size, size] as [number, number],
    }),
    [size],
  );

  const viewport = [styles.viewport, { width: size, height: size }];
  if (!effect) {
    // Extremely unlikely (see console.error above); keep the layout slot stable.
    return <View style={viewport} />;
  }

  return (
    <View style={viewport}>
      <Canvas style={{ width: size, height: size }}>
        <Fill>
          <Shader source={effect} uniforms={uniforms} />
        </Fill>
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    alignItems: "center",
    justifyContent: "center",
  },
});
