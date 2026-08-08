import { Text, type TextProps } from "react-native";

/**
 * Cap how far iOS Dynamic Type can stretch our chrome text. Users on
 * default through Accessibility-Medium see no change; users on the
 * largest accessibility sizes still get bigger text but not enough to
 * break composer pills, tab labels, or pairing-code inputs.
 *
 * Conversation content (assistant + user message bubbles) overrides
 * this with a higher multiplier so the reading surface still scales
 * generously for AX users.
 */
export const CHROME_MAX_FONT_SCALE = 1.4;
export const CONTENT_MAX_FONT_SCALE = 2.0;

let installed = false;

export function installTextDefaults(): void {
  if (installed) return;
  installed = true;
  // RN still honours Text.defaultProps even though it logs a deprecation
  // warning. Setting `maxFontSizeMultiplier` here is the lightest-touch
  // way to apply a sensible Dynamic Type cap app-wide; individual
  // <Text> sites can still opt into a higher multiplier.
  const defaults =
    (Text as unknown as { defaultProps?: Partial<TextProps> }).defaultProps ??
    {};
  (Text as unknown as { defaultProps: Partial<TextProps> }).defaultProps = {
    ...defaults,
    maxFontSizeMultiplier:
      defaults.maxFontSizeMultiplier ?? CHROME_MAX_FONT_SCALE,
  };
}
