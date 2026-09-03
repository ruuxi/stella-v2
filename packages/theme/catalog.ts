/**
 * The theme catalog and overlay resolution.
 *
 * One flat, native "Default" theme with light+dark variants driven by the
 * Appearance mode toggle, the invisible Custom overlay every user starts on,
 * and the colorful character themes that render the shifting-gradient
 * backdrop behind translucent panels.
 */
import custom from "./themes/custom";
import defaultTheme_ from "./themes/default";
import oc1 from "./themes/oc1";
import dracula from "./themes/dracula";
import catppuccin from "./themes/catppuccin";
import monokai from "./themes/monokai";
import solarized from "./themes/solarized";
import shadesofpurple from "./themes/shadesofpurple";
import nightowl from "./themes/nightowl";
import vesper from "./themes/vesper";
import gruvbox from "./themes/gruvbox";
import ayu from "./themes/ayu";
import aura from "./themes/aura";
import sage from "./themes/sage";
import crimson from "./themes/crimson";
import slate from "./themes/slate";
import cocoa from "./themes/cocoa";
import type { Theme, ThemeColors } from "./types";

const themes: Theme[] = [
  custom,
  defaultTheme_,
  oc1,
  dracula,
  catppuccin,
  monokai,
  solarized,
  shadesofpurple,
  nightowl,
  vesper,
  gruvbox,
  ayu,
  aura,
  sage,
  crimson,
  slate,
  cocoa,
];

const listeners = new Set<() => void>();
let themesSnapshot: readonly Theme[] = themes.slice();

const emitChange = () => {
  themesSnapshot = themes.slice();
  for (const listener of listeners) listener();
};

export const getThemeById = (id: string): Theme | undefined =>
  themes.find((t) => t.id === id);

// Everyone starts on the Custom overlay; while empty it renders as its base
// (Default), so the default look is unchanged.
export const defaultTheme = themes.find((t) => t.id === "custom")!;

/**
 * Retired theme ids and the stock theme + appearance each one was actually
 * showing. `light`/`dark` were the pre-Default pinned themes; `pearl`/`noir`
 * were mobile's copies of the same idea. Both clients migrate stored ids
 * through this table so a user who picked "Noir" lands on Default in dark.
 */
export const LEGACY_THEME_IDS: Readonly<
  Record<string, { id: string; mode: "light" | "dark" }>
> = {
  light: { id: "default", mode: "light" },
  dark: { id: "default", mode: "dark" },
  pearl: { id: "default", mode: "light" },
  noir: { id: "default", mode: "dark" },
};

export const migrateLegacyThemeId = <T extends string | null | undefined>(
  id: T,
): T | string => (id && LEGACY_THEME_IDS[id] ? LEGACY_THEME_IDS[id].id : id);

export interface ResolvedTheme {
  colors: ThemeColors;
  baseThemeId?: string;
  forcedMode?: "light" | "dark";
  /** Whether the theme renders flat (gradient-suppressed). `forcedMode` implies flat. */
  flat: boolean;
}

/**
 * Effective colors for a theme. Overlay themes (those with `base`) inherit the
 * base theme's colors for the given appearance and merge their per-mode
 * `overrides` on top. Non-overlay themes return their own colors directly.
 * Also reports the base id and effective forced mode.
 */
export const resolveThemeColors = (
  theme: Theme,
  isDark: boolean,
  baseOverrideId?: string,
): ResolvedTheme => {
  if (!theme.base && !baseOverrideId) {
    const dark = theme.forcedMode ? theme.forcedMode === "dark" : isDark;
    return {
      colors: dark ? theme.dark : theme.light,
      forcedMode: theme.forcedMode,
      flat: theme.forcedMode !== undefined || theme.flat === true,
    };
  }
  // Overlay: inherit from the runtime base override (the base the user has
  // Custom displaying) when present, else the theme's declared base.
  const baseId = baseOverrideId ?? theme.base;
  const baseTheme = baseId ? getThemeById(baseId) : undefined;
  const forcedMode = theme.forcedMode ?? baseTheme?.forcedMode;
  const resolvedDark = forcedMode ? forcedMode === "dark" : isDark;
  const baseColors = baseTheme
    ? resolvedDark
      ? baseTheme.dark
      : baseTheme.light
    : resolvedDark
      ? theme.dark
      : theme.light;
  const modeOverrides = resolvedDark
    ? theme.overrides?.dark
    : theme.overrides?.light;
  const flatFlag = theme.flat ?? baseTheme?.flat ?? false;
  return {
    colors: modeOverrides ? { ...baseColors, ...modeOverrides } : baseColors,
    baseThemeId: baseTheme?.id ?? baseId,
    forcedMode,
    flat: forcedMode !== undefined || flatFlag,
  };
};

/** Whether a theme should be hidden from the picker (empty overlay). */
export const isHiddenOverlay = (theme: Theme): boolean =>
  theme.base !== undefined && !theme.populated;

export const subscribeThemes = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getThemesSnapshot = (): readonly Theme[] => themesSnapshot;

export const registerTheme = (theme: Theme) => {
  const existing = themes.findIndex((t) => t.id === theme.id);
  if (existing >= 0) themes[existing] = theme;
  else themes.push(theme);
  emitChange();
};
