import { soften } from "./oklch";

export type Colors = {
  // Core backgrounds
  background: string;
  backgroundWeak: string;
  backgroundStrong: string;
  surface: string;
  panel: string;

  // Borders
  border: string;
  borderWeak: string;
  borderStrong: string;

  // Text
  text: string;
  textMuted: string;
  textStrong: string;

  // Brand / primary
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentForeground: string;

  // Decorative accent (distinct from brand — e.g. pink in Carbon, orange in Neon)
  decorative: string;
  decorativeForeground: string;

  // Status
  ok: string;
  warning: string;
  danger: string;
  info: string;

  // Surfaces
  card: string;
  cardForeground: string;
  muted: string;
  mutedForeground: string;

  // Overlay
  overlay: string;
};

/** Fallback light palette — mirrors the Pearl theme (desktop default) so the
 *  pre-load flash matches the real theme rather than an unrelated palette. */
export const lightColors: Colors = {
  background: "#ffffff",
  backgroundWeak: "#ffffff",
  backgroundStrong: "#ffffff",
  surface: "#ffffff",
  panel: "#f6f6f6",

  border: "#e8e8e8",
  borderWeak: "#f0f0f0",
  borderStrong: "#dcdcdc",

  text: "#111111",
  textMuted: "#737373",
  textStrong: "#000000",

  accent: "#2563eb",
  accentHover: "#2563eb",
  accentSoft: soften("#2563eb", "#ffffff", 0.12),
  accentForeground: "#ffffff",

  decorative: "#f2f2f2",
  decorativeForeground: "#111111",

  ok: "#16a34a",
  warning: "#a16207",
  danger: "#dc2626",
  info: "#2563eb",

  card: "#fbfbfb",
  cardForeground: "#111111",
  muted: "#f6f6f6",
  mutedForeground: "#737373",

  overlay: soften("#000000", "#ffffff", 0.38),
};

/** Fallback dark palette — mirrors the Noir theme so the pre-load flash matches
 *  the real theme rather than an unrelated palette. */
export const darkColors: Colors = {
  background: "#0a0a0a",
  backgroundWeak: "#050505",
  backgroundStrong: "#141414",
  surface: "#050505",
  panel: "#181818",

  border: "#242424",
  borderWeak: "#171717",
  borderStrong: "#333333",

  text: "#f0eee8",
  textMuted: "#9a958c",
  textStrong: "#fbfbf7",

  accent: "#f0eee8",
  accentHover: "#f0eee8",
  accentSoft: soften("#f0eee8", "#0a0a0a", 0.12),
  accentForeground: "#0a0a0a",

  decorative: "#202020",
  decorativeForeground: "#f0eee8",

  ok: "#4ade80",
  warning: "#fbbf24",
  danger: "#f87171",
  info: "#60a5fa",

  card: "#111111",
  cardForeground: "#f0eee8",
  muted: "#181818",
  mutedForeground: "#9a958c",

  overlay: soften("#fbfbf7", "#0a0a0a", 0.38),
};

/** @deprecated Use `useColors()` from theme-context instead. */
export const colors = lightColors;
