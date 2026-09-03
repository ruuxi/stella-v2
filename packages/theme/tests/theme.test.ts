import { describe, expect, test } from "bun:test";
import {
  deriveTokens,
  formatColor,
  generateBlobs,
  getThemesSnapshot,
  hexToOklch,
  mixOklch,
  mixOklchCss,
  mixSrgb,
  mixSrgbCss,
  parseColor,
  planGradientFrame,
  renderGradientImage,
  renderGradientPixels,
  resolveThemeColors,
  withAlpha,
} from "../index";
import zlib from "node:zlib";
import { bytesToBase64, encodePng } from "../gradient-image";

describe("parse / format", () => {
  test("hex forms", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#0a84ff")).toEqual({ r: 10, g: 132, b: 255, a: 1 });
    expect(parseColor("#0a84ff80")?.a).toBeCloseTo(128 / 255, 6);
    expect(parseColor("nope")).toBeNull();
  });
  test("rgb() forms the palettes use", () => {
    expect(parseColor("rgba(28, 23, 18, 0.12)")).toEqual({
      r: 28,
      g: 23,
      b: 18,
      a: 0.12,
    });
    expect(parseColor("rgb(255 255 255 / 50%)")).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 0.5,
    });
  });
  test("format keeps alpha precise and opaque as hex", () => {
    expect(formatColor({ r: 10, g: 132, b: 255, a: 1 })).toBe("#0a84ff");
    expect(formatColor({ r: 10, g: 132, b: 255, a: 0.46 })).toBe(
      "rgba(10, 132, 255, 0.46)",
    );
    expect(withAlpha("rgba(28, 23, 18, 0.12)", 0.6)).toBe(
      "rgba(28, 23, 18, 0.072)",
    );
  });
});

describe("color-mix semantics", () => {
  test("srgb midpoint of white and black is mid grey", () => {
    expect(mixSrgbCss("white", 50, "black")).toBe("#808080");
  });
  test("mixing toward transparent keeps the color and scales alpha", () => {
    const m = mixSrgb(parseColor("#1d1d1f")!, parseColor("transparent")!, 0.46);
    expect(m.r).toBe(0x1d);
    expect(m.b).toBe(0x1f);
    expect(m.a).toBeCloseTo(0.46, 9);
    const o = mixOklch(parseColor("#c4c6ba")!, parseColor("transparent")!, 0.6);
    expect(Math.round(o.r)).toBe(0xc4);
    expect(o.a).toBeCloseTo(0.6, 9);
  });
  test("achromatic input hands hue to the other color", () => {
    // white 42% + transparent (both hueless) → white at 0.42
    expect(mixOklchCss("white", 42, "transparent")).toBe(
      "rgba(255, 255, 255, 0.42)",
    );
    // grey mixed into a saturated blue keeps the blue hue
    const blue = hexToOklch("#0a84ff");
    const mixed = hexToOklch(mixOklchCss("#808080", 30, "#0a84ff"));
    expect(Math.abs(mixed.h - blue.h)).toBeLessThan(1);
  });
  test("oklch hue takes the shorter arc", () => {
    // hue 350 and hue 10 should meet near 0, not 180
    const a = "#ff0d3a"; // ~hue 20
    const b = "#ff0dd6"; // ~hue 340
    const h = hexToOklch(mixOklchCss(a, 50, b)).h;
    expect(h > 340 || h < 20).toBe(true);
  });
});

