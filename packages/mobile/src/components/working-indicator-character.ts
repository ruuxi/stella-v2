/**
 * The character states shared by the mobile working indicator and its mark.
 * This is the native counterpart of desktop's working-indicator state map.
 */
export type WorkingIndicatorCharacterState =
  | "thinking"
  | "working"
  | "writing"
  | "searching"
  | "reading";

export type WorkingIndicatorToolPose = Exclude<
  WorkingIndicatorCharacterState,
  "thinking"
>;

/** Every pose the mark can hold while a tool runs. */
export const WORKING_INDICATOR_TOOL_POSES: readonly WorkingIndicatorToolPose[] =
  ["working", "writing", "searching", "reading"];

/** How long one pose holds on a single long tool call before another is dealt. */
export const WORKING_INDICATOR_POSE_ROTATE_MS = 6000;

const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/**
 * A pose for a running tool, dealt from the whole set rather than read off
 * the tool's name (the desktop's rule): the same seed always lands on the
 * same pose so the mark holds still for one rotation window, and the next
 * window never repeats the pose it just left.
 */
export function pickWorkingIndicatorToolPose(
  seed: string,
  avoid?: WorkingIndicatorCharacterState,
): WorkingIndicatorToolPose {
  const poses = WORKING_INDICATOR_TOOL_POSES;
  let index = hashSeed(seed) % poses.length;
  if (poses[index] === avoid) index = (index + 1) % poses.length;
  return poses[index]!;
}

/**
 * Match the desktop character pose to the tool currently doing the work.
 * With a `seed`, a running tool's pose is dealt from the whole repertoire
 * instead, so a turn full of `code` calls still moves through every pose.
 */
export function getWorkingIndicatorCharacterState(
  toolName?: string,
  seed?: string,
  avoid?: WorkingIndicatorCharacterState,
): WorkingIndicatorCharacterState {
  const tool = toolName?.trim().toLowerCase() ?? "";
  if (!tool) return "thinking";
  if (seed !== undefined) return pickWorkingIndicatorToolPose(seed, avoid);
  if (/search|web/.test(tool)) return "searching";
  if (/read|fetch/.test(tool)) return "reading";
  if (/write|edit/.test(tool)) return "writing";
  return "working";
}
