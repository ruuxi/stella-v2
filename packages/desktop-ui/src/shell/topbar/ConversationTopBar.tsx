import { useRouter } from "@tanstack/react-router";
import {
  useAction,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type HTMLAttributes,
} from "react";
import type {
  ConversationSummary,
  LocalChatUpdatedPayload,
} from "@stella/contracts/local-chat";
import {
  conversationTabs,
  type ConversationTitleCursor,
  useConversationTabs,
} from "@/features/chat/services/conversation-tabs-store";
import { conversationModelSelections } from "@/features/chat/services/conversation-model-selection";
import { cloudApi, type CloudConversation } from "@/features/cloud/cloud-api";
import {
  cloudConversationBelongsToOwnerSubject,
  cloudConversationsForOwnerSubject,
  markCloudConversationCreated,
} from "@/features/cloud/cloud-conversation-selection";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { showToast } from "@/ui/toast";
import { Popover } from "@/ui/popover";
import {
  Check,
  History,
  House,
  MessageSquare,
  Plus,
  Trash2,
  X,
} from "@/ui/icons";
import {
  dispatchEnterChat,
  dispatchShowHome,
} from "@/shared/lib/stella-orb-chat";
import { useT } from "@/shared/i18n";
import "./conversation-topbar.css";

const ConversationHistoryPopoverContent = Popover.Content as ComponentType<
  HTMLAttributes<HTMLDivElement> & {
    align?: "start" | "center" | "end";
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
  }
>;

const HISTORY_PAGE_SIZE = 50;
const TAB_DRAG_ACTIVATION_DISTANCE = 4;
const TAB_DRAG_EDGE_SIZE = 24;
const TAB_DRAG_SCROLL_STEP = 12;
const HISTORY_DELETE_CONFIRM_TIMEOUT_MS = 3000;
const HISTORY_HOVER_CLOSE_DELAY_MS = 120;

export type TabOverflow = { left: boolean; right: boolean };

export const measureConversationTabOverflow = (
  element: Pick<HTMLElement, "scrollLeft" | "scrollWidth" | "clientWidth">,
): TabOverflow => ({
  left: element.scrollLeft > 1,
  right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
});

export const isConversationTabTitleOverflowing = (
  element: Pick<HTMLElement, "scrollWidth" | "clientWidth">,
): boolean => element.scrollWidth > element.clientWidth + 1;

export const shouldRenderConversationHomeLauncher = (tabCount: number) =>
  tabCount === 1;

export const shouldRenderNewChatLabel = (tabCount: number) => tabCount <= 1;

export const resolveHistoryDeleteActivation = (
  armedConversationId: string | null,
  conversationId: string,
): "arm" | "delete" =>
  armedConversationId === conversationId ? "delete" : "arm";

const formatHistoryTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};

const isKeyboardClick = (event: React.MouseEvent<HTMLElement>) =>
  event.detail === 0;

const historyKeyExtractor = (summary: ConversationSummary) =>
  summary.conversationId;

export const cloudConversationToSummary = (
  conversation: CloudConversation,
): ConversationSummary => ({
  conversationId: conversation.conversationId,
  title: conversation.title,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  latestMessageAt: conversation.updatedAt,
  latestMessageId: `cloud:${conversation.updatedAt}:${conversation.conversationId}`,
});

/**
 * A frozen history walk and the live recent slice deliberately overlap. Merge
 * by immutable conversation id, prefer the live projection, and reapply the
 * backend's declared `(updatedAt, conversationId)` order. A row that moves
 * above the walk's timestamp bound therefore stays discoverable without
 * perturbing or duplicating the cursor walk itself.
 */
export const mergeCloudConversationHistory = (
  frozen: readonly CloudConversation[],
  recent: readonly CloudConversation[],
): CloudConversation[] => {
  const byId = new Map(
    frozen.map((conversation) => [conversation.conversationId, conversation]),
  );
  for (const conversation of recent) {
    byId.set(conversation.conversationId, conversation);
  }
  return [...byId.values()].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      right.conversationId.localeCompare(left.conversationId),
  );
};

/**
 * A background tab earns its unread dot from a persisted assistant message
 * only. User turns are always the user's own doing, and the conversation the
 * user is currently reading is by definition already read.
 */
export const shouldMarkConversationUnread = (
  payload: LocalChatUpdatedPayload | null,
  conversationId: string,
  activeConversationId: string | null,
): boolean =>
  payload?.event?.type === "assistant_message" &&
  conversationId !== activeConversationId;

type ConversationTabShortcut =
  | { type: "new" }
  | { type: "close"; conversationId: string }
  | { type: "select"; conversationId: string };

type ConversationTabShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey" | "target"
>;

