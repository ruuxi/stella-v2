import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { useTheme } from "@/context/theme-context";
import { useUiState } from "@/context/ui-state";
import {
  CREATURE_HIDDEN_PHASES,
  type Phase as OnboardingPhase,
} from "@/global/onboarding/onboarding-flow";
import { useDiscoveryFlow } from "@/global/onboarding/DiscoveryFlow";
import { useOnboardingOverlay } from "@/global/onboarding/use-onboarding-overlay";
import {
  readLocalOnboardingCompleted,
  useOnboardingState,
} from "@/global/onboarding/use-onboarding-state";
import { useBootstrapState } from "@/bootstrap/bootstrap-state";
import { router } from "@/router";
import { ShiftingGradient } from "./background/ShiftingGradient";
import { AskStellaSelectionChip } from "./selection/AskStellaSelectionChip";
import "./full-shell.layout.css";
import "./mobile.css";

const onboardingChunkPromise: { current: Promise<unknown> | null } = {
  current: null,
};
const loadOnboardingChunk = () => {
  if (!onboardingChunkPromise.current) {
    onboardingChunkPromise.current = import(
      "@/global/onboarding/OnboardingOverlay"
    );
  }
  return onboardingChunkPromise.current;
};

const OnboardingView = lazy(() =>
  import("@/global/onboarding/OnboardingOverlay").then((module) => ({
    default: module.OnboardingView,
  })),
);

const dismissLaunchSplash = () => {
  const launch = document.getElementById("stella-launch");
  if (!launch) return;

  launch.dataset.exiting = "true";
  window.setTimeout(() => {
    launch.remove();
  }, 260);
};

type OnboardingExperienceProps = {
  activeConversationId: string | null;
  onEnteredApp: () => void;
};

function OnboardingExperience({
  activeConversationId,
  onEnteredApp,
}: OnboardingExperienceProps) {
  const [stellaHiddenByPhase, setStellaHiddenByPhase] = useState(false);
  const onboarding = useOnboardingOverlay();
  const {
    handleDiscoveryConfirm,
    discoveryWelcomeExpected,
    discoveryWelcomeReady,
  } = useDiscoveryFlow({
    conversationId: activeConversationId,
  });

  useEffect(() => {
    let cancelled = false;
    void loadOnboardingChunk().finally(() => {
      if (!cancelled) dismissLaunchSplash();
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleOnboardingPhaseChange = useCallback(
    (phase: OnboardingPhase) => {
      onboarding.persistPhase(phase);
      setStellaHiddenByPhase(CREATURE_HIDDEN_PHASES.has(phase));
    },
    [onboarding],
  );

  const pauseStellaAnimation =
    onboarding.onboardingExiting || stellaHiddenByPhase;

  useEffect(() => {
    if (!onboarding.onboardingDone) return;
    onEnteredApp();
  }, [onEnteredApp, onboarding.onboardingDone]);

  return (
    <div
      className="onboarding-layout"
      data-split={onboarding.splitMode || undefined}
    >
      <Suspense fallback={null}>
        <OnboardingView
          hasExpanded={onboarding.hasExpanded}
          onboardingDone={onboarding.onboardingDone}
          onboardingExiting={onboarding.onboardingExiting}
          isAuthenticated={onboarding.isAuthenticated}
          splitMode={onboarding.splitMode}
          splitEntering={onboarding.splitEntering}
          hasStarted={onboarding.hasStarted}
          stellaAnimationRef={onboarding.stellaAnimationRef}
          stellaAnimationPaused={pauseStellaAnimation}
          stellaAnimationHidden={stellaHiddenByPhase}
          onboardingKey={onboarding.onboardingKey}
          initialPhase={onboarding.initialPhase}
          triggerFlash={onboarding.triggerFlash}
          startOnboarding={onboarding.startOnboarding}
          completeOnboarding={onboarding.completeOnboarding}
          onDiscoveryConfirm={handleDiscoveryConfirm}
          onPhaseChange={handleOnboardingPhaseChange}
          discoveryWelcomeExpected={discoveryWelcomeExpected}
          discoveryWelcomeReady={discoveryWelcomeReady}
        />
      </Suspense>
    </div>
  );
}

export const FullShell = () => {
  const { state } = useUiState();
  const activeConversationId = state.conversationId;
  const { gradientMode, gradientColor } = useTheme();
  const { completed: onboardingDone, hydrated: onboardingHydrated } =
    useOnboardingState();

  const [hasEnteredApp, setHasEnteredApp] = useState(
    () => readLocalOnboardingCompleted(),
  );
  const { runtimeStatus, retryRuntimeBootstrap } = useBootstrapState();

  const onboardingResolved = onboardingHydrated || onboardingDone;
  const appReady = onboardingResolved && onboardingDone && hasEnteredApp;
  const needsOnboarding = onboardingHydrated && !onboardingDone;

  useEffect(() => {
    if (!onboardingResolved || !onboardingDone) return;
    const timer = window.setTimeout(() => {
      setHasEnteredApp(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [onboardingDone, onboardingResolved]);

  useEffect(() => {
    window.electronAPI?.ui.setAppReady?.(appReady);
  }, [appReady]);

  useEffect(() => {
    if (appReady) {
      dismissLaunchSplash();
    }
  }, [appReady]);

  useEffect(() => {
    if (!appReady) return;
    if (activeConversationId) return;
    if (runtimeStatus !== "ready") return;

    retryRuntimeBootstrap();
  }, [activeConversationId, appReady, retryRuntimeBootstrap, runtimeStatus]);

  return (
    <div
      className="window-shell full"
      data-window-mode={needsOnboarding ? "onboarding" : "app"}
    >
      <ShiftingGradient
        mode={gradientMode}
        colorMode={gradientColor}
        lightweight={false}
      />
      <div className="full-body">
        {appReady ? (
          <>
            <RouterProvider router={router} />
            <AskStellaSelectionChip />
          </>
        ) : needsOnboarding ? (
          <OnboardingExperience
            activeConversationId={activeConversationId}
            onEnteredApp={() => setHasEnteredApp(true)}
          />
        ) : null}
      </div>
    </div>
  );
};
