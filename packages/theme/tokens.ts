/**
 * Semantic tokens derived from a theme palette.
 *
 * These are the values the desktop stylesheet used to compute with
 * `color-mix()` and relative `oklch()` at paint time. Deriving them here, once,
 * means desktop writes them out as CSS custom properties and mobile reads them
 * from its theme context — the same strings on both platforms, so the same
 * theme renders the same muted text, the same hairlines, the same bubbles.
 *
 * The ratios are the ones the stylesheet shipped; change them here and both
 * clients move together.
 */
import type { ThemeColors } from "./types";
import {
  generateGradientTokens,
  mixOklchCss,
  mixSrgbCss,
  relativeOklch,
  withAlpha,
} from "./color";

export interface ThemeTokens {
  // ── Palette passthrough ──
  background: string;
  backgroundStrong: string;
  foreground: string;
  card: string;
  cardForeground: string;
  primary: string;
  primaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  border: string;
  interactive: string;
  success: string;
  warning: string;
  info: string;

  /** Interactive text (links, active controls) — the gradient palette's interactive step. */
  textInteractive: string;

  // ── Text hierarchy: solid, mixed toward the background ──
  textStrong: string;
  textBase: string;
  textWeak: string;
  textWeaker: string;

  // ── Hairlines: foreground over the opaque background ──
  borderStrong: string;
  borderBase: string;
  borderWeak: string;

  // ── Opaque surface ladder ──
  surfaceInset: string;
  surfaceRaised: string;
  surfaceRaisedHover: string;
  buttonSecondaryBase: string;
  buttonSecondaryHover: string;

  // ── Floating chrome over live content ──
  overlaySurface: string;
  overlayBorder: string;
  overlayBorderStrong: string;

  // ── Tint-only shell panels (sidebars, composer, assistant bubbles) ──
  panelSurfaceBg: string;
  panelSurfaceBgTop: string;
  panelSurfaceBgBottom: string;
  panelSurfaceBorder: string;
  panelSurfaceBorderHover: string;
  /** Color of the 1px inset top highlight. */
  panelSurfaceHighlight: string;

  // ── Canonical "selected" state ──
  selectFill: string;
  selectBorder: string;

  // ── Chat bubbles ──
  chatUserBubbleFill: string;
  chatUserBubbleText: string;
  chatAssistantBubbleFillTop: string;
  chatAssistantBubbleFillBottom: string;
  chatAssistantBubbleText: string;
}

export interface DeriveTokensOptions {
  /**
   * Whether the theme renders flat (no gradient blob). On a flat surface the
   * panel tint resolves into the plain page, so assistant bubbles take the
   * solid `muted` fill instead.
   */
  flat: boolean;
}

const RATIOS = {
  light: {
    textBase: 80,
    textWeak: 58,
    textWeaker: 40,
    borderStrong: 20,
    borderBase: 12,
    borderWeak: 7,
    surfaceInset: 5,
    surfaceRaisedHover: 4,
    buttonSecondaryBase: 5,
    buttonSecondaryHover: 9,
    overlayBorder: 32,
    overlayBorderStrong: 44,
    panelSurfaceBg: 0.5,
    panelSurfaceBgTop: 0.46,
    panelSurfaceBgBottom: 0.58,
    panelSurfaceHighlight: 0.42,
  },
  dark: {
    textBase: 82,
    textWeak: 60,
    textWeaker: 42,
    borderStrong: 24,
    borderBase: 16,
    borderWeak: 10,
    surfaceInset: 6,
    surfaceRaisedHover: 6,
    buttonSecondaryBase: 8,
    buttonSecondaryHover: 14,
    overlayBorder: 42,
    overlayBorderStrong: 56,
    panelSurfaceBg: 0.62,
    panelSurfaceBgTop: 0.56,
    panelSurfaceBgBottom: 0.7,
    panelSurfaceHighlight: 0.1,
  },
} as const;

/**
 * User-bubble lightness gate. Fills whose primary sits in the ambiguous
 * mid band (L 0.56–0.70, where neither black nor white text reads well) snap
 * to the nearest edge: L ≤ 0.65 clamps down to 0.55, L > 0.65 clamps up to
 * 0.70. Written as the same steep ramp the CSS used so the two agree bit for
 * bit at the threshold.
 */
