import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  deriveTokens,
  getThemesSnapshot,
  resolveThemeColors,
} from "@stella/theme";

/**
 * Guard against the drift this package exists to end: the derived color
 * tokens have exactly one definition (deriveTokens in @stella/theme), and the
 * root stylesheet must not grow a second one via color-mix()/oklch().
 */
const DERIVED_VARS = [
  "--text-base",
  "--text-weak",
  "--text-weaker",
  "--border-strong",
  "--border-base",
  "--border-weak",
  "--surface-inset",
  "--surface-raised-hover",
  "--button-secondary-base",
  "--button-secondary-hover",
  "--overlay-border",
  "--overlay-border-strong",
  "--panel-surface-bg",
  "--panel-surface-border",
  "--panel-surface-border-hover",
  "--select-fill",
  "--select-border",
  "--chat-user-bubble-fill",
  "--chat-user-bubble-text",
];

describe("theme tokens are single-sourced", () => {
  const css = readFileSync(
    path.resolve(__dirname, "../../src/index.css"),
    "utf8",
  );

  test("index.css defines no derived color token", () => {
    for (const v of DERIVED_VARS) {
      const definition = new RegExp(`^\\s*${v}\\s*:`, "m");
      expect(
        css,
        `${v} is defined in index.css; derive it in @stella/theme instead`,
      ).not.toMatch(definition);
    }
  });

  test("index.css contains no color-mix() at all", () => {
    expect(css.includes("color-mix(")).toBe(false);
  });

  test("every theme derives a full token set in both modes", () => {
    for (const theme of getThemesSnapshot()) {
      for (const isDark of [false, true]) {
        const r = resolveThemeColors(theme, isDark);
        const t = deriveTokens(r.colors, isDark, { flat: r.flat });
        for (const [key, value] of Object.entries(t)) {
          expect(typeof value, `${theme.id}/${key}`).toBe("string");
          expect(value.length, `${theme.id}/${key}`).toBeGreaterThan(0);
        }
      }
    }
  });
});