export const isEditableConversationTabShortcutTarget = (
  target: EventTarget | null,
): boolean => {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ),
  );
};

export const resolveConversationTabShortcut = (
  event: ConversationTabShortcutEvent,
  tabs: readonly { conversationId: string }[],
  activeConversationId: string | null,
): ConversationTabShortcut | null => {
  if (isEditableConversationTabShortcutTarget(event.target) || event.altKey) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (event.ctrlKey && !event.metaKey && key === "tab") {
    if (!activeConversationId || tabs.length === 0) return null;
    const activeIndex = tabs.findIndex(
      (tab) => tab.conversationId === activeConversationId,
    );
    if (activeIndex < 0) return null;
    const offset = event.shiftKey ? -1 : 1;
    const target = tabs[(activeIndex + offset + tabs.length) % tabs.length];
    return target
      ? { type: "select", conversationId: target.conversationId }
      : null;
  }

  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.shiftKey) return null;
  if (key === "t") return { type: "new" };
  if (key === "w") {
    return tabs.length > 1 &&
      activeConversationId &&
      tabs.some((tab) => tab.conversationId === activeConversationId)
      ? { type: "close", conversationId: activeConversationId }
      : null;
  }
  if (/^[1-9]$/.test(key)) {
    const target = tabs[Number(key) - 1];
    return target
      ? { type: "select", conversationId: target.conversationId }
      : null;
  }
  return null;
};

type ConversationTabPointerDrag = {
  conversationId: string;
  pointerId: number;
  startX: number;
  activated: boolean;
};