function bubbleGate(l: number): number {
  return Math.max(0, Math.min(1, (l - 0.65) * 10000));
}

export function deriveTokens(
  colors: ThemeColors,
  isDark: boolean,
  { flat }: DeriveTokensOptions,
): ThemeTokens {
  const r = isDark ? RATIOS.dark : RATIOS.light;
  const { background: bg, foreground: fg, card, border, primary } = colors;

  const gradient = generateGradientTokens(
    {
      primary: colors.primary,
      success: colors.success,
      warning: colors.warning,
      info: colors.info,
      interactive: colors.interactive,
    },
    isDark,
  );

  const panelSurfaceBgTop = withAlpha(bg, r.panelSurfaceBgTop);
  const panelSurfaceBgBottom = withAlpha(bg, r.panelSurfaceBgBottom);
  const panelSurfaceBorder = isDark ? border : withAlpha(border, 0.6);
  const surfaceRaised = card;

  const chatUserBubbleFill = relativeOklch(primary, ({ l, c, h }) => {
    const gate = bubbleGate(l);
    return {
      l: (1 - gate) * Math.min(l, 0.55) + gate * Math.max(l, 0.7),
      c: c * 0.75,
      h,
    };
  });
  const chatUserBubbleText = relativeOklch(
    chatUserBubbleFill,
    ({ l, c, h }) => ({
      l: 0.985 - bubbleGate(l) * 0.835,
      c: c * 0.12,
      h,
    }),
  );

  return {
    background: bg,
    backgroundStrong: colors.backgroundStrong,
    foreground: fg,
    card,
    cardForeground: colors.cardForeground,
    primary,
    primaryForeground: colors.primaryForeground,
    muted: colors.muted,
    mutedForeground: colors.mutedForeground,
    accent: colors.accent,
    accentForeground: colors.accentForeground,
    destructive: colors.error,
    border,
    interactive: colors.interactive,
    success: colors.success,
    warning: colors.warning,
    info: colors.info,

    textInteractive: gradient.textInteractive,

    textStrong: fg,
    textBase: mixSrgbCss(fg, r.textBase, bg),
    textWeak: mixSrgbCss(fg, r.textWeak, bg),
    textWeaker: mixSrgbCss(fg, r.textWeaker, bg),

    borderStrong: mixSrgbCss(fg, r.borderStrong, bg),
    borderBase: mixSrgbCss(fg, r.borderBase, bg),
    borderWeak: mixSrgbCss(fg, r.borderWeak, bg),

    surfaceInset: mixSrgbCss(fg, r.surfaceInset, bg),
    surfaceRaised,
    surfaceRaisedHover: mixSrgbCss(fg, r.surfaceRaisedHover, card),
    buttonSecondaryBase: mixSrgbCss(fg, r.buttonSecondaryBase, card),
    buttonSecondaryHover: mixSrgbCss(fg, r.buttonSecondaryHover, card),

    overlaySurface: colors.backgroundStrong,
    overlayBorder: mixSrgbCss(fg, r.overlayBorder, bg),
    overlayBorderStrong: mixSrgbCss(fg, r.overlayBorderStrong, bg),

    panelSurfaceBg: withAlpha(bg, r.panelSurfaceBg),
    panelSurfaceBgTop,
    panelSurfaceBgBottom,
    panelSurfaceBorder,
    panelSurfaceBorderHover: mixOklchCss(fg, 18, panelSurfaceBorder),
    panelSurfaceHighlight: withAlpha("white", r.panelSurfaceHighlight),

    selectFill: mixOklchCss(primary, 15, surfaceRaised),
    selectBorder: mixOklchCss(primary, 38, surfaceRaised),

    chatUserBubbleFill,
    chatUserBubbleText,
    chatAssistantBubbleFillTop: flat ? colors.muted : panelSurfaceBgTop,
    chatAssistantBubbleFillBottom: flat ? colors.muted : panelSurfaceBgBottom,
    chatAssistantBubbleText: fg,
  };
}
