import { useEffect, useId } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  RadialGradient,
  Stop,
} from "react-native-svg";

/**
 * Stella's branded working/thinking indicator: the six-ray aurora brand star
 * spinning in place around its vertical (Y) axis — a pseudo-3D "coin spin". The
 * star foreshortens horizontally to a thin edge at 90°/270° and opens back to
 * full width, with a subtle lighting dip near edge-on to sell depth. This is
 * NOT a flat rotateZ wheel spin.
 *
 * Provenance:
 *  - The silhouette is baked from the former WebGL indicator's six-ray
 *    `starArm` geometry (parent of commit 5630329b7), cross-checked against the
 *    app icon's central star. It is the exact path from the approved preview
 *    (`~/.stella/outputs/stella-working-star-preview.html`).
 *  - `starTurn()` is a direct port of the old star-spin fragment shader's
 *    staged 3.2s cycle: drift → wind-up → whip → sprung landing.
 *
 * OTA-safe: uses only already-bundled `react-native-svg` +
 * `react-native-reanimated`, no native modules. The whole animation is one
 * shared value driving a single worklet-computed transform on the UI thread —
 * no per-frame JS. It is cancelled and the shared value parked whenever the
 * indicator is hidden or reduced-motion is on, so nothing lingers.
 */

const STAR_CYCLE_MS = 3200;
const DEFAULT_SIZE = 34;

// Six-ray Stella brand star silhouette, viewBox 0 0 100 100. Identical to the
// approved preview's baked path.
const STAR_PATH =
  "M50 8 L49.68 12.93 L49.39 15.14 L48.66 19.35 L47.69 23.64 L46.51 27.96 L45.01 32.61 L43.33 37.2 L41.47 41.76 L37.04 42.37 L32.26 42.65 L28.42 42.57 L25.56 42.29 L23.96 42.04 L23.45 42.14 L26.19 43.4 L29.44 45.25 L32.6 47.4 L35.9 50 L32.6 52.6 L29.44 54.75 L26.19 56.6 L23.45 57.86 L23.96 57.96 L26.7 57.57 L29.13 57.39 L33.05 57.37 L35.58 57.5 L38.27 57.76 L41.62 58.24 L42.57 58.4 L42.63 58.48 L44.28 62.84 L45.73 67.12 L47 71.37 L48.01 75.34 L48.74 78.8 L49.43 82.9 L49.69 85.07 L50 89.9 L50.31 85.07 L50.57 82.9 L51.26 78.8 L51.99 75.34 L53.13 70.93 L54.36 66.84 L55.89 62.36 L57.43 58.4 L62.52 57.68 L67.33 57.36 L71.58 57.43 L74.44 57.71 L76.04 57.96 L76.55 57.86 L73.81 56.6 L70.56 54.75 L67.4 52.6 L64.1 50 L67.4 47.4 L70.56 45.25 L73.81 43.4 L76.55 42.14 L76.04 42.04 L74.44 42.29 L71.58 42.57 L67.74 42.65 L62.96 42.37 L58.53 41.76 L56.67 37.2 L54.99 32.61 L53.49 27.96 L52.31 23.64 L51.34 19.35 L50.61 15.14 L50.32 12.93 Z";

/**
 * Direct port of `starTurn()` from the old star-spin fragment shader. Maps
 * cycle progress (0..1) to fractional turn (0..1); multiplied by 360 it becomes
 * the vertical-axis rotation. The four staged beats — a settling drift, a short
 * backward wind-up, the whip, and a sprung landing that overshoots and settles
 * — are what give the turn its staged feel rather than a constant spin.
 */
