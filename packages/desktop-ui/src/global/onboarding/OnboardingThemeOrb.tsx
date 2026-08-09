import type { Theme } from "@/shared/theme/themes";
import { ThemeOrb } from "@/ui/theme-orb";

type ThemeOrbProps = {
  theme: Theme;
  isDark: boolean;
  active: boolean;
  onSelect: () => void;
  onPreviewEnter: () => void;
};

/**
 * Onboarding's hit target around the shared theme swatch. The swatch itself
 * (and the palette it paints) lives in `@/ui/theme-orb`, shared with the
 * settings theme picker.
 */
export function OnboardingThemeOrb({
  theme,
  isDark,
  active,
  onSelect,
  onPreviewEnter,
}: ThemeOrbProps) {
  return (
    <button
      type="button"
      className="onboarding-theme-orb"
      data-active={active}
      aria-label={theme.name}
      aria-pressed={active}
      title={theme.name}
      onClick={onSelect}
      onMouseEnter={onPreviewEnter}
      onFocus={onPreviewEnter}
    >
      <ThemeOrb theme={theme} isDark={isDark} />
    </button>
  );
}
