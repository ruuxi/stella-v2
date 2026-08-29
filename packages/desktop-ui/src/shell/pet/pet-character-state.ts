import type { PetOverlayState } from "@stella/contracts/desktop/pet";
import type { StellaCharacterState } from "@/ui/stella-character/rig";

export type PetVoiceMode = "idle" | "listening" | "speaking";

export type PetCharacterInput = {
  state: PetOverlayState;
  voiceMode?: PetVoiceMode;
  dragging?: boolean;
  hover?: boolean;
};

/**
 * The mood the chat surface broadcasts, expressed as a pose the mark can
 * hold. This is the only thing the overlay needs to know about the
 * orchestrator, so the mapping stays small and explicit rather than reaching
 * into chat internals.
 */
const BASE_STATE: Record<PetOverlayState, StellaCharacterState> = {
  idle: "idle",
  running: "working",
  waiting: "listening",
  review: "happy",
  failed: "confused",
  waving: "happy",
};

/**
 * Resolve the overlay's pose, highest-priority input first:
 *
 *  1. Drag — the user is physically moving the mark, so it reacts to them.
 *  2. Voice — with realtime voice active the overlay stands in for the
 *     removed voice creature, so listening/speaking outrank the agent mood.
 *  3. Hover — only on an otherwise-idle agent, so a greeting never papers
 *     over a run that is working, waiting, or failed.
 *  4. Otherwise the agent-driven mood.
 */
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
