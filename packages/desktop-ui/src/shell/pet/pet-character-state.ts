import type { PetOverlayState } from "@stella/contracts/desktop/pet";
import type { StellaCharacterState } from "@/ui/stella-character/rig";

export type PetVoiceMode = "idle" | "listening" | "speaking";

export type PetCharacterInput = {
  state: PetOverlayState;
  voiceMode?: PetVoiceMode;
  dragging?: boolean;
  hover?: boolean;
};

const BASE_STATE: Record<PetOverlayState, StellaCharacterState> = {
  idle: "idle",
  running: "working",
  waiting: "listening",
  review: "happy",
  failed: "confused",
  waving: "happy",
};

export function getPetCharacterState({
  state,
  voiceMode = "idle",
  dragging = false,
  hover = false,
}: PetCharacterInput): StellaCharacterState {
  if (dragging) return "happy";
  if (voiceMode === "speaking") return "speaking";
  if (voiceMode === "listening") return "listening";
  const base = BASE_STATE[state] ?? "idle";
  if (hover && base === "idle") return "happy";
  return base;
}
