/**
 * Mobile theme catalog — kept in 1:1 lockstep with the desktop themes in
 * `~/projects/stella/desktop/src/shared/theme/themes/*.ts`.
 *
 * Each entry maps the desktop `ThemeColors` palette onto the mobile `Colors`
 * shape via {@link map}. Derived values (accentSoft, overlay) are computed
 * with OKLCH for perceptual accuracy. When desktop themes change, mirror them
 * here — never invent mobile-only variants.
 *
 * Pearl and Noir are "exception" themes on desktop (single palette, ignores
 * Light/Dark). We honor that here by using the same palette for both modes.
 */
import type { Colors } from "./colors";
import { soften } from "./oklch";

export type StellaTheme = {
  id: string;
  name: string;
  /** Pin to a single appearance regardless of Light/Dark/System preference. */
  forcedMode?: "light" | "dark";
  light: Colors;
  dark: Colors;
};

type Src = {
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
};

function map(s: Src, isDark: boolean): Colors {
  return {
    background: s.background,
    backgroundWeak: s.backgroundWeak,
    backgroundStrong: s.backgroundStrong,
    surface: isDark ? s.backgroundWeak : s.backgroundStrong,
    panel: s.muted,

    border: s.border,
    borderWeak: s.borderWeak,
    borderStrong: s.borderStrong,

    text: s.foreground,
    textMuted: s.foregroundWeak,
    textStrong: s.foregroundStrong,

    accent: s.primary,
    accentHover: s.interactive,
    accentSoft: soften(s.primary, s.background, 0.12),
    accentForeground: s.primaryForeground,

    decorative: s.accent,
    decorativeForeground: s.accentForeground,

    ok: s.success,
    warning: s.warning,
    danger: s.error,
    info: s.info,

    card: s.card,
    cardForeground: s.cardForeground,
    muted: s.muted,
    mutedForeground: s.mutedForeground,

    overlay: soften(s.foregroundStrong, s.background, 0.38),
  };
}

function th(
  id: string,
  name: string,
  l: Src,
  d: Src,
  forcedMode?: "light" | "dark",
): StellaTheme {
  return { id, name, forcedMode, light: map(l, false), dark: map(d, true) };
}

// ---------------------------------------------------------------------------
// Theme definitions — colors mirror desktop/src/shared/theme/themes/*.ts.
// Order matches desktop/src/shared/theme/themes/index.ts.
// ---------------------------------------------------------------------------

const pearlPalette: Src = {
  background: "#ffffff", backgroundWeak: "#ffffff", backgroundStrong: "#ffffff",
  foreground: "#111111", foregroundWeak: "#737373", foregroundStrong: "#000000",
  primary: "#2563eb", primaryForeground: "#ffffff",
  success: "#16a34a", warning: "#a16207", error: "#dc2626", info: "#2563eb",
  interactive: "#2563eb",
  border: "#e8e8e8", borderWeak: "#f0f0f0", borderStrong: "#dcdcdc",
  card: "#fbfbfb", cardForeground: "#111111",
  muted: "#f6f6f6", mutedForeground: "#737373",
  accent: "#f2f2f2", accentForeground: "#111111",
};

const noirPalette: Src = {
  background: "#0a0a0a", backgroundWeak: "#050505", backgroundStrong: "#141414",
  foreground: "#f0eee8", foregroundWeak: "#9a958c", foregroundStrong: "#fbfbf7",
  primary: "#f0eee8", primaryForeground: "#0a0a0a",
  success: "#4ade80", warning: "#fbbf24", error: "#f87171", info: "#60a5fa",
  interactive: "#f0eee8",
  border: "#242424", borderWeak: "#171717", borderStrong: "#333333",
  card: "#111111", cardForeground: "#f0eee8",
  muted: "#181818", mutedForeground: "#9a958c",
  accent: "#202020", accentForeground: "#f0eee8",
};

