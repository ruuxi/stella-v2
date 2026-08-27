export interface ThemeColors {

  background: string;
  backgroundWeak: string;
  backgroundStrong: string;
  foreground: string;
  foregroundWeak: string;
  foregroundStrong: string;

  primary: string;
  primaryForeground: string;

  success: string;
  warning: string;
  error: string;
  info: string;

  interactive: string;

  border: string;
  borderWeak: string;
  borderStrong: string;

  card: string;
  cardForeground: string;

  muted: string;
  mutedForeground: string;

  accent: string;
  accentForeground: string;

  gradientAnchor?: string;
}

export interface Theme {
  id: string;
  name: string;

  forcedMode?: "light" | "dark";

  flat?: boolean;

  base?: string;

  overrides?: { light?: Partial<ThemeColors>; dark?: Partial<ThemeColors> };

  populated?: boolean;
  light: ThemeColors;
  dark: ThemeColors;
}
