import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

describe("selection toolbar contrast contract", () => {
  const light = extractBlock(tokensCss, ":root {");
  const dark = extractBlock(tokensCss, ".dark {");

  it("defines a reusable opaque overlay surface and high-contrast border", () => {
    for (const block of [light, dark]) {
      expect(extractDecl(block, "--overlay-surface")).toBe(
        "var(--background-strong)",
      );
      expect(extractDecl(block, "--overlay-border")).toMatch(
        /color-mix\(in srgb, var\(--foreground\) \d+%, var\(--background\)\s*\)/,
      );
      expect(extractDecl(block, "--overlay-border-strong")).toMatch(
        /color-mix\(in srgb, var\(--foreground\) \d+%, var\(--background\)\s*\)/,
      );
      expect(extractDecl(block, "--overlay-shadow")).toMatch(
        /rgba\(0, 0, 0,/,
      );
    }
  });

  it("mixes a stronger silhouette in dark than in light without using theme-identical borders", () => {
    const lightMix = Number(
      extractDecl(light, "--overlay-border").match(/(\d+)%/)?.[1],
    );
    const darkMix = Number(
      extractDecl(dark, "--overlay-border").match(/(\d+)%/)?.[1],
    );
    const lightStrong = Number(
      extractDecl(light, "--overlay-border-strong").match(/(\d+)%/)?.[1],
    );
    const darkStrong = Number(
      extractDecl(dark, "--overlay-border-strong").match(/(\d+)%/)?.[1],
    );

    expect(lightMix).toBeGreaterThanOrEqual(28);
    expect(darkMix).toBeGreaterThan(lightMix);
    expect(lightStrong).toBeGreaterThan(lightMix);
    expect(darkStrong).toBeGreaterThan(darkMix);
    expect(extractDecl(light, "--overlay-border")).not.toBe("var(--border)");
    expect(extractDecl(dark, "--overlay-border")).not.toBe("var(--border)");
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
