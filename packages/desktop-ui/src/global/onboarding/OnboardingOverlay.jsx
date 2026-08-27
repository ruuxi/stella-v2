import React, { useEffect, useState } from "react";
import { OnboardingStep1 } from "@/global/onboarding/OnboardingStep1";
import { StellaAnimation } from "@/shell/aurora/StellaAnimation";
import { disposeIdleAuroraRenderersFor } from "@/shell/aurora/renderer-pool";
import { LegalDialog } from "@/global/legal/LegalDialog";
import { shouldUseLowPowerEffects } from "@/shared/lib/device-perf";
import { LOCALE_NATIVE_LABELS, useI18n, useT } from "@/shared/i18n";
import { Select } from "@/ui/select";

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

  useEffect(
    () => () => {
      setTimeout(() => disposeIdleAuroraRenderersFor(CREATURE_AURORA), 0);
    },
    [],
  );
  const t = useT();
  const { locale, setLocale, supportedLocales } = useI18n();

  const lowPowerCreature = shouldUseLowPowerEffects();

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
      {hasStarted ? (
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
            initialBirthProgress={1}
            paused={
              stellaAnimationPaused ||
              stellaAnimationHidden ||
              (splitMode && lowPowerCreature)
            }
          />
        </div>
      ) : null}
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
                onClick={startOnboarding}
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
