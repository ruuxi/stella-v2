import type React from "react";
import type { AuroraVariant } from "./shader";

/**
 * Types for the .jsx implementation, following the same convention as
 * ui/brand-icon.d.ts. The component the aurora rebrand replaced was authored
 * in TypeScript, so its .tsx consumers (WorkingIndicator, FullShell) would
 * otherwise silently drop to `any` on every prop.
 */
export interface StellaAnimationHandle {
  triggerFlash: () => void;
  startBirth: () => void;
  reset: (value?: number) => void;
}

export type VoiceMode = "idle" | "listening" | "speaking";

export interface StellaAnimationProps {
  width?: number;
  height?: number;
  /** CSS footprint; backing resolution remains cell-derived for supersampling. */
  displayWidth?: number;
  displayHeight?: number;
  initialBirthProgress?: number;
  paused?: boolean;
  maxDpr?: number;
  frameSkip?: number;
  maxFps?: number;
  requireWindowFocus?: boolean;
  /** Multiplier on shader time; >1 speeds the curtains up. */
  timeScale?: number;
  variant?: AuroraVariant;
  voiceMode?: VoiceMode;
  isUserSpeaking?: boolean;
  analyserRef?: React.RefObject<AnalyserNode | null>;
  outputAnalyserRef?: React.RefObject<AnalyserNode | null>;
  micLevel?: number;
  outputLevel?: number;
  micLevelRef?: React.RefObject<number | undefined>;
  outputLevelRef?: React.RefObject<number | undefined>;
}

export declare const StellaAnimation: React.ForwardRefExoticComponent<
  StellaAnimationProps & React.RefAttributes<StellaAnimationHandle>
>;
