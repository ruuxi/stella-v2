import { STELLA_ORB_PATH, STELLA_STAR_PATH } from "./geometry";

/**
 * Blend the star toward the orb. Both paths come from one derivation and
 * share every command, so interpolating their numbers point for point gives
 * a valid intermediate profile. `t` = 0 is the star, 1 the orb.
 */
export function blendStarToOrb(t: number): string {
  const orb = STELLA_ORB_PATH.match(/-?\d*\.?\d+/g) ?? [];
  let index = 0;
  return STELLA_STAR_PATH.replace(/-?\d*\.?\d+/g, (value) => {
    const from = Number(value);
    const to = Number(orb[index++] ?? value);
    return (from + (to - from) * t).toFixed(2);
  });
}

/** Halfway between the star and the orb: the resting character. */
export const STELLA_SOFT_PATH = blendStarToOrb(0.5);
