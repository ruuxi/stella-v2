---
name: theme-parity-liquid-glass-exception
description: 2026-09-02 decision — desktop and mobile theming must be one-to-one (colors, derived tokens, blob background, bubbles) via a shared TS derivation; iOS Liquid Glass composer/chrome is the single intentional divergence
metadata:
  type: project
---

Decision (2026-09-02): mobile theming should match desktop exactly, not approximate it. One shared TypeScript source for palettes, OKLCH utils, derived tokens (text/border/surface/bubble tiers, currently `color-mix()` in desktop `index.css`), and the five-blob `ShiftingGradient` math. Mobile's hand-copied `themes.ts`, its own `soften()` ratios, and its diagonal linear-gradient backdrop are workarounds to be replaced. Mobile also lags desktop's catalog (still ships Pearl/Noir, lacks Default/Custom).

The one sanctioned exception: keep the native iOS Liquid Glass feel (composer, floating controls, menus). Do not flatten those to desktop's non-blurred translucent tint.

**Why:** the user wants the same theme to render the same creature on every platform; the glass is a deliberate platform-native touch, not drift.

**How to apply:** when touching theme code on either platform, derive from the shared function rather than adding platform-local mixing. Treat any new mobile-only color math as a bug. Glass surfaces still take their tint from the shared tokens. See [[mobile-verification-android-only]] for what can be checked locally.
