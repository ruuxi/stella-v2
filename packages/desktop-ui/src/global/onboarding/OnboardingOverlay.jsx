/**
 * Onboarding flow: Start -> Auth -> Intro (center) -> split layout steps.
 *
 * This module is the heavy "view" half of the onboarding overlay. It is
 * lazy-loaded by FullShell as a single onboarding chunk that pulls in
 * every phase component, the StellaAnimation aurora, the legal dialog,
 * and all onboarding CSS. Once the chunk has loaded, every transition
 * inside the flow is synchronous — there are no nested Suspense
 * boundaries below this point.
 *
 * The hook half (`useOnboardingOverlay`) lives in `use-onboarding-overlay.ts`
 * so FullShell can read onboarding state (`onboardingDone`, etc.) without
 * importing this view tree into the main bundle. Returning users — for
 * whom `appReady === true` at first paint — never fetch this chunk.
 */
import React, { useState } from "react";
import { OnboardingStep1 } from "@/global/onboarding/OnboardingStep1";
import { StellaAnimation } from "@/shell/aurora/StellaAnimation";
import { LegalDialog } from "@/global/legal/LegalDialog";
import { CREATURE_INITIAL_SIZE } from "@/global/onboarding/use-onboarding-overlay";
import { shouldUseLowPowerEffects } from "@/shared/lib/device-perf";
import { LOCALE_NATIVE_LABELS, useI18n, useT } from "@/shared/i18n";
import { Select } from "@/ui/select";
// IMPORTANT: this module is the lazy "onboarding chunk". Do NOT re-export
// the `useOnboardingOverlay` hook from here — FullShell needs to call
// the hook synchronously to read `onboardingDone`, and re-exporting from
// a heavy module risks pulling the view tree (StellaStep1, all phases,
// StellaAnimation, LegalDialog) into the main bundle. Always import the
// hook directly from `@/global/onboarding/use-onboarding-overlay`.
/**
 * Renders a localized "By using Stella, you agree to our {terms} and
 * {privacy}." line by splitting the translated template at the
 * `{terms}` / `{privacy}` placeholders so each becomes a real button.
 * Word order varies by locale (German moves verbs to the end, Hebrew
 * reads right-to-left, Japanese inserts particles), so we never
 * assume "agree to" + "and" + "." with linkified words appended.
 */
function LegalFooter({
  template,
  termsLabel,
  privacyLabel,
  onTermsClick,
  onPrivacyClick,
}) {
  const slots = {
    terms: (
      <button
        type="button"
        className="onboarding-legal-link"
        onClick={onTermsClick}
      >
        {termsLabel}
      </button>
    ),
    privacy: (
      <button
        type="button"
        className="onboarding-legal-link"
        onClick={onPrivacyClick}
      >
        {privacyLabel}
      </button>
    ),
  };
  // Split into [literal, slotName, literal, slotName, …]; even indices
  // are literal text, odd indices are placeholder names.
  const parts = template.split(/\{(\w+)\}/);
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) return <span key={index}>{part}</span>;
        return <span key={index}>{slots[part] ?? `{${part}}`}</span>;
      })}
    </>
  );
}
export function OnboardingView({
  hasExpanded,
  onboardingDone,
  onboardingExiting,
  isAuthenticated,
  splitMode,
  splitEntering = false,
  hasDiscoverySelections,
  hasStarted,
  stellaAnimationRef,
  onboardingKey,
  initialPhase = "intro",
  creatureInitialBirth,
  triggerFlash,
  startOnboarding,
  completeOnboarding,
  handleEnterSplit,
  onDiscoveryConfirm,
  onSelectionChange,
  onPhaseChange,
  discoveryWelcomeExpected = false,
  discoveryWelcomeReady = false,
  stellaAnimationPaused = false,
  stellaAnimationHidden = false,
}) {
  const [activeLegalDoc, setActiveLegalDoc] = useState(null);
  const t = useT();
  const { locale, setLocale, supportedLocales } = useI18n();
  // The creature is a hero visual, but onboarding is long-lived. Keep its
  // canvas at a deliberately small render budget even on fast machines so
  // it never competes with onboarding controls for the renderer thread.
  const lowPowerCreature = shouldUseLowPowerEffects();
  // The language switch is only relevant on the very first screen —
  // once the user starts, every other phase has its own layout and
  // settings already exposes the picker afterwards.
  const showLanguageSwitch = !hasStarted && !onboardingDone;
  return (
    <div
      className="new-session-view"
      data-split={splitMode}
      data-exiting={onboardingExiting || undefined}
    >
      <LegalDialog
        document={activeLegalDoc}
        onOpenChange={(open) => {
          if (!open) setActiveLegalDoc(null);
        }}
      />
      {showLanguageSwitch ? (
        <div className="onboarding-language-switch">
          <Select
            className="onboarding-language-switch-select"
            value={locale}
            aria-label={t("common.language")}
            onValueChange={(value) => setLocale(value)}
            options={supportedLocales.map((code) => ({
              value: code,
              label: LOCALE_NATIVE_LABELS[code],
            }))}
          />
        </div>
      ) : null}
      <div
        className="new-session-title"
        data-expanded={hasExpanded ? "true" : "false"}
      >
        Stella
      </div>
      <div
        className="onboarding-stella-animation"
        onClick={stellaAnimationHidden ? undefined : triggerFlash}
        data-expanded={hasExpanded ? "true" : "false"}
        data-split={splitMode}
        data-split-entering={splitEntering || undefined}
        data-has-selections={hasDiscoverySelections || undefined}
        data-hidden={stellaAnimationHidden || undefined}
        title="Click to sparkle"
      >
        <StellaAnimation
          ref={stellaAnimationRef}
          variant="waves"
          width={70}
          height={39}
          maxDpr={1}
          maxFps={splitMode ? 12 : lowPowerCreature ? 15 : 24}
          requireWindowFocus
          initialBirthProgress={
            creatureInitialBirth ?? (onboardingDone ? 1 : CREATURE_INITIAL_SIZE)
          }
          paused={
            stellaAnimationPaused ||
            stellaAnimationHidden ||
            (splitMode && lowPowerCreature)
          }
        />
      </div>
      {!onboardingDone &&
        (hasStarted ? (
          <OnboardingStep1
            key={onboardingKey}
            initialPhase={initialPhase}
            onComplete={completeOnboarding}
            onInteract={triggerFlash}
            onDiscoveryConfirm={onDiscoveryConfirm}
            onEnterSplit={handleEnterSplit}
            onSelectionChange={onSelectionChange}
            onPhaseChange={onPhaseChange}
            isAuthenticated={isAuthenticated}
            discoveryWelcomeExpected={discoveryWelcomeExpected}
            discoveryWelcomeReady={discoveryWelcomeReady}
          />
        ) : (
          <>
            <div className="onboarding-moment onboarding-moment--start">
              <button
                className="onboarding-start-button"
                onClick={() => {
                  startOnboarding();
                  triggerFlash();
                }}
              >
                {t("onboarding.startStella")}
              </button>
            </div>
            <div className="onboarding-legal-footer onboarding-legal-footer--new-session">
              <LegalFooter
                template={t("onboarding.legalFooter")}
                termsLabel={t("onboarding.termsOfService")}
                privacyLabel={t("onboarding.privacyPolicy")}
                onTermsClick={() => setActiveLegalDoc("terms")}
                onPrivacyClick={() => setActiveLegalDoc("privacy")}
              />
            </div>
          </>
        ))}
    </div>
  );
}
