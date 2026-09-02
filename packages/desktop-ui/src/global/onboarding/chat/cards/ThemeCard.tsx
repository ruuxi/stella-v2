/**
 * "Make it yours" — theme selection inside the conversation.
 *
 * Appearance (light / dark / system) plus the theme swatches from Settings,
 * with hover preview so the whole window tries a theme on before the user
 * commits. The choice is applied live through the theme context, so
 * nothing here needs saving on Continue.
 */
import { useMemo, useState } from "react";
import { Button } from "@/ui/button";
import { ThemeOrb } from "@/ui/theme-orb";
import { Palette } from "@/ui/icons";
import { useTheme } from "@/context/theme-context";
import { useOnboardingAppearance } from "@/global/onboarding/use-onboarding-appearance";
import { useT } from "@/shared/i18n";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";

type ThemeCardProps = {
  active: boolean;
  answered: OnboardingChatAnswer | undefined;
  onAnswer: (answer: OnboardingChatAnswer) => void;
};

const COLOR_MODES = ["light", "dark", "system"] as const;

export function ThemeCard({ active, answered, onAnswer }: ThemeCardProps) {
  const t = useT();
  const { resolvedColorMode, flat } = useTheme();
  const appearance = useOnboardingAppearance();
  const [hoveredThemeId, setHoveredThemeId] = useState<string | null>(null);
  const isDark = resolvedColorMode === "dark";

  const selectedTheme = useMemo(
    () => appearance.sortedThemes.find((theme) => theme.id === appearance.themeId),
    [appearance.sortedThemes, appearance.themeId],
  );
  const hoveredTheme = useMemo(
    () => appearance.sortedThemes.find((theme) => theme.id === hoveredThemeId),
    [appearance.sortedThemes, hoveredThemeId],
  );

  const modeLabel = (mode: (typeof COLOR_MODES)[number]) =>
    t(`onboarding.chat.theme.mode.${mode}`);

  if (answered !== undefined) {
    return (
      <div className="obc-card" data-settled>
        {selectedTheme ? (
          <span className="obc-theme-orb obc-theme-orb--settled" aria-hidden="true">
            <ThemeOrb theme={selectedTheme} isDark={isDark} />
          </span>
        ) : (
          <span className="obc-card__settled-icon">
            <Palette size={15} />
          </span>
        )}
        <span className="obc-card__settled-text">
          <span className="obc-card__settled-title">
            {selectedTheme?.name ?? t("onboarding.chat.theme.settledTitle")}
          </span>
          <span className="obc-card__settled-desc">
            {modeLabel(appearance.colorMode)}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="obc-card">
      <div className="obc-card__section">
        <h3 className="obc-card__title">{t("onboarding.chat.theme.title")}</h3>
        <p className="obc-card__body">{t("onboarding.chat.theme.body")}</p>
      </div>

      <div className="obc-card__section">
        <span className="obc-card__label">
          {t("onboarding.chat.theme.appearance")}
        </span>
        <div className="obc-segment" role="radiogroup">
          {COLOR_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={appearance.colorMode === mode}
              className="obc-segment__btn"
              data-active={appearance.colorMode === mode}
              disabled={!active}
              onClick={() => appearance.setColorMode(mode)}
            >
              {modeLabel(mode)}
            </button>
          ))}
        </div>
      </div>

      <div className="obc-card__section">
        <div className="obc-theme-readout">
          <span className="obc-card__label">
            {t("onboarding.chat.theme.themes")}
          </span>
          <span className="obc-theme-readout__name" aria-live="polite">
            {(hoveredTheme ?? selectedTheme)?.name ?? ""}
          </span>
        </div>
        <div
          className="obc-theme-grid"
          onMouseLeave={() => {
            setHoveredThemeId(null);
            appearance.cancelThemePreview();
          }}
        >
          {appearance.sortedThemes.map((theme) => {
            const isSelected = theme.id === appearance.themeId;
            const preview = () => {
              if (!active) return;
              setHoveredThemeId(theme.id);
              appearance.previewTheme(theme.id);
            };
            return (
              <button
                key={theme.id}
                type="button"
                className="obc-theme-orb"
                data-active={isSelected}
                aria-label={theme.name}
                aria-pressed={isSelected}
                title={theme.name}
                disabled={!active}
                onClick={() => appearance.selectTheme(theme.id)}
                onMouseEnter={preview}
                onFocus={preview}
                onBlur={() => {
                  setHoveredThemeId(null);
                  appearance.cancelThemePreview();
                }}
              >
                <ThemeOrb theme={theme} isDark={isDark} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="obc-card__section" data-disabled={flat || undefined}>
        <div className="obc-theme-rows">
          <div className="obc-theme-row">
            <span className="obc-card__label">
              {t("onboarding.chat.theme.gradientStyle")}
            </span>
            <div className="obc-segment" role="radiogroup">
              {(["soft", "flat"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={appearance.gradientMode === value}
                  className="obc-segment__btn"
                  data-active={appearance.gradientMode === value}
                  disabled={!active || flat}
                  onClick={() => appearance.setGradientMode(value)}
                >
                  {t(`onboarding.chat.theme.gradient.${value}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="obc-theme-row">
            <span className="obc-card__label">
              {t("onboarding.chat.theme.gradientColor")}
            </span>
            <div className="obc-segment" role="radiogroup">
              {(["relative", "strong"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={appearance.gradientColor === value}
                  className="obc-segment__btn"
                  data-active={appearance.gradientColor === value}
                  disabled={!active || flat}
                  onClick={() => appearance.setGradientColor(value)}
                >
                  {t(`onboarding.chat.theme.gradient.${value}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="obc-actions">
        <Button
          type="button"
          variant="primary"
          disabled={!active}
          onClick={() => onAnswer("done")}
        >
          {t("onboarding.chat.theme.confirm")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!active}
          onClick={() => onAnswer("skipped")}
        >
          {t("onboarding.chat.theme.skip")}
        </Button>
        <span className="obc-actions__spacer" />
        <span className="obc-actions__hint">
          {t("onboarding.chat.theme.hint")}
        </span>
      </div>
    </div>
  );
}
