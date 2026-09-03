/**
 * The mobile color surface: the shared palette + derived tokens from
 * `@stella/theme`, renamed onto the keys mobile components already use.
 *
 * Nothing here invents a color. Every value is either a palette entry or a
 * token that desktop writes to a CSS variable of the same recipe, so a theme
 * renders the same muted text, hairlines, bubbles, and panel tints on both.
 */
import {
  deriveTokens,
  getThemeById,
  mixSrgbCss,
  resolveThemeColors,
  type ThemeColors,
  type ThemeTokens,
} from "@stella/theme";

export type Colors = {
  // Core backgrounds
  background: string;
  backgroundWeak: string;
  backgroundStrong: string;
  /** Opaque floating chrome (desktop `--overlay-surface`). */
  surface: string;
  panel: string;
  /** Recessed surface (desktop `--surface-inset`). */
  surfaceInset: string;

  // Borders (desktop `--border`, `--border-weak`, `--border-strong`)
  border: string;
  borderWeak: string;
  borderStrong: string;

  // Text (desktop `--foreground` / `--text-*`)
  text: string;
  textBase: string;
  textMuted: string;
  textWeaker: string;
  textStrong: string;
  textInteractive: string;

  // Brand / primary
  accent: string;
  accentHover: string;
  /** Canonical "selected" fill (desktop `--select-fill`). */
  accentSoft: string;
  /** Canonical "selected" hairline (desktop `--select-border`). */
  selectBorder: string;
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

  // Tint-only panels (desktop `--panel-surface-*`): the composer material,
  // rendered top → bottom as a two-stop gradient.
  panelSurfaceBgTop: string;
  panelSurfaceBgBottom: string;
  panelSurfaceBorder: string;
  panelSurfaceHighlight: string;

  // Chat bubbles (desktop `--chat-*-bubble-*`)
  userBubbleFill: string;
  userBubbleText: string;
  assistantBubbleFillTop: string;
  assistantBubbleFillBottom: string;
  assistantBubbleText: string;

  // Scrim
  overlay: string;
};

/** Map the shared palette + tokens onto the mobile key set. */
export function makeColors(palette: ThemeColors, tokens: ThemeTokens): Colors {
  return {
    background: palette.background,
    backgroundWeak: palette.backgroundWeak,
    backgroundStrong: palette.backgroundStrong,
    surface: tokens.overlaySurface,
    panel: palette.muted,
    surfaceInset: tokens.surfaceInset,

    border: palette.border,
    borderWeak: tokens.borderWeak,
    borderStrong: tokens.borderStrong,

    text: tokens.textStrong,
    textBase: tokens.textBase,
    textMuted: tokens.textWeak,
    textWeaker: tokens.textWeaker,
    textStrong: tokens.textStrong,
    textInteractive: tokens.textInteractive,

    accent: palette.primary,
    accentHover: palette.interactive,
    accentSoft: tokens.selectFill,
    selectBorder: tokens.selectBorder,
    accentForeground: palette.primaryForeground,

    decorative: palette.accent,
    decorativeForeground: palette.accentForeground,

    ok: palette.success,
    warning: palette.warning,
    danger: palette.error,
    info: palette.info,

    card: palette.card,
    cardForeground: palette.cardForeground,
    muted: palette.muted,
    mutedForeground: palette.mutedForeground,

    panelSurfaceBgTop: tokens.panelSurfaceBgTop,
    panelSurfaceBgBottom: tokens.panelSurfaceBgBottom,
    panelSurfaceBorder: tokens.panelSurfaceBorder,
    panelSurfaceHighlight: tokens.panelSurfaceHighlight,

    userBubbleFill: tokens.chatUserBubbleFill,
    userBubbleText: tokens.chatUserBubbleText,
    assistantBubbleFillTop: tokens.chatAssistantBubbleFillTop,
    assistantBubbleFillBottom: tokens.chatAssistantBubbleFillBottom,
    assistantBubbleText: tokens.chatAssistantBubbleText,

    overlay: mixSrgbCss(palette.foregroundStrong, 38, palette.background),
  };
}

function fallbackFor(isDark: boolean): Colors {
  const theme = getThemeById("default")!;
  const { colors, flat } = resolveThemeColors(theme, isDark);
  return makeColors(colors, deriveTokens(colors, isDark, { flat }));
}

/** Pre-load palettes — the Default theme, so the frame before AsyncStorage
 *  resolves matches what most users actually see. */
export const lightColors: Colors = fallbackFor(false);
export const darkColors: Colors = fallbackFor(true);

/** @deprecated Use `useColors()` from theme-context instead. */
export const colors = lightColors;
