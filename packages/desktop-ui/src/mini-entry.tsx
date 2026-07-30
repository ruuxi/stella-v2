import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { PanelRight, Pin } from "@/ui/icons";
import "./index.css";
import "./ui/register-styles";
import "./shared/styles/app-base.css";
import "./shared/i18n/rtl.css";
import "./mini-entry.css";
import { applyLowPowerDocumentFlag } from "./shared/lib/device-perf";

import { ChatStoreProvider } from "./context/chat-store";
import { useChatStore } from "./context/chat-store-context";
import { ThemeProvider, useTheme } from "./context/theme-context";
import { ShiftingGradient } from "./shell/background/ShiftingGradient";
import { UiStateProvider } from "./context/ui-state";
import { BootstrapStateProvider } from "./bootstrap/bootstrap-state";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { ChatPanelTab, type ChatPanelOpenRequest } from "./shell/ChatSidebar";
import { ToastProvider } from "./ui/toast";
import { LocalI18nProvider, useLocale } from "./shared/i18n/I18nProvider";
import { useConversationDisplayMessages } from "./features/chat/hooks/use-conversation-display-messages";
import { useConversationMessages } from "./features/chat/hooks/use-conversation-messages";
import { useStreamingChatCore } from "./features/chat/hooks/use-streaming-chat-core";
import { DesktopConvexAuthProvider } from "./global/auth/DesktopConvexAuthProvider";
import { useCloudMode } from "./global/auth/hooks/use-cloud-mode";
import { resolveOwnershipMigrationGate } from "./global/auth/lib/cloud-session-mode";
import { cloudApi } from "./features/cloud/cloud-api";
import {
  markCloudConversationCreated,
  resolveCloudConversationRoute,
} from "./features/cloud/cloud-conversation-selection";
import {
  getMiniCloudConversationCreateId,
  readActiveCloudConversationIdCache,
  rotateMiniCloudConversationCreateId,
  writeActiveCloudConversationIdCache,
} from "./features/cloud/cloud-conversation-cache";
import {
  activeCloudUserMessageIds,
  completeJournalWindowRecords,
  hasIncompleteLeadingJournalTurn,
  journalRecordsToMessageRecords,
  mergeCanonicalMessagesWithLocalCache,
} from "./features/cloud/journal-message-records";
import { useConversation } from "./features/cloud/use-conversation";
import { useOwnDeviceRemoteCancel } from "./features/cloud/use-own-device-remote-cancel";
import "./shell/error-boundary.css";

applyLowPowerDocumentFlag();
document.documentElement.dataset.stellaWindow = "mini";

const noopNotifyTierRestrictedModel = () => {};
type MiniDisplayModule = typeof import("./mini-display/MiniDisplayFeature");
type IdleCallbackHandle = number;
type IdleDeadline = {
  readonly didTimeout: boolean;
  timeRemaining(): number;
};
type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadline) => void,
    options?: { timeout?: number },
  ) => IdleCallbackHandle;
  cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
};

const MAX_QUEUED_DISPLAY_PAYLOADS = 20;
let miniDisplayModulePromise: Promise<MiniDisplayModule> | null = null;

function loadMiniDisplayModule(): Promise<MiniDisplayModule> {
  miniDisplayModulePromise ??= import("./mini-display/MiniDisplayFeature");
  return miniDisplayModulePromise;
}

