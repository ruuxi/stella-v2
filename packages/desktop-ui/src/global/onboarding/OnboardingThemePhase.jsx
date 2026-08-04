import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getThemeById } from "@/shared/theme/themes";
/** User-friendly display labels for option values */
const DISPLAY_LABELS = {
    light: "Light",
    dark: "Dark",
    system: "System",
    soft: "Soft",
    flat: "Flat",
    relative: "Relative",
    strong: "Strong",
};
const renderThemeOptionRow = (label, options, selectedValue, onSelect, disabledOptions) => {
    const disabled = new Set(disabledOptions ?? []);
    return (<>
      <div className="onboarding-step-label">{label}</div>
      <div className="onboarding-theme-row">
        {options.map((option) => {
            const isDisabled = disabled.has(option);
            return (<button key={option} type="button" className="onboarding-pill" data-active={selectedValue === option} data-disabled={isDisabled || undefined} disabled={isDisabled} onClick={() => {
                    if (isDisabled)
                        return;
                    onSelect(option);
                }}>
              {DISPLAY_LABELS[option] ??
                    option.charAt(0).toUpperCase() + option.slice(1)}
            </button>);
        })}
      </div>
    </>);
};
/** Pearl / Noir ignore gradient controls — flat surface, strong color. */
const applyForcedThemePreferences = (forcedMode, onSelectColorMode, onSelectGradientMode, onSelectGradientColor) => {
    onSelectColorMode(forcedMode);
    onSelectGradientMode("flat");
    onSelectGradientColor("strong");
};
export function OnboardingThemePhase({ colorMode, gradientColor, gradientMode, sortedThemes, splitTransitionActive, themeId, onContinue, onSelectColorMode, onSelectGradientColor, onSelectGradientMode, onSelectTheme, onThemePreviewEnter, onThemePreviewLeave, }) {
    const [showAppearance, setShowAppearance] = useState(false);
    const [showGradientStyle, setShowGradientStyle] = useState(false);
    const [showGradientColor, setShowGradientColor] = useState(false);
    const [hasSelectedGradientColor, setHasSelectedGradientColor] = useState(false);
    const selectedTheme = useMemo(() => getThemeById(themeId), [themeId]);
    // Overlay themes (Custom) inherit their forced appearance from the base.
    const forcedMode = useMemo(() => {
        if (!selectedTheme)
            return undefined;
        if (selectedTheme.forcedMode)
            return selectedTheme.forcedMode;
        return selectedTheme.base ? getThemeById(selectedTheme.base)?.forcedMode : undefined;
    }, [selectedTheme]);
    // rAF-coalesce theme preview hover. `previewTheme(id)` writes CSS
    // variables on `:root` and triggers a full-tree style recalc; sweeping
    // the cursor across the pill row would otherwise fire one such
    // recalc per `mouseenter` (potentially several per frame). We commit
    // only the latest hovered theme on the next animation frame.
    const previewFrameRef = useRef(null);
    const pendingPreviewIdRef = useRef(null);
    const handleThemePreviewEnter = useCallback((id) => {
        pendingPreviewIdRef.current = id;
        if (previewFrameRef.current !== null)
            return;
        previewFrameRef.current = requestAnimationFrame(() => {
            previewFrameRef.current = null;
            const next = pendingPreviewIdRef.current;
            if (next !== null)
                onThemePreviewEnter(next);
        });
    }, [onThemePreviewEnter]);
    const handleThemePreviewLeave = useCallback(() => {
        pendingPreviewIdRef.current = null;
        if (previewFrameRef.current !== null) {
            cancelAnimationFrame(previewFrameRef.current);
            previewFrameRef.current = null;
        }
        onThemePreviewLeave();
    }, [onThemePreviewLeave]);
    useEffect(() => () => {
        if (previewFrameRef.current !== null) {
            cancelAnimationFrame(previewFrameRef.current);
            previewFrameRef.current = null;
        }
    }, []);
    const handleSelectTheme = useCallback((id) => {
        const nextTheme = getThemeById(id);
        onSelectTheme(id);
        if (nextTheme?.forcedMode) {
            applyForcedThemePreferences(nextTheme.forcedMode, onSelectColorMode, onSelectGradientMode, onSelectGradientColor);
            return;
        }
        // Regular themes: only ensure Appearance is visible on the very
        // first pick. Switching themes (including Pearl/Noir → anything
        // else) never collapses the sub-rows — only pill disabled states
        // change via `forcedMode`.
        setShowAppearance(true);
    }, [
        onSelectTheme,
        onSelectColorMode,
        onSelectGradientMode,
        onSelectGradientColor,
    ]);
    const handleSelectColorMode = useCallback((mode) => {
        if (forcedMode)
            return;
        onSelectColorMode(mode);
        setShowGradientStyle(true);
    }, [forcedMode, onSelectColorMode]);
    const handleSelectGradientMode = useCallback((mode) => {
        if (forcedMode)
            return;
        onSelectGradientMode(mode);
        setShowGradientColor(true);
    }, [forcedMode, onSelectGradientMode]);
    const handleSelectGradientColor = useCallback((color) => {
        if (forcedMode)
            return;
        onSelectGradientColor(color);
        setHasSelectedGradientColor(true);
    }, [forcedMode, onSelectGradientColor]);
    const effectiveColorMode = forcedMode ?? colorMode;
    const effectiveGradientMode = forcedMode ? "flat" : gradientMode;
    const effectiveGradientColor = forcedMode ? "strong" : gradientColor;
    const appearanceDisabled = useMemo(() => {
        if (forcedMode === "light")
            return ["dark", "system"];
        if (forcedMode === "dark")
            return ["light", "system"];
        return [];
    }, [forcedMode]);
    const gradientStyleDisabled = forcedMode ? ["soft"] : [];
    const gradientColorDisabled = forcedMode ? ["relative"] : [];
    // Pearl / Noir are single-surface themes — no sub-rows to reveal.
    // Regular themes use click-to-reveal: Theme → Appearance → Gradient
    // Style → Gradient Color.
    const canContinue = forcedMode
        ? true
        : showAppearance &&
            showGradientStyle &&
            showGradientColor &&
            hasSelectedGradientColor;
    return (<div className="onboarding-step-content">
      <div className="onboarding-step-label">Theme</div>
      <div className="onboarding-theme-grid onboarding-pill-stagger" onMouseLeave={handleThemePreviewLeave}>
        {sortedThemes.map((theme) => (<button key={theme.id} type="button" className="onboarding-pill" data-active={theme.id === themeId} onClick={() => handleSelectTheme(theme.id)} onMouseEnter={() => handleThemePreviewEnter(theme.id)}>
            {theme.name}
          </button>))}
      </div>

      <div className="onboarding-theme-grow-in" data-visible={(!forcedMode && showAppearance) || undefined}>
        <div className="onboarding-theme-grow-in-inner">
          {renderThemeOptionRow("Appearance", ["light", "dark", "system"], effectiveColorMode, handleSelectColorMode, appearanceDisabled)}
        </div>
      </div>

      <div className="onboarding-theme-grow-in onboarding-theme-grow-in--delayed-1" data-visible={(!forcedMode && showGradientStyle) || undefined}>
        <div className="onboarding-theme-grow-in-inner">
          {renderThemeOptionRow("Gradient Style", ["soft", "flat"], effectiveGradientMode, handleSelectGradientMode, gradientStyleDisabled)}
        </div>
      </div>

      <div className="onboarding-theme-grow-in onboarding-theme-grow-in--delayed-2" data-visible={(!forcedMode && showGradientColor) || undefined}>
        <div className="onboarding-theme-grow-in-inner">
          {renderThemeOptionRow("Gradient Color", ["relative", "strong"], effectiveGradientColor, handleSelectGradientColor, gradientColorDisabled)}
        </div>
      </div>

      <button className="onboarding-confirm" data-visible={canContinue || undefined} disabled={splitTransitionActive || !canContinue} onClick={onContinue}>
        Continue
      </button>
    </div>);
}
