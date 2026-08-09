import { useRouter, useRouterState } from "@tanstack/react-router";
import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type HTMLAttributes,
} from "react";
import type {
  ConversationSummary,
  ConversationSummaryCursor,
  LocalChatUpdatedPayload,
} from "@stella/contracts/local-chat";
import {
  compareConversationTitleCursors,
  conversationTabs,
  type ConversationTitleCursor,
  useConversationTabs,
} from "@/features/chat/services/conversation-tabs-store";
import {
  conversationTitleFromUpdate,
  createNewLocalConversationId,
  deleteLocalConversation,
  listLocalConversations,
  subscribeToLocalChatUpdates,
} from "@/features/chat/services/local-chat-store";
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
import { dispatchShowHome } from "@/shared/lib/stella-orb-chat";
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
  const { tabs } = useConversationTabs();
  const showNewChatLabel = shouldRenderNewChatLabel(tabs.length);
  const activeConversationId = useRouterState({
    select: (state) =>
      state.location.pathname === "/chat"
        ? ((state.location.search as { c?: string }).c ?? null)
        : null,
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [historyCursor, setHistoryCursor] =
    useState<ConversationSummaryCursor | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyDeleteArmedId, setHistoryDeleteArmedId] = useState<
    string | null
  >(null);
  const [historyDeletingId, setHistoryDeletingId] = useState<string | null>(
    null,
  );
  const [historyDeleteErrorId, setHistoryDeleteErrorId] = useState<
    string | null
  >(null);
  const historyRequestRef = useRef(0);
  const historyLoadingRef = useRef(false);
  const historyDeleteTimerRef = useRef<number | null>(null);
  const historyHoverCloseTimerRef = useRef<number | null>(null);
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

  const createConversation = useCallback(async () => {
    const conversationId = await createNewLocalConversationId();
    navigateToConversation(
      conversationId,
      t("shell.topbar.conversation.newChat"),
    );
  }, [navigateToConversation, t]);

  const loadHistory = useCallback(
    async (cursor: ConversationSummaryCursor | null, replace: boolean) => {
      if (historyLoadingRef.current) return;
      const requestId = historyRequestRef.current + 1;
      historyRequestRef.current = requestId;
      historyLoadingRef.current = true;
      setHistoryLoading(true);
      setHistoryError(false);
      try {
        const page = await listLocalConversations({
          limit: HISTORY_PAGE_SIZE,
          cursor,
        });
        if (historyRequestRef.current !== requestId) return;
        conversationTabs.mergeSummaries(page.conversations);
        setHistory((current) => {
          if (replace) return page.conversations;
          const byId = new Map(
            current.map((summary) => [summary.conversationId, summary]),
          );
          for (const summary of page.conversations) {
            byId.set(summary.conversationId, summary);
          }
          return [...byId.values()];
        });
        setHistoryCursor(page.nextCursor ?? null);
        setHistoryHasMore(page.hasMore);
      } catch {
        if (historyRequestRef.current === requestId) setHistoryError(true);
      } finally {
        if (historyRequestRef.current === requestId) {
          historyLoadingRef.current = false;
          setHistoryLoading(false);
        }
      }
    },
    [],
  );

  // The update subscription below is mounted once; it reads the active
  // conversation through this ref so it never resubscribes on navigation.
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  useEffect(() => {
    if (!activeConversationId) return;
    conversationTabs.openConversation(activeConversationId);
    conversationTabs.markRead(activeConversationId);
  }, [activeConversationId]);

  // Hydrate cached tab titles from one bounded history page. Inactive tabs
  // remain metadata only; this never subscribes them to message timelines.
  useEffect(() => {
    let disposed = false;
    void listLocalConversations({ limit: HISTORY_PAGE_SIZE })
      .then((page) => {
        if (!disposed) conversationTabs.mergeSummaries(page.conversations);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  // Persisted local-chat updates are the title boundary. Streaming token
  // chunks deliberately do not touch this lightweight store.
  useEffect(
    () =>
      subscribeToLocalChatUpdates((payload: LocalChatUpdatedPayload | null) => {
        const update = conversationTitleFromUpdate(payload);
        if (!update) return;
        const incomingCursor = {
          latestMessageAt: update.latestMessageAt,
          latestMessageId: update.latestMessageId,
        };
        conversationTabs.updateTitle(
          update.conversationId,
          update.title,
          incomingCursor,
        );
        if (
          shouldMarkConversationUnread(
            payload,
            update.conversationId,
            activeConversationIdRef.current,
          )
        ) {
          conversationTabs.markUnread(update.conversationId);
        }
        setHistory((current) => {
          const index = current.findIndex(
            (item) => item.conversationId === update.conversationId,
          );
          if (index < 0) return current;
          const existing = current[index]!;
          const existingCursor =
            typeof existing.latestMessageAt === "number" &&
            existing.latestMessageId
              ? {
                  latestMessageAt: existing.latestMessageAt,
                  latestMessageId: existing.latestMessageId,
                }
              : null;
          const sameMessage =
            existingCursor?.latestMessageId === incomingCursor.latestMessageId;
          if (
            existingCursor &&
            !sameMessage &&
            compareConversationTitleCursors(incomingCursor, existingCursor) <= 0
          ) {
            return current;
          }
          const next = {
            ...existing,
            title: update.title,
            ...incomingCursor,
            updatedAt: Math.max(existing.updatedAt, update.latestMessageAt),
          };
          if (sameMessage) {
            return current.map((item, itemIndex) =>
              itemIndex === index ? next : item,
            );
          }
          return [
            next,
            ...current.filter((_, itemIndex) => itemIndex !== index),
          ];
        });
      }),
    [],
  );

  useEffect(() => {
    if (historyOpen) void loadHistory(null, true);
  }, [historyOpen, loadHistory]);

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
      try {
        const deleted = await deleteLocalConversation(summary.conversationId);
        if (!deleted) return;
        setHistory((current) =>
          current.filter(
            (item) => item.conversationId !== summary.conversationId,
          ),
        );
        await closeConversation(summary.conversationId);
      } catch {
        setHistoryDeleteErrorId(summary.conversationId);
        historyDeleteTimerRef.current = window.setTimeout(() => {
          setHistoryDeleteErrorId(null);
          historyDeleteTimerRef.current = null;
        }, HISTORY_DELETE_CONFIRM_TIMEOUT_MS);
      } finally {
        setHistoryDeletingId(null);
      }
    },
    [clearHistoryDeleteTimer, closeConversation, historyDeleteArmedId],
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
              navigateToConversation(summary.conversationId, summary.title, {
                latestMessageAt: summary.latestMessageAt ?? summary.updatedAt,
                latestMessageId: summary.latestMessageId ?? "",
              });
              setHistoryOpen(false);
            }}
            onClick={(event) => {
              if (!isKeyboardClick(event)) return;
              disarmHistoryDelete();
              navigateToConversation(summary.conversationId, summary.title, {
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
      navigateToConversation,
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
    <div className="conversation-topbar" data-testid="conversation-topbar">
      <Popover
        open={historyOpen}
        onOpenChange={(open) => {
          clearHistoryHoverCloseTimer();
          setHistoryOpen(open);
          if (!open) disarmHistoryDelete();
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
                void loadHistory(historyCursor, false);
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
