/**
 * The top-bar activity indicator, as behaviour rather than pixels.
 *
 * Mobile grew this first: Stella's mark sits in the top bar, and while
 * background work runs the mark glides aside and a label reads the work out —
 * the single running agent's own description, or a count once several are
 * going. Desktop now shows the same thing in its own top bar, so the parts
 * that decide WHAT is shown and WHEN it moves live here instead of being
 * written twice. Each platform keeps only its own rendering: Reanimated and
 * `GlassSurface` on mobile, `motion/react` and the DOM on desktop.
 *
 * Nothing here imports React or a renderer, so the module is safe for any
 * consumer of `@stella/contracts`.
 */

/** One in-progress agent, as the indicator and its menu see it. */
export type ActivityIndicatorEntry = {
  id: string;
  /** The agent's own description — never live tool narration. */
  title: string;
};

/**
 * How many rows the indicator's menu lists before it stops.
 *
 * Carried over from the activity panel the desktop top bar replaced, whose
 * overview capped its agent list at the same number. Both platforms use it so
 * the menu is the same list everywhere.
 */
export const ACTIVITY_INDICATOR_MENU_MAX_ROWS = 9;

/**
 * `spawn` plays the thinking bounce for a newly started agent before the mark
 * settles into a work pose; `working` is that settled state; `idle` is the
 * resting mark with nothing to say.
 */
export type ActivityIndicatorPhase = "idle" | "spawn" | "working";

/** How long the spawn beat plays before the mark settles into a work pose. */
export const ACTIVITY_INDICATOR_SPAWN_BEAT_MS = 1100;

/** Label cross-fade. The delay lets the mark finish moving aside first. */
export const ACTIVITY_INDICATOR_LABEL_IN_MS = 260;
export const ACTIVITY_INDICATOR_LABEL_IN_DELAY_MS = 120;
export const ACTIVITY_INDICATOR_LABEL_OUT_MS = 140;

/** Mark cross-fade between the resting mark and the working one. */
export const ACTIVITY_INDICATOR_MARK_IN_MS = 220;
export const ACTIVITY_INDICATOR_MARK_OUT_MS = 160;

/**
 * The barely-overshooting settle the indicator travels on, as a duration and
 * a damping ratio rather than a physical spring: that is the one description
 * both renderers can take literally (Reanimated springs on it directly;
 * `motion` takes the same duration with `bounce = 1 - dampingRatio`).
 */
export const ACTIVITY_INDICATOR_SETTLE_SPRING = {
  durationMs: 420,
  dampingRatio: 0.88,
} as const;

/** The pop the mark plays once the last agent finishes. */
export const ACTIVITY_INDICATOR_POP_SCALE = 1.14;
export const ACTIVITY_INDICATOR_POP_RISE_MS = 160;
export const ACTIVITY_INDICATOR_POP_SETTLE_SPRING = {
  damping: 12,
  stiffness: 180,
} as const;

/**
 * What the indicator should do about a change in how many agents are running.
 *
 * `spawn` — something new started: play the beat, then settle into work.
 * `settle` — the last one finished: pop the mark and return to rest.
 * `none`  — the count only shrank toward a still-running set; nothing to play.
 */
export type ActivityIndicatorTransition = "spawn" | "settle" | "none";

export const activityIndicatorTransition = (
  count: number,
  previousCount: number,
): ActivityIndicatorTransition => {
  if (count > previousCount) return "spawn";
  if (count === 0 && previousCount > 0) return "settle";
  return "none";
};

/**
 * What the indicator reads out: one agent speaks for itself, several collapse
 * to a count. `formatCount` stays with the caller so each platform keeps its
 * own translation catalog and plural rules.
 */
export const selectActivityIndicatorLabel = (
  running: readonly ActivityIndicatorEntry[],
  formatCount: (count: number) => string,
): string | null => {
  if (running.length === 0) return null;
  if (running.length === 1) return running[0]!.title;
  return formatCount(running.length);
};

/** The rows the menu lists, capped. */
export const activityIndicatorMenuEntries = (
  running: readonly ActivityIndicatorEntry[],
): ActivityIndicatorEntry[] =>
  running.slice(0, ACTIVITY_INDICATOR_MENU_MAX_ROWS);
