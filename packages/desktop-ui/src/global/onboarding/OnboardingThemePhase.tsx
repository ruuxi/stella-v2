import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/context/theme-context";
import { getThemeById, type Theme } from "@/shared/theme/themes";
import { OnboardingThemeOrb } from "./OnboardingThemeOrb";

type ThemePhaseProps = {
  colorMode: "light" | "dark" | "system";
  gradientColor: "relative" | "strong";
  gradientMode: "soft" | "flat";
  sortedThemes: Theme[];
  splitTransitionActive: boolean;
  themeId: string;
  onContinue: () => void;
  onSelectColorMode: (mode: "light" | "dark" | "system") => void;
  onSelectGradientColor: (color: "relative" | "strong") => void;
  onSelectGradientMode: (mode: "soft" | "flat") => void;
  onSelectTheme: (id: string) => void;
  onThemePreviewEnter: (id: string) => void;
  onThemePreviewLeave: () => void;
};

const DISPLAY_LABELS: Record<string, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
  soft: "Soft",
  flat: "Flat",
  relative: "Relative",
  strong: "Strong",
};

const renderThemeOptionRow = <T extends string>(
  label: string,
  options: readonly T[],
  selectedValue: T,
  onSelect: (value: T) => void,
  disabledOptions?: readonly T[],
) => {
  const disabled = new Set(disabledOptions ?? []);
  return (
    <>
      <div className="onboarding-step-label">{label}</div>
      <div className="onboarding-theme-row">
        {options.map((option) => {
          const isDisabled = disabled.has(option);
          return (
            <button
              key={option}
              type="button"
              className="onboarding-pill"
              data-active={selectedValue === option}
              data-disabled={isDisabled || undefined}
              disabled={isDisabled}
              onClick={() => {
                if (isDisabled) return;
                onSelect(option);
              }}
            >
              {DISPLAY_LABELS[option] ??
                option.charAt(0).toUpperCase() + option.slice(1)}
            </button>
          );
        })}
      </div>
    </>
  );
};

const applyForcedThemePreferences = (
  forcedMode: "light" | "dark",
  onSelectColorMode: (mode: "light" | "dark" | "system") => void,
  onSelectGradientMode: (mode: "soft" | "flat") => void,
  onSelectGradientColor: (color: "relative" | "strong") => void,
) => {
  onSelectColorMode(forcedMode);
  onSelectGradientMode("flat");
  onSelectGradientColor("strong");
};

