export const STELLA_EDGE_SCALE = 2.5;

export const STELLA_GLYPH_PX = 7;

export const WORKING_INDICATOR_GRID = 10;

export const WORKING_INDICATOR_DISPLAY_PT = 30;

export const WORKING_INDICATOR_VIEWPORT_SLACK_PT = 4;

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
