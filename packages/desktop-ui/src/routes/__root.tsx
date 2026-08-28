import {
  createRootRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { z } from "zod";
import { ChatRuntimeProvider } from "@/context/chat-runtime";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { OPEN_CONNECT_DIALOG_EVENT } from "@/global/integrations/connect-action";
import { setActiveLocalConversationId } from "@/features/chat/services/local-chat-store";
import { conversationTabs } from "@/features/chat/services/conversation-tabs-store";
import { writeActiveConversationIdCache } from "@/features/chat/services/active-conversation-cache";
import type { RightSidebarHandle } from "@/shell/RightSidebar";

const RightSidebar = lazy(() =>
  import("@/shell/RightSidebar").then((m) => ({ default: m.RightSidebar })),
);
const WorkspaceHomeSurface = lazy(() =>
  import("@/shell/WorkspaceHomeSurface").then((m) => ({
    default: m.WorkspaceHomeSurface,
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
import { MobileWalletSpendNotificationsBridge } from "@/global/mobile/MobileWalletSpendNotificationsBridge";
import { useDictationToggleBridge } from "@/shell/root-chrome/use-dictation-toggle-bridge";
import { useDisplayPayloadRouting } from "@/shell/root-chrome/use-display-payload-routing";
import { useLastLocationRestore } from "@/shell/root-chrome/use-last-location-restore";
import { usePersistLastLocation } from "@/shell/root-chrome/use-persist-last-location";
import { useWorkspacePanelEvents } from "@/shell/root-chrome/use-workspace-panel-events";
import {
  shellBreakpointStore,
  useShellBreakpointState,
} from "@/shell/shell-breakpoints";

function RootLayout() {
  const { state, setConversationId } = useUiState();
  const matchRoute = useMatchRoute();
  const isOnChatRoute = Boolean(matchRoute({ to: "/chat" }));
  const routerConversationId = useRouterState({
    select: (s) =>
      s.location.pathname === "/chat"
        ? ((s.location.search as { c?: string }).c ?? null)
        : null,
  });
  const conversationId = routerConversationId ?? state.conversationId;
  const router = useRouter();

  useEffect(() => {
    if (routerConversationId && routerConversationId !== state.conversationId) {
      setConversationId(routerConversationId);
    }
  }, [routerConversationId, setConversationId, state.conversationId]);

  useEffect(() => {
    if (!routerConversationId) return;
    writeActiveConversationIdCache(routerConversationId);
    void setActiveLocalConversationId(routerConversationId);
  }, [routerConversationId]);

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

  return (
    <ModelCatalogUpdatedAtProvider>
      <ChatRuntimeProvider
        activeConversationId={conversationId}
        isOnChatRoute={isOnChatRoute}
        navigateToConversation={navigateToConversation}
      >
        <RootChrome />
      </ChatRuntimeProvider>
    </ModelCatalogUpdatedAtProvider>
  );
}

function RootChrome() {
  useRestrictedStellaModelReset();

  const navigate = useNavigate();
  const { dialog: activeDialog } = Route.useSearch();
  const { state } = useUiState();
  const conversationId = state.conversationId;
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
      <MobileWalletSpendNotificationsBridge />

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

        {

}
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

      <GlobalModelsControl visible={modelControlVisible} />

      <FullShellDialogs
        activeDialog={activeDialog ?? null}
        onDialogOpenChange={handleDialogOpenChange}
      />

      <SettingsDialogHost />

      <FeedbackDialogHost />

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

const RootSearch = z.object({
  dialog: z.enum(["auth", "connect"]).optional(),
});

export const Route = createRootRoute({
  validateSearch: RootSearch,
  component: RootLayout,
});
