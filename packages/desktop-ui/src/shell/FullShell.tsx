import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
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
import { readOnboardingVariant } from "@/global/onboarding/chat/onboarding-chat-flow";
import { setPendingComposerDraft } from "@/global/onboarding/chat/pending-handoff";
import type { OnboardingChatHandoff } from "@/global/onboarding/chat/use-onboarding-chat";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { router } from "@/router";
import { ShiftingGradient } from "./background/ShiftingGradient";
import { AskStellaSelectionChip } from "./selection/AskStellaSelectionChip";
import "./full-shell.layout.css";
import "./mobile.css";
import { platformCapabilities } from "@/platform/capabilities";
import {
  dismissLaunchSplash,
  holdLaunchSplashUntilLive,
} from "./launch-splash";

/* Onboarding is loaded as a dynamic chunk that contains the whole flow:
 * every phase component, the character mark, the legal dialog,
 * and all onboarding CSS.
 *
 * Returning users (`appReady === true` at first paint) never fetch this
 * chunk. After completion the React subtree unmounts and the lazy
 * import is never re-evaluated, so onboarding code is genuinely gone
 * for the remainder of the session and absent from the next cold start. */
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

/* The chat-style onboarding is its own lazy chunk for the same reason: a
 * returning user never pays for it. It shares nothing with the legacy
 * overlay chunk except the discovery pipeline services. */
const chatOnboardingChunkPromise: { current: Promise<unknown> | null } = {
  current: null,
};
const loadChatOnboardingChunk = () => {
  if (!chatOnboardingChunkPromise.current) {
    chatOnboardingChunkPromise.current = import(
      "@/global/onboarding/chat/OnboardingChat"
    );
  }
  return chatOnboardingChunkPromise.current;
};

const OnboardingChatView = lazy(() =>
  import("@/global/onboarding/chat/OnboardingChat").then((module) => ({
    default: module.OnboardingChat,
  })),
);

type ChatOnboardingExperienceProps = {
  onEnteredApp: () => void;
};

/**
 * First run as a conversation. Mounts inside the normal window chrome (no
 * fullscreen presentation, no split layout) and completes through the same
 * shared onboarding state the legacy flow uses, so the shell's hand-off to
 * the real chat is identical for both variants.
 */
function ChatOnboardingExperience({
  onEnteredApp,
}: ChatOnboardingExperienceProps) {
  const { completed: onboardingDone, complete: completeOnboarding } =
    useOnboardingState();
  const { hasConnectedAccount } = useAuthSessionState();

  useEffect(() => {
    let cancelled = false;
    void loadChatOnboardingChunk().finally(() => {
      if (!cancelled) dismissLaunchSplash();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!onboardingDone) return;
    onEnteredApp();
  }, [onEnteredApp, onboardingDone]);

  const handleComplete = useCallback(
    (handoff: OnboardingChatHandoff) => {
      if (handoff.composerDraft) setPendingComposerDraft(handoff.composerDraft);
      completeOnboarding();
    },
    [completeOnboarding],
  );

  return (
    <Suspense fallback={null}>
      <OnboardingChatView
        isAuthenticated={hasConnectedAccount}
        onComplete={handleComplete}
      />
    </Suspense>
  );
}

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

  // Once the split flow starts, the mark is decorative beside controls. Keep
  // it alive — a frozen frame reads as a rendering glitch — but
  // OnboardingOverlay pauses it outright on low-power machines so form
  // interactions and demos still own the frame budget. Hidden phases are
  // paused through `stellaHiddenByPhase`.
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

function ShellChrome({
  windowMode,
  children,
}: {
  windowMode: "app" | "onboarding";
  children: ReactNode;
}) {
  const { gradientMode, gradientColor } = useTheme();
  return (
    <div className="window-shell full" data-window-mode={windowMode}>
      <ShiftingGradient
        mode={gradientMode}
        colorMode={gradientColor}
        lightweight={false}
      />
      <div className="full-body">{children}</div>
    </div>
  );
}

const HostedChatSurface = () => (
  <>
    <RouterProvider router={router} />
    <AskStellaSelectionChip />
  </>
);

const WebsiteShell = () => {
  useEffect(() => {
    holdLaunchSplashUntilLive();
  }, []);

  return (
    <ShellChrome windowMode="app">
      <HostedChatSurface />
    </ShellChrome>
  );
};

const DesktopFullShell = () => {
  const { state } = useUiState();
  const activeConversationId = state.conversationId;
  // `activeConversationId` is only handed to onboarding below. It is owned by
  // the root layout (cloud selection) and must never drive a runtime
  // re-bootstrap from here: a null id is the normal pre-selection state.
  const { completed: onboardingDone, hydrated: onboardingHydrated } =
    useOnboardingState();
  // Returning users resolve `onboardingDone` synchronously from shared UI state,
  // so seed `hasEnteredApp` synchronously too. Otherwise the chat surface /
  // RouterProvider mount waits on the setTimeout(0) below. The splash stays up
  // until `appReady`, so there is no flash.
  const [hasEnteredApp, setHasEnteredApp] = useState(() =>
    readLocalOnboardingCompleted(),
  );

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

  // The renderer shell does not depend on auth or the local runtime. Those
  // background bootstraps only unlock cloud state, chat history, sends, and
  // local tools once their own state arrives.
  useEffect(() => {
    window.electronAPI?.ui.setAppReady?.(appReady);
  }, [appReady]);

  // Keep the static launch splash up for returning users until the shell is
  // *live* — auth resolved and the active conversation selected — so the
  // window reveals once, fully working, instead of showing a shell whose
  // composer enables and conversation list fills in a moment later. The root
  // layout calls `dismissLaunchSplash()` at that point; `holdLaunchSplash…`
  // bounds the wait so offline or cold starts never sit behind the splash.
  // First-run onboarding dismisses it after its chunk is loaded from
  // OnboardingExperience.
  useEffect(() => {
    if (appReady) {
      holdLaunchSplashUntilLive();
    }
  }, [appReady]);

  return (
    <ShellChrome windowMode={needsOnboarding ? "onboarding" : "app"}>
      {appReady ? (
        <HostedChatSurface />
      ) : needsOnboarding ? (
        readOnboardingVariant() === "legacy" ? (
          <OnboardingExperience
            activeConversationId={activeConversationId}
            onEnteredApp={() => setHasEnteredApp(true)}
          />
        ) : (
          <ChatOnboardingExperience
            onEnteredApp={() => setHasEnteredApp(true)}
          />
        )
      ) : null}
    </ShellChrome>
  );
};

export const FullShell = () =>
  platformCapabilities.onboarding ? <DesktopFullShell /> : <WebsiteShell />;
