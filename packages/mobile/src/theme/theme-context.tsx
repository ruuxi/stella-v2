import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setColorSchemeSafely } from "../carplay/carplay-appearance";
import { type Colors, lightColors, darkColors } from "./colors";
import { themes, defaultThemeId, getThemeById, type StellaTheme } from "./themes";

export type ThemePreference = "light" | "dark" | "system";

export type GradientMode = "soft" | "flat";

type ThemeContextValue = {

  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;

  theme: StellaTheme;
  setThemeId: (id: string) => void;

  themes: StellaTheme[];

  isDark: boolean;

  colors: Colors;

  gradientPreference: GradientMode;
  setGradientPreference: (mode: GradientMode) => void;

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

  const isDark = theme.forcedMode
    ? theme.forcedMode === "dark"
    : prefersDark;

  useEffect(() => {
    if (!loaded) return;

    setColorSchemeSafely(
      theme.forcedMode
        ? theme.forcedMode
        : preference === "system"
          ? "unspecified"
          : preference,
    );
  }, [loaded, preference, theme.forcedMode]);
  const colors = isDark ? theme.dark : theme.light;

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