export function OnboardingThemePhase({
  colorMode,
  gradientColor,
  gradientMode,
  sortedThemes,
  splitTransitionActive,
  themeId,
  onContinue,
  onSelectColorMode,
  onSelectGradientColor,
  onSelectGradientMode,
  onSelectTheme,
  onThemePreviewEnter,
  onThemePreviewLeave,
}: ThemePhaseProps) {
  const [showAppearance, setShowAppearance] = useState(false);
  const [showGradientStyle, setShowGradientStyle] = useState(false);
  const [showGradientColor, setShowGradientColor] = useState(false);
  const [hasSelectedGradientColor, setHasSelectedGradientColor] = useState(false);

  const [hoveredThemeId, setHoveredThemeId] = useState<string | null>(null);

  const { resolvedColorMode } = useTheme();

  const selectedTheme = useMemo(() => getThemeById(themeId), [themeId]);

  const forcedMode = useMemo(() => {
    if (!selectedTheme) return undefined;
    if (selectedTheme.forcedMode) return selectedTheme.forcedMode;
    return selectedTheme.base ? getThemeById(selectedTheme.base)?.forcedMode : undefined;
  }, [selectedTheme]);

  const previewFrameRef = useRef<number | null>(null);
  const pendingPreviewIdRef = useRef<string | null>(null);
  const handleThemePreviewEnter = useCallback(
    (id: string) => {
      pendingPreviewIdRef.current = id;
      if (previewFrameRef.current !== null) return;
      previewFrameRef.current = requestAnimationFrame(() => {
        previewFrameRef.current = null;
        const next = pendingPreviewIdRef.current;
        if (next !== null) onThemePreviewEnter(next);
      });
    },
    [onThemePreviewEnter],
  );
  const handleThemePreviewLeave = useCallback(() => {
    pendingPreviewIdRef.current = null;
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    setHoveredThemeId(null);
    onThemePreviewLeave();
  }, [onThemePreviewLeave]);
  useEffect(
    () => () => {
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
      }
    },
    [],
  );

  const handleSelectTheme = useCallback(
    (id: string) => {
      const nextTheme = getThemeById(id);
      onSelectTheme(id);
      if (nextTheme?.forcedMode) {
        applyForcedThemePreferences(
          nextTheme.forcedMode,
          onSelectColorMode,
          onSelectGradientMode,
          onSelectGradientColor,
        );
        return;
      }

      setShowAppearance(true);
    },
    [
      onSelectTheme,
      onSelectColorMode,
      onSelectGradientMode,
      onSelectGradientColor,
    ],
  );

  const handleSelectColorMode = useCallback(
    (mode: "light" | "dark" | "system") => {
      if (forcedMode) return;
      onSelectColorMode(mode);
      setShowGradientStyle(true);
    },
    [forcedMode, onSelectColorMode],
  );

  const handleSelectGradientMode = useCallback(
    (mode: "soft" | "flat") => {
      if (forcedMode) return;
      onSelectGradientMode(mode);
      setShowGradientColor(true);
    },
    [forcedMode, onSelectGradientMode],
  );

  const handleSelectGradientColor = useCallback(
    (color: "relative" | "strong") => {
      if (forcedMode) return;
      onSelectGradientColor(color);
      setHasSelectedGradientColor(true);
    },
    [forcedMode, onSelectGradientColor],
  );

  const effectiveColorMode = forcedMode ?? colorMode;
  const effectiveGradientMode = forcedMode ? "flat" : gradientMode;
  const effectiveGradientColor = forcedMode ? "strong" : gradientColor;

  const appearanceDisabled = useMemo((): Array<"light" | "dark" | "system"> => {
    if (forcedMode === "light") return ["dark", "system"];
    if (forcedMode === "dark") return ["light", "system"];
    return [];
  }, [forcedMode]);

  const gradientStyleDisabled = forcedMode ? (["soft"] as const) : [];
  const gradientColorDisabled = forcedMode ? (["relative"] as const) : [];

  const canContinue =
    forcedMode
      ? true
      : showAppearance &&
        showGradientStyle &&
        showGradientColor &&
        hasSelectedGradientColor;

  return (
    <div className="onboarding-step-content">
      <div className="onboarding-step-label">Theme</div>
      <div
        className="onboarding-theme-grid onboarding-theme-grid--orbs onboarding-pill-stagger"
        onMouseLeave={handleThemePreviewLeave}
      >
        {sortedThemes.map((theme) => (
          <OnboardingThemeOrb
            key={theme.id}
            theme={theme}
            isDark={resolvedColorMode === "dark"}
            active={theme.id === themeId}
            onSelect={() => handleSelectTheme(theme.id)}
            onPreviewEnter={() => {
              setHoveredThemeId(theme.id);
              handleThemePreviewEnter(theme.id);
            }}
          />
        ))}
      </div>
      <div className="onboarding-theme-orb-caption" aria-live="polite">
        {getThemeById(hoveredThemeId ?? themeId)?.name ?? ""}
      </div>

      <div
        className="onboarding-theme-grow-in"
        data-visible={(!forcedMode && showAppearance) || undefined}
      >
        <div className="onboarding-theme-grow-in-inner">
          {renderThemeOptionRow(
            "Appearance",
            ["light", "dark", "system"] as const,
            effectiveColorMode,
            handleSelectColorMode,
            appearanceDisabled,
          )}
        </div>
      </div>

      <div
        className="onboarding-theme-grow-in onboarding-theme-grow-in--delayed-1"
        data-visible={(!forcedMode && showGradientStyle) || undefined}
      >
        <div className="onboarding-theme-grow-in-inner">
          {renderThemeOptionRow(
            "Gradient Style",
            ["soft", "flat"] as const,
            effectiveGradientMode,
            handleSelectGradientMode,
            gradientStyleDisabled,
          )}
        </div>
      </div>

      <div
        className="onboarding-theme-grow-in onboarding-theme-grow-in--delayed-2"
        data-visible={(!forcedMode && showGradientColor) || undefined}
      >
        <div className="onboarding-theme-grow-in-inner">
          {renderThemeOptionRow(
            "Gradient Color",
            ["relative", "strong"] as const,
            effectiveGradientColor,
            handleSelectGradientColor,
            gradientColorDisabled,
          )}
        </div>
      </div>

      <button
        className="onboarding-confirm"
        data-visible={canContinue || undefined}
        disabled={splitTransitionActive || !canContinue}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}
