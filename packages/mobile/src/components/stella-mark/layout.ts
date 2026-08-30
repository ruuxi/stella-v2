/**
 * Pixel layout of the thinking ellipsis, split out of the component for the
 * same reason as `motion.ts`: it is arithmetic, so it is worklet-safe and
 * directly testable.
 *
 * `react-native-svg` rasterizes an `<Svg>` at the size it is laid out at, and a
 * parent transform then resamples that bitmap rather than re-rendering the
 * vector. A dot drawn at the full mark size and scaled down ~5x therefore lands
 * as a jagged blob that shimmers as the wave animates it. So each dot is laid
 * out at the pixel size it settles on and the morph scales it *up* at the
 * start, which puts the resting state at exactly scale 1.
 */

import { STELLA_MARK_CENTER, STELLA_MARK_VIEWBOX_SPAN } from "./geometry";
import { DOT_RADIUS_UNITS, DOT_SPREAD_UNITS, SIDE_DOT_SCALE } from "./motion";

/** Fraction of the full mark a settled ellipsis dot occupies. */
export const DOT_SHRINK = DOT_RADIUS_UNITS / STELLA_MARK_CENTER;

/** Three dots at indicator size are tiny; the desktop rig zooms under 44px. */
export const SMALL_SIZE_THRESHOLD = 44;
export const DOTS_ZOOM = 1.5;

export function markZoom(size: number): number {
  return size < SMALL_SIZE_THRESHOLD ? DOTS_ZOOM : 1;
}

export type StellaMarkLayout = {
  /** Pixels per viewBox unit at this mark size. */
  pxPerUnit: number;
  zoom: number;
  /** Side-dot offset from centre, in pixels, zoom included. */
  spreadPx: number;
  dotPx: number;
  sideDotPx: number;
  /** Scale that takes a settled dot back up to the full mark's box. */
  dotOversize: number;
};

export function stellaMarkLayout(size: number): StellaMarkLayout {
  const zoom = markZoom(size);
  const pxPerUnit = size / STELLA_MARK_VIEWBOX_SPAN;
  const dotPx = size * DOT_SHRINK * zoom;
  return {
    pxPerUnit,
    zoom,
    spreadPx: DOT_SPREAD_UNITS * pxPerUnit * zoom,
    dotPx,
    sideDotPx: dotPx * SIDE_DOT_SCALE,
    dotOversize: size / dotPx,
  };
}

/**
 * Carries a full-size layer down to dot size, including the zoom the dots state
 * needs on top of the stage.
 */
export function morphShrink(env: number, zoom: number): number {
  "worklet";
  return (1 + (DOT_SHRINK - 1) * env) * (1 + (zoom - 1) * env);
}

/**
 * The middle dot is authored at its settled size, so it starts oversized to sit
 * under the star it replaces and reaches exactly 1 when the morph lands.
 */
export function middleDotScale(env: number, layout: StellaMarkLayout): number {
  "worklet";
  return layout.dotOversize * morphShrink(env, layout.zoom);
}

/**
 * Side dots only exist in the dots state, so they just inherit the stage's zoom
 * ramp, normalized so they too settle at exactly 1.
 */
export function sideDotScale(env: number, zoom: number): number {
  "worklet";
  return (1 + (zoom - 1) * env) / zoom;
}
