/**
 * Color math shared by every Stella client.
 *
 * Everything here is pure arithmetic on strings and numbers — no DOM, no
 * React Native — so desktop (CSS custom properties) and mobile (style objects)
 * derive the exact same bytes from the same palette. The mixing functions
 * reproduce CSS `color-mix()` semantics (premultiplied alpha, shorter hue arc,
 * powerless hue on achromatic colors) so the desktop stylesheet could hand its
 * derivations to TypeScript without changing a single rendered pixel.
 */

export type Rgba = {
  /** 0–255 */
  r: number;
  /** 0–255 */
  g: number;
  /** 0–255 */
  b: number;
  /** 0–1 */
  a: number;
};

export interface OklchColor {
  /** Lightness 0–1 */
  l: number;
  /** Chroma 0–0.4+ */
  c: number;
  /** Hue 0–360 */
  h: number;
}

type Oklcha = OklchColor & { a: number };

// ─── Parsing / formatting ────────────────────────────────────────────────

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, v));
}

function parseHex(input: string): Rgba | null {
  const hex = input.slice(1).trim();
  const expand = (i: number) => parseInt(hex[i] + hex[i], 16);
  const pair = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  let r: number,
    g: number,
    b: number,
    a = 255;
  if (hex.length === 3 || hex.length === 4) {
    r = expand(0);
    g = expand(1);
    b = expand(2);
    if (hex.length === 4) a = expand(3);
  } else if (hex.length === 6 || hex.length === 8) {
    r = pair(0);
    g = pair(2);
    b = pair(4);
    if (hex.length === 8) a = pair(6);
  } else {
    return null;
  }
  if ([r, g, b, a].some(Number.isNaN)) return null;
  return { r, g, b, a: a / 255 };
}

function parseChannel(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  if (t.endsWith("%")) {
    const pct = Number.parseFloat(t.slice(0, -1));
    return Number.isFinite(pct) ? clampByte((pct / 100) * 255) : null;
  }
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? clampByte(n) : null;
}

