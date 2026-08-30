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
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { ChatRuntimeProvider } from "@/context/chat-runtime";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { OPEN_CONNECT_DIALOG_EVENT } from "@/global/integrations/connect-action";
import { conversationTabs } from "@/features/chat/services/conversation-tabs-store";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { SIGN_IN_TOAST_ACTION } from "@/shared/lib/auth-cta";
import { resolveOwnershipMigrationGate } from "@/global/auth/lib/cloud-session-mode";
import { cloudApi } from "@/features/cloud/cloud-api";
import {
  acknowledgeCloudConversation,
  cloudConversationBelongsToOwnerSubject,
  cloudConversationsForOwnerSubject,
  isOwnedCloudConversation,
  markCloudConversationCreated,
  resolveCloudConversationForShell,
  resolveCloudConversationRoute,
} from "@/features/cloud/cloud-conversation-selection";
import {
  readActiveCloudConversationIdCache,
  writeActiveCloudConversationIdCache,
} from "@/features/cloud/cloud-conversation-cache";
import { retireCloudConversationClientAuthority } from "@/features/cloud/conversation-store";
import { cloudAttachmentsStore } from "@/features/cloud/cloud-composer-store";
import { retireCloudExecutionClientAuthority } from "@/features/cloud/cloud-execution-store";
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
const WorkspaceHomeSurface = lazy(() =>
  import("@/shell/WorkspaceHomeSurface").then((m) => ({
    default: m.WorkspaceHomeSurface,
  })),
);
// These dialogs are rarely seen on first interaction (nickname prompt,
// post-OAuth confirmation, billing upgrade) and each already
// renders null until its own open/visibility state flips. In a dev-server-in-prod
// app every static import is a separate first-paint transform, so they are
// lazy-loaded — wrapped in <Suspense fallback={null}> at their conditional mount
// sites — to keep them off the always-eager shell's first-paint graph. Behavior
// is unchanged: each dialog still renders null until its own state opens, so
// nothing visual depends on the deferred chunk and there is no fallback flash.
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
import { ShellTopBarFull } from "@/shell/ShellTopBarFull";
import { GlobalModelsControl } from "@/shell/GlobalModelsControl";
import { useActiveSidebarSection } from "@/features/workspace-display/sidebar-sections";
import { shouldShowGlobalModelsControl } from "@/shell/global-models-control-visibility";
import { DisplayPanelTopBar } from "@/shell/DisplayPanelTopBar";
import { StellaContextMenu } from "@/shell/context-menu/StellaContextMenu";
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
import { SettingsDialogHost } from "@/shell/SettingsDialogHost";
import { FeedbackDialogHost } from "@/shell/FeedbackDialogHost";
import {
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
import { usePersistLastLocation } from "@/shell/root-chrome/use-persist-last-location";
import { useWorkspacePanelEvents } from "@/shell/root-chrome/use-workspace-panel-events";
import {
  shellBreakpointStore,
  useShellBreakpointState,
} from "@/shell/shell-breakpoints";
import "@/shell/error-boundary.css";

const CLOUD_CONVERSATION_CREATE_MAX_ATTEMPTS = 4;
const CLOUD_CONVERSATION_CREATE_RETRY_BASE_MS = 1_000;

export const getCloudConversationCreateRetryDelayMs = (attempt: number) =>
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

function CloudStartupPending() {
  return (
    <div
      className="error-boundary"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="error-boundary-gradient" />
      <div className="error-boundary-content">
        <h2>Getting Stella ready…</h2>
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
    authBootstrapStatus,
    isLoading: isAuthLoading,
    accountScope,
    ownerSubject,
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
  const routeIntent = `${isOnChatRoute ? "chat" : "other"}:${routerConversationId ?? ""}`;
  const activeRouteIntentRef = useRef(routeIntent);
  activeRouteIntentRef.current = routeIntent;
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
  const canQueryOwnershipFencedCloudData =
    ownershipMigrationGate.canSelectConversation;
  const cloudConversations = useQuery(
    cloudApi.listMyConversations,
    canQueryOwnershipFencedCloudData ? {} : "skip",
  );
  const conversationIdentity = useQuery(
    cloudApi.getMyCloudConversationIdentity,
    canQueryOwnershipFencedCloudData ? {} : "skip",
  );
  const ownerGeneration =
    conversationIdentity?.ownerId === ownerSubject
      ? conversationIdentity.ownerGeneration
      : null;
  const createCloudConversation = useMutation(cloudApi.createMyConversation);
  const retryOwnershipMigrationMutation = useMutation(
    cloudApi.retryMyLatestFailedOwnershipMigration,
  );
  const cloudCreateRequestRef = useRef<{
    accountScope: string;
    routeIntent: string;
    ownerGeneration: string;
    clientCreateId: string;
    attempt: number;
    inFlight: boolean;
  } | null>(null);
  const ownershipMigrationRetryRef = useRef<{
    accountScope: string;
    requestId: string;
  } | null>(null);
  const activeAccountScopeRef = useRef(accountScope);
  activeAccountScopeRef.current = accountScope;
  const activeOwnerGenerationRef = useRef(ownerGeneration);
  activeOwnerGenerationRef.current = ownerGeneration;
  const cloudCreateRetryTimerRef = useRef<number | null>(null);
  const [cloudCreateRetrySignal, setCloudCreateRetrySignal] = useState(0);
  const [cloudCreateFailure, setCloudCreateFailure] = useState<{
    accountScope: string;
    routeIntent: string;
    message: string;
  } | null>(null);
  const [ownershipMigrationRetryFailure, setOwnershipMigrationRetryFailure] =
    useState<string | null>(null);

  const scopedCloudConversations = useMemo(
    () =>
      cloudConversationsForOwnerSubject(cloudConversations ?? [], ownerSubject),
    [cloudConversations, ownerSubject],
  );
  const cachedCloudConversationId = cloudMode
    ? readActiveCloudConversationIdCache(accountScope)
    : null;
  const routeIsListedOrPendingCloudConversation = isOwnedCloudConversation(
    scopedCloudConversations,
    routerConversationId,
    accountScope,
    ownerSubject,
  );
  const exactCloudConversation = useQuery(
    cloudApi.getMyConversation,
    canQueryOwnershipFencedCloudData &&
      routerConversationId &&
      !routeIsListedOrPendingCloudConversation
      ? { conversationId: routerConversationId }
      : "skip",
  );
  const cachedConversationIsListed = Boolean(
    cachedCloudConversationId &&
      scopedCloudConversations.some(
        (conversation) =>
          conversation.conversationId === cachedCloudConversationId,
      ),
  );
  const exactCachedCloudConversation = useQuery(
    cloudApi.getMyConversation,
    canQueryOwnershipFencedCloudData &&
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
    (exactCloudConversation?.conversationId === routerConversationId &&
      cloudConversationBelongsToOwnerSubject(
        exactCloudConversation,
        ownerSubject,
      ));
  const scopedExactCloudConversation =
    exactCloudConversation &&
    cloudConversationBelongsToOwnerSubject(exactCloudConversation, ownerSubject)
      ? exactCloudConversation
      : null;
  const scopedExactCachedCloudConversation =
    exactCachedCloudConversation &&
    cloudConversationBelongsToOwnerSubject(
      exactCachedCloudConversation,
      ownerSubject,
    )
      ? exactCachedCloudConversation
      : null;
  const ownedCloudConversationCandidates = [
    ...(scopedExactCloudConversation ? [scopedExactCloudConversation] : []),
    ...(scopedExactCachedCloudConversation
      ? [scopedExactCachedCloudConversation]
      : []),
    ...scopedCloudConversations,
  ];
  const shellConversationSelectionIsLoading =
    ownershipMigrationGate.isLoading ||
    ownershipMigrationGate.isPending ||
    ownershipMigrationGate.isFailed ||
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
          ownerSubject,
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

  // Clear the previous owner synchronously, before any child can paint or an
  // Electron UiState hydration can reintroduce an unvalidated UUID. Tabs are
  // loaded from the same immutable account scope as one atomic snapshot.
  useLayoutEffect(() => {
    clearCloudCreateRetryTimer();
    cloudCreateRequestRef.current = null;
    ownershipMigrationRetryRef.current = null;
    setCloudCreateFailure(null);
    setOwnershipMigrationRetryFailure(null);
    retireCloudConversationClientAuthority(accountScope);
    retireCloudExecutionClientAuthority(accountScope);
    cloudAttachmentsStore.clear();
    conversationTabs.setAccountScope(cloudMode ? accountScope : null);
    setConversationId(null);
  }, [accountScope, clearCloudCreateRetryTimer, cloudMode, setConversationId]);

  // `conversationId` is derived only from owner-checked server data. Mirroring
  // that derived value (including null while gated) makes UiState a consumer,
  // never an alternate selection authority.
  useLayoutEffect(() => {
    if (state.conversationId !== conversationId) {
      setConversationId(conversationId);
    }
  }, [conversationId, setConversationId, state.conversationId]);

  const retryCloudConversationCreate = useCallback(() => {
    clearCloudCreateRetryTimer();
    const current = cloudCreateRequestRef.current;
    if (
      current?.accountScope === accountScope &&
      current.routeIntent === routeIntent
    ) {
      current.attempt = 0;
      current.inFlight = false;
    }
    setCloudCreateFailure(null);
    setCloudCreateRetrySignal((signal) => signal + 1);
  }, [accountScope, clearCloudCreateRetryTimer, routeIntent]);

  const retryOwnershipMigration = useCallback(() => {
    const operation = {
      accountScope,
      requestId: crypto.randomUUID(),
    };
    ownershipMigrationRetryRef.current = operation;
    setOwnershipMigrationRetryFailure(null);
    void (async () => {
      try {
        const { scheduled } = await retryOwnershipMigrationMutation({});
        if (
          activeAccountScopeRef.current !== operation.accountScope ||
          ownershipMigrationRetryRef.current !== operation
        ) {
          return;
        }
        if (!scheduled) {
          setOwnershipMigrationRetryFailure(
            "Stella couldn't find the failed account-link transfer to retry.",
          );
        }
      } catch (error: unknown) {
        if (
          activeAccountScopeRef.current !== operation.accountScope ||
          ownershipMigrationRetryRef.current !== operation
        ) {
          return;
        }
        setOwnershipMigrationRetryFailure(
          error instanceof Error && error.message.trim()
            ? error.message
            : "Stella couldn't retry the account-link transfer.",
        );
      } finally {
        if (ownershipMigrationRetryRef.current === operation) {
          ownershipMigrationRetryRef.current = null;
        }
      }
    })();
  }, [accountScope, retryOwnershipMigrationMutation]);

  useEffect(() => {
    const priorRequest = cloudCreateRequestRef.current;
    if (priorRequest && priorRequest.routeIntent !== routeIntent) {
      clearCloudCreateRetryTimer();
      priorRequest.inFlight = false;
      cloudCreateRequestRef.current = null;
      setCloudCreateFailure(null);
    }
    if (isAuthLoading || !isOnChatRoute || !cloudMode) return;
    if (
      ownershipMigrationGate.isLoading ||
      ownershipMigrationGate.isPending ||
      ownershipMigrationGate.isFailed
    ) {
      return;
    }
    if (cloudConversations === undefined || routeOwnershipIsLoading) return;
    for (const item of scopedCloudConversations) {
      acknowledgeCloudConversation(item.conversationId);
    }

    if (routeIsOwnedCloudConversation && routerConversationId) {
      clearCloudCreateRetryTimer();
      cloudCreateRequestRef.current = null;
      setCloudCreateFailure(null);
      return;
    }

    if (cachedOwnershipIsLoading) return;
    const fallbackConversationId = resolveCloudConversationRoute({
      conversations: scopedExactCachedCloudConversation
        ? [scopedExactCachedCloudConversation, ...scopedCloudConversations]
        : scopedCloudConversations,
      routeConversationId: routerConversationId,
      cachedConversationId: cachedCloudConversationId,
      accountScope,
      ownerSubject,
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
    if (!ownerGeneration) return;

    let request = cloudCreateRequestRef.current;
    if (
      request?.accountScope !== accountScope ||
      request.routeIntent !== routeIntent ||
      request.ownerGeneration !== ownerGeneration
    ) {
      request = {
        accountScope,
        routeIntent,
        ownerGeneration,
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
    void createCloudConversation({
      clientCreateId,
      expectedOwnerGeneration: request.ownerGeneration,
    })
      .then((created) => {
        const current = cloudCreateRequestRef.current;
        if (
          activeAccountScopeRef.current !== accountScope ||
          activeOwnerGenerationRef.current !== request.ownerGeneration ||
          activeRouteIntentRef.current !== routeIntent ||
          current?.accountScope !== accountScope ||
          current.routeIntent !== routeIntent ||
          current.clientCreateId !== clientCreateId
        ) {
          return;
        }
        clearCloudCreateRetryTimer();
        current.inFlight = false;
        cloudCreateRequestRef.current = null;
        setCloudCreateFailure(null);
        markCloudConversationCreated(created.conversationId, accountScope);
        return router.navigate({
          to: "/chat",
          search: { c: created.conversationId },
          replace: true,
        });
      })
      .catch((error: unknown) => {
        const current = cloudCreateRequestRef.current;
        if (
          activeAccountScopeRef.current !== accountScope ||
          activeOwnerGenerationRef.current !== request.ownerGeneration ||
          activeRouteIntentRef.current !== routeIntent ||
          current?.accountScope !== accountScope ||
          current.routeIntent !== routeIntent ||
          current.clientCreateId !== clientCreateId
        ) {
          return;
        }
        current.inFlight = false;
        if (attempt >= CLOUD_CONVERSATION_CREATE_MAX_ATTEMPTS) {
          setCloudCreateFailure({
            accountScope,
            routeIntent,
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
    accountScope,
    cachedCloudConversationId,
    cachedOwnershipIsLoading,
    clearCloudCreateRetryTimer,
    cloudConversations,
    cloudCreateRetrySignal,
    ownerGeneration,
    ownerSubject,
    cloudMode,
    createCloudConversation,
    routeIntent,
    scopedCloudConversations,
    scopedExactCachedCloudConversation,
    isAuthLoading,
    isOnChatRoute,
    ownershipMigrationGate.isFailed,
    ownershipMigrationGate.isLoading,
    ownershipMigrationGate.isPending,
    routeIsOwnedCloudConversation,
    routeOwnershipIsLoading,
    router,
    routerConversationId,
  ]);

  useEffect(() => {
    if (!conversationId || isAuthLoading || !cloudMode) return;
    writeActiveCloudConversationIdCache(accountScope, conversationId);
  }, [accountScope, cloudMode, conversationId, isAuthLoading]);

  // Opens + navigates to a conversation (tab strip + router). Mirrors the
  // top bar's new-chat navigation and is handed to the chat runtime so the
  // Fork action can jump to the newly branched conversation.
  const navigateToConversation = useCallback(
    (targetConversationId: string, title?: string) => {
      conversationTabs.openConversation(targetConversationId, title);
      void router.navigate({
        to: "/chat",
        search: { c: targetConversationId },
      });
    },
    [router],
  );

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

  if (ownershipMigrationGate.isFailed) {
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

  if (ownershipMigrationGate.isLoading || ownershipMigrationGate.isPending) {
    return <CloudStartupPending />;
  }

  if (
    isOnChatRoute &&
    !conversationId &&
    cloudCreateFailure?.accountScope === accountScope &&
    cloudCreateFailure.routeIntent === routeIntent
  ) {
    return (
      <CloudStartupFailure
        message={cloudCreateFailure.message}
        onRetry={retryCloudConversationCreate}
      />
    );
  }

  return (
    <>
      {authBootstrapStatus === "reauth_required" ? (
        <div
          role="status"
          style={{
            position: "fixed",
            zIndex: 10000,
            left: "50%",
            top: 12,
            transform: "translateX(-50%)",
            padding: "8px 14px",
            borderRadius: 999,
            background: "rgba(32, 28, 39, 0.94)",
            color: "white",
            fontSize: 13,
            boxShadow: "0 8px 30px rgba(0, 0, 0, 0.3)",
          }}
        >
          Your session expired.{" "}
          <button
            type="button"
            onClick={SIGN_IN_TOAST_ACTION.onClick}
            style={{
              margin: 0,
              padding: 0,
              border: 0,
              background: "transparent",
              color: "inherit",
              font: "inherit",
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            Sign in again
          </button>{" "}
          to reconnect your account.
        </div>
      ) : null}
      <ModelCatalogUpdatedAtProvider>
        <ChatRuntimeProvider
          activeConversationId={conversationId}
          isOnChatRoute={isOnChatRoute}
          navigateToConversation={navigateToConversation}
        >
          <RootChrome conversationId={conversationId} />
        </ChatRuntimeProvider>
      </ModelCatalogUpdatedAtProvider>
    </>
  );
}

function RootChrome({ conversationId }: { conversationId: string | null }) {
  useRestrictedStellaModelReset();

  const navigate = useNavigate();
  const { dialog: activeDialog } = Route.useSearch();
  const chat = useChatRuntime();
  const panelOpen = useDisplayPanelOpen();
  const panelExpanded = useDisplayPanelExpanded();
  const shellBreakpoints = useShellBreakpointState();
  const activeSidebarSection = useActiveSidebarSection();
  const modelControlVisible = shouldShowGlobalModelsControl({
    panelOpen,
    activeSidebarSection,
  });
  const panelExpandedBeforeTakeoverRef = useRef<boolean | null>(null);
  const displayBreakpointTransitionTimeoutRef = useRef<number | null>(null);

  const rightSidebarRef = useRef<RightSidebarHandle>(null);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOnChatRoute = pathname === "/chat";

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
    window.electronAPI?.window.setNativeButtonsVisible?.(true);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.shellPanelChrome = "true";
    return () => {
      delete root.dataset.shellPanelChrome;
    };
  }, []);

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

  // Route-aware default surface for a manual panel open (right-click /
  // keyboard). Home never opens to a duplicate chat — it shows the Home
  // launcher; every other route opens the chat viewer. An already-active
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
    displayTabs.setPanelOpen(true);
  }, []);

  const handleContextMenuClosePanel = useCallback(() => {
    displayTabs.setPanelOpen(false);
  }, []);

  const { latestDisplayPayloadRef } = useDisplayPayloadRouting({
    rightSidebarRef,
  });

  useDictationToggleBridge();

  useWorkspacePanelEvents({
    rightSidebarRef,
    latestDisplayPayloadRef,
    openChatPanel,
    openDefaultPanelSurface,
  });

  // Auto-follow the route with the panel's default surface: navigating to
  // home flips an open Chat panel to the Home launcher, and navigating away
  // from home flips an open Home launcher to Chat. Only the default
  // surfaces follow the route — an open artifact viewer (Media / Canvas /
  // PDF / …) is left untouched so navigation never yanks the user off it,
  // and a closed panel stays closed (it picks the right surface when opened).
  useEffect(() => {
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
  }, [isOnChatRoute]);

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

  const applyShellBreakpoints = useCallback((width: number) => {
    shellBreakpointStore.setWidth(width);
  }, []);

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
        applyShellBreakpoints(shellWidthRef.current);
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

  useEffect(() => {
    const root = document.documentElement;
    if (shellBreakpoints.displayPanelTakeover) {
      root.dataset.displayPanelTakeover = "true";
    } else {
      delete root.dataset.displayPanelTakeover;
    }
    return () => {
      delete root.dataset.displayPanelTakeover;
    };
  }, [shellBreakpoints.displayPanelTakeover]);

  useEffect(() => {
    const { panelExpanded } = displayTabs.getSnapshot();
    if (shellBreakpoints.displayPanelTakeover) {
      if (panelExpandedBeforeTakeoverRef.current === null) {
        panelExpandedBeforeTakeoverRef.current = panelExpanded;
      }
      if (panelExpanded) {
        triggerDisplayBreakpointTransition();
        displayTabs.setPanelExpanded(false);
      }
      return;
    }

    const restoreExpanded = panelExpandedBeforeTakeoverRef.current;
    panelExpandedBeforeTakeoverRef.current = null;
    if (restoreExpanded && !panelExpanded) {
      triggerDisplayBreakpointTransition();
      displayTabs.setPanelExpanded(true);
    }
  }, [
    panelExpanded,
    shellBreakpoints.displayPanelTakeover,
    triggerDisplayBreakpointTransition,
  ]);

  return (
    <>
      <MobileActivityNotificationsBridge />

      <StellaContextMenu
        isOpen={panelOpen}
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
              composer={chat.composer}
              scroll={chat.scroll}
              conversationId={conversationId}
              showHomeContent={chat.showHomeContent}
            />
          </div>
          <div
            className={`route-outlet-surface${isOnChatRoute ? "" : " route-outlet-surface--active"}`}
            aria-hidden={isOnChatRoute}
          >
            <Outlet />
          </div>
        </div>

        {/* The top bar spans the whole shell while Activity is visible, then
            follows the main column's right edge when the display panel opens.
            It is rendered after the content area's drag strip so its
            `no-drag` controls remain interactive. */}
        <ShellTopBarFull onSignIn={showAuthDialog} />

        <Suspense fallback={null}>
          <WorkspaceHomeSurface
            hidden={panelOpen || shellBreakpoints.hideWorkspaceStrip}
          />
        </Suspense>

        <DisplayPanelTopBar />

        <Suspense fallback={null}>
          <RightSidebar ref={rightSidebarRef} />
        </Suspense>
      </StellaContextMenu>

      {/* Global bottom-right Models control — top-level, not owned by the
          right sidebar (state/overlay/lifecycle stay global), but its on-screen
          visibility follows the display panel so it never creates an empty
          right gutter when there is nothing on the right. */}
      <GlobalModelsControl visible={modelControlVisible} />

      <FullShellDialogs
        activeDialog={activeDialog ?? null}
        onDialogOpenChange={handleDialogOpenChange}
      />

      <SettingsDialogHost />

      <FeedbackDialogHost />

      {/* Suspense fallback={null} mirrors the lazy RightSidebar above: the
          deferred chunk stays off the first-paint graph, and each dialog still
          renders null until its own open state flips — no flash, no behavior change. */}
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
