/**
 * Dimension-aware vision estimate shared by provider preflight, persisted
 * thread accounting and compaction on every host. The tile formula is
 * intentionally provider-neutral; an unknown-size image uses the same
 * conservative fallback in every path.
 */

export const DEFAULT_ESTIMATED_IMAGE_TOKENS = 1_200;
const IMAGE_TILE_EDGE_PX = 512;
const IMAGE_DETAIL_MAX_EDGE_PX = 2_048;
const IMAGE_BASE_TOKENS = 85;
const IMAGE_TILE_TOKENS = 170;

const positiveDimension = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

export const estimateModelVisibleImageTokens = (value: unknown): number => {
  const image = (value ?? {}) as Record<string, unknown>;
  const width = positiveDimension(image.width ?? image.widthPx);
  const height = positiveDimension(image.height ?? image.heightPx);
  if (!width || !height) return DEFAULT_ESTIMATED_IMAGE_TOKENS;
  const scale = Math.min(1, IMAGE_DETAIL_MAX_EDGE_PX / Math.max(width, height));
  const scaledWidth = Math.max(1, Math.ceil(width * scale));
  const scaledHeight = Math.max(1, Math.ceil(height * scale));
  const tiles =
    Math.ceil(scaledWidth / IMAGE_TILE_EDGE_PX) *
    Math.ceil(scaledHeight / IMAGE_TILE_EDGE_PX);
  return IMAGE_BASE_TOKENS + IMAGE_TILE_TOKENS * tiles;
};
