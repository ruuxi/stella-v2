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

export const EDGE_SCALE = 2.5;

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

  displayWidth?: number;
  displayHeight?: number;
  maxDpr?: number;
  variant?: AuroraVariant;
};

export function resolveAuroraSpec(
  container: HTMLElement,
  {
    width,
    height,
    displayWidth,
    displayHeight,
    maxDpr,
    variant = "star",
  }: AuroraSpecOptions,
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

  const renderWidth = Math.max(1, Math.floor(width * cellWidth * EDGE_SCALE));
  const renderHeight = Math.max(
    1,
    Math.floor(height * cellHeight * EDGE_SCALE),
  );
  const cssWidth = Math.max(1, displayWidth ?? renderWidth);
  const cssHeight = Math.max(1, displayHeight ?? renderHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr ?? Infinity);
  const backingWidth = Math.floor(renderWidth * dpr);
  const backingHeight = Math.floor(renderHeight * dpr);

  const key = `${variant}|${cellWidth}x${cellHeight}|${backingWidth}x${backingHeight}|${cssWidth}x${cssHeight}`;

  return {
    key,
    cssWidth,
    cssHeight,
    backingWidth,
    backingHeight,
    variant,
  };
}
