import { describe, expect, test } from "bun:test";
import {
  HEARING_LEAN,
  RING_COUNT,
  RING_PERIOD_MS,
  RING_REACH,
  TALK_STRETCH,
  levelGain,
  talkPulse,
  voiceBodyMotion,
  voiceRingMotion,
  type VoiceCharacterPhase,
} from "../stella-mark/voice-motion";

const PHASES: VoiceCharacterPhase[] = [
  "connecting",
  "listening",
  "hearing",
  "talking",
  "error",
];

const sample = (phase: VoiceCharacterPhase, energy = 0.3) =>
  Array.from({ length: 60 }, (_, i) => voiceBodyMotion(phase, i * 50, energy));

const range = (values: number[]) => Math.max(...values) - Math.min(...values);

describe("voice character body motion", () => {
  test("every phase stays finite and within a sane envelope", () => {
    for (const phase of PHASES) {
      for (const frame of sample(phase)) {
        for (const value of Object.values(frame)) expect(Number.isFinite(value)).toBe(true);
        expect(frame.scaleX).toBeGreaterThan(0.85);
        expect(frame.scaleX).toBeLessThan(1.2);
        expect(frame.scaleY).toBeGreaterThan(0.85);
        expect(frame.scaleY).toBeLessThan(1.2);
        expect(frame.opacity).toBeGreaterThan(0.6);
        expect(frame.opacity).toBeLessThanOrEqual(1);
      }
    }
  });

  test("the phases are visibly different from one another", () => {
    // Connecting dims and stays upright; listening sways; hearing leans in and
    // holds; talking squashes and stretches; error droops and freezes.
    expect(range(sample("connecting").map((f) => f.opacity))).toBeGreaterThan(0.1);
    expect(range(sample("connecting").map((f) => f.rotationDeg))).toBe(0);

    expect(range(sample("listening").map((f) => f.rotationDeg))).toBeGreaterThan(4);
    expect(range(sample("listening").map((f) => f.scaleY))).toBeLessThan(0.03);

    const hearing = sample("hearing");
    expect(Math.min(...hearing.map((f) => f.scaleX))).toBeGreaterThan(1.02);
    expect(range(hearing.map((f) => f.scaleY))).toBeLessThan(0.02);
    expect(hearing.every((f) => f.rotationDeg < 0)).toBe(true);

    const talking = sample("talking");
    expect(range(talking.map((f) => f.scaleY))).toBeGreaterThan(TALK_STRETCH * 0.5);
    // Stretch and squash counter each other, like a body, not a zoom.
    const peak = talking.reduce((a, b) => (b.scaleY > a.scaleY ? b : a));
    expect(peak.scaleX).toBeLessThan(peak.scaleY);

    const error = sample("error");
    expect(range(error.map((f) => f.scaleY))).toBe(0);
    expect(error[0].rotationDeg).toBeLessThan(0);
  });

  test("live level scales hearing and talking amplitude but never removes it", () => {
    expect(levelGain(0)).toBeCloseTo(0.6);
    expect(levelGain(1)).toBeCloseTo(1);
    expect(levelGain(Number.NaN)).toBeCloseTo(0.6);
    const quiet = voiceBodyMotion("hearing", 0, 0);
    const loud = voiceBodyMotion("hearing", 0, 1);
    expect(loud.scaleX).toBeGreaterThan(quiet.scaleX);
    expect(quiet.scaleX - 1).toBeCloseTo(HEARING_LEAN * 0.6, 2);
    const quietTalk = range(sample("talking", 0).map((f) => f.scaleY));
    const loudTalk = range(sample("talking", 1).map((f) => f.scaleY));
    expect(loudTalk).toBeGreaterThan(quietTalk);
    expect(quietTalk).toBeGreaterThan(0.02);
  });

  test("the talk pulse is a bounded rhythm with pauses", () => {
    const pulses = Array.from({ length: 200 }, (_, i) => talkPulse(i * 20));
    expect(Math.max(...pulses)).toBeLessThanOrEqual(1);
    expect(Math.min(...pulses)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...pulses)).toBeGreaterThan(0.7);
    expect(Math.min(...pulses)).toBeLessThan(0.1);
  });
});

describe("voice character rings", () => {
  test("phases without rings render nothing", () => {
    expect(voiceRingMotion(0, "connecting", 500, 0.5).opacity).toBe(0);
    expect(voiceRingMotion(0, "error", 500, 0.5).opacity).toBe(0);
  });

  test("listening and talking rings expand outward and fade", () => {
    for (const phase of ["listening", "talking"] as const) {
      const period = RING_PERIOD_MS[phase];
      const early = voiceRingMotion(0, phase, period * 0.05, 0.5);
      const late = voiceRingMotion(0, phase, period * 0.9, 0.5);
      expect(early.scale).toBeLessThan(late.scale);
      expect(early.opacity).toBeGreaterThan(late.opacity);
      expect(late.scale).toBeLessThanOrEqual(RING_REACH);
    }
  });

  test("hearing rings converge inward toward the body", () => {
    const period = RING_PERIOD_MS.hearing;
    const early = voiceRingMotion(0, "hearing", period * 0.05, 0.5);
    const late = voiceRingMotion(0, "hearing", period * 0.9, 0.5);
    expect(early.scale).toBeGreaterThan(late.scale);
    expect(late.scale).toBeGreaterThanOrEqual(1);
  });

  test("rings are evenly staggered", () => {
    const period = RING_PERIOD_MS.listening;
    const scales = Array.from({ length: RING_COUNT }, (_, i) =>
      voiceRingMotion(i, "listening", 0, 0.5).scale,
    );
    const sorted = [...scales].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i] - sorted[i - 1]).toBeCloseTo(
        (RING_REACH - 1) / RING_COUNT,
        5,
      );
    }
    // One full period later every ring is back where it started.
    expect(voiceRingMotion(1, "listening", period, 0.5).scale).toBeCloseTo(
      scales[1],
      5,
    );
  });
});
