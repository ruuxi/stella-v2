import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { STELLA_MARK_CENTER, STELLA_MARK_VIEWBOX } from "./geometry";
import {
  BLINK_EVERY_MS,
  BLINK_MS,
  EYE_POSES,
  FACE,
  IDLE_POSES,
  POSE_EVERY_MS,
  POSE_TRANSITION_MS,
  type EyePoseName,
  eyePath,
  randomBetween,
} from "./face";

/**
 * The character's eyes, laid over the mark's silhouette.
 *
 * Three independent idle behaviours, each on its own random schedule: the pose
 * changes, the eyes blink, and the gaze drifts. Only the pose change rebuilds
 * the eye path, and only while its 190ms transition runs — blinking rides the
 * same path as a height scale, and the gaze as a centre offset, so a face that
 * is merely sitting there costs no per-frame path work at all.
 *
 * All three are gated on `active`, which the caller ties to app visibility and
 * reduced motion. The socket layout below is the desktop rig's, factor for
 * factor, against the same baked face box.
 */

const AnimatedPath = Animated.createAnimatedComponent(Path);

const C = STELLA_MARK_CENTER;
const SOCKET_X = C + FACE.dx;
const SOCKET_Y = C + FACE.dy - FACE.ry * 0.05;
const HALF_GAP = FACE.rx * 0.42;
const EYE_W = FACE.rx * 0.78;
const EYE_H = FACE.ry * 0.62;

/** Floor on the blink's height scale: a zero-height ring is a degenerate path. */
const BLINK_FLOOR = 0.04;

const GAZE_EVERY_MS: [number, number] = [1600, 3400];
const GAZE_MS = 620;
const GAZE_X = C * 0.085;
const GAZE_Y = C * 0.06;

export function StellaFace({
  size,
  color,
  active = true,
}: {
  size: number;
  color: string;
  active?: boolean;
}) {
  const [poses, setPoses] = useState<{ from: EyePoseName; to: EyePoseName }>({
    from: "neutral",
    to: "neutral",
  });
  const poseIndexRef = useRef(0);

  const mix = useSharedValue(1);
  const blink = useSharedValue(1);
  const gazeX = useSharedValue(0);
  const gazeY = useSharedValue(0);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        const pool = IDLE_POSES;
        // Step by at least one so the same pose is never picked twice running.
        poseIndexRef.current =
          (poseIndexRef.current +
            1 +
            Math.floor(Math.random() * (pool.length - 1))) %
          pool.length;
        setPoses((prev) => ({ from: prev.to, to: pool[poseIndexRef.current] }));
        mix.value = 0;
        mix.value = withTiming(1, {
          duration: POSE_TRANSITION_MS,
          easing: Easing.inOut(Easing.cubic),
        });
        schedule();
      }, randomBetween(POSE_EVERY_MS[0], POSE_EVERY_MS[1]));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [active, mix]);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        blink.value = withTiming(BLINK_FLOOR, { duration: BLINK_MS }, () => {
          blink.value = withTiming(1, { duration: BLINK_MS + 40 });
        });
        schedule();
      }, randomBetween(BLINK_EVERY_MS[0], BLINK_EVERY_MS[1]));
    };
    schedule();
    return () => {
      clearTimeout(timer);
      cancelAnimation(blink);
    };
  }, [active, blink]);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        const reach = Math.random();
        const angle = Math.random() * Math.PI * 2;
        gazeX.value = withTiming(Math.cos(angle) * reach * GAZE_X, {
          duration: GAZE_MS,
          easing: Easing.out(Easing.cubic),
        });
        gazeY.value = withTiming(Math.sin(angle) * reach * GAZE_Y, {
          duration: GAZE_MS,
          easing: Easing.out(Easing.cubic),
        });
        schedule();
      }, randomBetween(GAZE_EVERY_MS[0], GAZE_EVERY_MS[1]));
    };
    schedule();
    return () => {
      clearTimeout(timer);
      cancelAnimation(gazeX);
      cancelAnimation(gazeY);
    };
  }, [active, gazeX, gazeY]);

  const from = EYE_POSES[poses.from];
  const to = EYE_POSES[poses.to];

  const leftProps = useAnimatedProps(() => ({
    d: eyePath(
      from,
      to,
      mix.value,
      SOCKET_X - HALF_GAP + gazeX.value,
      SOCKET_Y + gazeY.value,
      EYE_W,
      EYE_H * Math.max(blink.value, BLINK_FLOOR),
    ),
  }));
  const rightProps = useAnimatedProps(() => ({
    d: eyePath(
      from,
      to,
      mix.value,
      SOCKET_X + HALF_GAP + gazeX.value,
      SOCKET_Y + gazeY.value,
      EYE_W,
      EYE_H * Math.max(blink.value, BLINK_FLOOR),
    ),
  }));

  const style = useMemo(
    () => [StyleSheet.absoluteFill, { width: size, height: size }],
    [size],
  );

  return (
    <Svg
      pointerEvents="none"
      width={size}
      height={size}
      viewBox={STELLA_MARK_VIEWBOX}
      style={style}
    >
      <AnimatedPath animatedProps={leftProps} fill={color} />
      <AnimatedPath animatedProps={rightProps} fill={color} />
    </Svg>
  );
}