function starTurn(progress: number): number {
  "worklet";
  if (progress >= 1) return 1;
  const driftEnd = 0.5;
  const windEnd = 0.57;
  const whipEnd = 0.88;
  const driftTurn = 0.125;
  const windTurn = 0.114;
  const knee = 0.28;
  const tail = 0.34;
  const peakRate = 2 / (knee + (1 - knee) * (1 + tail));
  const exitRate = peakRate * tail;

  if (progress < driftEnd) {
    const w = progress / driftEnd;
    return driftTurn * w * w * (3 - 2 * w);
  }
  if (progress < windEnd) {
    const w = (progress - driftEnd) / (windEnd - driftEnd);
    return driftTurn + (windTurn - driftTurn) * (1 - (1 - w) * (1 - w));
  }
  if (progress < whipEnd) {
    const w = (progress - windEnd) / (whipEnd - windEnd);
    const eased =
      w < knee
        ? (peakRate * w * w) / (2 * knee)
        : peakRate * knee * 0.5 +
          peakRate * (w - knee) -
          (peakRate * (1 - tail) * (w - knee) * (w - knee)) / (2 * (1 - knee));
    return windTurn + (1 - windTurn) * eased;
  }
  const w = (progress - whipEnd) / (1 - whipEnd);
  const handoff = (((1 - windTurn) * exitRate) / (whipEnd - windEnd)) * (1 - whipEnd);
  return 1 + (handoff / 6.5) * Math.exp(-2 * w) * Math.sin(6.5 * w);
}

export function WorkingStar({
  active,
  size = DEFAULT_SIZE,
}: {
  /** When true, the star spins. When false, it parks front-on and idle. */
  active: boolean;
  size?: number;
}) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const uid = useId().replace(/:/g, "");
  const fillId = `ws-fill-${uid}`;
  const glowId = `ws-glow-${uid}`;
  const coreId = `ws-core-${uid}`;

  useEffect(() => {
    cancelAnimation(progress);
    if (!active || reduceMotion) {
      // Park front-on (full width). Reduced motion falls back to this gentle
      // static pose rather than any spinning.
      progress.value = 0;
      return;
    }
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: STAR_CYCLE_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [active, reduceMotion, progress]);

  // Perspective scaled to the star's size keeps the foreshortening consistent
  // regardless of render size (matches the preview's inline ratio).
  const perspective = size * 6;

  const animatedStyle = useAnimatedStyle(() => {
    const turn = starTurn(progress.value);
    const angle = turn * 360;
    // Subtle lighting dip as the face passes edge-on (90°/270°), the port of
    // the preview's brightness/saturate falloff. Peaks twice per turn.
    const edge = Math.abs(Math.sin(turn * Math.PI * 2));
    return {
      opacity: 1 - edge * 0.12,
      transform: [{ perspective }, { rotateY: `${angle}deg` }],
    };
  });

  return (
    <View style={[styles.viewport, { width: size, height: size }]}>
      <Animated.View style={animatedStyle} collapsable={false}>
        <Svg width={size} height={size} viewBox="0 0 100 100">
          <Defs>
            <LinearGradient
              id={fillId}
              x1={50}
              y1={90}
              x2={50}
              y2={8}
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset={0} stopColor="#00aad8" />
              <Stop offset={0.25} stopColor="#3493d9" />
              <Stop offset={0.5} stopColor="#4878db" />
              <Stop offset={0.75} stopColor="#7449c5" />
              <Stop offset={1} stopColor="#be57a4" />
            </LinearGradient>
            <RadialGradient
              id={glowId}
              cx={50}
              cy={50}
              r={46}
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset={0} stopColor="#4878db" stopOpacity={0.24} />
              <Stop offset={0.55} stopColor="#00aad8" stopOpacity={0.1} />
              <Stop offset={1} stopColor="#00aad8" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient
              id={coreId}
              cx={50}
              cy={50}
              r={45}
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset={0} stopColor="#ffffff" stopOpacity={0.24} />
              <Stop offset={0.32} stopColor="#ffffff" stopOpacity={0.08} />
              <Stop offset={1} stopColor="#ffffff" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={50} cy={50} r={46} fill={`url(#${glowId})`} />
          <Path d={STAR_PATH} fill={`url(#${fillId})`} opacity={0.96} />
          <Path d={STAR_PATH} fill={`url(#${coreId})`} />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    alignItems: "center",
    justifyContent: "center",
  },
});
