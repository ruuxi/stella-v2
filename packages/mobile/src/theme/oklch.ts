export interface OklchColor {
  l: number;
  c: number;
  h: number;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  if (!hex) return { r: 0.5, g: 0.5, b: 0.5 };
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return { r: 0.5, g: 0.5, b: 0.5 };
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    return Math.round(clamped * 255).toString(16).padStart(2, "0");
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function srgbToLinear(c: number): number {
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToOklch(r: number, g: number, b: number): OklchColor {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l = Math.cbrt(l_);
  const m = Math.cbrt(m_);
  const s = Math.cbrt(s_);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bOk = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const C = Math.sqrt(a * a + bOk * bOk);
  let H = Math.atan2(bOk, a) * (180 / Math.PI);
  if (H < 0) H += 360;

  return { l: L, c: C, h: H };
}

function oklchToRgb(oklch: OklchColor): { r: number; g: number; b: number } {
  const { l: L, c: C, h: H } = oklch;
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);

  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;

  const lr = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  return {
    r: linearToSrgb(Math.max(0, lr)),
    g: linearToSrgb(Math.max(0, lg)),
    b: linearToSrgb(Math.max(0, lb)),
  };
}

export function hexToOklch(hex: string): OklchColor {
  const { r, g, b } = hexToRgb(hex);
  return rgbToOklch(r, g, b);
}

function oklchToHex(oklch: OklchColor): string {
  const { r, g, b } = oklchToRgb(oklch);
  return rgbToHex(r, g, b);
}

function blendToward(hex: string, bg: string, strength: number): string {
  const c = hexToOklch(hex);
  const b = hexToOklch(bg);
  return oklchToHex({
    l: b.l + (c.l - b.l) * strength,
    c: b.c + (c.c - b.c) * strength,
    h: c.c > 0.001 ? c.h : b.h,
  });
}

export function soften(hex: string, bg: string, alpha: number): string {
  return blendToward(hex, bg, alpha);
}

export function generateAuroraStops(
  interactive: string,
  accent: string,
  isDark: boolean,
): [string, string, string, string, string] {
  const p = hexToOklch(interactive);
  const a = hexToOklch(accent);

  let delta = ((a.h - p.h + 540) % 360) - 180;
  const accentIsDistinct = a.c >= 0.05 && Math.abs(delta) >= 50;
  if (!accentIsDistinct) delta = 75;

  const hues = accentIsDistinct
    ? [p.h - 30, p.h - 12, p.h, p.h + delta * 0.55, p.h + delta]
    : [p.h - 40, p.h - 18, p.h, p.h + 32, p.h + delta];

  const lightness = [0.74, 0.7, 0.65, 0.58, 0.67];
  const chromaMul = [0.9, 0.85, 1.0, 1.15, 1.0];
  const cBase = Math.min(Math.max(p.c, 0.05), 0.16);

  const lightnessShift = isDark ? 0 : -0.06;

  return hues.map((h, i) =>
    oklchToHex({
      l: lightness[i] + lightnessShift,
      c: cBase * chromaMul[i],
      h: ((h % 360) + 360) % 360,
    }),
  ) as [string, string, string, string, string];
}

export function fadeHex(hex: string, opacity: number): string {
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, "0");

  const clean = hex.replace("#", "").slice(0, 6);
  return `#${clean}${alpha}`;
}