function MiniWindowTopBar({
  latestRawPayloadRef,
  miniDisplayModule,
  onOpenWorkspacePanel,
}: {
  latestRawPayloadRef: RefObject<unknown | null>;
  miniDisplayModule: MiniDisplayModule | null;
  onOpenWorkspacePanel: () => void;
}) {
  const [miniAlwaysOnTop, setMiniAlwaysOnTopState] = useState(true);
  const MiniDisplayTabBar = miniDisplayModule?.MiniDisplayTabBar;
  const MiniDisplayWorkspaceButton =
    miniDisplayModule?.MiniDisplayWorkspaceButton;

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.window.isMiniAlwaysOnTop?.().then((enabled) => {
      if (!cancelled) setMiniAlwaysOnTopState(Boolean(enabled));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleMiniAlwaysOnTop = useCallback(() => {
    const next = !miniAlwaysOnTop;
    setMiniAlwaysOnTopState(next);
    void window.electronAPI?.window
      .setMiniAlwaysOnTop?.(next)
      .then((actual) => setMiniAlwaysOnTopState(Boolean(actual)))
      .catch(() => setMiniAlwaysOnTopState(!next));
  }, [miniAlwaysOnTop]);

  return (
    <header className="mini-window-topbar">
      <div className="mini-window-topbar__drag" aria-hidden="true" />
      {MiniDisplayTabBar ? <MiniDisplayTabBar /> : null}
      <div className="mini-window-topbar__spacer" aria-hidden="true" />
      <div className="mini-window-topbar__actions">
        <button
          type="button"
          className="mini-window-topbar__button"
          onClick={toggleMiniAlwaysOnTop}
          aria-label={
            miniAlwaysOnTop
              ? "Disable always on top"
              : "Keep mini window on top"
          }
          aria-pressed={miniAlwaysOnTop}
          title={
            miniAlwaysOnTop
              ? "Disable always on top"
              : "Keep mini window on top"
          }
        >
          <Pin size={14} strokeWidth={1.75} />
        </button>
        {MiniDisplayWorkspaceButton ? (
          <MiniDisplayWorkspaceButton
            latestRawPayloadRef={latestRawPayloadRef}
          />
        ) : (
          <button
            type="button"
            className="mini-window-topbar__button"
            onClick={onOpenWorkspacePanel}
            aria-label="Open workspace panel"
            title="Open workspace panel"
          >
            <PanelRight size={14} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </header>
  );
}

function useMiniActiveConversationId() {
  const { cloudMode, isLoading, accountScope } = useCloudMode();
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
  const conversations = useQuery(
    cloudApi.listMyConversations,
    cloudMode ? {} : "skip",
  );
  const cachedCloudConversationId = cloudMode
    ? readActiveCloudConversationIdCache(accountScope)
    : null;
  const cachedConversationIsListed = Boolean(
    cachedCloudConversationId &&
    conversations?.some(
      (conversation) =>
        conversation.conversationId === cachedCloudConversationId,
    ),
  );
  const exactCachedCloudConversation = useQuery(
    cloudApi.getMyConversation,
    cloudMode && cachedCloudConversationId && !cachedConversationIsListed
      ? { conversationId: cachedCloudConversationId }
      : "skip",
  );
  const cachedOwnershipIsLoading = Boolean(
    cloudMode &&
    cachedCloudConversationId &&
    !cachedConversationIsListed &&
    exactCachedCloudConversation === undefined,
  );
  const createCloudConversation = useMutation(cloudApi.createMyConversation);
  const retryOwnershipMigrationMutation = useMutation(
    cloudApi.retryMyLatestFailedOwnershipMigration,
  );
  const [ownershipMigrationRetryFailure, setOwnershipMigrationRetryFailure] =
    useState<string | null>(null);
  const selectionKey = isLoading || !cloudMode ? null : `cloud:${accountScope}`;
  const selectionKeyRef = useRef(selectionKey);
  selectionKeyRef.current = selectionKey;
  const [selection, setSelection] = useState<{
    key: string;
    conversationId: string;
  } | null>(null);
  const cloudCreateAttemptsRef = useRef(
    new Map<string, Promise<{ conversationId: string }>>(),
  );
  const [, retryCloudCreate] = useState(0);

  useEffect(() => {
    if (
      !cloudMode ||
      !selectionKey ||
      ownershipMigrationIsLoading ||
      ownershipMigrationPending ||
      ownershipMigrationFailed ||
      conversations === undefined ||
      cachedOwnershipIsLoading
    ) {
      return;
    }
    const currentConversationId =
      selection?.key === selectionKey ? selection.conversationId : null;
    const resolved = resolveCloudConversationRoute({
      conversations: exactCachedCloudConversation
        ? [exactCachedCloudConversation, ...conversations]
        : conversations,
      routeConversationId: currentConversationId,
      cachedConversationId: cachedCloudConversationId,
      accountScope,
    });
    if (resolved) {
      setSelection((current) =>
        current?.key === selectionKey && current.conversationId === resolved
          ? current
          : { key: selectionKey, conversationId: resolved },
      );
      writeActiveCloudConversationIdCache(accountScope, resolved);
      return;
    }

    if (cloudCreateAttemptsRef.current.has(accountScope)) return;
    const clientCreateId = getMiniCloudConversationCreateId(accountScope);
    const attempt = createCloudConversation({ clientCreateId });
    cloudCreateAttemptsRef.current.set(accountScope, attempt);
    void attempt
      .then((created) => {
        cloudCreateAttemptsRef.current.delete(accountScope);
        rotateMiniCloudConversationCreateId(accountScope);
        markCloudConversationCreated(created.conversationId, accountScope);
        if (selectionKeyRef.current !== selectionKey) return;
        writeActiveCloudConversationIdCache(
          accountScope,
          created.conversationId,
        );
        setSelection({
          key: selectionKey,
          conversationId: created.conversationId,
        });
      })
      .catch(() => {
        cloudCreateAttemptsRef.current.delete(accountScope);
        window.setTimeout(() => {
          if (selectionKeyRef.current === selectionKey) {
            retryCloudCreate((current) => current + 1);
          }
        }, 1_000);
      });
  }, [
    accountScope,
    cachedCloudConversationId,
    cachedOwnershipIsLoading,
    cloudMode,
    conversations,
    createCloudConversation,
    exactCachedCloudConversation,
    ownershipMigrationFailed,
    ownershipMigrationIsLoading,
    ownershipMigrationPending,
    selection,
    selectionKey,
  ]);

  useEffect(() => {
    setOwnershipMigrationRetryFailure(null);
  }, [accountScope]);

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

  const setConversationId = useCallback(
    (conversationId: string) => {
      if (!selectionKey || !cloudMode) return;
      setSelection({ key: selectionKey, conversationId });
      markCloudConversationCreated(conversationId, accountScope);
      writeActiveCloudConversationIdCache(accountScope, conversationId);
    },
    [accountScope, cloudMode, selectionKey],
  );

  return {
    conversationId:
      selectionKey && selection?.key === selectionKey
        ? selection.conversationId
        : null,
    setConversationId,
    cloudMode,
    accountScope,
    createCloudConversation,
    ownershipMigrationPending,
    ownershipMigrationFailed,
    ownershipMigrationIsLoading,
    ownershipMigrationError:
      ownershipMigrationRetryFailure ?? ownershipMigration?.error ?? null,
    retryOwnershipMigration,
  };
}

function MiniCloudStartupFailure({
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

function MiniChatSurface() {
  const locale = useLocale();
  const { gradientMode, gradientColor } = useTheme();
  const { cloudFeaturesEnabled } = useChatStore();
  const {
    conversationId,
    setConversationId,
    cloudMode,
    accountScope,
    createCloudConversation,
    ownershipMigrationPending,
    ownershipMigrationFailed,
    ownershipMigrationIsLoading,
    ownershipMigrationError,
    retryOwnershipMigration,
  } = useMiniActiveConversationId();
  const cloudConversation = useConversation(
    cloudFeaturesEnabled ? conversationId : null,
  );
  const [displayPortalTarget, setDisplayPortalTarget] =
    useState<HTMLDivElement | null>(null);
  const [miniDisplayModule, setMiniDisplayModule] =
    useState<MiniDisplayModule | null>(null);
  const miniDisplayModuleRef = useRef<MiniDisplayModule | null>(null);
  const latestDisplayRawPayloadRef = useRef<unknown | null>(null);
  const queuedDisplayRawPayloadsRef = useRef<unknown[]>([]);

  const drainQueuedDisplayPayloads = useCallback(
    (module: MiniDisplayModule) => {
      const queuedPayloads = queuedDisplayRawPayloadsRef.current.splice(0);
      for (const rawPayload of queuedPayloads) {
        module.routeMiniDisplayPayload(rawPayload, {
          activate: true,
          openPanel: false,
        });
      }
    },
    [],
  );

  const markMiniDisplayModuleReady = useCallback(
    (module: MiniDisplayModule) => {
      miniDisplayModuleRef.current = module;
      setMiniDisplayModule(module);
      drainQueuedDisplayPayloads(module);
    },
    [drainQueuedDisplayPayloads],
  );

  const ensureMiniDisplayModule = useCallback(async () => {
    const existingModule = miniDisplayModuleRef.current;
    if (existingModule) return existingModule;
    const module = await loadMiniDisplayModule();
    markMiniDisplayModuleReady(module);
    return module;
  }, [markMiniDisplayModuleReady]);

  useEffect(() => {
    return window.electronAPI?.display.onUpdate((rawPayload) => {
      latestDisplayRawPayloadRef.current = rawPayload;
      const module = miniDisplayModuleRef.current;
      if (module) {
        module.routeMiniDisplayPayload(rawPayload, {
          activate: true,
          openPanel: false,
        });
        return;
      }

      queuedDisplayRawPayloadsRef.current.push(rawPayload);
      if (
        queuedDisplayRawPayloadsRef.current.length > MAX_QUEUED_DISPLAY_PAYLOADS
      ) {
        queuedDisplayRawPayloadsRef.current.splice(
          0,
          queuedDisplayRawPayloadsRef.current.length -
            MAX_QUEUED_DISPLAY_PAYLOADS,
        );
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let frameId: number | null = null;
    let timerId: number | null = null;
    let idleId: IdleCallbackHandle | null = null;
    const idleWindow = window as WindowWithIdleCallback;

    const preload = () => {
      void loadMiniDisplayModule().then((module) => {
        if (cancelled) return;
        markMiniDisplayModuleReady(module);
      });
    };

    frameId = window.requestAnimationFrame(() => {
      timerId = window.setTimeout(() => {
        timerId = null;
        if (idleWindow.requestIdleCallback) {
          idleId = idleWindow.requestIdleCallback(
            () => {
              idleId = null;
              preload();
            },
            { timeout: 1500 },
          );
          return;
        }
        preload();
      }, 300);
    });

    return () => {
      cancelled = true;
      if (frameId != null) window.cancelAnimationFrame(frameId);
      if (timerId != null) window.clearTimeout(timerId);
      if (idleId != null) idleWindow.cancelIdleCallback?.(idleId);
    };
  }, [markMiniDisplayModuleReady]);

  // Focus the composer each time the mini window opens / regains focus, so the
  // user can type immediately and focus never lands on the scrollable message
  // region (a keyboard-focusable scroller that would otherwise draw a
  // focus-ring "selected" border on open). Mirrors the full window, which
  // focuses the composer whenever chat opens.
  const [composerFocusRequest, setComposerFocusRequest] =
    useState<ChatPanelOpenRequest>({ id: 1 });
  useEffect(() => {
    const onFocus = () =>
      setComposerFocusRequest((prev) => ({ id: prev.id + 1 }));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const { messages: localPersistedMessages } = useConversationMessages(
    conversationId ?? undefined,
  );
  const hasIncompleteCloudLeadingTurn =
    cloudFeaturesEnabled &&
    hasIncompleteLeadingJournalTurn(
      cloudConversation.state.records,
      cloudConversation.state.hasOlder,
    );
  const completeCloudRecords = useMemo(
    () =>
      cloudFeaturesEnabled
        ? completeJournalWindowRecords(
            cloudConversation.state.records,
            cloudConversation.state.hasOlder,
          )
        : [],
    [
      cloudConversation.state.hasOlder,
      cloudConversation.state.records,
      cloudFeaturesEnabled,
    ],
  );
  const canonicalMessages = useMemo(
    () =>
      cloudFeaturesEnabled
        ? journalRecordsToMessageRecords(completeCloudRecords)
        : [],
    [cloudFeaturesEnabled, completeCloudRecords],
  );
  const activeCanonicalUserMessageIds = useMemo(
    () =>
      cloudFeaturesEnabled
        ? activeCloudUserMessageIds(cloudConversation.state.records)
        : new Set<string>(),
    [cloudConversation.state.records, cloudFeaturesEnabled],
  );
  const persistedMessages = useMemo(
    () =>
      mergeCanonicalMessagesWithLocalCache(
        canonicalMessages,
        localPersistedMessages,
        activeCanonicalUserMessageIds,
      ),
    [activeCanonicalUserMessageIds, canonicalMessages, localPersistedMessages],
  );
  const hasOlderMessages =
    cloudFeaturesEnabled && cloudConversation.state.hasOlder;
  const isLoadingOlderMessages =
    cloudFeaturesEnabled && cloudConversation.state.loadingOlder;
  const isInitialLoadingMessages =
    !cloudFeaturesEnabled ||
    Boolean(
      conversationId &&
      canonicalMessages.length === 0 &&
      (hasIncompleteCloudLeadingTurn ||
        cloudConversation.status === "idle" ||
        cloudConversation.status === "connecting"),
    );
  const loadOlderCloudMessages = cloudConversation.loadOlder;
  useEffect(() => {
    if (
      !hasIncompleteCloudLeadingTurn ||
      cloudConversation.state.loadingOlder
    ) {
      return;
    }
    loadOlderCloudMessages();
  }, [
    cloudConversation.state.loadingOlder,
    hasIncompleteCloudLeadingTurn,
    loadOlderCloudMessages,
  ]);
  const loadOlderMessages = useCallback(() => {
    if (!cloudFeaturesEnabled) return;
    loadOlderCloudMessages();
  }, [cloudFeaturesEnabled, loadOlderCloudMessages]);

  const {
    optimisticEvents,
    runtimeStatusText,
    activeToolCallId,
    activeToolName,
    hasToolActivity,
    isToolActive,
    streamingAssistants,
    isStreaming,
    isStreamingResponseText,
    pendingUserMessageId,
    queuedUserMessages,
    removeQueuedUserMessage,
    sendMessage,
    cancelCurrentStream,
  } = useStreamingChatCore({
    conversationId,
    locale,
    notifyTierRestrictedModel: noopNotifyTierRestrictedModel,
    // The DO journal, not SQLite, acknowledges ordinary conversation rows.
    // The merged list still carries any unacknowledged recovery overlays.
    persistedMessages,
  });

  useOwnDeviceRemoteCancel({
    conversationId: cloudConversation.state.conversationId,
    records: cloudConversation.state.records,
    enabled: cloudFeaturesEnabled,
    onCancel: cancelCurrentStream,
  });

  const displayMessages = useConversationDisplayMessages({
    conversationId,
    persistedMessages,
    optimisticEvents,
    streamingAssistants,
  });

  const startNewChat = useCallback(async () => {
    if (!cloudMode) return;
    const nextConversationId = (
      await createCloudConversation({
        clientCreateId: crypto.randomUUID(),
      })
    ).conversationId;
    markCloudConversationCreated(nextConversationId, accountScope);
    setConversationId(nextConversationId);
  }, [accountScope, cloudMode, createCloudConversation, setConversationId]);

  const handleSend = useCallback(
    (
      text: string,
      chatContext?: Parameters<typeof sendMessage>[0]["chatContext"],
      selectedText?: string | null,
    ) => {
      void sendMessage({
        text,
        chatContext: chatContext ?? null,
        selectedText: selectedText ?? null,
        onClear: () => {},
      });
    },
    [sendMessage],
  );

  const loadingConversation = !conversationId || isInitialLoadingMessages;
  const messages = useMemo(
    () => (conversationId ? displayMessages : []),
    [conversationId, displayMessages],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      void ensureMiniDisplayModule().then((module) => {
        module.toggleMiniWorkspacePanel(latestDisplayRawPayloadRef.current);
      });
    },
    [ensureMiniDisplayModule],
  );
  const handleOpenWorkspacePanel = useCallback(() => {
    void ensureMiniDisplayModule().then((module) => {
      module.openMiniWorkspacePanel(latestDisplayRawPayloadRef.current);
    });
  }, [ensureMiniDisplayModule]);
  const MiniDisplayPanelHost = miniDisplayModule?.MiniDisplayPanelHost;

  if (ownershipMigrationFailed) {
    return (
      <MiniCloudStartupFailure
        message={
          ownershipMigrationError ??
          "Stella couldn't finish moving your anonymous cloud data to this account."
        }
        onRetry={retryOwnershipMigration}
      />
    );
  }

  if (ownershipMigrationIsLoading || ownershipMigrationPending) {
    return (
      <div className="error-boundary" role="status">
        <div className="error-boundary-gradient" />
        <div className="error-boundary-content">
          <h2>
            {ownershipMigrationPending
              ? "Moving your conversations…"
              : "Loading your conversations…"}
          </h2>
          <p>
            {ownershipMigrationPending
              ? "Stella will open chat when your anonymous cloud data is ready."
              : "Stella is checking your cloud conversation history."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mini-chat-app">
      <div className="mini-chat-shell" onContextMenu={handleContextMenu}>
        <ShiftingGradient
          mode={gradientMode}
          colorMode={gradientColor}
          lightweight={false}
          contained
        />
        <MiniWindowTopBar
          latestRawPayloadRef={latestDisplayRawPayloadRef}
          miniDisplayModule={miniDisplayModule}
          onOpenWorkspacePanel={handleOpenWorkspacePanel}
        />
        <div ref={setDisplayPortalTarget} className="mini-chat-body full-body">
          <div className="mini-chat-content">
            <ChatPanelTab
              openRequest={composerFocusRequest}
              conversationId={conversationId}
              variant="mini"
              messages={messages}
              isStreaming={isStreaming}
              isStreamingResponseText={isStreamingResponseText}
              runtimeStatusText={runtimeStatusText}
              activeToolCallId={activeToolCallId}
              activeToolName={activeToolName}
              hasToolActivity={hasToolActivity}
              isToolActive={isToolActive}
              pendingUserMessageId={pendingUserMessageId}
              queuedUserMessages={queuedUserMessages}
              removeQueuedUserMessage={removeQueuedUserMessage}
              hasOlderMessages={hasOlderMessages}
              isLoadingOlder={isLoadingOlderMessages}
              isInitialLoading={loadingConversation}
              onLoadOlder={loadOlderMessages}
              onSend={handleSend}
              onStop={cancelCurrentStream}
              onNewChat={startNewChat}
            />
          </div>
          {MiniDisplayPanelHost ? (
            <MiniDisplayPanelHost portalTarget={displayPortalTarget} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MiniRoot() {
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get(
      "rendererReadiness",
    );
    if (token) window.electronAPI?.ui.setRendererMounted?.("mini", token);
  }, []);

  return (
    <ErrorBoundary>
      <DesktopConvexAuthProvider enableRuntimeEffects={false}>
        <LocalI18nProvider>
          <ThemeProvider>
            <ToastProvider>
              <BootstrapStateProvider>
                <UiStateProvider>
                  <ChatStoreProvider>
                    <MiniChatSurface />
                  </ChatStoreProvider>
                </UiStateProvider>
              </BootstrapStateProvider>
            </ToastProvider>
          </ThemeProvider>
        </LocalI18nProvider>
      </DesktopConvexAuthProvider>
    </ErrorBoundary>
  );
}

createRoot(document.getElementById("root")!).render(<MiniRoot />);
