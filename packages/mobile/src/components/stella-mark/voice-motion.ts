/**
 * Motion math for the realtime voice character. Pure worklet arithmetic, like
 * `motion.ts`, so the rig evaluates it on the UI thread from one shared clock
 * and the tests evaluate it directly.
 *
 * The voice overlay used to show the silhouette breathing with a scale tied to
 * mic/output level. Those levels are coarse (the session publishes a fixed
 * floor while someone talks), so the mark barely moved and every phase looked
 * the same. Each phase now has its own read-at-a-glance behaviour:
 *
 * - connecting: a slow, dim breathe — the character is not awake yet.
 * - listening: an alert, upright breathe with a gentle head sway.
 * - hearing (the user is speaking): leans in and holds still — sound is
 *   arriving.
 * - talking (Stella is speaking): a syllabic squash-and-stretch with a bob and
 *   sway.
 * - error: droops and sits still.
 *
 * Real level, when it is above the floor, scales the amplitude of hearing and
 * talking so a loud moment still reads louder.
 */

import { BREATHE_AMPLITUDE, BREATHE_MS, clamp01 } from "./motion";

export type VoiceCharacterPhase =
  | "connecting"
  | "listening"
  | "hearing"
  | "talking"
  | "error";

export type VoiceBodyMotion = {
  translateX: number;
  translateY: number;
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
};

/** Syllable rhythm of the talking squash. */
export const TALK_SYLLABLE_MS = 260;
/** Slower phrase envelope layered over the syllables so speech has pauses. */
export const TALK_PHRASE_MS = 1900;
/** Peak vertical stretch while talking, in scale units. */
export const TALK_STRETCH = 0.075;
/** How far the body leans in while the user speaks, in scale units. */
export const HEARING_LEAN = 0.06;

const TAU = Math.PI * 2;

/** 0..1 syllable pulse: fast beats shaped by a slow phrase envelope. */
export function talkPulse(timeMs: number): number {
  "worklet";
  const syllable = 0.5 + 0.5 * Math.sin((timeMs / TALK_SYLLABLE_MS) * TAU);
  const phrase = 0.55 + 0.45 * Math.sin((timeMs / TALK_PHRASE_MS) * TAU);
  // A second, incommensurate beat keeps the mouth-less body from looking
  // metronomic.
  const jitter = 0.85 + 0.15 * Math.sin(timeMs * 0.0071);
  return clamp01(syllable * phrase * jitter);
}

/** Amplitude multiplier from live level: the floor keeps motion visible. */
export function levelGain(energy: number): number {
  "worklet";
  return 0.6 + 0.4 * clamp01(energy);
}

export function voiceBodyMotion(
  phase: VoiceCharacterPhase,
  timeMs: number,
  energy: number,
): VoiceBodyMotion {
  "worklet";
  // `levelGain` and `talkPulse` are inlined here rather than called: the iOS
  // worklet serializer has left same-file helper references undefined on the
  // UI thread (see the note in `toolCharacterMotion`), which takes the app down
  // the first time the rig mounts. The exported helpers remain the tested
  // reference for the same arithmetic.
  const clampedEnergy = !Number.isFinite(energy)
    ? 0
    : energy <= 0
      ? 0
      : energy >= 1
        ? 1
        : energy;
  const gain = 0.6 + 0.4 * clampedEnergy;
  const breathe = BREATHE_AMPLITUDE * Math.sin((timeMs / BREATHE_MS) * TAU);
  if (phase === "connecting") {
    const slow = 0.5 + 0.5 * Math.sin((timeMs / 2600) * TAU);
    return {
      translateX: 0,
      translateY: 0,
      rotationDeg: 0,
      scaleX: 0.97 + breathe,
      scaleY: 0.97 + breathe,
      opacity: 0.72 + 0.18 * slow,
    };
  }
  if (phase === "error") {
    return {
      translateX: 0,
      translateY: 0.01,
      rotationDeg: -5,
      scaleX: 0.94,
      scaleY: 0.92,
      opacity: 0.9,
    };
  }
  if (phase === "listening") {
    // Alert and upright: full breathe, a slow head sway so it is obviously
    // awake, no squash.
    const sway = Math.sin((timeMs / 2400) * TAU);
    return {
      translateX: sway * 0.012,
      translateY: -0.004 + breathe * 0.4,
      rotationDeg: sway * 3.2,
      scaleX: 1.02 + breathe,
      scaleY: 1.02 + breathe,
      opacity: 1,
    };
  }
  if (phase === "hearing") {
    // Leans in toward the speaker and holds very still, with a faint
    // level-driven tremor so it reads as receiving sound rather than frozen.
    const tremor = Math.sin((timeMs / 140) * TAU) * 0.008 * gain;
    const lean = 1 + HEARING_LEAN * gain;
    return {
      translateX: 0,
      translateY: -0.02 * gain,
      rotationDeg: -2.5 * gain,
      scaleX: lean - tremor,
      scaleY: lean + tremor,
      opacity: 1,
    };
  }
  // talking
  const syllable = 0.5 + 0.5 * Math.sin((timeMs / TALK_SYLLABLE_MS) * TAU);
  const phrase = 0.55 + 0.45 * Math.sin((timeMs / TALK_PHRASE_MS) * TAU);
  const jitter = 0.85 + 0.15 * Math.sin(timeMs * 0.0071);
  const rawPulse = syllable * phrase * jitter;
  const pulse = (rawPulse <= 0 ? 0 : rawPulse >= 1 ? 1 : rawPulse) * gain;
  const sway = Math.sin((timeMs / 900) * TAU);
  return {
    translateX: sway * 0.01,
    translateY: -pulse * 0.03,
    rotationDeg: sway * 2.2,
    scaleX: 1 + breathe - TALK_STRETCH * 0.6 * pulse,
    scaleY: 1 + breathe + TALK_STRETCH * pulse,
    opacity: 1,
  };
}
