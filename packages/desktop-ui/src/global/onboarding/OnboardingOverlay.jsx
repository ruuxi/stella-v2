/**
 * Onboarding flow: Start -> Auth -> split layout steps.
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
import React, { useEffect, useState } from "react";
import { OnboardingStep1 } from "@/global/onboarding/OnboardingStep1";
import { StellaAnimation } from "@/shell/aurora/StellaAnimation";
import { disposeIdleAuroraRenderersFor } from "@/shell/aurora/renderer-pool";
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
/**
 * The creature's geometry, shared between the mount and the retire effect
 * below (both must resolve to the same pooled-renderer key).
 *
 * `star` — the star from the Stella mark, made of aurora, turning slowly at a
 * constant rate. The staged turn — crawl, whip, landing — belongs to the chat
 * working indicator instead: there it reads as effort, which is the whole point
 * of it and means nothing on a welcome screen. Width and height are in aurora
 * cells (5x7px at EDGE_SCALE
 * 2.5), picked so the canvas lands on a square 420x420: the star's arms are laid
 * out on a circular axis, so a square canvas is what keeps it from shearing.
 */
const CREATURE_AURORA = {
  variant: "star",
  width: 33.6,
  height: 24,
  maxDpr: 1,
};

export function OnboardingView({
  hasExpanded,
  onboardingDone,
  onboardingExiting,
  isAuthenticated,
  splitMode,
  splitEntering = false,
  hasStarted,
  stellaAnimationRef,
  onboardingKey,
  initialPhase = "capabilities",
  creatureInitialBirth,
  triggerFlash,
  startOnboarding,
  completeOnboarding,
  onDiscoveryConfirm,
  onPhaseChange,
  discoveryWelcomeExpected = false,
  discoveryWelcomeReady = false,
  stellaAnimationPaused = false,
  stellaAnimationHidden = false,
}) {
  const [activeLegalDoc, setActiveLegalDoc] = useState(null);
  // The creature appears exactly once per install, so the renderer it hands
  // back on unmount has no second customer — left pooled, its 420x420 GL
  // context stays resident for the rest of the process. Retired by geometry
  // rather than by variant so this stays correct however the creature is
  // skinned: the working indicator's pre-warmed context is a different size
  // and is never touched.
  //
  // Note this deliberately does NOT run when the creature alone remounts (the
  // split transition changes `maxFps`, which re-acquires): only the whole flow
  // going away retires the surface.
  //
  // Deferred a macrotask because React's ordering between this cleanup and
  // StellaAnimation's `releaseAuroraRenderer` is not something to depend on;
  // by the next task the entry is certainly back in the idle pool.
  useEffect(
    () => () => {
      setTimeout(() => disposeIdleAuroraRenderersFor(CREATURE_AURORA), 0);
    },
    [],
  );
  const t = useT();
  const { locale, setLocale, supportedLocales } = useI18n();
  // The creature is the hero visual of onboarding, so let it run at full
  // display rate. The reduced tiers use 30 (not 24/15/12) because caps that
  // don't divide 60Hz land frames on an uneven 33ms/50ms cadence — the
  // resulting judder reads far choppier than the raw rate suggests.
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
        data-hidden={stellaAnimationHidden || undefined}
        title="Click to sparkle"
      >
        <StellaAnimation
          ref={stellaAnimationRef}
          {...CREATURE_AURORA}
          maxFps={splitMode || lowPowerCreature ? 30 : 60}
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
