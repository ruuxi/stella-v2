import { useCallback, useMemo } from "react";
import { useTheme, useThemeControl } from "@/context/theme-context";
import { isHiddenOverlay } from "@stella/theme";

export function useOnboardingAppearance() {
  const { selectedThemeId, themes, colorMode, gradientMode, gradientColor, forcedMode } =
    useTheme();
  // While Custom is unpopulated the user is always on it; surface the stock
  // theme it's displaying as the "selected" one for the onboarding pills.
  const themeId = selectedThemeId;
  // Overlay themes (Custom) inherit their forced mode from the base; the
  // context resolves this for us.
  const isForcedTheme = forcedMode !== undefined;
  const {
    setTheme,
    setColorMode,
    previewTheme,
    cancelThemePreview,
    cancelPreview,
    setGradientMode,
    setGradientColor,
  } = useThemeControl();

  const sortedThemes = useMemo(
    () =>
      [...themes]
        .filter((t) => !isHiddenOverlay(t))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [themes],
  );

  const selectTheme = useCallback(
    (id: string) => {
      setTheme(id);
      cancelPreview();
    },
    [cancelPreview, setTheme],
  );

  return {
    colorMode,
    gradientColor,
    gradientMode,
    isForcedTheme,
    sortedThemes,
    themeId,
    cancelThemePreview,
    previewTheme,
    selectTheme,
    setColorMode,
    setGradientColor,
    setGradientMode,
  };
}
