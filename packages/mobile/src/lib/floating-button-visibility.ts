export const FLOATING_NEAR_BOTTOM_PX = 96;

export const FLOATING_DIRECTION_DELTA_PX = 4;

export interface FloatingScrollMetrics {

  offsetY: number;
  contentHeight: number;
  layoutHeight: number;
}

export function distanceFromBottom(metrics: FloatingScrollMetrics): number {
  return Math.max(
    0,
    metrics.contentHeight - metrics.offsetY - metrics.layoutHeight,
  );
}

export function deriveFloatingHidden(
  prevHidden: boolean,
  prevOffsetY: number,
  metrics: FloatingScrollMetrics,
): boolean {

  if (distanceFromBottom(metrics) <= FLOATING_NEAR_BOTTOM_PX) return false;

  if (metrics.offsetY <= 0) return false;

  const dy = metrics.offsetY - prevOffsetY;
  if (dy > FLOATING_DIRECTION_DELTA_PX) return false;
  if (dy < -FLOATING_DIRECTION_DELTA_PX) return true;
  return prevHidden;
}
