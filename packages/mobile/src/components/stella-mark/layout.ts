import { STELLA_MARK_CENTER, STELLA_MARK_VIEWBOX_SPAN } from "./geometry";
import { DOT_RADIUS_UNITS, DOT_SPREAD_UNITS, SIDE_DOT_SCALE } from "./motion";

// Fraction of the full mark a settled ellipsis dot occupies.
export const DOT_SHRINK = DOT_RADIUS_UNITS / STELLA_MARK_CENTER;

export const SMALL_SIZE_THRESHOLD = 44;

export const DOTS_ZOOM = 1.5;

export function markZoom(size: number): number {
  return size < SMALL_SIZE_THRESHOLD ? DOTS_ZOOM : 1;
}

export type StellaMarkLayout = {
  pxPerUnit: number;
  zoom: number;
  spreadPx: number;

  dotPx: number;
  sideDotPx: number;

  dotOversize: number;
};

// react-native-svg rasterizes at the size the <Svg> is laid out at; a parent
// transform then resamples that bitmap instead of re-rendering the vector. A
// dot drawn at the full mark size and scaled down ~5x therefore lands as a
// jagged, shimmering blob. So the dots are laid out at their settled pixel
// size and the morph scales them *up* at the start instead of down at rest.
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

// Carries a full-size layer down to dot size, including the zoom the dots
// state used to get from the stage.
export function morphShrink(env: number, zoom: number): number {
  "worklet";
  return (1 + (DOT_SHRINK - 1) * env) * (1 + (zoom - 1) * env);
}

// The middle dot is authored at its settled size, so it starts oversized to
// sit under the star it replaces and reaches exactly 1 when the morph lands.
export function middleDotScale(env: number, layout: StellaMarkLayout): number {
  "worklet";
  return layout.dotOversize * morphShrink(env, layout.zoom);
}

// Side dots only exist in the dots state; they just inherit the stage zoom
// ramp, normalized so they too settle at exactly 1.
export function sideDotScale(env: number, zoom: number): number {
  "worklet";
  return (1 + (zoom - 1) * env) / zoom;
}
