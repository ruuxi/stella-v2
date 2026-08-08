// Mobile port of `desktop/src/shell/ascii-creature/glyph-atlas.ts`.
//
// The desktop generates the dot atlas with Canvas2D `arc()` fills. React Native
// has no DOM canvas, so we rasterize the same circles directly into an RGBA
// Uint8Array that we hand to `gl.texImage2D` via the pixel-pointer overload.

export const DOT_COUNT = 10;
export const BIRTH_DURATION = 12_000;
export const FLASH_DURATION = 1_200;

export type GlyphAtlas = {
  pixels: Uint8Array;
  width: number;
  height: number;
};

/**
 * Build a horizontal strip of `DOT_COUNT` cells. Cell 0 is empty; cells 1..N-1
 * contain anti-aliased white circles of monotonically increasing radius.
 */
export const buildGlyphAtlas = (
  glyphWidth: number,
  glyphHeight: number,
): GlyphAtlas => {
  const width = Math.max(1, Math.floor(glyphWidth)) * DOT_COUNT;
  const height = Math.max(1, Math.floor(glyphHeight));
  const pixels = new Uint8Array(width * height * 4);

  const maxRadius = Math.min(glyphWidth, glyphHeight) * 0.45;

  for (let i = 1; i < DOT_COUNT; i++) {
    const t = i / (DOT_COUNT - 1);
    const radius = maxRadius * Math.pow(t, 0.7);
    if (radius < 0.5) continue;

    const cx = i * glyphWidth + glyphWidth / 2;
    const cy = glyphHeight / 2;

    const minX = Math.max(0, Math.floor(cx - radius - 1));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius + 1));
    const minY = Math.max(0, Math.floor(cy - radius - 1));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius + 1));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const a = Math.max(0, Math.min(1, radius - d + 0.5));
        if (a <= 0) continue;
        const idx = (y * width + x) * 4;
        const aByte = Math.round(a * 255);
        if (aByte <= pixels[idx + 3]) continue;
        pixels[idx] = 255;
        pixels[idx + 1] = 255;
        pixels[idx + 2] = 255;
        pixels[idx + 3] = aByte;
      }
    }
  }

  return { pixels, width, height };
};

/**
 * Convert a `#rrggbb` / `#rgb` / `rgb(…)` string into a [0..1] RGB triple
 * suitable for a GLSL `vec3` uniform.
 */
export const parseColor = (value: string): [number, number, number] => {
  const v = value.trim();
  if (v.startsWith("#")) {
    let s = v.slice(1);
    if (s.length === 3) {
      s = s
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (s.length >= 6) {
      const r = parseInt(s.slice(0, 2), 16);
      const g = parseInt(s.slice(2, 4), 16);
      const b = parseInt(s.slice(4, 6), 16);
      if (
        Number.isFinite(r) &&
        Number.isFinite(g) &&
        Number.isFinite(b)
      ) {
        return [r / 255, g / 255, b / 255];
      }
    }
  }
  const match = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (match) {
    return [
      Number(match[1]) / 255,
      Number(match[2]) / 255,
      Number(match[3]) / 255,
    ];
  }
  return [1, 1, 1];
};
