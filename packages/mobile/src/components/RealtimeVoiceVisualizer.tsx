import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import {
  Easing,
  cancelAnimation,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { StellaMarkHero } from "./stella-mark/StellaMarkHero";
import { clamp01 } from "./stella-mark/motion";

export type RealtimeVoiceVisualizerMode = "idle" | "listening" | "speaking";

type Props = {
  size: number;
  mode: RealtimeVoiceVisualizerMode;
  isUserSpeaking: boolean;
  micLevel: number;
  outputLevel: number;
};

/** How fast the mark chases a new audio level. */
const ENERGY_RAMP_MS = 90;

/**
 * One 0..1 level for the character to pulse on, from whichever side of the
 * conversation currently holds the floor. Each branch keeps a floor so a quiet
 * talker still reads as present rather than as silence.
 */
export const realtimeVoiceEnergy = ({
  mode,
  isUserSpeaking,
  micLevel,
  outputLevel,
}: Omit<Props, "size">): number => {
  const mic = clamp01(micLevel);
  const output = clamp01(outputLevel);
  if (mode === "speaking") return Math.max(0.28, output);
  if (isUserSpeaking) return Math.max(0.22, mic);
  if (mode === "listening") return Math.max(0.06, mic * 0.8);
  return 0;
};

/**
 * The voice overlay's meter: the character mark itself, breathing at rest and
 * pulsing with live level while anyone is talking.
 *
 * Audio snapshots retarget one shared value, which the hero rig reads on the
 * UI thread, so a busy call never re-renders React at frame rate and no GL
 * context is left behind when the modal closes.
 */
export function RealtimeVoiceVisualizer({
  size,
  mode,
  isUserSpeaking,
  micLevel,
  outputLevel,
}: Props) {
  const reduceMotion = useReducedMotion();
  const energy = useSharedValue(0);

  useEffect(() => {
    const target = realtimeVoiceEnergy({
      mode,
      isUserSpeaking,
      micLevel,
      outputLevel,
    });
    cancelAnimation(energy);
    if (reduceMotion) {
      energy.value = 0;
      return;
    }
    energy.value = withTiming(target, {
      duration: ENERGY_RAMP_MS,
      easing: Easing.out(Easing.quad),
    });
    return () => cancelAnimation(energy);
  }, [energy, isUserSpeaking, micLevel, mode, outputLevel, reduceMotion]);

  return (
    <View
      style={[styles.root, { height: size, width: size }]}
      pointerEvents="none"
    >
      <StellaMarkHero size={size * 0.62} energy={energy} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    justifyContent: "center",
  },
});
