import { Text, type TextProps } from "react-native";

export const CHROME_MAX_FONT_SCALE = 1.4;
export const CONTENT_MAX_FONT_SCALE = 2.0;

let installed = false;

export function installTextDefaults(): void {
  if (installed) return;
  installed = true;

  const defaults =
    (Text as unknown as { defaultProps?: Partial<TextProps> }).defaultProps ??
    {};
  (Text as unknown as { defaultProps: Partial<TextProps> }).defaultProps = {
    ...defaults,
    maxFontSizeMultiplier:
      defaults.maxFontSizeMultiplier ?? CHROME_MAX_FONT_SCALE,
  };
}