export function ConversationTopBar() {
  const t = useT();
  const router = useRouter();
  const chat = useChatRuntime();
  const { cloudMode, accountScope, ownerSubject } = useCloudMode();
  const tabSnapshot = useConversationTabs();
  // A scope change clears the backing store in RootLayout's layout effect.
  // Filter during the transition too so a previous owner's ids cannot enter
  // this render tree for even one frame.
  const tabs =
    tabSnapshot.accountScope === accountScope ? tabSnapshot.tabs : [];
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySnapshot, setHistorySnapshot] = useState<{
    accountScope: string;
    snapshotUpdatedAt: number;
  } | null>(null);
  const frozenHistorySnapshot =
    historySnapshot?.accountScope === accountScope ? historySnapshot : null;
  const recentCloudConversations = useQuery(
    cloudApi.listMyConversations,
    cloudMode ? {} : "skip",
  );
  const conversationIdentity = useQuery(
    cloudApi.getMyCloudConversationIdentity,
    cloudMode ? {} : "skip",
  );
  const ownerGeneration =
    conversationIdentity?.ownerId === ownerSubject
      ? conversationIdentity.ownerGeneration
      : null;
  const historySnapshotCandidate = useQuery(
    cloudApi.getMyConversationHistorySnapshot,
    cloudMode && historyOpen && frozenHistorySnapshot === null ? {} : "skip",
  );
  const paginatedHistory = usePaginatedQuery(
    cloudApi.listMyConversationsPage,
    cloudMode && frozenHistorySnapshot
      ? { snapshotUpdatedAt: frozenHistorySnapshot.snapshotUpdatedAt }
      : "skip",
    { initialNumItems: HISTORY_PAGE_SIZE },
  );
  const scopedRecentCloudConversations = useMemo(
    () =>
      cloudConversationsForOwnerSubject(
        recentCloudConversations ?? [],
        ownerSubject,
      ),
    [ownerSubject, recentCloudConversations],
  );
  const createCloudConversation = useMutation(cloudApi.createMyConversation);
  const deleteCloudConversation = useAction(cloudApi.deleteMyConversation);
  const showNewChatLabel = shouldRenderNewChatLabel(tabs.length);
  const activeConversationId = chat.conversation.conversationId;
  const activeConversationIsRecent = Boolean(
    activeConversationId &&
      scopedRecentCloudConversations.some(
        (conversation) => conversation.conversationId === activeConversationId,
      ),
  );
  const activeCloudConversation = useQuery(
    cloudApi.getMyConversation,
    cloudMode && activeConversationId && !activeConversationIsRecent
      ? { conversationId: activeConversationId }
      : "skip",
  );
  const scopedActiveCloudConversation =
    activeCloudConversation &&
    cloudConversationBelongsToOwnerSubject(
      activeCloudConversation,
      ownerSubject,
    )
      ? activeCloudConversation
      : null;
  const [historyState, setHistoryState] = useState<{
    accountScope: string;
    items: ConversationSummary[];
  }>(() => ({ accountScope, items: [] }));
  const history =
    historyState.accountScope === accountScope ? historyState.items : [];
  const historyHasMore =
    paginatedHistory.status === "CanLoadMore" ||
    paginatedHistory.status === "LoadingMore";
  const historyLoading =
    (historyOpen && frozenHistorySnapshot === null) ||
    paginatedHistory.status === "LoadingFirstPage" ||
    paginatedHistory.status === "LoadingMore";
  const historyError = false;
  const [historyDeleteArmedId, setHistoryDeleteArmedId] = useState<
    string | null
  >(null);
  const [historyDeletingId, setHistoryDeletingId] = useState<string | null>(
    null,
  );
  const [historyDeleteErrorId, setHistoryDeleteErrorId] = useState<
    string | null
  >(null);
  const createRequestRef = useRef<{
    id: string;
    ownerGeneration: string;
  } | null>(null);
  const createInFlightRef = useRef(false);
  const activeAccountScopeRef = useRef(accountScope);
  activeAccountScopeRef.current = accountScope;
  const activeOwnerGenerationRef = useRef(ownerGeneration);
  activeOwnerGenerationRef.current = ownerGeneration;
  const cloudUpdatedAtRef = useRef<{
    accountScope: string;
    values: Map<string, number>;
  }>({ accountScope: "", values: new Map() });
  const historyDeleteTimerRef = useRef<number | null>(null);
  const historyHoverCloseTimerRef = useRef<number | null>(null);
  const historyAuthorityRef = useRef({ accountScope, ownerGeneration });
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const titleRefs = useRef(new Map<string, HTMLSpanElement>());
  const tabPointerDragRef = useRef<ConversationTabPointerDrag | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const [draggingConversationId, setDraggingConversationId] = useState<
    string | null
  >(null);
  const [overflow, setOverflow] = useState<TabOverflow>({
    left: false,
    right: false,
  });
  const [overflowingTitleIds, setOverflowingTitleIds] = useState<
    ReadonlySet<string>
  >(new Set());

  const navigateToConversation = useCallback(
    (
      conversationId: string,
      title?: string,
      cursor?: ConversationTitleCursor,
    ) => {
      conversationTabs.openConversation(conversationId, title, cursor);
      void router.navigate({
        to: "/chat",
        search: { c: conversationId },
      });
    },
    [router],
  );

  /**
   * History is in-place navigation: the current tab becomes the selected
   * session. New Chat (+) is the only action that appends a tab.
   */
  const openHistoryConversation = useCallback(
    (
      conversationId: string,
      title?: string,
      cursor?: ConversationTitleCursor,
    ) => {
      conversationTabs.replaceConversation(
        activeConversationId,
        conversationId,
        title,
        cursor,
      );
      dispatchEnterChat();
      void router.navigate({
        to: "/chat",
        search: { c: conversationId },
      });
    },
    [activeConversationId, router],
  );

  const createConversation = useCallback(async () => {
    if (!cloudMode || !ownerGeneration || createInFlightRef.current) return;
    const prior = createRequestRef.current;
    const request =
      prior?.ownerGeneration === ownerGeneration
        ? prior
        : { id: crypto.randomUUID(), ownerGeneration };
    const clientCreateId = request.id;
    createRequestRef.current = request;
    createInFlightRef.current = true;
    try {
      const created = await createCloudConversation({
        clientCreateId,
        expectedOwnerGeneration: request.ownerGeneration,
      });
      if (
        activeAccountScopeRef.current !== accountScope ||
        activeOwnerGenerationRef.current !== request.ownerGeneration ||
        createRequestRef.current !== request
      ) {
        return;
      }
      createInFlightRef.current = false;
      createRequestRef.current = null;
      markCloudConversationCreated(created.conversationId, accountScope);
      navigateToConversation(created.conversationId, created.title);
    } catch (error) {
      if (
        activeAccountScopeRef.current !== accountScope ||
        activeOwnerGenerationRef.current !== request.ownerGeneration ||
        createRequestRef.current !== request
      ) {
        return;
      }
      // Retain the idempotency key. A retry must converge on the conversation
      // even when the first response was lost after the server committed it.
      showToast({
        title: "Couldn’t create a new chat",
        description:
          error instanceof Error && error.message.trim()
            ? error.message
            : "Try again in a moment.",
        variant: "error",
      });
    } finally {
      if (
        activeAccountScopeRef.current === accountScope &&
        activeOwnerGenerationRef.current === request.ownerGeneration &&
        createRequestRef.current === request
      ) {
        createInFlightRef.current = false;
      }
    }
  }, [
    accountScope,
    cloudMode,
    createCloudConversation,
    navigateToConversation,
    ownerGeneration,
  ]);

  const loadHistory = useCallback(
    async (_cursor: unknown, replace: boolean) => {
      if (!replace && paginatedHistory.status === "CanLoadMore") {
        paginatedHistory.loadMore(HISTORY_PAGE_SIZE);
      }
    },
    [paginatedHistory],
  );

  const historyFromServer = useMemo(() => {
    const frozen = cloudConversationsForOwnerSubject(
      paginatedHistory.results as CloudConversation[],
      ownerSubject,
    );
    return mergeCloudConversationHistory(
      frozen,
      scopedRecentCloudConversations,
    ).map(cloudConversationToSummary);
  }, [ownerSubject, paginatedHistory.results, scopedRecentCloudConversations]);

  useEffect(() => {
    if (!historyOpen) {
      // Reopening is the explicit refresh boundary: it obtains a new server
      // clock anchor and starts a new cursor walk.
      setHistorySnapshot(null);
      return;
    }
    if (!historySnapshotCandidate || frozenHistorySnapshot !== null) return;
    setHistorySnapshot({
      accountScope,
      snapshotUpdatedAt: historySnapshotCandidate.snapshotUpdatedAt,
    });
  }, [
    accountScope,
    frozenHistorySnapshot,
    historyOpen,
    historySnapshotCandidate,
  ]);

  useEffect(() => {
    const previousAuthority = historyAuthorityRef.current;
    historyAuthorityRef.current = { accountScope, ownerGeneration };
    const initialGenerationResolution =
      previousAuthority.accountScope === accountScope &&
      previousAuthority.ownerGeneration === null &&
      ownerGeneration !== null;
    if (initialGenerationResolution) return;
    for (const timerRef of [historyDeleteTimerRef, historyHoverCloseTimerRef]) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    createRequestRef.current = null;
    createInFlightRef.current = false;
    cloudUpdatedAtRef.current = { accountScope, values: new Map() };
    setHistorySnapshot(null);
    setHistoryState({ accountScope, items: [] });
    setHistoryDeleteArmedId(null);
    setHistoryDeletingId(null);
    setHistoryDeleteErrorId(null);
    setHistoryOpen(false);
  }, [accountScope, ownerGeneration]);

  useEffect(() => {
    setHistoryState({ accountScope, items: historyFromServer });
    conversationTabs.mergeSummaries(historyFromServer);
    // `ownerGeneration` can resolve after the server list. The authority-reset
    // effect above deliberately clears prior-generation rows; rerun this
    // owner-filtered projection in the same commit so initial resolution does
    // not strand History empty until a later server mutation.
  }, [accountScope, historyFromServer, ownerGeneration]);

  useEffect(() => {
    if (!activeConversationId) return;
    const summary = [
      ...(scopedActiveCloudConversation ? [scopedActiveCloudConversation] : []),
      ...scopedRecentCloudConversations,
    ].find(
      (conversation) => conversation.conversationId === activeConversationId,
    );
    conversationTabs.openConversation(
      activeConversationId,
      summary?.title,
      summary
        ? {
            latestMessageAt: summary.updatedAt,
            latestMessageId: `cloud:${summary.updatedAt}:${summary.conversationId}`,
          }
        : undefined,
    );
    conversationTabs.markRead(activeConversationId);
  }, [
    activeConversationId,
    scopedActiveCloudConversation,
    scopedRecentCloudConversations,
  ]);

  // Background unread and title changes come from the server-owned index, not
  // desktop SQLite. The first snapshot only seeds cursors; later monotonic
  // `updatedAt` advances may mark an inactive open tab unread.
  useEffect(() => {
    if (!recentCloudConversations) return;
    let tracker = cloudUpdatedAtRef.current;
    if (tracker.accountScope !== accountScope) {
      tracker = { accountScope, values: new Map() };
      cloudUpdatedAtRef.current = tracker;
    }
    const summaries = scopedRecentCloudConversations.map(
      cloudConversationToSummary,
    );
    conversationTabs.mergeSummaries(summaries);
    for (const conversation of scopedRecentCloudConversations) {
      const previous = tracker.values.get(conversation.conversationId);
      if (
        previous !== undefined &&
        conversation.updatedAt > previous &&
        conversation.conversationId !== activeConversationId
      ) {
        conversationTabs.markUnread(conversation.conversationId);
      }
      tracker.values.set(conversation.conversationId, conversation.updatedAt);
    }
  }, [
    accountScope,
    activeConversationId,
    recentCloudConversations,
    scopedRecentCloudConversations,
  ]);

  const scheduleOverflowMeasurement = useCallback(() => {
    if (measureFrameRef.current !== null) return;
    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null;
      const element = stripRef.current;
      if (!element) return;
      const next = measureConversationTabOverflow(element);
      setOverflow((current) =>
        current.left === next.left && current.right === next.right
          ? current
          : next,
      );
      const nextOverflowingTitleIds = new Set<string>();
      for (const [conversationId, title] of titleRefs.current) {
        if (isConversationTabTitleOverflowing(title)) {
          nextOverflowingTitleIds.add(conversationId);
        }
      }
      setOverflowingTitleIds((current) => {
        if (
          current.size === nextOverflowingTitleIds.size &&
          [...current].every((conversationId) =>
            nextOverflowingTitleIds.has(conversationId),
          )
        ) {
          return current;
        }
        return nextOverflowingTitleIds;
      });
    });
  }, []);

  useLayoutEffect(() => {
    const element = stripRef.current;
    if (!element) return;
    const observer = new ResizeObserver(scheduleOverflowMeasurement);
    observer.observe(element);
    scheduleOverflowMeasurement();
    return () => observer.disconnect();
  }, [scheduleOverflowMeasurement, tabs.length]);

  useLayoutEffect(() => {
    const activeTab = activeConversationId
      ? tabRefs.current.get(activeConversationId)
      : null;
    activeTab?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "auto",
    });
    scheduleOverflowMeasurement();
  }, [activeConversationId, scheduleOverflowMeasurement, tabs]);

  useEffect(
    () => () => {
      if (measureFrameRef.current !== null) {
        window.cancelAnimationFrame(measureFrameRef.current);
      }
    },
    [],
  );

  const closeConversation = useCallback(
    async (conversationId: string) => {
      const result = conversationTabs.closeConversation(
        conversationId,
        activeConversationId,
      );
      if (!result.closed || activeConversationId !== conversationId) return;
      if (result.nextConversationId) {
        navigateToConversation(result.nextConversationId);
        return;
      }
      await createConversation();
    },
    [activeConversationId, createConversation, navigateToConversation],
  );

  const clearHistoryDeleteTimer = useCallback(() => {
    if (historyDeleteTimerRef.current === null) return;
    window.clearTimeout(historyDeleteTimerRef.current);
    historyDeleteTimerRef.current = null;
  }, []);

  const disarmHistoryDelete = useCallback(() => {
    clearHistoryDeleteTimer();
    setHistoryDeleteArmedId(null);
    setHistoryDeleteErrorId(null);
  }, [clearHistoryDeleteTimer]);

  const clearHistoryHoverCloseTimer = useCallback(() => {
    if (historyHoverCloseTimerRef.current === null) return;
    window.clearTimeout(historyHoverCloseTimerRef.current);
    historyHoverCloseTimerRef.current = null;
  }, []);

  const openHistoryFromHover = useCallback(() => {
    clearHistoryHoverCloseTimer();
    setHistoryOpen(true);
  }, [clearHistoryHoverCloseTimer]);

  const scheduleHistoryCloseFromHover = useCallback(() => {
    clearHistoryHoverCloseTimer();
    historyHoverCloseTimerRef.current = window.setTimeout(() => {
      historyHoverCloseTimerRef.current = null;
      disarmHistoryDelete();
      setHistoryOpen(false);
    }, HISTORY_HOVER_CLOSE_DELAY_MS);
  }, [clearHistoryHoverCloseTimer, disarmHistoryDelete]);

  const deleteHistoryConversation = useCallback(
    async (summary: ConversationSummary) => {
      const action = resolveHistoryDeleteActivation(
        historyDeleteArmedId,
        summary.conversationId,
      );
      setHistoryDeleteErrorId(null);
      clearHistoryDeleteTimer();
      if (action === "arm") {
        setHistoryDeleteArmedId(summary.conversationId);
        historyDeleteTimerRef.current = window.setTimeout(() => {
          setHistoryDeleteArmedId(null);
          historyDeleteTimerRef.current = null;
        }, HISTORY_DELETE_CONFIRM_TIMEOUT_MS);
        return;
      }

      setHistoryDeleteArmedId(null);
      setHistoryDeletingId(summary.conversationId);
      const operationAccountScope = accountScope;
      try {
        const deleted = await deleteCloudConversation({
          conversationId: summary.conversationId,
        });
        if (activeAccountScopeRef.current !== operationAccountScope) return;
        if (!deleted.ok) {
          throw new Error("The cloud conversation was not deleted.");
        }
        conversationModelSelections.delete(summary.conversationId);
        setHistoryState((current) =>
          current.accountScope === operationAccountScope
            ? {
                ...current,
                items: current.items.filter(
                  (item) => item.conversationId !== summary.conversationId,
                ),
              }
            : current,
        );
        await closeConversation(summary.conversationId);
      } catch {
        if (activeAccountScopeRef.current !== operationAccountScope) return;
        setHistoryDeleteErrorId(summary.conversationId);
        historyDeleteTimerRef.current = window.setTimeout(() => {
          setHistoryDeleteErrorId(null);
          historyDeleteTimerRef.current = null;
        }, HISTORY_DELETE_CONFIRM_TIMEOUT_MS);
      } finally {
        if (activeAccountScopeRef.current === operationAccountScope) {
          setHistoryDeletingId(null);
        }
      }
    },
    [
      clearHistoryDeleteTimer,
      closeConversation,
      deleteCloudConversation,
      historyDeleteArmedId,
      accountScope,
    ],
  );

  useEffect(
    () => () => {
      clearHistoryDeleteTimer();
      clearHistoryHoverCloseTimer();
    },
    [clearHistoryDeleteTimer, clearHistoryHoverCloseTimer],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const action = resolveConversationTabShortcut(
        event,
        tabs,
        activeConversationId,
      );
      if (!action) return;
      event.preventDefault();
      if (action.type === "new") {
        void createConversation();
        return;
      }
      if (action.type === "close") {
        void closeConversation(action.conversationId);
        return;
      }
      const tab = tabs.find(
        (candidate) => candidate.conversationId === action.conversationId,
      );
      if (tab) navigateToConversation(tab.conversationId, tab.title);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeConversationId,
    closeConversation,
    createConversation,
    navigateToConversation,
    tabs,
  ]);

  const beginTabPointerDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, conversationId: string) => {
      if (
        event.button !== 0 ||
        (event.pointerType !== "mouse" && event.pointerType !== "pen") ||
        (event.target instanceof Element &&
          Boolean(event.target.closest(".conversation-topbar__tab-close")))
      ) {
        return;
      }
      tabPointerDragRef.current = {
        conversationId,
        pointerId: event.pointerId,
        startX: event.clientX,
        activated: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const moveTabPointerDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = tabPointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (
        !drag.activated &&
        Math.abs(event.clientX - drag.startX) < TAB_DRAG_ACTIVATION_DISTANCE
      ) {
        return;
      }
      if (!drag.activated) {
        drag.activated = true;
        setDraggingConversationId(drag.conversationId);
      }
      event.preventDefault();

      const strip = stripRef.current;
      if (strip) {
        const bounds = strip.getBoundingClientRect();
        if (event.clientX < bounds.left + TAB_DRAG_EDGE_SIZE) {
          strip.scrollLeft -= TAB_DRAG_SCROLL_STEP;
        } else if (event.clientX > bounds.right - TAB_DRAG_EDGE_SIZE) {
          strip.scrollLeft += TAB_DRAG_SCROLL_STEP;
        }
      }

      const currentTabs = conversationTabs.getSnapshot().tabs;
      let targetIndex = currentTabs.findIndex(
        (tab) => tab.conversationId === drag.conversationId,
      );
      let targetDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < currentTabs.length; index += 1) {
        const tab = currentTabs[index];
        const element = tab
          ? tabRefs.current.get(tab.conversationId)
          : undefined;
        if (!element) continue;
        const bounds = element.getBoundingClientRect();
        const distance = Math.abs(
          event.clientX - (bounds.left + bounds.width / 2),
        );
        if (distance < targetDistance) {
          targetDistance = distance;
          targetIndex = index;
        }
      }
      if (targetIndex >= 0) {
        conversationTabs.reorderConversation(drag.conversationId, targetIndex);
      }
      scheduleOverflowMeasurement();
    },
    [scheduleOverflowMeasurement],
  );

  const finishTabPointerDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = tabPointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      tabPointerDragRef.current = null;
      setDraggingConversationId(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const renderHistoryItem = useCallback(
    ({ item: summary }: LegendListRenderItemProps<ConversationSummary>) => {
      const deleteArmed = historyDeleteArmedId === summary.conversationId;
      const deleting = historyDeletingId === summary.conversationId;
      const deleteFailed = historyDeleteErrorId === summary.conversationId;
      return (
        <div
          className="conversation-history-popover__item"
          data-conversation-id={summary.conversationId}
          data-active={
            summary.conversationId === activeConversationId ? "true" : undefined
          }
          data-delete-armed={deleteArmed ? "true" : undefined}
          data-delete-error={deleteFailed ? "true" : undefined}
        >
          <button
            type="button"
            className="conversation-history-popover__item-target"
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              disarmHistoryDelete();
              openHistoryConversation(summary.conversationId, summary.title, {
                latestMessageAt: summary.latestMessageAt ?? summary.updatedAt,
                latestMessageId: summary.latestMessageId ?? "",
              });
              setHistoryOpen(false);
            }}
            onClick={(event) => {
              if (!isKeyboardClick(event)) return;
              disarmHistoryDelete();
              openHistoryConversation(summary.conversationId, summary.title, {
                latestMessageAt: summary.latestMessageAt ?? summary.updatedAt,
                latestMessageId: summary.latestMessageId ?? "",
              });
              setHistoryOpen(false);
            }}
            aria-label={t("shell.topbar.conversation.openConversation", {
              title: summary.title,
            })}
          >
            <span className="conversation-history-popover__title">
              {summary.title}
            </span>
            <span className="conversation-history-popover__time">
              {formatHistoryTime(summary.latestMessageAt ?? summary.updatedAt)}
            </span>
          </button>
          <button
            type="button"
            className="conversation-history-popover__delete"
            disabled={deleting}
            aria-label={
              deleteFailed
                ? t("shell.topbar.conversation.deleteFailedFor", {
                    title: summary.title,
                  })
                : deleteArmed
                  ? t("shell.topbar.conversation.deleteConfirmFor", {
                      title: summary.title,
                    })
                  : t("shell.topbar.conversation.delete", {
                      title: summary.title,
                    })
            }
            title={
              deleteFailed
                ? t("shell.topbar.conversation.deleteFailed")
                : deleteArmed
                  ? t("shell.topbar.conversation.deleteConfirm")
                  : t("shell.topbar.conversation.delete", {
                      title: summary.title,
                    })
            }
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              disarmHistoryDelete();
            }}
            onClick={(event) => {
              event.stopPropagation();
              void deleteHistoryConversation(summary);
            }}
          >
            {deleteArmed ? (
              <Check size={13} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </div>
      );
    },
    [
      activeConversationId,
      deleteHistoryConversation,
      disarmHistoryDelete,
      historyDeleteArmedId,
      historyDeleteErrorId,
      historyDeletingId,
      openHistoryConversation,
      t,
    ],
  );

  const historyListHeight = Math.min(
    380,
    Math.max(
      54,
      history.length * 34 + (historyLoading || historyError ? 44 : 0) + 10,
    ),
  );
  const showHomeLauncher = shouldRenderConversationHomeLauncher(tabs.length);

  return (
    <div
      className="conversation-topbar"
      data-testid="conversation-topbar"
      data-active-conversation-id={activeConversationId ?? undefined}
    >
      <Popover
        open={historyOpen}
        onOpenChange={(open) => {
          clearHistoryHoverCloseTimer();
          setHistoryOpen(open);
          if (!open) {
            disarmHistoryDelete();
          }
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="shell-topbar-icon-btn conversation-topbar__history"
            aria-label={t("shell.topbar.conversation.history")}
            title={t("shell.topbar.conversation.history")}
            onPointerEnter={(event) => {
              if (event.pointerType !== "touch") openHistoryFromHover();
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== "touch") {
                scheduleHistoryCloseFromHover();
              }
            }}
            onClick={(event) => {
              if (isKeyboardClick(event)) return;
              event.preventDefault();
              openHistoryFromHover();
            }}
          >
            <History
              className="conversation-topbar__control-icon"
              size={16}
              strokeWidth={1.85}
            />
          </button>
        </Popover.Trigger>
        <ConversationHistoryPopoverContent
          className="conversation-history-popover"
          data-history-has-more={historyHasMore ? "true" : "false"}
          data-history-loading={historyLoading ? "true" : "false"}
          align="start"
          side="bottom"
          sideOffset={6}
          aria-label={t("shell.topbar.conversation.history")}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") clearHistoryHoverCloseTimer();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "touch") {
              scheduleHistoryCloseFromHover();
            }
          }}
        >
          <LegendList<ConversationSummary>
            className="conversation-history-popover__list"
            data={history}
            keyExtractor={historyKeyExtractor}
            renderItem={renderHistoryItem}
            extraData={`${historyDeleteArmedId ?? ""}:${historyDeletingId ?? ""}:${historyDeleteErrorId ?? ""}`}
            estimatedItemSize={34}
            recycleItems
            onEndReached={() => {
              if (historyHasMore && !historyLoading) {
                void loadHistory(null, false);
              }
            }}
            onEndReachedThreshold={0.25}
            ListEmptyComponent={
              !historyLoading && !historyError ? (
                <div className="conversation-history-popover__status">
                  {t("shell.topbar.conversation.historyEmpty")}
                </div>
              ) : undefined
            }
            ListFooterComponent={
              historyLoading ? (
                <div className="conversation-history-popover__status">
                  {t("common.loading")}
                </div>
              ) : historyError ? (
                <button
                  type="button"
                  className="conversation-history-popover__retry"
                  onClick={() => void loadHistory(null, true)}
                >
                  {t("shell.topbar.conversation.historyRetry")}
                </button>
              ) : undefined
            }
            contentContainerStyle={{ padding: 5 }}
            style={{
              height: `min(${historyListHeight}px, calc(100vh - 78px))`,
              width: "100%",
            }}
          />
        </ConversationHistoryPopoverContent>
      </Popover>

      {showHomeLauncher ? (
        <button
          type="button"
          className="shell-topbar-icon-btn conversation-topbar__home"
          onClick={dispatchShowHome}
          aria-label={t("shell.topbar.conversation.home")}
          title={t("shell.topbar.conversation.home")}
        >
          <House
            className="conversation-topbar__control-icon"
            size={16}
            strokeWidth={1.85}
            aria-hidden="true"
          />
        </button>
      ) : (
        <div
          className="conversation-topbar__viewport"
          data-overflow-left={overflow.left ? "true" : undefined}
          data-overflow-right={overflow.right ? "true" : undefined}
        >
          <div
            ref={stripRef}
            className="conversation-topbar__tabs"
            role="tablist"
            aria-label={t("shell.topbar.conversation.openConversations")}
            onScroll={scheduleOverflowMeasurement}
          >
            {tabs.map((tab) => {
              const active = tab.conversationId === activeConversationId;
              const unread = Boolean(tab.unread) && !active;
              return (
                <div
                  key={tab.conversationId}
                  data-conversation-id={tab.conversationId}
                  ref={(element) => {
                    if (element)
                      tabRefs.current.set(tab.conversationId, element);
                    else tabRefs.current.delete(tab.conversationId);
                  }}
                  className="conversation-topbar__tab"
                  data-active={active ? "true" : undefined}
                  data-unread={unread ? "true" : undefined}
                  data-title-overflow={
                    overflowingTitleIds.has(tab.conversationId)
                      ? "true"
                      : undefined
                  }
                  data-dragging={
                    draggingConversationId === tab.conversationId
                      ? "true"
                      : undefined
                  }
                  title={tab.title}
                  onPointerDown={(event) =>
                    beginTabPointerDrag(event, tab.conversationId)
                  }
                  onPointerEnter={scheduleOverflowMeasurement}
                  onPointerLeave={scheduleOverflowMeasurement}
                  onPointerMove={moveTabPointerDrag}
                  onPointerUp={finishTabPointerDrag}
                  onPointerCancel={finishTabPointerDrag}
                  onLostPointerCapture={() => {
                    if (
                      tabPointerDragRef.current?.conversationId ===
                      tab.conversationId
                    ) {
                      tabPointerDragRef.current = null;
                      setDraggingConversationId(null);
                    }
                  }}
                  onMouseDown={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    event.stopPropagation();
                    void closeConversation(tab.conversationId);
                  }}
                >
                  <button
                    type="button"
                    className="conversation-topbar__tab-target"
                    role="tab"
                    aria-selected={active}
                    aria-label={t(
                      "shell.topbar.conversation.openConversation",
                      {
                        title: tab.title,
                      },
                    )}
                    onMouseDown={(event) => {
                      if (event.button === 0) {
                        navigateToConversation(tab.conversationId, tab.title);
                      }
                    }}
                    onClick={(event) => {
                      if (isKeyboardClick(event)) {
                        navigateToConversation(tab.conversationId, tab.title);
                      }
                    }}
                  >
                    <MessageSquare
                      className="conversation-topbar__tab-icon"
                      size={16}
                      strokeWidth={1.65}
                      aria-hidden="true"
                    />
                    <span
                      ref={(element) => {
                        if (element) {
                          titleRefs.current.set(tab.conversationId, element);
                        } else {
                          titleRefs.current.delete(tab.conversationId);
                        }
                      }}
                      className="conversation-topbar__tab-title"
                    >
                      {tab.title}
                    </span>
                  </button>
                  {unread ? (
                    <span
                      className="conversation-topbar__tab-unread"
                      role="img"
                      aria-label={t("shell.topbar.conversation.unread")}
                      title={t("shell.topbar.conversation.unread")}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="conversation-topbar__tab-close"
                    aria-label={t(
                      "shell.topbar.conversation.closeConversation",
                      {
                        title: tab.title,
                      },
                    )}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      if (event.button === 0) {
                        void closeConversation(tab.conversationId);
                      }
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isKeyboardClick(event)) {
                        void closeConversation(tab.conversationId);
                      }
                    }}
                  >
                    <X size={11} strokeWidth={1.8} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button
        type="button"
        className="shell-topbar-icon-btn conversation-topbar__plus"
        data-compact={!showNewChatLabel ? "true" : undefined}
        onClick={() => void createConversation()}
        aria-label={t("shell.topbar.conversation.newChat")}
        title={t("shell.topbar.conversation.newChat")}
      >
        <Plus
          className="conversation-topbar__control-icon"
          size={16}
          strokeWidth={1.85}
          aria-hidden="true"
        />
        {showNewChatLabel ? (
          <span className="conversation-topbar__new-label">
            {t("shell.topbar.conversation.newChat")}
          </span>
        ) : null}
      </button>
    </div>
  );
}
