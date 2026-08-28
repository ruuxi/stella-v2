import { useCallback, useMemo } from "react";
import { useTheme, useThemeControl } from "@/context/theme-context";
import { isHiddenOverlay } from "@/shared/theme/themes";

export function useOnboardingAppearance() {
  const { selectedThemeId, themes, colorMode, gradientMode, gradientColor, forcedMode } =
    useTheme();

  const themeId = selectedThemeId;

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
