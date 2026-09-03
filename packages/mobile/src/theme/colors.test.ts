import { describe, expect, test } from "bun:test";
import {
  deriveTokens,
  getThemesSnapshot,
  resolveThemeColors,
} from "@stella/theme";
import { makeColors } from "./colors";

/**
 * Mobile must not invent colors: every value on the Colors surface is either
 * a palette entry or a shared derived token (the one deliberate exception is
 * the scrim `overlay`). This is what keeps a theme identical to desktop.
 */
describe("mobile colors come from the shared palette + tokens", () => {
  for (const theme of getThemesSnapshot()) {
    for (const isDark of [false, true]) {
      test(`${theme.id} ${isDark ? "dark" : "light"}`, () => {
        const r = resolveThemeColors(theme, isDark);
        const tokens = deriveTokens(r.colors, isDark, { flat: r.flat });
        const allowed = new Set<string>([
          ...Object.values(r.colors).filter(
            (v): v is string => typeof v === "string",
          ),
          ...Object.values(tokens),
        ]);
        const colors = makeColors(r.colors, tokens);
        for (const [key, value] of Object.entries(colors)) {
          if (key === "overlay") continue;
          expect(allowed.has(value), `${key}=${value}`).toBe(true);
        }
        // The parity-critical mappings, spelled out.
        expect(colors.textMuted).toBe(tokens.textWeak);
        expect(colors.borderStrong).toBe(tokens.borderStrong);
        expect(colors.userBubbleFill).toBe(tokens.chatUserBubbleFill);
        expect(colors.assistantBubbleFillTop).toBe(
          tokens.chatAssistantBubbleFillTop,
        );
        expect(colors.panelSurfaceBorder).toBe(tokens.panelSurfaceBorder);
      });
    }
  }
});
