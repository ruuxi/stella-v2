/**
 * Where two pictures of the window differ, as rects in CSS px. Works on
 * quarter-resolution bitmaps (Electron's resize box-filters, so a one-pixel
 * change still moves its cell), which costs ~5 ms per Retina window to make.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type LiveRect = [number, number, number, number];

/** A channel moving less than this is compression noise. */
const THRESHOLD = 12;
/** Changes within this many CSS px of each other are one region. */
const JOIN_PX = 16;
/** Above this share of the window, the whole window is the region. */
const WHOLE_SHARE = 0.4;

/** Grow a 0/1 mask by `r` cells: a sliding-window max, rows then columns. */
const dilate = (src: Uint8Array, w: number, h: number, r: number) => {
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const o = y * w;
    let n = 0;
    for (let k = 0; k < r && k < w; k += 1) n += src[o + k]!;
    for (let x = 0; x < w; x += 1) {
      if (x + r < w) n += src[o + x + r]!;
      if (x - r - 1 >= 0) n -= src[o + x - r - 1]!;
      rows[o + x] = n > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1) {
    let n = 0;
    for (let k = 0; k < r && k < h; k += 1) n += rows[k * w + x]!;
    for (let y = 0; y < h; y += 1) {
      if (y + r < h) n += rows[(y + r) * w + x]!;
      if (y - r - 1 >= 0) n -= rows[(y - r - 1) * w + x]!;
      out[y * w + x] = n > 0 ? 1 : 0;
    }
  }
  return out;
};

/**
 * Compare two same-size 4-byte-per-pixel bitmaps `w`×`h`, each cell `cell`
 * CSS px square, in a `viewport` of CSS px. `live` rects never count.
 */
export const diffRegions = (
  a: Buffer,
  b: Buffer,
  w: number,
  h: number,
  cell: number,
  viewport: { w: number; h: number },
  live: LiveRect[],
): { whole: boolean; regions: Rect[] } => {
  const diff = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i += 1, j += 4) {
    if (
      Math.abs(a[j]! - b[j]!) > THRESHOLD ||
      Math.abs(a[j + 1]! - b[j + 1]!) > THRESHOLD ||
      Math.abs(a[j + 2]! - b[j + 2]!) > THRESHOLD
    ) {
      diff[i] = 1;
    }
  }
  for (const [lx, ly, lw, lh] of live) {
    const x0 = Math.max(0, Math.floor(lx / cell));
    const x1 = Math.min(w, Math.ceil((lx + lw) / cell));
    const y0 = Math.max(0, Math.floor(ly / cell));
    const y1 = Math.min(h, Math.ceil((ly + lh) / cell));
    for (let y = y0; y < y1; y += 1) diff.fill(0, y * w + x0, y * w + x1);
  }
  const grown = dilate(diff, w, h, Math.max(1, Math.round(JOIN_PX / cell)));
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const regions: Rect[] = [];
  for (let s = 0; s < w * h; s += 1) {
    if (!grown[s] || seen[s]) continue;
    let head = 0;
    let tail = 0;
    let count = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % w;
      const y = (i / w) | 0;
      count += diff[i]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const neighbors = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of neighbors) {
        if (j < 0 || !grown[j] || seen[j]) continue;
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
    // A few stray cells are compression noise, not a change.
    if (count < 3) continue;
    regions.push({
      x: Math.floor(x0 * cell),
      y: Math.floor(y0 * cell),
      w: Math.ceil((x1 - x0 + 1) * cell),
      h: Math.ceil((y1 - y0 + 1) * cell),
    });
  }
  const covered = regions.reduce((sum, r) => sum + r.w * r.h, 0);
  if (covered > WHOLE_SHARE * viewport.w * viewport.h) {
    return { whole: true, regions: [{ x: 0, y: 0, w: viewport.w, h: viewport.h }] };
  }
  return { whole: false, regions };
};