export const themes: StellaTheme[] = [
  th("pearl", "Pearl", pearlPalette, pearlPalette, "light"),
  th("noir", "Noir", noirPalette, noirPalette, "dark"),

  th("oc-1", "Sandstone",
    { background: "#f8f7f7", backgroundWeak: "#f0eeee", backgroundStrong: "#fcfcfc", foreground: "#1c1712", foregroundWeak: "#5a5248", foregroundStrong: "#0a0806", primary: "#1c1712", primaryForeground: "#f7f2ea", success: "#4a9c3d", warning: "#c9922a", error: "#d94830", info: "#4a8eb5", interactive: "#034cff", border: "rgba(28, 23, 18, 0.12)", borderWeak: "rgba(28, 23, 18, 0.08)", borderStrong: "rgba(28, 23, 18, 0.18)", card: "rgba(255, 255, 255, 0.75)", cardForeground: "#1c1712", muted: "#f0eeee", mutedForeground: "#6b6257", accent: "#dcde8d", accentForeground: "#1c1712" },
    { background: "#1a1614", backgroundWeak: "#1c1717", backgroundStrong: "#151313", foreground: "#e8e3dc", foregroundWeak: "#a09891", foregroundStrong: "#f7f2ea", primary: "#f7f2ea", primaryForeground: "#1c1712", success: "#6ab85e", warning: "#e0a840", error: "#e05a42", info: "#8cb8d4", interactive: "#4a7fff", border: "rgba(255, 255, 255, 0.12)", borderWeak: "rgba(255, 255, 255, 0.08)", borderStrong: "rgba(255, 255, 255, 0.18)", card: "rgba(40, 35, 32, 0.75)", cardForeground: "#e8e3dc", muted: "#2a2522", mutedForeground: "#8a8078", accent: "#fab283", accentForeground: "#1c1712" },
  ),
  th("dracula", "Orchid",
    { background: "#eee8ff", backgroundWeak: "#e2daf8", backgroundStrong: "#f6f2ff", foreground: "#1f1f2f", foregroundWeak: "#52526b", foregroundStrong: "#05040c", primary: "#7c6bf5", primaryForeground: "#ffffff", success: "#2fbf71", warning: "#f7a14d", error: "#d9536f", info: "#1d7fc5", interactive: "#7c6bf5", border: "#c4c6ba", borderWeak: "#e2e3da", borderStrong: "#9fa293", card: "rgba(255, 255, 255, 0.85)", cardForeground: "#1f1f2f", muted: "#e8e9e0", mutedForeground: "#52526b", accent: "#d16090", accentForeground: "#ffffff" },
    { background: "#14151f", backgroundWeak: "#181926", backgroundStrong: "#161722", foreground: "#f8f8f2", foregroundWeak: "#b6b9e4", foregroundStrong: "#ffffff", primary: "#bd93f9", primaryForeground: "#14151f", success: "#50fa7b", warning: "#ffb86c", error: "#ff5555", info: "#8be9fd", interactive: "#bd93f9", border: "#3f415a", borderWeak: "#2d2f3c", borderStrong: "#606488", card: "rgba(40, 42, 64, 0.9)", cardForeground: "#f8f8f2", muted: "#282a40", mutedForeground: "#b6b9e4", accent: "#ff79c6", accentForeground: "#14151f" },
  ),
  th("catppuccin", "Ros\u00e9",
    { background: "#f5e0dc", backgroundWeak: "#f2d8d4", backgroundStrong: "#f9e8e4", foreground: "#4c4f69", foregroundWeak: "#6c6f85", foregroundStrong: "#1f1f2a", primary: "#7287fd", primaryForeground: "#ffffff", success: "#40a02b", warning: "#df8e1d", error: "#d20f39", info: "#04a5e5", interactive: "#7287fd", border: "#bca6b2", borderWeak: "#e0cfd3", borderStrong: "#83677f", card: "rgba(255, 255, 255, 0.85)", cardForeground: "#4c4f69", muted: "#eed5d0", mutedForeground: "#6c6f85", accent: "#ea76cb", accentForeground: "#ffffff" },
    { background: "#1e1e2e", backgroundWeak: "#211f31", backgroundStrong: "#1c1c29", foreground: "#cdd6f4", foregroundWeak: "#a6adc8", foregroundStrong: "#f4f2ff", primary: "#b4befe", primaryForeground: "#1e1e2e", success: "#a6d189", warning: "#f2c97d", error: "#f38ba8", info: "#89dceb", interactive: "#b4befe", border: "#4a4763", borderWeak: "#35324a", borderStrong: "#6e6a8c", card: "rgba(48, 46, 72, 0.9)", cardForeground: "#cdd6f4", muted: "#313244", mutedForeground: "#a6adc8", accent: "#f5c2e7", accentForeground: "#1e1e2e" },
  ),
  th("monokai", "Neon",
    { background: "#eef6e3", backgroundWeak: "#e3eed5", backgroundStrong: "#f6faee", foreground: "#272822", foregroundWeak: "#75715e", foregroundStrong: "#1a1a16", primary: "#ae81ff", primaryForeground: "#ffffff", success: "#7da82a", warning: "#d48b1a", error: "#f92672", info: "#66d9ef", interactive: "#ae81ff", border: "#c8c8c4", borderWeak: "#e0e0dc", borderStrong: "#9e9e98", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#272822", muted: "#e8e8e4", mutedForeground: "#75715e", accent: "#fd971f", accentForeground: "#272822" },
    { background: "#272822", backgroundWeak: "#2d2e27", backgroundStrong: "#1e1f1c", foreground: "#f8f8f2", foregroundWeak: "#a8a8a0", foregroundStrong: "#ffffff", primary: "#ae81ff", primaryForeground: "#272822", success: "#a6e22e", warning: "#fd971f", error: "#f92672", info: "#66d9ef", interactive: "#ae81ff", border: "#49483e", borderWeak: "#3e3d32", borderStrong: "#6a6960", card: "rgba(62, 61, 50, 0.9)", cardForeground: "#f8f8f2", muted: "#3e3d32", mutedForeground: "#a8a8a0", accent: "#fd971f", accentForeground: "#272822" },
  ),
  th("solarized", "Solstice",
    { background: "#fdf6e3", backgroundWeak: "#f5efdc", backgroundStrong: "#fffbf0", foreground: "#4a6068", foregroundWeak: "#6e878c", foregroundStrong: "#073642", primary: "#268bd2", primaryForeground: "#ffffff", success: "#859900", warning: "#b58900", error: "#dc322f", info: "#2aa198", interactive: "#268bd2", border: "#d3cbb7", borderWeak: "#e8e2d0", borderStrong: "#a8a18c", card: "rgba(255, 255, 255, 0.85)", cardForeground: "#657b83", muted: "#eee8d5", mutedForeground: "#839496", accent: "#6c71c4", accentForeground: "#ffffff" },
    { background: "#002b36", backgroundWeak: "#073642", backgroundStrong: "#001f27", foreground: "#93a1a1", foregroundWeak: "#748d95", foregroundStrong: "#fdf6e3", primary: "#268bd2", primaryForeground: "#002b36", success: "#859900", warning: "#b58900", error: "#dc322f", info: "#2aa198", interactive: "#268bd2", border: "#0a4050", borderWeak: "#073642", borderStrong: "#1a5a6e", card: "rgba(7, 54, 66, 0.9)", cardForeground: "#93a1a1", muted: "#073642", mutedForeground: "#748d95", accent: "#6c71c4", accentForeground: "#002b36" },
  ),
  th("shadesofpurple", "Amethyst",
    { background: "#f5f3ff", backgroundWeak: "#ede9ff", backgroundStrong: "#faf9ff", foreground: "#2d2b55", foregroundWeak: "#6a67a5", foregroundStrong: "#1a1837", primary: "#7b6dc8", primaryForeground: "#ffffff", success: "#2ab800", warning: "#d88600", error: "#d43835", info: "#0090d4", interactive: "#7b6dc8", border: "#c5c0e8", borderWeak: "#ddd9f5", borderStrong: "#9992c5", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#2d2b55", muted: "#e8e4fc", mutedForeground: "#6a67a5", accent: "#fad000", accentForeground: "#1a1837" },
    { background: "#1e1e3f", backgroundWeak: "#232350", backgroundStrong: "#181835", foreground: "#e7e7ff", foregroundWeak: "#a599e9", foregroundStrong: "#ffffff", primary: "#a599e9", primaryForeground: "#1e1e3f", success: "#3ad900", warning: "#ff9d00", error: "#ec3a37", info: "#00b0ff", interactive: "#a599e9", border: "#4e4e8a", borderWeak: "#38385e", borderStrong: "#6a6ab5", card: "rgba(45, 43, 85, 0.9)", cardForeground: "#e7e7ff", muted: "#2d2b55", mutedForeground: "#a599e9", accent: "#fad000", accentForeground: "#1e1e3f" },
  ),
  th("nightowl", "Midnight",
    { background: "#e7f1fb", backgroundWeak: "#dbe8f6", backgroundStrong: "#f2f8fd", foreground: "#403f53", foregroundWeak: "#716f8a", foregroundStrong: "#1a1a2e", primary: "#4876d6", primaryForeground: "#ffffff", success: "#08916a", warning: "#daaa01", error: "#de3d3b", info: "#0c969b", interactive: "#4876d6", border: "#c9c9c9", borderWeak: "#e0e0e0", borderStrong: "#9a9a9a", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#403f53", muted: "#e5e5e5", mutedForeground: "#716f8a", accent: "#c96765", accentForeground: "#ffffff" },
    { background: "#011627", backgroundWeak: "#021d32", backgroundStrong: "#00101e", foreground: "#d6deeb", foregroundWeak: "#8badc1", foregroundStrong: "#ffffff", primary: "#82aaff", primaryForeground: "#011627", success: "#22da6e", warning: "#ffeb95", error: "#ef5350", info: "#7fdbca", interactive: "#82aaff", border: "#1d3b53", borderWeak: "#122d42", borderStrong: "#2a4a66", card: "rgba(1, 42, 74, 0.9)", cardForeground: "#d6deeb", muted: "#0b2942", mutedForeground: "#8badc1", accent: "#c792ea", accentForeground: "#011627" },
  ),
  th("vesper", "Ember",
    { background: "#f4ebe1", backgroundWeak: "#e9ddd1", backgroundStrong: "#faf3ec", foreground: "#1f1d1b", foregroundWeak: "#5c5654", foregroundStrong: "#0a0908", primary: "#8b5cf6", primaryForeground: "#ffffff", success: "#22c55e", warning: "#f59e0b", error: "#ef4444", info: "#3b82f6", interactive: "#8b5cf6", border: "#d4cfc9", borderWeak: "#e8e4e0", borderStrong: "#a8a29e", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#1f1d1b", muted: "#e7e5e4", mutedForeground: "#5c5654", accent: "#fbbf24", accentForeground: "#1f1d1b" },
    { background: "#101010", backgroundWeak: "#171717", backgroundStrong: "#0a0a0a", foreground: "#e5e5e5", foregroundWeak: "#a3a3a3", foregroundStrong: "#ffffff", primary: "#a78bfa", primaryForeground: "#101010", success: "#4ade80", warning: "#fbbf24", error: "#f87171", info: "#60a5fa", interactive: "#a78bfa", border: "#2e2e2e", borderWeak: "#1f1f1f", borderStrong: "#454545", card: "rgba(28, 28, 28, 0.9)", cardForeground: "#e5e5e5", muted: "#1c1c1c", mutedForeground: "#a3a3a3", accent: "#fbbf24", accentForeground: "#101010" },
  ),
  th("gruvbox", "Autumn",
    { background: "#fbf1c7", backgroundWeak: "#f2e5bc", backgroundStrong: "#fffbeb", foreground: "#3c3836", foregroundWeak: "#665c54", foregroundStrong: "#1d2021", primary: "#d65d0e", primaryForeground: "#fbf1c7", success: "#98971a", warning: "#d79921", error: "#cc241d", info: "#458588", interactive: "#d65d0e", border: "#d5c4a1", borderWeak: "#ebdbb2", borderStrong: "#a89984", card: "rgba(255, 255, 255, 0.85)", cardForeground: "#3c3836", muted: "#ebdbb2", mutedForeground: "#665c54", accent: "#b16286", accentForeground: "#fbf1c7" },
    { background: "#282828", backgroundWeak: "#302e2d", backgroundStrong: "#1d2021", foreground: "#ebdbb2", foregroundWeak: "#a89984", foregroundStrong: "#fbf1c7", primary: "#fe8019", primaryForeground: "#282828", success: "#b8bb26", warning: "#fabd2f", error: "#fb4934", info: "#83a598", interactive: "#fe8019", border: "#3c3836", borderWeak: "#32302f", borderStrong: "#504945", card: "rgba(60, 56, 54, 0.9)", cardForeground: "#ebdbb2", muted: "#3c3836", mutedForeground: "#a89984", accent: "#d3869b", accentForeground: "#282828" },
  ),
  th("ayu", "Amber",
    { background: "#fafafa", backgroundWeak: "#f0f0f0", backgroundStrong: "#ffffff", foreground: "#575f66", foregroundWeak: "#8a919a", foregroundStrong: "#1a1f26", primary: "#ff9940", primaryForeground: "#1a1f26", success: "#86b300", warning: "#f29718", error: "#e4584a", info: "#55b4d4", interactive: "#ff9940", border: "#c9ccd0", borderWeak: "#e0e2e5", borderStrong: "#9a9fa5", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#575f66", muted: "#e7e8e9", mutedForeground: "#8a919a", accent: "#a37acc", accentForeground: "#ffffff" },
    { background: "#0a0e14", backgroundWeak: "#0d1117", backgroundStrong: "#050709", foreground: "#bfbdb6", foregroundWeak: "#6c7380", foregroundStrong: "#e6e1cf", primary: "#ffb454", primaryForeground: "#0a0e14", success: "#aad94c", warning: "#e8815c", error: "#f07178", info: "#59c2ff", interactive: "#ffb454", border: "#1f2430", borderWeak: "#151a22", borderStrong: "#2d3640", card: "rgba(18, 24, 32, 0.9)", cardForeground: "#bfbdb6", muted: "#131721", mutedForeground: "#6c7380", accent: "#d2a6ff", accentForeground: "#0a0e14" },
  ),
  th("aura", "Velvet",
    { background: "#f5f2ff", backgroundWeak: "#ece8fa", backgroundStrong: "#faf9ff", foreground: "#29263c", foregroundWeak: "#605d78", foregroundStrong: "#15131f", primary: "#a277ff", primaryForeground: "#ffffff", success: "#2ea88a", warning: "#d4943c", error: "#d94e4e", info: "#3a9bc5", interactive: "#a277ff", border: "#c8c3e0", borderWeak: "#ddd9f0", borderStrong: "#9d98b8", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#29263c", muted: "#e8e4f5", mutedForeground: "#605d78", accent: "#d4943c", accentForeground: "#29263c" },
    { background: "#15141b", backgroundWeak: "#1a1921", backgroundStrong: "#0e0d12", foreground: "#edecee", foregroundWeak: "#9d9ba8", foregroundStrong: "#ffffff", primary: "#a277ff", primaryForeground: "#15141b", success: "#54deb0", warning: "#f0b86a", error: "#ff6767", info: "#6ecfef", interactive: "#a277ff", border: "#2d2b3a", borderWeak: "#21202a", borderStrong: "#433f55", card: "rgba(33, 32, 42, 0.9)", cardForeground: "#edecee", muted: "#21202a", mutedForeground: "#9d9ba8", accent: "#ffca85", accentForeground: "#15141b" },
  ),

  th("sage", "Sage",
    { background: "#f4f7f1", backgroundWeak: "#eaf0e3", backgroundStrong: "#fafcf7", foreground: "#1f2a1f", foregroundWeak: "#5a6c58", foregroundStrong: "#0e150e", primary: "#4f7d4f", primaryForeground: "#f4f7f1", success: "#3f8a3f", warning: "#b08a1c", error: "#b9434a", info: "#4a8a8a", interactive: "#4f7d4f", border: "#d3dfcb", borderWeak: "#e3ecdb", borderStrong: "#a9bfa1", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#1f2a1f", muted: "#e6ecde", mutedForeground: "#5a6c58", accent: "#cdb98c", accentForeground: "#1f2a1f" },
    { background: "#10180f", backgroundWeak: "#0a110a", backgroundStrong: "#1a221a", foreground: "#dbe5d4", foregroundWeak: "#8aa085", foregroundStrong: "#f0f5ec", primary: "#8fbf8a", primaryForeground: "#10180f", success: "#7fc97f", warning: "#d6b14a", error: "#e57373", info: "#7fb8b8", interactive: "#8fbf8a", border: "#1f2a1f", borderWeak: "#161e16", borderStrong: "#3a4a38", card: "rgba(26, 34, 26, 0.9)", cardForeground: "#dbe5d4", muted: "#1a221a", mutedForeground: "#8aa085", accent: "#d6c69a", accentForeground: "#10180f" },
  ),
  th("crimson", "Crimson",
    { background: "#fbf3f3", backgroundWeak: "#f4e5e5", backgroundStrong: "#fffafa", foreground: "#2a1010", foregroundWeak: "#7a4a4a", foregroundStrong: "#180606", primary: "#b91c1c", primaryForeground: "#fffafa", success: "#3f8a3f", warning: "#b08a1c", error: "#991b1b", info: "#7c5a5a", interactive: "#b91c1c", border: "#e6c7c7", borderWeak: "#f0d8d8", borderStrong: "#c08a8a", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#2a1010", muted: "#f0dada", mutedForeground: "#7a4a4a", accent: "#c97a4a", accentForeground: "#2a1010" },
    { background: "#170c0c", backgroundWeak: "#0e0707", backgroundStrong: "#1f1010", foreground: "#ecd9d9", foregroundWeak: "#a07a7a", foregroundStrong: "#fff0f0", primary: "#ef4444", primaryForeground: "#170c0c", success: "#7fc97f", warning: "#e0b04a", error: "#f87171", info: "#c7a4a4", interactive: "#ef4444", border: "#2a1818", borderWeak: "#1c1010", borderStrong: "#4a2a2a", card: "rgba(31, 16, 16, 0.9)", cardForeground: "#ecd9d9", muted: "#1f1010", mutedForeground: "#a07a7a", accent: "#e8a87c", accentForeground: "#170c0c" },
  ),
  th("slate", "Slate",
    { background: "#eef0f2", backgroundWeak: "#e2e5e8", backgroundStrong: "#f5f6f8", foreground: "#1f2530", foregroundWeak: "#5b6573", foregroundStrong: "#0c1018", primary: "#475569", primaryForeground: "#f5f6f8", success: "#3f8a3f", warning: "#a37011", error: "#b91c1c", info: "#3a6e9c", interactive: "#475569", border: "#cdd2d8", borderWeak: "#dde1e6", borderStrong: "#9aa3af", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#1f2530", muted: "#dde0e4", mutedForeground: "#5b6573", accent: "#7a8694", accentForeground: "#f5f6f8" },
    { background: "#181b20", backgroundWeak: "#101317", backgroundStrong: "#20242a", foreground: "#dde2e8", foregroundWeak: "#8a93a0", foregroundStrong: "#f0f3f7", primary: "#a3aebc", primaryForeground: "#181b20", success: "#7fc97f", warning: "#d6b14a", error: "#f87171", info: "#7fa8d6", interactive: "#a3aebc", border: "#2a2f37", borderWeak: "#1c2026", borderStrong: "#444b56", card: "rgba(32, 36, 42, 0.9)", cardForeground: "#dde2e8", muted: "#20242a", mutedForeground: "#8a93a0", accent: "#7c8694", accentForeground: "#181b20" },
  ),
  th("cocoa", "Cocoa",
    { background: "#f5efe6", backgroundWeak: "#ebe2d4", backgroundStrong: "#fbf6ee", foreground: "#3a2a1e", foregroundWeak: "#7a6553", foregroundStrong: "#1f140c", primary: "#7c4a1f", primaryForeground: "#fbf6ee", success: "#5a8a3f", warning: "#b07a1c", error: "#b9434a", info: "#5a7a8a", interactive: "#7c4a1f", border: "#d8c8b0", borderWeak: "#e6dac4", borderStrong: "#a8927a", card: "rgba(255, 250, 244, 0.9)", cardForeground: "#3a2a1e", muted: "#e6dac4", mutedForeground: "#7a6553", accent: "#a87742", accentForeground: "#fbf6ee" },
    { background: "#1a1310", backgroundWeak: "#120c0a", backgroundStrong: "#241a14", foreground: "#e8d9c4", foregroundWeak: "#a08d75", foregroundStrong: "#f5ead6", primary: "#c8956a", primaryForeground: "#1a1310", success: "#8fbf6a", warning: "#d6b14a", error: "#e57373", info: "#8aa8b8", interactive: "#c8956a", border: "#2c2018", borderWeak: "#1f1612", borderStrong: "#4a3a2a", card: "rgba(36, 26, 20, 0.9)", cardForeground: "#e8d9c4", muted: "#241a14", mutedForeground: "#a08d75", accent: "#d6a87a", accentForeground: "#1a1310" },
  ),
];

// Matches the desktop default (Pearl).
export const defaultThemeId = "pearl";

export function getThemeById(id: string): StellaTheme | undefined {
  return themes.find((t) => t.id === id);
}
