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
import {
  readLocalOnboardingCompleted,
  useOnboardingState,
} from "@/global/onboarding/use-onboarding-state";
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
 * the conversation surface, every card, the demo scenes, and all
 * onboarding CSS.
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
      "@/global/onboarding/chat/OnboardingChat"
    );
  }
  return onboardingChunkPromise.current;
};

const OnboardingChatView = lazy(() =>
  import("@/global/onboarding/chat/OnboardingChat").then((module) => ({
    default: module.OnboardingChat,
  })),
);

type OnboardingExperienceProps = {
  onEnteredApp: () => void;
};

/**
 * First run as a conversation. Mounts inside the normal window chrome and
 * completes through the shared onboarding state, so the shell's hand-off
 * to the real chat is the same flip of `onboardingDone`.
 */
function OnboardingExperience({ onEnteredApp }: OnboardingExperienceProps) {
  const { completed: onboardingDone, complete: completeOnboarding } =
    useOnboardingState();
  const { hasConnectedAccount } = useAuthSessionState();

  useEffect(() => {
    let cancelled = false;
    void loadOnboardingChunk().finally(() => {
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
        <OnboardingExperience onEnteredApp={() => setHasEnteredApp(true)} />
      ) : null}
    </ShellChrome>
  );
};

export const FullShell = () =>
  platformCapabilities.onboarding ? <DesktopFullShell /> : <WebsiteShell />;