function parseAlpha(token: string | undefined): number {
  if (token === undefined) return 1;
  const t = token.trim();
  if (t.endsWith("%")) {
    const pct = Number.parseFloat(t.slice(0, -1));
    return Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 1;
  }
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function parseRgbFunction(input: string): Rgba | null {
  const match = input.trim().match(/^rgba?\((.+)\)$/i);
  if (!match) return null;
  const body = match[1].replace(/\s*\/\s*/g, ",");
  const parts = body.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const r = parseChannel(parts[0]);
  const g = parseChannel(parts[1]);
  const b = parseChannel(parts[2]);
  if (r === null || g === null || b === null) return null;
  return { r, g, b, a: parseAlpha(parts[3]) };
}

/**
 * Parse the color syntaxes a theme palette may use: `#rgb[a]`, `#rrggbb[aa]`,
 * `rgb()` / `rgba()` (comma or space separated, optional `/ alpha`), and the
 * three keywords the token recipes lean on (`transparent`, `white`, `black`).
 * Returns null for anything else — callers pick their own fallback.
 */
export function parseColor(input: string | null | undefined): Rgba | null {
  if (!input) return null;
  const s = input.trim();
  const named = NAMED[s.toLowerCase()];
  if (named) return { ...named };
  if (s.startsWith("#")) return parseHex(s);
  return parseRgbFunction(s);
}

/** `parseColor` with a mid-grey fallback so token math never throws. */
export function parseColorOr(
  input: string | null | undefined,
  fallback: Rgba = { r: 128, g: 128, b: 128, a: 1 },
): Rgba {
  return parseColor(input) ?? { ...fallback };
}

function byteHex(v: number): string {
  return Math.round(clampByte(v)).toString(16).padStart(2, "0");
}

/**
 * Serialize for both CSS and React Native. Opaque colors become `#rrggbb`;
 * translucent ones become `rgba(r, g, b, a)` so alpha keeps float precision
 * instead of being quantized to 8 bits.
 */
export function formatColor(c: Rgba): string {
  const r = Math.round(clampByte(c.r));
  const g = Math.round(clampByte(c.g));
  const b = Math.round(clampByte(c.b));
  if (c.a >= 1) return `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`;
  const a = Math.round(Math.max(0, c.a) * 10000) / 10000;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Opaque `#rrggbb` regardless of alpha. */
export function toHex(c: Rgba): string {
  return `#${byteHex(c.r)}${byteHex(c.g)}${byteHex(c.b)}`;
}

/** `color` with its alpha replaced (multiplied into any existing alpha). */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColorOr(color);
  return formatColor({ ...c, a: c.a * Math.max(0, Math.min(1, alpha)) });
}

// ─── sRGB ⇄ OKLCH ────────────────────────────────────────────────────────

function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function srgbToLinear(c: number): number {
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

/** r, g, b in 0–1. */
export function rgbToOklch(r: number, g: number, b: number): OklchColor {
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

/**
 * OKLCH → sRGB in 0–1, channel-clipped. Clipping (rather than CSS Color 4's
 * chroma-reducing gamut map) is deliberate: it is what Chromium does when it
 * paints an out-of-gamut `oklch()` value, and Electron is Chromium, so this
 * keeps mobile in step with what the desktop actually shows.
 */
export function oklchToRgb(oklch: OklchColor): {
  r: number;
  g: number;
  b: number;
} {
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

  const clip = (v: number) => Math.max(0, Math.min(1, v));
  return {
    r: clip(linearToSrgb(Math.max(0, lr))),
    g: clip(linearToSrgb(Math.max(0, lg))),
    b: clip(linearToSrgb(Math.max(0, lb))),
  };
}

export function hexToOklch(color: string): OklchColor {
  const { r, g, b } = parseColorOr(color);
  return rgbToOklch(r / 255, g / 255, b / 255);
}

export function oklchToHex(oklch: OklchColor): string {
  const { r, g, b } = oklchToRgb(oklch);
  return toHex({ r: r * 255, g: g * 255, b: b * 255, a: 1 });
}

function toOklcha(c: Rgba): Oklcha {
  return { ...rgbToOklch(c.r / 255, c.g / 255, c.b / 255), a: c.a };
}

function fromOklcha(c: Oklcha): Rgba {
  const { r, g, b } = oklchToRgb(c);
  return { r: r * 255, g: g * 255, b: b * 255, a: c.a };
}

// ─── CSS color-mix() ─────────────────────────────────────────────────────

/** Hue is powerless (treated as missing for interpolation) when chroma is ~0. */
const POWERLESS_CHROMA = 1e-4;

/**
 * `color-mix(in srgb, a <weightA>%, b)` — premultiplied-alpha interpolation of
 * gamma-encoded sRGB, exactly as the browser does it. `weightA` is a 0–1
 * fraction; `b` gets the remainder.
 */
export function mixSrgb(a: Rgba, b: Rgba, weightA: number): Rgba {
  const pA = Math.max(0, Math.min(1, weightA));
  const pB = 1 - pA;
  const alpha = a.a * pA + b.a * pB;
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const wa = (a.a * pA) / alpha;
  const wb = (b.a * pB) / alpha;
  return {
    r: a.r * wa + b.r * wb,
    g: a.g * wa + b.g * wb,
    b: a.b * wa + b.b * wb,
    a: alpha,
  };
}

/**
 * `color-mix(in oklch, a <weightA>%, b)` — premultiplied L and C, hue along
 * the shorter arc, and a missing/powerless hue (fully transparent or
 * achromatic input) inherits the other color's hue.
 */
export function mixOklch(a: Rgba, b: Rgba, weightA: number): Rgba {
  const pA = Math.max(0, Math.min(1, weightA));
  const pB = 1 - pA;
  const A = toOklcha(a);
  const B = toOklcha(b);
  const alpha = A.a * pA + B.a * pB;
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const wa = (A.a * pA) / alpha;
  const wb = (B.a * pB) / alpha;

  const hueMissingA = A.a <= 0 || A.c < POWERLESS_CHROMA;
  const hueMissingB = B.a <= 0 || B.c < POWERLESS_CHROMA;
  let h: number;
  if (hueMissingA && hueMissingB) h = 0;
  else if (hueMissingA) h = B.h;
  else if (hueMissingB) h = A.h;
  else {
    let d = B.h - A.h;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    h = A.h + d * pB;
  }

  return fromOklcha({
    l: A.l * wa + B.l * wb,
    c: A.c * wa + B.c * wb,
    h: ((h % 360) + 360) % 360,
    a: alpha,
  });
}

/** String-in, string-out convenience over `mixSrgb`. `pct` is 0–100. */
export function mixSrgbCss(a: string, pct: number, b: string): string {
  return formatColor(mixSrgb(parseColorOr(a), parseColorOr(b), pct / 100));
}

/** String-in, string-out convenience over `mixOklch`. `pct` is 0–100. */
export function mixOklchCss(a: string, pct: number, b: string): string {
  return formatColor(mixOklch(parseColorOr(a), parseColorOr(b), pct / 100));
}

/**
 * CSS relative color syntax `oklch(from <color> L C H / alpha)`: hand the
 * source's OKLCH channels to `adjust` and get a serialized color back.
 */
export function relativeOklch(
  color: string,
  adjust: (c: OklchColor) => OklchColor,
): string {
  const src = parseColorOr(color);
  const next = adjust(toOklcha(src));
  return formatColor(fromOklcha({ ...next, a: src.a }));
}

// ─── Aura-style scales (gradient blob palette) ──────────────────────────

/**
 * The 12-step scale the shifting-gradient palette samples from. Kept exactly
 * as the original desktop port so the blob colors do not move.
 */
function generateScale(seed: string, isDark: boolean): string[] {
  const base = hexToOklch(seed);
  const scale: string[] = [];

  const lightSteps = isDark
    ? [
        0.15,
        0.18,
        0.22,
        0.26,
        0.32,
        0.38,
        0.46,
        0.56,
        base.l,
        base.l - 0.05,
        0.75,
        0.93,
      ]
    : [
        0.99,
        0.97,
        0.94,
        0.9,
        0.85,
        0.79,
        0.72,
        0.64,
        base.l,
        base.l + 0.05,
        0.45,
        0.25,
      ];

  const chromaMultipliers = isDark
    ? [0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1, 1, 0.9, 0.6]
    : [0.1, 0.15, 0.25, 0.35, 0.45, 0.55, 0.7, 0.85, 1, 1, 0.95, 0.85];

  for (let i = 0; i < 12; i++) {
    scale.push(
      oklchToHex({
        l: lightSteps[i],
        c: base.c * chromaMultipliers[i],
        h: base.h,
      }),
    );
  }

  return scale;
}

export interface GradientSeeds {
  primary: string;
  success: string;
  warning: string;
  info: string;
  interactive: string;
}

export interface GradientTokens {
  textInteractive: string;
  surfaceInfoStrong: string;
  surfaceSuccessStrong: string;
  surfaceWarningStrong: string;
  surfaceBrandBase: string;
}

/** Derived gradient tokens from theme seed colors (Aura's token recipe). */
export function generateGradientTokens(
  seeds: GradientSeeds,
  isDark: boolean,
): GradientTokens {
  const interactive = generateScale(seeds.interactive, isDark);
  const info = generateScale(seeds.info, isDark);
  const success = generateScale(seeds.success, isDark);
  const warning = generateScale(seeds.warning, isDark);
  const primary = generateScale(seeds.primary, isDark);

  return {
    textInteractive: interactive[isDark ? 10 : 8],
    surfaceInfoStrong: info[8],
    surfaceSuccessStrong: success[8],
    surfaceWarningStrong: warning[8],
    surfaceBrandBase: primary[8],
  };
}
