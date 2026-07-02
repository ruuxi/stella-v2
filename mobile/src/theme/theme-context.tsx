import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setColorSchemeSafely } from "../carplay/carplay-appearance";
import { type Colors, lightColors, darkColors } from "./colors";
import { themes, defaultThemeId, getThemeById, type StellaTheme } from "./themes";

export type ThemePreference = "light" | "dark" | "system";
/** Mirrors desktop's gradient setting — `soft` paints the shifting blob,
 *  `flat` paints the plain theme background with no gradient. Pearl/Noir
 *  always resolve to `flat` regardless of the stored preference. */
export type GradientMode = "soft" | "flat";

type ThemeContextValue = {
  /** Light / Dark / System preference. */
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  /** Currently active theme definition. */
  theme: StellaTheme;
  setThemeId: (id: string) => void;
  /** All available themes. */
  themes: StellaTheme[];
  /** Whether the resolved appearance is dark. */
  isDark: boolean;
  /** Resolved color palette. */
  colors: Colors;
  /** User's stored gradient preference (before forcedMode coercion). */
  gradientPreference: GradientMode;
  setGradientPreference: (mode: GradientMode) => void;
  /** Resolved gradient mode after applying theme `forcedMode` rules. */
  gradientMode: GradientMode;
};

const MODE_KEY = "stella-color-mode";
const THEME_KEY = "stella-theme-id";
const GRADIENT_KEY = "stella-gradient-mode";

const fallbackTheme: StellaTheme = {
  id: "__fallback",
  name: "Stella",
  light: lightColors,
  dark: darkColors,
};

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  setPreference: () => {},
  theme: fallbackTheme,
  setThemeId: () => {},
  themes,
  isDark: false,
  colors: lightColors,
  gradientPreference: "soft",
  setGradientPreference: () => {},
  gradientMode: "soft",
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [themeId, setThemeIdState] = useState(defaultThemeId);
  const [gradientPreference, setGradientPreferenceState] =
    useState<GradientMode>("soft");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void Promise.all([
      AsyncStorage.getItem(MODE_KEY),
      AsyncStorage.getItem(THEME_KEY),
      AsyncStorage.getItem(GRADIENT_KEY),
    ]).then(([storedMode, storedTheme, storedGradient]) => {
      if (storedMode === "light" || storedMode === "dark" || storedMode === "system") {
        setPreferenceState(storedMode);
      }
      if (storedTheme && getThemeById(storedTheme)) {
        setThemeIdState(storedTheme);
      }
      if (storedGradient === "soft" || storedGradient === "flat") {
        setGradientPreferenceState(storedGradient);
      }
      setLoaded(true);
    });
  }, []);

  const setPreference = (p: ThemePreference) => {
    setPreferenceState(p);
    void AsyncStorage.setItem(MODE_KEY, p);
  };

  const setThemeId = (id: string) => {
    if (getThemeById(id)) {
      setThemeIdState(id);
      void AsyncStorage.setItem(THEME_KEY, id);
    }
  };

  const setGradientPreference = (mode: GradientMode) => {
    setGradientPreferenceState(mode);
    void AsyncStorage.setItem(GRADIENT_KEY, mode);
  };

  const prefersDark =
    preference === "system" ? systemScheme === "dark" : preference === "dark";

  const theme = getThemeById(themeId) ?? fallbackTheme;
  // Pearl/Noir are pinned-mode themes on desktop; mirror that here so picking
  // Pearl while the phone is dark doesn't render its (nonexistent) dark
  // variant, and vice versa for Noir.
  const isDark = theme.forcedMode
    ? theme.forcedMode === "dark"
    : prefersDark;

  // Propagate the *resolved* appearance down to UIKit so system chrome (Liquid
  // Glass surfaces, native popovers, the keyboard appearance, the status bar
  // trait, etc.) matches the JS palette we actually render. We follow the
  // theme's `forcedMode` first — otherwise Pearl (forced light) over a dark OS,
  // or Noir (forced dark) over a light OS, leaves native glass rendering the
  // wrong scheme so it collides with the text color (e.g. light glass + light
  // text). Only when the theme has no forced mode do we defer to the picker.
  useEffect(() => {
    if (!loaded) return;
    // CarPlay-safe wrapper: the raw Appearance.setColorScheme crashes the
    // whole app while a CarPlay scene is connected (RCTAppearance walks
    // connectedScenes assuming UIWindowScene). See carplay-appearance.ts.
    setColorSchemeSafely(
      theme.forcedMode
        ? theme.forcedMode
        : preference === "system"
          ? "unspecified"
          : preference,
    );
  }, [loaded, preference, theme.forcedMode]);
  const colors = isDark ? theme.dark : theme.light;
  // Pearl/Noir are standardized single-surface themes — desktop coerces them
  // to flat (no gradient blob) regardless of preference, so do the same here.
  const gradientMode: GradientMode = theme.forcedMode ? "flat" : gradientPreference;

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      setPreference,
      theme,
      setThemeId,
      themes,
      isDark,
      colors,
      gradientPreference,
      setGradientPreference,
      gradientMode,
    }),
    [preference, themeId, isDark, gradientPreference, gradientMode],
  );

  if (!loaded) return null;

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function useColors() {
  return useContext(ThemeContext).colors;
}
