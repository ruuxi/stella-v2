import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveTokens,
  getThemeById,
  parseColor,
  resolveThemeColors,
} from "@stella/theme";

const tokensCss = readFileSync(
  resolve(__dirname, "../../../src/index.css"),
  "utf8",
);
const chipCss = readFileSync(
  resolve(__dirname, "../../../src/shell/selection/ask-stella-selection-chip.css"),
  "utf8",
);

const extractBlock = (source: string, selector: string): string => {
  const start = source.indexOf(selector);
  expect(start, `${selector} missing`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`Unclosed block for ${selector}`);
};

const extractDecl = (block: string, name: string): string => {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  expect(match, `${name} missing from block`).toBeTruthy();
  return match![1].replace(/\s+/g, " ").replace(/\( /g, "(").trim();
};

/** How far a derived hairline sits from the background, 0–1 per channel. */
const distanceFromBackground = (token: string, background: string): number => {
  const a = parseColor(token)!;
  const b = parseColor(background)!;
  return (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) / (3 * 255);
};

const tokensFor = (isDark: boolean) => {
  const theme = getThemeById("default")!;
  const { colors, flat } = resolveThemeColors(theme, isDark);
  return { colors, tokens: deriveTokens(colors, isDark, { flat }) };
};

describe("selection toolbar contrast contract", () => {
  const light = extractBlock(tokensCss, ":root {");
  const dark = extractBlock(tokensCss, ".dark {");

  it("keeps the overlay shadow in the stylesheet and the overlay colors in the shared derivation", () => {
    for (const block of [light, dark]) {
      expect(extractDecl(block, "--overlay-shadow")).toMatch(/rgba\(0, 0, 0,/);
    }
    for (const isDark of [false, true]) {
      const { colors, tokens } = tokensFor(isDark);
      expect(tokens.overlaySurface).toBe(colors.backgroundStrong);
      // Opaque, foreground-over-background hairlines — never the theme border.
      expect(parseColor(tokens.overlayBorder)!.a).toBe(1);
      expect(parseColor(tokens.overlayBorderStrong)!.a).toBe(1);
      expect(tokens.overlayBorder).not.toBe(colors.border);
    }
  });

  it("mixes a stronger silhouette in dark than in light", () => {
    const l = tokensFor(false);
    const d = tokensFor(true);
    const lightMix = distanceFromBackground(l.tokens.overlayBorder, l.colors.background);
    const darkMix = distanceFromBackground(d.tokens.overlayBorder, d.colors.background);
    const lightStrong = distanceFromBackground(l.tokens.overlayBorderStrong, l.colors.background);
    const darkStrong = distanceFromBackground(d.tokens.overlayBorderStrong, d.colors.background);

    // Light mixes ≥28% of a near-black foreground into white.
    expect(lightMix).toBeGreaterThanOrEqual(0.28 * (0xff - 0x1f) / 0xff);
    expect(darkMix).toBeGreaterThan(lightMix);
    expect(lightStrong).toBeGreaterThan(lightMix);
    expect(darkStrong).toBeGreaterThan(darkMix);
  });

  it("paints the Ask Stella toolbar as an opaque overlay with a crisp ring", () => {
    const chip = extractBlock(chipCss, ".ask-stella-selection-chip {");
    expect(chip).toContain("background-color: var(--background);");
    expect(chip).toContain("var(--overlay-surface)");
    expect(chip).toContain("border: 1px solid var(--overlay-border);");
    expect(chip).toContain("box-shadow: var(--overlay-shadow);");
    expect(chip).toContain("color: var(--text-strong);");
    expect(chip).not.toContain("var(--card)");
    expect(chip).not.toMatch(/background:\s*var\(--card\)/);
    expect(chip).not.toMatch(/transparent/);
  });

  it("keeps hover, active, focus, and disabled states on the overlay tokens", () => {
    const hover = extractBlock(chipCss, ".ask-stella-selection-chip:hover {");
    const active = extractBlock(chipCss, ".ask-stella-selection-chip:active {");
    const focus = extractBlock(
      chipCss,
      ".ask-stella-selection-chip:focus-visible {",
    );
    const disabled = extractBlock(
      chipCss,
      ".ask-stella-selection-chip:disabled {",
    );

    expect(hover).toContain("var(--overlay-border-strong)");
    expect(hover).toContain("var(--overlay-surface)");
    expect(active).toContain("var(--overlay-border-strong)");
    expect(active).toContain("var(--overlay-surface)");
    expect(focus).toContain("var(--overlay-shadow)");
    expect(focus).toContain("var(--focus-ring)");
    expect(disabled).toContain("var(--text-weak)");
    expect(disabled).toContain("var(--overlay-border)");
  });
});
