import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { fadeHex } from "../theme/oklch";
import { useColors } from "../theme/theme-context";

export type RealtimeVoiceVisualizerMode = "idle" | "listening" | "speaking";

type Props = {
  size: number;
  mode: RealtimeVoiceVisualizerMode;
  isUserSpeaking: boolean;
  micLevel: number;
  outputLevel: number;
};

const BAR_COUNT = 9;
const PHASE_STEPS = 16;
const PHASE_DURATION_MS = 1500;

const clampLevel = (value: number): number =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

const getTargetEnergy = ({
  mode,
  isUserSpeaking,
  micLevel,
  outputLevel,
}: Omit<Props, "size">): number => {
  const mic = clampLevel(micLevel);
  const output = clampLevel(outputLevel);
  if (mode === "speaking") return Math.max(0.28, output);
  if (isUserSpeaking) return Math.max(0.22, mic);
  if (mode === "listening") return Math.max(0.06, mic * 0.8);
  return 0;
};

const phaseInputRange = Array.from(
  { length: PHASE_STEPS + 1 },
  (_, index) => index / PHASE_STEPS,
);

const barPhaseOutputRange = (index: number): number[] => {
  const center = (BAR_COUNT - 1) / 2;
  const distanceFromCenter = Math.abs(index - center) / center;
  const shape = 1 - distanceFromCenter * 0.28;
  return phaseInputRange.map(
    (phase) =>
      shape *
      (0.54 + Math.abs(Math.sin(phase * Math.PI * 2 + index * 0.72)) * 0.7),
  );
};

/**
 * A native-view voice meter. One native-driver phase value animates every bar
 * and ring; audio snapshots only retarget one native-driver energy value.
 * Keeping this off Expo GL avoids a dedicated render loop and, critically,
 * leaves no GL context behind when the voice modal closes.
 */
export function RealtimeVoiceVisualizer({
  size,
  mode,
  isUserSpeaking,
  micLevel,
  outputLevel,
}: Props) {
  const colors = useColors();
  const reduceMotion = useReducedMotion();
  const phase = useRef(new Animated.Value(0)).current;
  const energy = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    phase.stopAnimation();
    if (reduceMotion) {
      phase.setValue(0.25);
      return;
    }
    phase.setValue(0);
    const animation = Animated.loop(
      Animated.timing(phase, {
        toValue: 1,
        duration: PHASE_DURATION_MS,
        easing: Easing.linear,
        isInteraction: false,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [phase, reduceMotion]);

  useEffect(() => {
    energy.stopAnimation();
    const animation = Animated.timing(energy, {
      toValue: getTargetEnergy({
        mode,
        isUserSpeaking,
        micLevel,
        outputLevel,
      }),
      duration: reduceMotion ? 0 : 90,
      easing: Easing.out(Easing.quad),
      isInteraction: false,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [energy, isUserSpeaking, micLevel, mode, outputLevel, reduceMotion]);

  const geometry = useMemo(() => {
    const backdropSize = size * 0.733;
    const outerRingSize = size * 0.633;
    const innerRingSize = size * 0.5;
    const barHeight = size * 0.115;
    const barWidth = Math.max(4, size * 0.025);
    return {
      root: { height: size, width: size },
      backdrop: {
        backgroundColor: fadeHex(colors.accent, 0.05),
        borderRadius: backdropSize / 2,
        height: backdropSize,
        width: backdropSize,
      },
      outerRing: {
        borderColor: colors.decorative,
        borderRadius: outerRingSize / 2,
        borderWidth: 1.5,
        height: outerRingSize,
        width: outerRingSize,
      },
      innerRing: {
        backgroundColor: fadeHex(colors.accent, 0.06),
        borderColor: colors.accent,
        borderRadius: innerRingSize / 2,
        borderWidth: 1.25,
        height: innerRingSize,
        width: innerRingSize,
      },
      barGroup: { gap: size * 0.025 },
      bar: {
        backgroundColor: colors.accent,
        borderRadius: barWidth / 2,
        height: barHeight,
        width: barWidth,
      },
    };
  }, [colors.accent, colors.decorative, size]);

  const outerRingMotion = useMemo(
    () => ({
      opacity: energy.interpolate({
        inputRange: [0, 1],
        outputRange: [0.08, 0.24],
      }),
      transform: [
        {
          scale: phase.interpolate({
            inputRange: [0, 0.5, 1],
            outputRange: [0.96, 1.07, 0.96],
          }),
        },
      ],
    }),
    [energy, phase],
  );
  const innerRingMotion = useMemo(
    () => ({
      opacity: energy.interpolate({
        inputRange: [0, 1],
        outputRange: [0.12, 0.34],
      }),
      transform: [
        {
          scale: phase.interpolate({
            inputRange: [0, 0.5, 1],
            outputRange: [1.04, 0.96, 1.04],
          }),
        },
      ],
    }),
    [energy, phase],
  );
  const barEnergyMotion = useMemo(
    () => ({
      opacity: energy.interpolate({
        inputRange: [0, 1],
        outputRange: [0.42, 0.96],
      }),
      transform: [
        {
          scaleY: energy.interpolate({
            inputRange: [0, 1],
            outputRange: [0.5, 2.3],
          }),
        },
      ],
    }),
    [energy],
  );
  const barMotions = useMemo(
    () =>
      Array.from({ length: BAR_COUNT }, (_, index) => ({
        transform: [
          {
            scaleY: phase.interpolate({
              inputRange: phaseInputRange,
              outputRange: barPhaseOutputRange(index),
            }),
          },
        ],
      })),
    [phase],
  );

  return (
    <View style={[styles.root, geometry.root]} pointerEvents="none">
      <View style={[styles.centered, geometry.backdrop]} />
      <Animated.View
        style={[styles.centered, geometry.outerRing, outerRingMotion]}
      />
      <Animated.View
        style={[styles.centered, geometry.innerRing, innerRingMotion]}
      />
      <Animated.View
        style={[styles.barGroup, geometry.barGroup, barEnergyMotion]}
      >
        {barMotions.map((motion, index) => (
          <Animated.View
            key={index}
            style={[geometry.bar, motion]}
          />
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    justifyContent: "center",
  },
  centered: {
    position: "absolute",
  },
  barGroup: {
    alignItems: "center",
    flexDirection: "row",
  },
});
