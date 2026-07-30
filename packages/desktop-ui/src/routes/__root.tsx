import {
  createRootRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { ChatRuntimeProvider } from "@/context/chat-runtime";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { useCloudChat } from "@/features/cloud/CloudChatTail";
import { cloudApi } from "@/features/cloud/cloud-api";
import { ComposerAreaSelectOverlay } from "@/app/chat/ComposerAreaSelectOverlay";
import { OPEN_CONNECT_DIALOG_EVENT } from "@/global/integrations/connect-action";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { resolveOwnershipMigrationGate } from "@/global/auth/lib/cloud-session-mode";
import {
  acknowledgeCloudConversation,
  isOwnedCloudConversation,
  markCloudConversationCreated,
  resolveCloudConversationForShell,
  resolveCloudConversationRoute,
} from "@/features/cloud/cloud-conversation-selection";
import {
  readActiveCloudConversationIdCache,
  writeActiveCloudConversationIdCache,
} from "@/features/cloud/cloud-conversation-cache";
import type { RightSidebarHandle } from "@/shell/RightSidebar";
// The workspace panel is a ~410-line surface not needed for first
// interaction, so it is lazy-loaded to keep it out of the always-eager
// shell's first-paint module graph. The imperative `ref` handle is null
// until the chunk mounts; every consumer (`use-workspace-panel-events`,
// `use-display-payload-routing`) already accesses it defensively with `?.`,
// and only from event/async callbacks — never synchronously on mount.
const RightSidebar = lazy(() =>
  import("@/shell/RightSidebar").then((m) => ({ default: m.RightSidebar })),
);
// These dialogs are rarely seen on first interaction (onboarding welcome,
// nickname prompt, post-OAuth confirmation, billing upgrade) and each already
// renders null until its own open/visibility state flips. In a dev-server-in-prod
// app every static import is a separate first-paint transform, so they are
// lazy-loaded — wrapped in <Suspense fallback={null}> at their conditional mount
// sites — to keep them off the always-eager shell's first-paint graph. Behavior
// is unchanged: each dialog still renders null until its own state opens, so
// nothing visual depends on the deferred chunk and there is no fallback flash.
const WelcomeDialog = lazy(() =>
  import("@/global/onboarding/WelcomeDialog").then((m) => ({
    default: m.WelcomeDialog,
  })),
);
const NicknameDialog = lazy(() =>
  import("@/global/auth/NicknameDialog").then((m) => ({
    default: m.NicknameDialog,
  })),
);
const ProviderConnectedDialog = lazy(() =>
  import("@/global/settings/ProviderConnectedDialog").then((m) => ({
    default: m.ProviderConnectedDialog,
  })),
);
const SubscriptionUpgradeDialog = lazy(() =>
  import("@/global/billing/SubscriptionUpgradeDialog").then((m) => ({
    default: m.SubscriptionUpgradeDialog,
  })),
);
import { ShellTopBar } from "@/shell/ShellTopBar";
import { WindowControls } from "@/shell/WindowControls";
import { LeftSidebar } from "@/shell/LeftSidebar";
import { leftSidebarVisibilityStore } from "@/shell/left-sidebar-visibility-store";
import { ShellTopBarAccount } from "@/shell/sidebar/ShellTopBarAccount";
import {
  activityPresenceAllowsSidebar,
  isActivitySidebarDocked,
  shouldAutoOpenActivitySidebar,
} from "@/shell/activity-sidebar-visibility";
import {
  displayTabs,
  useDisplayPanelExpanded,
  useDisplayPanelOpen,
} from "@/features/workspace-display/tab-store";
import {
  CHAT_DISPLAY_TAB_ID,
  HOME_DISPLAY_TAB_ID,
  ensureChatDisplayTab,
  openChatDisplayTab,
  openHomeDisplayTab,
} from "@/shell/display/default-tabs";
import { FullShellDialogs } from "@/shell/full-shell-dialogs";
import { StellaContextMenu } from "@/shell/context-menu/StellaContextMenu";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { getPlatform } from "@/platform/electron/platform";
import { uiState } from "@/platform/ui-state";
import { PanelLeft, PanelRight } from "@/ui/icons";
import {
  dispatchClosePanel,
  dispatchOpenWorkspacePanel,
  STELLA_COMPOSE_TEXT_EVENT,
  type StellaOpenPanelChatDetail,
  type StellaComposeTextDetail,
} from "@/shared/lib/stella-orb-chat";
import { ModelCatalogUpdatedAtProvider } from "@/global/settings/hooks/model-catalog-updated-at";
import { useRestrictedStellaModelReset } from "@/global/settings/hooks/use-restricted-stella-model-reset";
import { MobileActivityNotificationsBridge } from "@/global/mobile/MobileActivityNotificationsBridge";
import { useDictationToggleBridge } from "@/shell/root-chrome/use-dictation-toggle-bridge";
import { useDisplayPayloadRouting } from "@/shell/root-chrome/use-display-payload-routing";
import { useLastLocationRestore } from "@/shell/root-chrome/use-last-location-restore";
import { useOnboardingMemoryPromotion } from "@/shell/root-chrome/use-onboarding-memory-promotion";
import { usePersistLastLocation } from "@/shell/root-chrome/use-persist-last-location";
import { useWorkspacePanelEvents } from "@/shell/root-chrome/use-workspace-panel-events";
import {
  getShellBreakpointState,
  type ShellBreakpointState,
} from "@/shell/shell-breakpoints";
import "@/shell/error-boundary.css";

/** Persisted left-sidebar visibility ("0" = hidden). */
const LEFT_SIDEBAR_VISIBLE_KEY = "stella.leftSidebar.visible";
const CLOUD_CONVERSATION_CREATE_MAX_ATTEMPTS = 4;
const CLOUD_CONVERSATION_CREATE_RETRY_BASE_MS = 1_000;

const getCloudConversationCreateRetryDelayMs = (attempt: number) =>
  Math.min(
    10_000,
    CLOUD_CONVERSATION_CREATE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );

const toCloudConversationCreateError = (error: unknown) =>
  error instanceof Error && error.message.trim()
    ? error.message
    : "Stella couldn't create your cloud conversation.";

function CloudStartupFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="error-boundary" role="alert">
      <div className="error-boundary-gradient" />
      <div className="error-boundary-content">
        <h2>Stella couldn&apos;t start chat</h2>
        <p>{message}</p>
        <div className="error-boundary-actions">
          <button
            className="error-boundary-btn error-boundary-btn--fix"
            onClick={onRetry}
            type="button"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The root route owns the app chrome — top shell bar, workspace panel,
 * dialogs, welcome — plus an `<Outlet />` where the active route renders.
 * Chat runtime state is hoisted into a provider so both the chat route and
 * the workspace panel consume the same hook output.
 */
function RootLayout() {
  const { state, setConversationId } = useUiState();
  const {
    cloudMode,
    error: authBootstrapError,
    isLoading: isAuthLoading,
    accountScope,
    retryAuthBootstrap,
  } = useCloudMode();
  const matchRoute = useMatchRoute();
  const isOnChatRoute = Boolean(matchRoute({ to: "/chat" }));
  const routerConversationId = useRouterState({
    select: (s) =>
      s.location.pathname === "/chat"
        ? ((s.location.search as { c?: string }).c ?? null)
        : null,
  });
  const router = useRouter();
  const cloudConversations = useQuery(
    cloudApi.listMyConversations,
    cloudMode ? {} : "skip",
  );
  const ownershipMigration = useQuery(
    cloudApi.getMyOwnershipMigrationStatus,
    cloudMode ? {} : "skip",
  );
  const ownershipMigrationGate = resolveOwnershipMigrationGate(
    ownershipMigration === undefined
      ? undefined
      : (ownershipMigration?.status ?? null),
    cloudMode,
  );
  const ownershipMigrationIsLoading = ownershipMigrationGate.isLoading;
  const ownershipMigrationPending = ownershipMigrationGate.isPending;
  const ownershipMigrationFailed = ownershipMigrationGate.isFailed;
  const createCloudConversation = useMutation(cloudApi.createMyConversation);
  const retryOwnershipMigrationMutation = useMutation(
    cloudApi.retryMyLatestFailedOwnershipMigration,
  );
  const cloudCreateRequestRef = useRef<{
    accountScope: string;
    clientCreateId: string;
    attempt: number;
    inFlight: boolean;
  } | null>(null);
  const cloudCreateRetryTimerRef = useRef<number | null>(null);
  const [cloudCreateRetrySignal, setCloudCreateRetrySignal] = useState(0);
  const [cloudCreateFailure, setCloudCreateFailure] = useState<{
    accountScope: string;
    message: string;
  } | null>(null);
  const [ownershipMigrationRetryFailure, setOwnershipMigrationRetryFailure] =
    useState<string | null>(null);
  const cachedCloudConversationId = cloudMode
    ? readActiveCloudConversationIdCache(accountScope)
    : null;
  const routeIsListedOrPendingCloudConversation = isOwnedCloudConversation(
    cloudConversations ?? [],
    routerConversationId,
    accountScope,
  );
  const exactCloudConversation = useQuery(
    cloudApi.getMyConversation,
    cloudMode &&
      routerConversationId &&
      !routeIsListedOrPendingCloudConversation
      ? { conversationId: routerConversationId }
      : "skip",
  );
  const cachedConversationIsListed = Boolean(
    cachedCloudConversationId &&
    cloudConversations?.some(
      (conversation) =>
        conversation.conversationId === cachedCloudConversationId,
    ),
  );
  const exactCachedCloudConversation = useQuery(
    cloudApi.getMyConversation,
    cloudMode &&
      cachedCloudConversationId &&
      cachedCloudConversationId !== routerConversationId &&
      !cachedConversationIsListed
      ? { conversationId: cachedCloudConversationId }
      : "skip",
  );
  const routeOwnershipIsLoading = Boolean(
    cloudMode &&
    routerConversationId &&
    !routeIsListedOrPendingCloudConversation &&
    exactCloudConversation === undefined,
  );
  const cachedOwnershipIsLoading = Boolean(
    cloudMode &&
    cachedCloudConversationId &&
    cachedCloudConversationId !== routerConversationId &&
    !cachedConversationIsListed &&
    exactCachedCloudConversation === undefined,
  );
  const routeIsOwnedCloudConversation =
    routeIsListedOrPendingCloudConversation ||
    exactCloudConversation?.conversationId === routerConversationId;
  const ownedCloudConversationCandidates = [
    ...(exactCloudConversation ? [exactCloudConversation] : []),
    ...(exactCachedCloudConversation ? [exactCachedCloudConversation] : []),
    ...(cloudConversations ?? []),
  ];
  const shellConversationSelectionIsLoading =
    ownershipMigrationIsLoading ||
    ownershipMigrationPending ||
    ownershipMigrationFailed ||
    cloudConversations === undefined ||
    (isOnChatRoute ? routeOwnershipIsLoading : cachedOwnershipIsLoading);
  const conversationId =
    !isAuthLoading &&
    ownershipMigrationGate.canSelectConversation &&
    !shellConversationSelectionIsLoading
      ? resolveCloudConversationForShell({
          isOnChatRoute,
          conversations: ownedCloudConversationCandidates,
          routeConversationId: routerConversationId,
          cachedConversationId: cachedCloudConversationId,
          accountScope,
        })
      : null;

  const clearCloudCreateRetryTimer = useCallback(() => {
    if (cloudCreateRetryTimerRef.current === null) return;
    window.clearTimeout(cloudCreateRetryTimerRef.current);
    cloudCreateRetryTimerRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearCloudCreateRetryTimer();
    },
    [clearCloudCreateRetryTimer],
  );

  useLayoutEffect(() => {
    clearCloudCreateRetryTimer();
    cloudCreateRequestRef.current = null;
    setCloudCreateFailure(null);
    setOwnershipMigrationRetryFailure(null);
    // The previous owner's UUID must stop reaching Electron/mobile/voice
    // before any query under the next identity resolves. A newly selected
    // conversation is published only after the owner-checked cloud query
    // below confirms it belongs to the current account scope.
    setConversationId(null);
  }, [accountScope, clearCloudCreateRetryTimer, setConversationId]);

  useLayoutEffect(() => {
    if (!isAuthLoading && cloudMode) return;
    setConversationId(null);
  }, [cloudMode, isAuthLoading, setConversationId]);

  const retryCloudConversationCreate = useCallback(() => {
    clearCloudCreateRetryTimer();
    const current = cloudCreateRequestRef.current;
    if (current?.accountScope === accountScope) {
      current.attempt = 0;
      current.inFlight = false;
    }
    setCloudCreateFailure(null);
    setCloudCreateRetrySignal((signal) => signal + 1);
  }, [accountScope, clearCloudCreateRetryTimer]);

  const retryOwnershipMigration = useCallback(() => {
    setOwnershipMigrationRetryFailure(null);
    void retryOwnershipMigrationMutation({})
      .then(({ scheduled }) => {
        if (!scheduled) {
          setOwnershipMigrationRetryFailure(
            "Stella couldn't find the failed account-link transfer to retry.",
          );
        }
      })
      .catch((error: unknown) => {
        setOwnershipMigrationRetryFailure(
          error instanceof Error && error.message.trim()
            ? error.message
            : "Stella couldn't retry the account-link transfer.",
        );
      });
  }, [retryOwnershipMigrationMutation]);

  useEffect(() => {
    if (isAuthLoading) return;
    // Conversation route repair belongs to `/chat` only. The shell stays
    // mounted on apps/settings/drive routes; treating their intentionally
    // absent `?c=` as a broken chat link would force every navigation back to
    // chat.
    if (!isOnChatRoute) return;
    // Automatic anonymous auth is the fallback. Until it exists,
    // `useCloudMode` remains loading and no local conversation is selected.
    if (!cloudMode) return;
    // Never create or route a destination conversation until the migration
    // status query has proved there is no pending/failed account-link handoff.
    if (ownershipMigrationIsLoading) return;
    // Better Auth publishes this marker before switching identities. Preserve
    // the exact anonymous route until its cloud ownership is visible under the
    // connected account instead of navigating to or creating a blank chat.
    if (ownershipMigrationPending) return;
    // A failed transfer is recoverable and remains attached to the exact
    // anonymous route. Falling through would replace it with a blank
    // destination conversation and make the failed source look lost.
    if (ownershipMigrationFailed) return;

    if (cloudConversations === undefined || routeOwnershipIsLoading) return;
    for (const item of cloudConversations) {
      acknowledgeCloudConversation(item.conversationId);
    }

    if (routeIsOwnedCloudConversation && routerConversationId) {
      clearCloudCreateRetryTimer();
      cloudCreateRequestRef.current = null;
      setCloudCreateFailure(null);
      if (routerConversationId !== state.conversationId) {
        setConversationId(routerConversationId);
      }
      return;
    }

    if (cachedOwnershipIsLoading) return;
    const fallbackConversationId = resolveCloudConversationRoute({
      conversations: exactCachedCloudConversation
        ? [exactCachedCloudConversation, ...cloudConversations]
        : cloudConversations,
      routeConversationId: routerConversationId,
      cachedConversationId: cachedCloudConversationId,
      accountScope,
    });
    if (fallbackConversationId) {
      clearCloudCreateRetryTimer();
      cloudCreateRequestRef.current = null;
      setCloudCreateFailure(null);
      void router.navigate({
        to: "/chat",
        search: { c: fallbackConversationId },
        replace: true,
      });
      return;
    }

    // Every Better Auth identity, including an anonymous one, needs a cloud
    // conversation before a turn can run. The client key makes
    // StrictMode/remount retries converge on one blank conversation.
    let request = cloudCreateRequestRef.current;
    if (request?.accountScope !== accountScope) {
      request = {
        accountScope,
        clientCreateId: crypto.randomUUID(),
        attempt: 0,
        inFlight: false,
      };
      cloudCreateRequestRef.current = request;
    }
    if (
      request.inFlight ||
      request.attempt >= CLOUD_CONVERSATION_CREATE_MAX_ATTEMPTS
    ) {
      return;
    }
    request.inFlight = true;
    request.attempt += 1;
    const { attempt, clientCreateId } = request;
    void createCloudConversation({ clientCreateId })
      .then((created) => {
        clearCloudCreateRetryTimer();
        setCloudCreateFailure(null);
        markCloudConversationCreated(created.conversationId, accountScope);
        setConversationId(created.conversationId);
        return router.navigate({
          to: "/chat",
          search: { c: created.conversationId },
          replace: true,
        });
      })
      .catch((error: unknown) => {
        const current = cloudCreateRequestRef.current;
        if (
          current?.accountScope !== accountScope ||
          current.clientCreateId !== clientCreateId
        ) {
          return;
        }
        current.inFlight = false;
        if (attempt >= CLOUD_CONVERSATION_CREATE_MAX_ATTEMPTS) {
          setCloudCreateFailure({
            accountScope,
            message: toCloudConversationCreateError(error),
          });
          return;
        }
        clearCloudCreateRetryTimer();
        cloudCreateRetryTimerRef.current = window.setTimeout(() => {
          cloudCreateRetryTimerRef.current = null;
          setCloudCreateRetrySignal((signal) => signal + 1);
        }, getCloudConversationCreateRetryDelayMs(attempt));
      });
  }, [
    cachedCloudConversationId,
    cachedOwnershipIsLoading,
    cloudConversations,
    cloudCreateRetrySignal,
    clearCloudCreateRetryTimer,
    createCloudConversation,
    accountScope,
    cloudMode,
    exactCloudConversation,
    exactCachedCloudConversation,
    isAuthLoading,
    isOnChatRoute,
    ownershipMigrationFailed,
    ownershipMigrationIsLoading,
    ownershipMigrationPending,
    routeOwnershipIsLoading,
    routeIsOwnedCloudConversation,
    router,
    routerConversationId,
    setConversationId,
    state.conversationId,
  ]);

  // Keep non-chat shell surfaces and the desktop/mobile bridge on the same
  // validated cloud conversation. Route repair still belongs to `/chat`;
  // this only mirrors an already-owned selection into shell state.
  useEffect(() => {
    if (
      isAuthLoading ||
      !cloudMode ||
      isOnChatRoute ||
      !conversationId ||
      conversationId === state.conversationId
    ) {
      return;
    }
    setConversationId(conversationId);
  }, [
    cloudMode,
    conversationId,
    isAuthLoading,
    isOnChatRoute,
    setConversationId,
    state.conversationId,
  ]);

  // Single writer for the account-scoped active-conversation pointer. The
  // `/chat?c=<id>` route wins on chat; an owned cached/newest conversation
  // keeps the workspace panel attached on other routes. A cloud UUID never
  // becomes the legacy SQLite active-conversation pointer.
  useEffect(() => {
    if (!conversationId || isAuthLoading || !cloudMode) {
      return;
    }
    writeActiveCloudConversationIdCache(accountScope, conversationId);
  }, [accountScope, cloudMode, conversationId, isAuthLoading]);

  useLastLocationRestore(router);
  usePersistLastLocation(router);

  if (authBootstrapError) {
    return (
      <CloudStartupFailure
        message={authBootstrapError}
        onRetry={retryAuthBootstrap}
      />
    );
  }

  if (ownershipMigrationFailed) {
    return (
      <CloudStartupFailure
        message={
          ownershipMigrationRetryFailure ??
          ownershipMigration?.error ??
          "Stella couldn't finish moving your anonymous cloud data to this account."
        }
        onRetry={retryOwnershipMigration}
      />
    );
  }

  if (
    isOnChatRoute &&
    !conversationId &&
    cloudCreateFailure?.accountScope === accountScope
  ) {
    return (
      <CloudStartupFailure
        message={cloudCreateFailure.message}
        onRetry={retryCloudConversationCreate}
      />
    );
  }

  return (
    <ModelCatalogUpdatedAtProvider>
      <ChatRuntimeProvider
        activeConversationId={conversationId}
        isOnChatRoute={isOnChatRoute}
      >
        <RootChrome conversationId={conversationId} />
      </ChatRuntimeProvider>
    </ModelCatalogUpdatedAtProvider>
  );
}

function RootChrome({ conversationId }: { conversationId: string | null }) {
  useRestrictedStellaModelReset();

  const navigate = useNavigate();
  const { dialog: activeDialog } = Route.useSearch();
  const chat = useChatRuntime();
  const cloudChat = useCloudChat(chat.composer, chat.cloudConversation);
  const activityPresence = chat.conversation.activityPresence;
  const { cloudMode } = useCloudMode();
  const cloudApps = useQuery(cloudApi.listMyApps, cloudMode ? {} : "skip");
  const cloudConversations = useQuery(
    cloudApi.listMyConversations,
    cloudMode ? {} : "skip",
  );
  // Cloud apps and cloud agent threads are both reasons the sidebar has
  // something to show, independent of local activity presence.
  const hasCloudApps = Boolean(
    cloudApps?.some((app) => app.status !== "suspended"),
  );
  const hasCloudSidebarContent =
    hasCloudApps ||
    Boolean(cloudConversations?.length) ||
    cloudChat.hasCloudActivity;
  const sidebarHasContent =
    hasCloudSidebarContent || activityPresenceAllowsSidebar(activityPresence);
  const panelOpen = useDisplayPanelOpen();
  const panelExpanded = useDisplayPanelExpanded();
  const [leftSidebarVisible, setLeftSidebarVisible] = useState<boolean>(
    () => uiState.getItem(LEFT_SIDEBAR_VISIBLE_KEY) !== "0",
  );
  const breakpointSidebarVisible = leftSidebarVisible && sidebarHasContent;

  const [shellBreakpoints, setShellBreakpoints] =
    useState<ShellBreakpointState>(() =>
      getShellBreakpointState(
        typeof window === "undefined" ? 0 : window.innerWidth,
        breakpointSidebarVisible,
      ),
    );
  const shellBreakpointsRef = useRef(shellBreakpoints);
  const displayPanelWasHiddenRef = useRef(shellBreakpoints.hideDisplayPanel);
  const autoCollapsedDisplayPanelRef = useRef<{
    panelExpanded: boolean;
  } | null>(null);
  const displayBreakpointTransitionTimeoutRef = useRef<number | null>(null);

  const rightSidebarRef = useRef<RightSidebarHandle>(null);

  const { hasConnectedAccount, isLoading: isAuthLoading } =
    useAuthSessionState();

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOnChatRoute = pathname === "/chat";
  const isMiniWindow = useWindowType() === "mini";
  const isMobileWebView =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-platform") === "mobile";
  const isFullWindow = !isMiniWindow && !isMobileWebView;
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const dockedLeftSidebarVisible = hasCloudSidebarContent
    ? leftSidebarVisible && isFullWindow && !shellBreakpoints.hideLeftSidebar
    : isActivitySidebarDocked({
        presence: activityPresence,
        preferredVisible: leftSidebarVisible,
        isFullWindow,
        breakpointHidden: shellBreakpoints.hideLeftSidebar,
      });

  // Left sidebar visibility — a toggle next to the traffic lights collapses
  // it; a floating button at the same spot brings it back. Persisted so the
  // choice survives reloads.
  const toggleLeftSidebar = useCallback(() => {
    setLeftSidebarVisible((prev) => {
      const next = !prev;
      uiState.setItem(LEFT_SIDEBAR_VISIBLE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const previousActivityPresenceRef =
    useRef<typeof activityPresence>("unknown");
  useLayoutEffect(() => {
    const previous = previousActivityPresenceRef.current;
    previousActivityPresenceRef.current = activityPresence;
    if (!shouldAutoOpenActivitySidebar(previous, activityPresence)) return;
    setLeftSidebarVisible((visible) => {
      if (visible) return visible;
      uiState.setItem(LEFT_SIDEBAR_VISIBLE_KEY, "1");
      return true;
    });
  }, [activityPresence]);

  const triggerDisplayBreakpointTransition = useCallback(() => {
    document.body.dataset.displayBreakpointTransition = "true";
    if (displayBreakpointTransitionTimeoutRef.current !== null) {
      window.clearTimeout(displayBreakpointTransitionTimeoutRef.current);
    }
    displayBreakpointTransitionTimeoutRef.current = window.setTimeout(() => {
      displayBreakpointTransitionTimeoutRef.current = null;
      delete document.body.dataset.displayBreakpointTransition;
    }, 520);
  }, []);

  useEffect(
    () => () => {
      if (displayBreakpointTransitionTimeoutRef.current !== null) {
        window.clearTimeout(displayBreakpointTransitionTimeoutRef.current);
        displayBreakpointTransitionTimeoutRef.current = null;
      }
      delete document.body.dataset.displayBreakpointTransition;
    },
    [],
  );

  useEffect(() => {
    if (isMiniWindow) return;
    window.electronAPI?.window.setNativeButtonsVisible?.(true);
  }, [isMiniWindow]);

  useEffect(() => {
    const root = document.documentElement;
    if (isFullWindow) root.dataset.shellPanelChrome = "true";
    else delete root.dataset.shellPanelChrome;
    return () => {
      delete root.dataset.shellPanelChrome;
    };
  }, [isFullWindow]);

  // Expose the current left-sidebar width so an expanded display panel can
  // inset past it (keeping the rail visible). 252px mirrors
  // `--left-sidebar-width` in left-sidebar.css; 0 when collapsed.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (dockedLeftSidebarVisible) root.dataset.shellLeftSidebarDocked = "true";
    else delete root.dataset.shellLeftSidebarDocked;

    root.style.setProperty(
      "--shell-left-sidebar-width",
      dockedLeftSidebarVisible ? "252px" : "0px",
    );
    // Mirror the effective sidebar state into the module store so the
    // composer activity pill (a separate tree) can stand down while the
    // sidebar's Activity section is on screen.
    leftSidebarVisibilityStore.setDocked(dockedLeftSidebarVisible);
    return () => {
      delete root.dataset.shellLeftSidebarDocked;
      root.style.removeProperty("--shell-left-sidebar-width");
      leftSidebarVisibilityStore.setDocked(false);
    };
  }, [dockedLeftSidebarVisible]);

  const setDialogSearch = useCallback(
    (next: "auth" | "connect" | undefined) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown> | undefined) => ({
          ...(prev ?? {}),
          dialog: next,
        }),
      });
    },
    [navigate],
  );

  const showAuthDialog = useCallback(
    () => setDialogSearch("auth"),
    [setDialogSearch],
  );
  const showConnectDialog = useCallback(
    () => setDialogSearch("connect"),
    [setDialogSearch],
  );
  const closeDialog = useCallback(
    () => setDialogSearch(undefined),
    [setDialogSearch],
  );

  useEffect(() => {
    const handler = () => showConnectDialog();
    window.addEventListener(OPEN_CONNECT_DIALOG_EVENT, handler);
    return () => window.removeEventListener(OPEN_CONNECT_DIALOG_EVENT, handler);
  }, [showConnectDialog]);

  useOnboardingMemoryPromotion({
    hasConnectedAccount,
    isAuthLoading,
    showAuthDialog,
  });

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeDialog();
    },
    [closeDialog],
  );

  const openChatPanel = useCallback(
    (detail: StellaOpenPanelChatDetail = {}) => {
      openChatDisplayTab({ id: Date.now(), ...detail });
    },
    [],
  );

  // Route-aware default surface for a manual panel summon (right-click /
  // keyboard). Home never opens to a duplicate chat — it shows the Home
  // overview; every other route opens the chat viewer. An already-active
  // artifact viewer (media / canvas / pdf / …) reopens as-is regardless of
  // route so summoning doesn't lose what the user was looking at.
  const openDefaultPanelSurface = useCallback(() => {
    const { activeTabId } = displayTabs.getTabListSnapshot();
    const isArtifactViewer =
      activeTabId !== null &&
      activeTabId !== CHAT_DISPLAY_TAB_ID &&
      activeTabId !== HOME_DISPLAY_TAB_ID;
    if (isArtifactViewer) {
      displayTabs.setPanelOpen(true);
      return;
    }
    if (isOnChatRoute) {
      openHomeDisplayTab();
      return;
    }
    openChatPanel();
  }, [isOnChatRoute, openChatPanel]);

  useEffect(() => {
    const handleComposeText = (event: Event) => {
      const detail = (event as CustomEvent<StellaComposeTextDetail>).detail;
      const text = typeof detail?.text === "string" ? detail.text : "";
      const hasPrefillText = Boolean(text.trim());
      const hasChatContext = Object.prototype.hasOwnProperty.call(
        detail,
        "chatContext",
      );
      const hasSelectedText = Object.prototype.hasOwnProperty.call(
        detail,
        "selectedText",
      );
      if (!hasPrefillText && !hasChatContext && !hasSelectedText) return;

      const selectedTextContext =
        hasSelectedText && detail.selectedText
          ? {
              window: null,
              browserUrl: null,
              selectedText: detail.selectedText,
              regionScreenshots: [],
            }
          : null;
      const nextChatContext = hasChatContext
        ? (detail.chatContext ?? null)
        : selectedTextContext;

      if (isOnChatRoute) {
        if (hasPrefillText) {
          chat.composer.setMessage(text);
        }
        if (hasChatContext || selectedTextContext) {
          chat.composer.setChatContext(nextChatContext);
        }
        if (hasSelectedText) {
          chat.composer.setSelectedText(detail.selectedText ?? null);
        }
        chat.composer.requestFocus?.();
        return;
      }

      openChatDisplayTab({
        id: Date.now(),
        chatContext: nextChatContext,
        ...(hasPrefillText ? { prefillText: text } : {}),
      });
    };

    window.addEventListener(STELLA_COMPOSE_TEXT_EVENT, handleComposeText);
    return () => {
      window.removeEventListener(STELLA_COMPOSE_TEXT_EVENT, handleComposeText);
    };
  }, [chat.composer, isOnChatRoute]);

  // Display tab rule: Chat is always present in the strip; its body
  // adapts to the route inside `ChatDisplayTab` (home shows the activity
  // / files overview, every other route shows the live chat panel).
  // Tabs are otherwise sticky — only the user closes them.
  useEffect(() => {
    ensureChatDisplayTab();
  }, []);

  const handleContextMenuOpenPanel = useCallback(() => {
    dispatchOpenWorkspacePanel();
  }, []);

  const handleContextMenuClosePanel = useCallback(() => {
    dispatchClosePanel();
  }, []);

  const isContextMenuPanelOpen = panelOpen;

  const { latestDisplayPayloadRef } = useDisplayPayloadRouting({
    rightSidebarRef,
    isMiniWindow,
  });

  useDictationToggleBridge();

  useWorkspacePanelEvents({
    rightSidebarRef,
    latestDisplayPayloadRef,
    openChatPanel,
    openDefaultPanelSurface,
  });

  // Auto-follow the route with the panel's default surface: navigating to
  // home flips an open Chat panel to the Home overview, and navigating away
  // from home flips an open Home overview to Chat. Only the default
  // surfaces follow the route — an open artifact viewer (Media / Canvas /
  // PDF / …) is left untouched so navigation never yanks the user off it,
  // and a closed panel stays closed (it picks the right surface on summon).
  useEffect(() => {
    if (isMiniWindow || isMobileWebView) return;
    const { panelOpen, activeTabId } = displayTabs.getSnapshot();
    if (!panelOpen) return;
    const isDefaultSurface =
      activeTabId === CHAT_DISPLAY_TAB_ID ||
      activeTabId === HOME_DISPLAY_TAB_ID;
    if (!isDefaultSurface) return;
    if (isOnChatRoute) {
      if (activeTabId !== HOME_DISPLAY_TAB_ID) openHomeDisplayTab();
    } else if (activeTabId !== CHAT_DISPLAY_TAB_ID) {
      displayTabs.activateTab(CHAT_DISPLAY_TAB_ID);
    }
  }, [isOnChatRoute, isMiniWindow, isMobileWebView]);

  useEffect(() => {
    const root = document.documentElement;
    if (panelOpen) root.dataset.displayPanelOpen = "true";
    else delete root.dataset.displayPanelOpen;

    if (panelOpen && panelExpanded) root.dataset.displayPanelExpanded = "true";
    else delete root.dataset.displayPanelExpanded;

    return () => {
      delete root.dataset.displayPanelOpen;
      delete root.dataset.displayPanelExpanded;
    };
  }, [panelExpanded, panelOpen]);

  useEffect(() => {
    const root = document.documentElement;
    let active = false;
    let timeout = 0;

    const clearActive = () => {
      active = false;
      timeout = 0;
      delete root.dataset.shellWindowResizing;
    };

    const onResize = () => {
      if (!active) {
        active = true;
        root.dataset.shellWindowResizing = "true";
      }
      window.clearTimeout(timeout);
      timeout = window.setTimeout(clearActive, 140);
    };

    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("resize", onResize);
      delete root.dataset.shellWindowResizing;
    };
  }, []);

  const applyShellBreakpoints = useCallback(
    (width: number, sidebarVisible: boolean) => {
      const next = getShellBreakpointState(Math.round(width), sidebarVisible);
      const previous = shellBreakpointsRef.current;
      if (
        next.hideWorkspaceStrip === previous.hideWorkspaceStrip &&
        next.hideDisplayPanel === previous.hideDisplayPanel &&
        next.hideLeftSidebar === previous.hideLeftSidebar
      ) {
        return;
      }
      shellBreakpointsRef.current = next;
      setShellBreakpoints(next);
    },
    [],
  );

  // The observer mounts once; effective Activity/sidebar presence flows
  // through a ref so a transition doesn't recreate the ResizeObserver.
  // sidebar toggle doesn't tear down / recreate the ResizeObserver and force
  // a synchronous re-measure on the very frame the collapse animation starts.
  const breakpointSidebarVisibleRef = useRef(breakpointSidebarVisible);
  breakpointSidebarVisibleRef.current = breakpointSidebarVisible;
  const shellWidthRef = useRef(0);

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".full-body");
    if (!shell) return;

    let frame = 0;
    const syncWidth = (width: number) => {
      shellWidthRef.current = width;
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyShellBreakpoints(
          shellWidthRef.current,
          breakpointSidebarVisibleRef.current,
        );
      });
    };

    syncWidth(shell.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      const onResize = () => syncWidth(shell.getBoundingClientRect().width);
      window.addEventListener("resize", onResize);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("resize", onResize);
      };
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      syncWidth(entry.contentRect.width);
    });
    observer.observe(shell);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [applyShellBreakpoints]);

  // Breakpoints also depend on the sidebar's visibility (the strip / display
  // panel auto-hide thresholds shift by its width) — recompute from the
  // cached shell width instead of re-measuring on toggle.
  useEffect(() => {
    if (shellWidthRef.current <= 0) return;
    applyShellBreakpoints(shellWidthRef.current, breakpointSidebarVisible);
  }, [applyShellBreakpoints, breakpointSidebarVisible]);

  useEffect(() => {
    if (isMiniWindow || isMobileWebView) {
      displayPanelWasHiddenRef.current = shellBreakpoints.hideDisplayPanel;
      autoCollapsedDisplayPanelRef.current = null;
      return;
    }

    const wasHidden = displayPanelWasHiddenRef.current;
    const isHidden = shellBreakpoints.hideDisplayPanel;
    displayPanelWasHiddenRef.current = isHidden;

    const { panelExpanded, panelOpen } = displayTabs.getSnapshot();

    if (isHidden) {
      if (!wasHidden && panelOpen) {
        autoCollapsedDisplayPanelRef.current = { panelExpanded };
        triggerDisplayBreakpointTransition();
      }
      if (panelExpanded) displayTabs.setPanelExpanded(false);
      if (panelOpen) displayTabs.setPanelOpen(false);
      return;
    }

    const autoCollapsedPanel = autoCollapsedDisplayPanelRef.current;
    if (!wasHidden || !autoCollapsedPanel) return;
    autoCollapsedDisplayPanelRef.current = null;
    triggerDisplayBreakpointTransition();
    if (!panelOpen) displayTabs.setPanelOpen(true);
    if (autoCollapsedPanel.panelExpanded) displayTabs.setPanelExpanded(true);
  }, [
    isMiniWindow,
    isMobileWebView,
    panelExpanded,
    panelOpen,
    shellBreakpoints.hideDisplayPanel,
    triggerDisplayBreakpointTransition,
  ]);

  return (
    <>
      <MobileActivityNotificationsBridge />

      {!isFullWindow ? <ShellTopBar /> : null}

      {isFullWindow ? (
        <LeftSidebar collapsed={!dockedLeftSidebarVisible} />
      ) : null}

      <StellaContextMenu
        isOpen={isContextMenuPanelOpen}
        onOpen={handleContextMenuOpenPanel}
        onClose={handleContextMenuClosePanel}
      >
        <div className="content-area">
          <div
            className={`persistent-chat-surface${isOnChatRoute ? " persistent-chat-surface--active" : ""}`}
            aria-hidden={!isOnChatRoute}
          >
            <ChatColumn
              conversation={chat.conversation}
              composer={cloudChat.composer}
              scroll={chat.scroll}
              conversationId={conversationId}
              showHomeContent={chat.showHomeContent}
              onDismissHome={chat.dismissHome}
              extraTail={cloudChat.extraTail}
            />
          </div>
          <div
            className={`route-outlet-surface${isOnChatRoute ? "" : " route-outlet-surface--active"}`}
            aria-hidden={isOnChatRoute}
          >
            <Outlet />
          </div>
          {isFullWindow && !panelExpanded ? (
            <div
              className="main-shell-top-actions"
              data-platform={isWin ? "win" : isMac ? "mac" : "other"}
              data-panel-open={panelOpen ? "true" : "false"}
            >
              {!panelOpen ? (
                <button
                  type="button"
                  className="shell-topbar-icon-btn"
                  onClick={() => dispatchOpenWorkspacePanel()}
                  aria-label="Open panel"
                  title="Open panel"
                >
                  <PanelRight size={16} strokeWidth={1.75} />
                </button>
              ) : null}
              <ShellTopBarAccount
                onSignIn={showAuthDialog}
                onConnect={showConnectDialog}
              />
              {!panelOpen && isWin ? (
                <WindowControls useWindowsIcons hidden={false} />
              ) : null}
            </div>
          ) : null}
        </div>
      </StellaContextMenu>

      {/* Rendered after `.content-area` so their `no-drag` carve is applied
          after the content area's top `-webkit-app-region: drag` strip —
          draggable regions resolve in DOM order, not z-index, so a button
          painted above but earlier in the DOM would still read as draggable
          (and swallow clicks). When Activity exists, the left toggle stays at
          a fixed position across open and collapsed states. */}
      {isFullWindow && sidebarHasContent ? (
        <button
          type="button"
          className="shell-topbar-icon-btn shell-edge-toggle shell-edge-toggle--left"
          data-platform={isMac ? "mac" : "other"}
          onClick={toggleLeftSidebar}
          aria-label={
            dockedLeftSidebarVisible ? "Hide sidebar" : "Show sidebar"
          }
          title={dockedLeftSidebarVisible ? "Hide sidebar" : "Show sidebar"}
        >
          <PanelLeft size={16} strokeWidth={1.75} />
        </button>
      ) : null}

      <Suspense fallback={null}>
        <RightSidebar ref={rightSidebarRef} />
      </Suspense>

      <ComposerAreaSelectOverlay
        active={chat.annotation.active}
        requestId={chat.annotation.requestId}
        onCancel={chat.annotation.cancel}
        onSelect={chat.annotation.submit}
      />

      <FullShellDialogs
        activeDialog={activeDialog ?? null}
        onDialogOpenChange={handleDialogOpenChange}
      />

      {/* Suspense fallback={null} mirrors the lazy RightSidebar above: the
          deferred chunk stays off the first-paint graph, and each dialog still
          renders null until its own open state flips — no flash, no behavior change. */}
      <Suspense fallback={null}>
        <WelcomeDialog
          conversationId={conversationId}
          onConnect={showConnectDialog}
          onSignIn={showAuthDialog}
        />
      </Suspense>

      <Suspense fallback={null}>
        <NicknameDialog />
      </Suspense>

      <Suspense fallback={null}>
        <ProviderConnectedDialog />
      </Suspense>

      <Suspense fallback={null}>
        <SubscriptionUpgradeDialog />
      </Suspense>
    </>
  );
}

/**
 * Root-level search params: dialogs (auth/connect) become URL state so they
 * are deep-linkable (e.g. an auth deep-link from an external browser opens
 * the AuthDialog without any other glue).
 */
const RootSearch = z.object({
  dialog: z.enum(["auth", "connect"]).optional(),
});

export const Route = createRootRoute({
  validateSearch: RootSearch,
  component: RootLayout,
});
