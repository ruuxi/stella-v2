import type { Theme, ThemeColors } from "./types";

const light: ThemeColors = {
  background: "#ffffff",
  backgroundWeak: "#f5f5f7",
  backgroundStrong: "#ffffff",
  foreground: "#1d1d1f",
  foregroundWeak: "#86868b",
  foregroundStrong: "#000000",
  primary: "#0a84ff",
  primaryForeground: "#ffffff",
  success: "#34c759",
  warning: "#ff9f0a",
  error: "#ff3b30",
  info: "#0a84ff",
  interactive: "#0a84ff",
  border: "#d6d6d6",
  borderWeak: "#e5e5e5",
  borderStrong: "#c4c4c4",
  card: "#ffffff",
  cardForeground: "#1d1d1f",
  muted: "#e9e9ee",
  mutedForeground: "#86868b",
  accent: "#e8e8ed",
  accentForeground: "#1d1d1f",

  gradientAnchor: "#ececec",
};

const dark: ThemeColors = {
  background: "#1c1c1e",
  backgroundWeak: "#161618",
  backgroundStrong: "#2c2c2e",
  foreground: "#f5f5f7",
  foregroundWeak: "#98989d",
  foregroundStrong: "#ffffff",
  primary: "#0a84ff",
  primaryForeground: "#ffffff",
  success: "#30d158",
  warning: "#ff9f0a",
  error: "#ff453a",
  info: "#0a84ff",
  interactive: "#0a84ff",
  border: "#38383a",
  borderWeak: "#2c2c2e",
  borderStrong: "#48484a",
  card: "#2c2c2e",
  cardForeground: "#f5f5f7",
  muted: "#3a3a3c",
  mutedForeground: "#98989d",
  accent: "#3a3a3c",
  accentForeground: "#f5f5f7",

  gradientAnchor: "#1c1c1e",
};

const theme: Theme = {
  id: "default",
  name: "Default",

  flat: true,
  light,
  dark,
};

export default theme;