describe("tokens", () => {
  const themes = getThemesSnapshot();

  test("catalog has Default and Custom, and no retired ids", () => {
    const ids = themes.map((t) => t.id);
    expect(ids).toContain("default");
    expect(ids).toContain("custom");
    expect(ids).not.toContain("pearl");
    expect(ids).not.toContain("noir");
  });

  test("user bubble snaps out of the mid band and text flips with it", () => {
    const { colors, flat } = resolveThemeColors(
      themes.find((t) => t.id === "default")!,
      false,
    );
    const t = deriveTokens(colors, false, { flat });
    const fill = hexToOklch(t.chatUserBubbleFill);
    expect(fill.l).toBeCloseTo(0.55, 2);
    const text = hexToOklch(t.chatUserBubbleText);
    expect(text.l).toBeGreaterThan(0.95);
  });

  test("flat themes give assistant bubbles the solid muted fill", () => {
    const def = themes.find((t) => t.id === "default")!;
    const r = resolveThemeColors(def, true);
    const t = deriveTokens(r.colors, true, { flat: r.flat });
    expect(t.chatAssistantBubbleFillTop).toBe(r.colors.muted);
    const orchid = themes.find((t) => t.id === "dracula")!;
    const o = resolveThemeColors(orchid, true);
    const ot = deriveTokens(o.colors, true, { flat: o.flat });
    expect(ot.chatAssistantBubbleFillTop).toBe(ot.panelSurfaceBgTop);
    expect(ot.panelSurfaceBgTop).toMatch(/^rgba\(/);
  });

  test("every theme × mode derives the pinned token set", () => {
    const all: Record<string, unknown> = {};
    for (const theme of themes) {
      for (const isDark of [false, true]) {
        const r = resolveThemeColors(theme, isDark);
        all[`${theme.id}:${isDark ? "dark" : "light"}`] = deriveTokens(
          r.colors,
          isDark,
          {
            flat: r.flat,
          },
        );
      }
    }
    expect(all).toMatchSnapshot();
  });
});

describe("gradient", () => {
  const orchid = getThemesSnapshot().find((t) => t.id === "dracula")!;

  test("blob layout is deterministic per seed and differs across seeds", () => {
    const palette = [{ r: 1, g: 2, b: 3 }];
    const a = generateBlobs(palette, "soft", "dracula");
    const b = generateBlobs(palette, "soft", "dracula");
    const c = generateBlobs(palette, "soft", "monokai");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const blob of a) {
      expect(blob.alpha).toBeGreaterThanOrEqual(0.25);
      expect(blob.alpha).toBeLessThanOrEqual(0.4);
    }
  });

  test("flat themes plan zero blobs; soft themes plan five", () => {
    const def = getThemesSnapshot().find((t) => t.id === "default")!;
    const d = resolveThemeColors(def, false);
    expect(
      planGradientFrame({
        colors: d.colors,
        isDark: false,
        mode: "soft",
        colorMode: "relative",
        flat: d.flat,
        seedKey: "default",
      }).blobs,
    ).toHaveLength(0);
    const o = resolveThemeColors(orchid, false);
    expect(
      planGradientFrame({
        colors: o.colors,
        isDark: false,
        mode: "soft",
        colorMode: "relative",
        flat: o.flat,
        seedKey: "dracula",
      }).blobs,
    ).toHaveLength(5);
  });

  test("pixel renderer is pure: same inputs, same bytes", () => {
    const o = resolveThemeColors(orchid, true);
    const plan = planGradientFrame({
      colors: o.colors,
      isDark: true,
      mode: "soft",
      colorMode: "relative",
      flat: o.flat,
      seedKey: "dracula",
    });
    const a = new Uint8ClampedArray(40 * 30 * 4);
    const b = new Uint8ClampedArray(40 * 30 * 4);
    renderGradientPixels(a, 40, 30, plan.bg, plan.blobs);
    renderGradientPixels(b, 40, 30, plan.bg, plan.blobs);
    expect(a).toEqual(b);
    expect(a[3]).toBe(255);
    // The wash never leaves the frame pure background everywhere.
    let differs = false;
    for (let i = 0; i < a.length; i += 4) {
      if (
        a[i] !== plan.bg.r ||
        a[i + 1] !== plan.bg.g ||
        a[i + 2] !== plan.bg.b
      )
        differs = true;
    }
    expect(differs).toBe(true);
  });

  test("png encoder produces a valid stored-deflate image", () => {
    const w = 70,
      h = 50;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = i % 255;
      px[i + 1] = 7;
      px[i + 2] = 200;
      px[i + 3] = 255;
    }
    const png = encodePng(px, w, h);
    expect(Array.from(png.subarray(0, 8))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    // IHDR
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(w);
    expect(view.getUint32(20)).toBe(h);
    // IDAT payload inflates to (w*3+1)*h filtered bytes
    const idatLen = view.getUint32(33);
    const idat = png.subarray(41, 41 + idatLen);
    const inflated = zlib.inflateSync(Buffer.from(idat));
    expect(inflated.length).toBe((w * 3 + 1) * h);
    expect(inflated[1]).toBe(px[0]);
    expect(inflated[3]).toBe(200);
  });

  test("base64 matches the platform encoder", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) & 255);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  test("renderGradientImage yields a data URI at the scaled size", () => {
    const o = resolveThemeColors(orchid, false);
    const img = renderGradientImage(
      {
        colors: o.colors,
        isDark: false,
        mode: "soft",
        colorMode: "relative",
        flat: o.flat,
        seedKey: "dracula",
      },
      390,
      844,
      0.25,
    );
    expect(img.width).toBe(98);
    expect(img.height).toBe(211);
    expect(img.uri.startsWith("data:image/png;base64,")).toBe(true);
  });
});
