/**
 * Layout math shared with `desktop/src/shell/ascii-creature/StellaAnimation.tsx`
 * and `desktop/src/app/chat/indicators.css` (`.indicator-stella*`).
 */

/** Extra shader margin so edge effects are not clipped (desktop EDGE_SCALE). */
export const STELLA_EDGE_SCALE = 2.5;

/** Desktop `--ascii-font-size` / `--ascii-line-height` for the creature. */
export const STELLA_GLYPH_PX = 7;

/**
 * Character-grid size used by the inline working indicator.
 *
 * Desktop uses 20. On mobile we render the creature into a small ~52pt circle
 * (much smaller than desktop's 350px supersampled canvas), so a coarser grid
 * keeps the silhouette readable — at higher grid values each glyph collapses
 * below the 4-pixel minimum and the creature visually disappears.
 */
export const WORKING_INDICATOR_GRID = 10;

/**
 * GLView footprint for the inline indicator, in pt.
 *
 * Matches desktop's 30px `.indicator-stella` slot, which is the size the star
 * shader was tuned for (arm girth, coarse field, 3-octave fbm — see
 * `aurora-shader.ts`). Square, and that matters: the star's arms are laid out
 * on a circular axis, so anything but a 1:1 canvas shears it.
 */
export const WORKING_INDICATOR_DISPLAY_PT = 30;

/**
 * Breathing room between the canvas and its layout box, so the aurora cannot
 * be clipped. The GL surface is a native view that Android clips to its
 * container whatever `overflow` says, and the star fills its canvas out to the
 * frame fade at ~97% — with no dead margin to absorb a crop, a container merely
 * *equal* to the canvas is one rounded fractional pt from shaving an arm off.
 * Cheap insurance: it costs a few pt of row height and no star size.
 */
export const WORKING_INDICATOR_VIEWPORT_SLACK_PT = 4;

/** Layout box around the canvas — deliberately larger than it. */
export const WORKING_INDICATOR_VIEWPORT_PT =
  WORKING_INDICATOR_DISPLAY_PT + WORKING_INDICATOR_VIEWPORT_SLACK_PT;

export type StellaRenderLayout = {
  gridCharsW: number;
  gridCharsH: number;
  shaderGridW: number;
  shaderGridH: number;
  renderWidth: number;
  renderHeight: number;
};

/** Canvas layout size before the working-indicator CSS scale transform. */
export function getStellaRenderLayout(
  gridCharsW: number,
  gridCharsH: number,
): StellaRenderLayout {
  const shaderGridW = Math.max(6, Math.round(gridCharsW * STELLA_EDGE_SCALE));
  const shaderGridH = Math.max(4, Math.round(gridCharsH * STELLA_EDGE_SCALE));
  const renderWidth = Math.max(
    1,
    Math.floor(gridCharsW * STELLA_GLYPH_PX * STELLA_EDGE_SCALE),
  );
  const renderHeight = Math.max(
    1,
    Math.floor(gridCharsH * STELLA_GLYPH_PX * STELLA_EDGE_SCALE),
  );
  return {
    gridCharsW,
    gridCharsH,
    shaderGridW,
    shaderGridH,
    renderWidth,
    renderHeight,
  };
}

export function getWorkingIndicatorLayout(): StellaRenderLayout & {
  viewport: number;
  display: number;
} {
  const layout = getStellaRenderLayout(
    WORKING_INDICATOR_GRID,
    WORKING_INDICATOR_GRID,
  );
  return {
    ...layout,
    viewport: WORKING_INDICATOR_VIEWPORT_PT,
    display: WORKING_INDICATOR_DISPLAY_PT,
  };
}
