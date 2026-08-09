import type { AuroraVariant } from "./shader";

export const BIRTH_DURATION = 12000;
export const FLASH_DURATION = 1200;

export const parseColor = (value: string): [number, number, number] => {
  const match = value
    .trim()
    .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
  if (!match) return [1, 1, 1];
  return [
    Number(match[1]) / 255,
    Number(match[2]) / 255,
    Number(match[3]) / 255,
  ];
};

export const getCssNumber = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Extra canvas space around the aurora so edge effects (speaking
 * expansion, breathing, flash wave) are never clipped. The shader UV
 * mapping is scaled by the same factor so the aurora stays the same
 * pixel size.
 */
export const EDGE_SCALE = 2.5;

/**
 * Fully-resolved, context-independent description of an aurora canvas:
 * its pixel/backing geometry and a `key` that uniquely identifies a
 * reusable GL renderer. Two `StellaAnimation` mounts that resolve to the
 * same `key` (same cell metrics + size + dpr) can share — and therefore
 * pool — a single WebGL context + program.
 */
export type AuroraSpec = {
  key: string;
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  variant: AuroraVariant;
};

export type AuroraSpecOptions = {
  width: number;
  height: number;
  maxDpr?: number;
  variant?: AuroraVariant;
};

/**
 * Measure the aurora geometry from a mounted `.stella-animation-container`
 * (reads its `--aurora-cell-*` custom properties) and derive the
 * canvas/backing sizes + cache key. The `width`/`height` props are in
 * abstract cells — a sizing unit inherited from the ascii era so every
 * existing surface keeps its exact footprint.
 */
export function resolveAuroraSpec(
  container: HTMLElement,
  { width, height, maxDpr, variant = "orb" }: AuroraSpecOptions,
): AuroraSpec {
  const styles = getComputedStyle(container);
  const cellWidth = getCssNumber(
    styles.getPropertyValue("--aurora-cell-width"),
    5,
  );
  const cellHeight = getCssNumber(
    styles.getPropertyValue("--aurora-cell-height"),
    7,
  );

  const cssWidth = Math.max(1, Math.floor(width * cellWidth * EDGE_SCALE));
  const cssHeight = Math.max(1, Math.floor(height * cellHeight * EDGE_SCALE));
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr ?? Infinity);
  const backingWidth = Math.floor(cssWidth * dpr);
  const backingHeight = Math.floor(cssHeight * dpr);

  const key = `${variant}|${cellWidth}x${cellHeight}|${backingWidth}x${backingHeight}`;

  return {
    key,
    cssWidth,
    cssHeight,
    backingWidth,
    backingHeight,
    variant,
  };
}
