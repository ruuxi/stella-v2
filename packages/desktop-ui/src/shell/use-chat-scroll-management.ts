import { useCallback, useEffect, useRef, useState } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { subscribeChatContentGrowth } from "@/shell/chat-scroll-follow";
import {
  AT_BOTTOM_TOLERANCE_PX,
  CHAT_VIEWPORT_BOTTOM_FADE_PX,
  POST_SEND_USER_MESSAGE_BREATHING_PX,
  consumeResponseSpacerHeight,
  resolveIdleTailTarget,
  resolvePostSendTarget,
  resolveResponseSpacerHeight,
  shouldPlaceLatestTurn,
} from "@/shell/chat-follow-target";
import {
  captureChatPrependAnchor,
  ChatHistoryPaginationGate,
  ChatPrependAnchorStabilizer,
  emitChatHistoryPaginationDebug,
  restoreChatPrependAnchor,
  type ChatPrependAnchor,
  type HistoryPaginationMetrics,
  type HistoryScrollDirection,
} from "@/shell/chat-history-pagination";

const SCROLL_BUTTON_THRESHOLD = 180;
const THUMB_MIN_HEIGHT = 24;
const THUMB_FADE_MS = 1200;
const MANUAL_SCROLL_SETTLE_MS = 140;

const THUMB_EPSILON_PX = 0.5;

const FOLLOW_SPRING_STIFFNESS = 0.00026;
const FOLLOW_SPRING_DAMPING = 0.0322;

const FOLLOW_STREAM_IDLE_MS = 200;

const FOLLOW_MAX_FRAME_MS = 48;

const FOLLOW_DEFAULT_FRAME_MS = 16;
const FOLLOW_HARD_SNAP_PX = 240;

const FOLLOW_GENTLE_LERP_FACTOR = 0.12;

const FOLLOW_MIN_STEP_PX = 0.5;

const TRAILING_REGION_MIN_PX = {
  full: 160,
  compact: 120,
} as const;

const FOLLOW_REARM_EXTRA_PX = 24;

const followRearmThresholdPx = (trailingRegionMinPx: number): number =>
  trailingRegionMinPx + FOLLOW_REARM_EXTRA_PX;

const isTextEditingTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  Boolean(
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ),
  );

type ChatScrollSurface = keyof typeof TRAILING_REGION_MIN_PX;

type ChatScrollManagementOptions = {
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => boolean | void | Promise<boolean>;
  hasNewerEvents?: boolean;
  isLoadingNewer?: boolean;
  onLoadNewer?: () => boolean | void | Promise<boolean>;
  onLoadLatest?: () => boolean | void | Promise<boolean>;
  paginationKey?: string | null;

  surface?: ChatScrollSurface;
};

type FollowTargetOptions = {

  allowBackward?: boolean;

  gentle?: boolean;
};

type FollowApi = {

  setTarget: (target: number, options?: FollowTargetOptions) => void;

  nudgeBy: (delta: number) => void;

  scrollLatestUserMessageIntoView: () => void;

  scrollQueuedMessagesIntoView: () => void;

  activateResponseSpacer: () => void;

  clearResponseSpacer: () => void;

  cancel: () => void;
};

export function useChatScrollManagement({
  hasOlderEvents = false,
  isLoadingOlder = false,
  onLoadOlder,
  hasNewerEvents = false,
  isLoadingNewer = false,
  onLoadNewer,
  onLoadLatest,
  paginationKey = null,
  surface = "full",
}: ChatScrollManagementOptions = {}) {
  const trailingRegionMinPx = TRAILING_REGION_MIN_PX[surface];
  const followRearmThreshold = followRearmThresholdPx(trailingRegionMinPx);
  const responseSpacerBottomInsetPx =
    surface === "full" ? CHAT_VIEWPORT_BOTTOM_FADE_PX : 0;
  const listRef = useRef<LegendListRef | null>(null);
  const attachedScrollNodeRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(false);
  const responseSpacerHeightRef = useRef<number>(trailingRegionMinPx);
  const responseSpacerTargetHeightRef = useRef<number>(trailingRegionMinPx);
  const responseSpacerExpandedRef = useRef(false);
  const paginationGateRef = useRef(new ChatHistoryPaginationGate());
  const newerPaginationGateRef = useRef(new ChatHistoryPaginationGate("end"));
  const paginationActionIdRef = useRef(0);
  const prependAnchorRef = useRef<{
    node: HTMLElement;
    anchor: ChatPrependAnchor;
    gate: ChatHistoryPaginationGate;
    cancelledByUser: boolean;
  } | null>(null);
  const prependRestoreRafRef = useRef<number | null>(null);
  const anchorStabilizerRef = useRef<ChatPrependAnchorStabilizer | null>(null);
  const jumpToLatestPendingRef = useRef(false);
  const historyOptionsRef = useRef({
    hasOlderEvents,
    isLoadingOlder,
    onLoadOlder,
    hasNewerEvents,
    isLoadingNewer,
    onLoadNewer,
    onLoadLatest,
  });
  historyOptionsRef.current = {
    hasOlderEvents,
    isLoadingOlder,
    onLoadOlder,
    hasNewerEvents,
    isLoadingNewer,
    onLoadNewer,
    onLoadLatest,
  };
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [paginationCompletionVersion, setPaginationCompletionVersion] =
    useState(0);

  useEffect(() => {
    paginationGateRef.current = new ChatHistoryPaginationGate();
    newerPaginationGateRef.current = new ChatHistoryPaginationGate("end");
    prependAnchorRef.current = null;
    jumpToLatestPendingRef.current = false;
    anchorStabilizerRef.current?.stop();
    anchorStabilizerRef.current = null;
    if (prependRestoreRafRef.current !== null) {
      cancelAnimationFrame(prependRestoreRafRef.current);
      prependRestoreRafRef.current = null;
    }
  }, [paginationKey]);

  const [isNearBottom, setIsNearBottom] = useState(true);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const thumbElRef = useRef<HTMLDivElement | null>(null);
  const thumbVisibleRef = useRef(false);
  const thumbTopRef = useRef(0);
  const thumbHeightRef = useRef(0);
  const setThumbRef = useCallback((el: HTMLDivElement | null) => {
    thumbElRef.current = el;
  }, []);
  const thumbFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollStateRafRef = useRef<number | null>(null);
  const isAtBottomRef = useRef(true);
  const isNearBottomRef = useRef(true);
  const showScrollButtonRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const manualScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const noteManualScroll = useCallback(() => {
    if (!isUserScrollingRef.current) {
      isUserScrollingRef.current = true;
      setIsUserScrolling(true);
    }
    if (manualScrollTimerRef.current) {
      clearTimeout(manualScrollTimerRef.current);
    }
    manualScrollTimerRef.current = setTimeout(() => {
      manualScrollTimerRef.current = null;
      if (!isUserScrollingRef.current) return;
      isUserScrollingRef.current = false;
      setIsUserScrolling(false);
    }, MANUAL_SCROLL_SETTLE_MS);
  }, []);

  const followRef = useRef(true);
  const isFollowingLatestRef = useRef(true);

  const followRearmBlockedRef = useRef(false);

  const setFollow = useCallback((following: boolean) => {
    if (following) followRearmBlockedRef.current = false;
    if (
      followRef.current === following &&
      isFollowingLatestRef.current === following
    ) {
      return;
    }
    followRef.current = following;
    isFollowingLatestRef.current = following;
    setIsFollowingLatest(following);
  }, []);

  const followApi = useRef<FollowApi | null>(null);

  const hideThumb = useCallback(() => {
    if (!thumbVisibleRef.current) return;
    thumbVisibleRef.current = false;
    thumbElRef.current?.classList.remove("chat-scrollbar__thumb--visible");
  }, []);

  const updateThumb = useCallback(
    (scroll: number, scrollLength: number, contentLength: number) => {
      const el = thumbElRef.current;
      if (!el) return;
      if (contentLength <= scrollLength || scrollLength <= 0) {
        hideThumb();
        return;
      }

      const ratio = scrollLength / contentLength;
      const thumbHeight = Math.max(THUMB_MIN_HEIGHT, ratio * scrollLength);
      const maxScroll = Math.max(1, contentLength - scrollLength);
      const progress = Math.max(0, Math.min(1, scroll / maxScroll));
      const maxThumbTop = Math.max(0, scrollLength - thumbHeight);
      const thumbTop = progress * maxThumbTop;

      if (
        !thumbVisibleRef.current ||
        Math.abs(thumbTopRef.current - thumbTop) >= THUMB_EPSILON_PX ||
        Math.abs(thumbHeightRef.current - thumbHeight) >= THUMB_EPSILON_PX
      ) {
        thumbTopRef.current = thumbTop;
        thumbHeightRef.current = thumbHeight;
        el.style.top = `${thumbTop}px`;
        el.style.height = `${thumbHeight}px`;
      }
      if (!thumbVisibleRef.current) {
        thumbVisibleRef.current = true;
        el.classList.add("chat-scrollbar__thumb--visible");
      }

      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current);
      thumbFadeRef.current = setTimeout(hideThumb, THUMB_FADE_MS);
    },
    [hideThumb],
  );

  const scheduleScrollStateUpdate = useCallback(() => {
    if (scrollStateRafRef.current !== null) return;
    scrollStateRafRef.current = requestAnimationFrame(() => {
      scrollStateRafRef.current = null;
      const list = listRef.current;
      if (!list) return;
      const state = list.getState();
      const { scroll, scrollLength, contentLength, isAtEnd } = state;
      const distFromEnd = Math.max(0, contentLength - scrollLength - scroll);
      const shouldShowScrollButton = distFromEnd > SCROLL_BUTTON_THRESHOLD;

      const spacerOveragePx = Math.max(
        0,
        responseSpacerHeightRef.current - trailingRegionMinPx,
      );
      const nearBottom =
        isAtEnd || distFromEnd - spacerOveragePx <= AT_BOTTOM_TOLERANCE_PX;

      if (isAtBottomRef.current !== isAtEnd) {
        isAtBottomRef.current = isAtEnd;
        setIsAtBottom(isAtEnd);
      }
      if (isNearBottomRef.current !== nearBottom) {
        isNearBottomRef.current = nearBottom;
        setIsNearBottom(nearBottom);
      }
      if (showScrollButtonRef.current !== shouldShowScrollButton) {
        showScrollButtonRef.current = shouldShowScrollButton;
        setShowScrollButton(shouldShowScrollButton);
      }
      updateThumb(scroll, scrollLength, contentLength);

      if (
        !followRearmBlockedRef.current &&
        (isAtEnd || distFromEnd <= followRearmThreshold)
      ) {
        setFollow(true);
      }
    });
  }, [followRearmThreshold, setFollow, trailingRegionMinPx, updateThumb]);

  const scrollToBottom = useCallback(
    (behavior: "instant" | "smooth" = "smooth") => {
      responseSpacerExpandedRef.current = false;
      setFollow(true);

      followApi.current?.cancel();
      followApi.current?.clearResponseSpacer();
      const history = historyOptionsRef.current;
      if (history.hasNewerEvents) {
        if (!history.onLoadLatest) return;
        jumpToLatestPendingRef.current = true;
        try {
          const accepted = history.onLoadLatest();
          if (accepted instanceof Promise) {
            void accepted.then(
              (succeeded) => {
                if (!succeeded) jumpToLatestPendingRef.current = false;
              },
              () => {
                jumpToLatestPendingRef.current = false;
              },
            );
          } else if (
            accepted === false &&
            !history.isLoadingOlder &&
            !history.isLoadingNewer &&
            paginationGateRef.current.snapshot().requestPhase === "idle" &&
            newerPaginationGateRef.current.snapshot().requestPhase === "idle"
          ) {
            jumpToLatestPendingRef.current = false;
          }
        } catch {
          jumpToLatestPendingRef.current = false;
        }

        return;
      }
      void listRef.current?.scrollToEnd({ animated: behavior !== "instant" });
    },
    [setFollow],
  );

  const getIsFollowing = useCallback(() => followRef.current, []);

  const getShouldPlaceLatestTurn = useCallback(() => {
    const node =
      attachedScrollNodeRef.current ?? listRef.current?.getScrollableNode();
    if (!node) return followRef.current;
    const distanceFromBottomPx = Math.max(
      0,
      node.scrollHeight - node.clientHeight - node.scrollTop,
    );
    return shouldPlaceLatestTurn({
      distanceFromBottomPx,
      responseSpacerHeightPx: Math.max(
        0,
        responseSpacerHeightRef.current - trailingRegionMinPx,
      ),
      isFollowingLatest: followRef.current,
    });
  }, [trailingRegionMinPx]);

  const getIsEffectivelyAtBottom = useCallback(() => {
    const node =
      attachedScrollNodeRef.current ?? listRef.current?.getScrollableNode();
    if (!node) return isNearBottomRef.current;
    const distanceFromBottomPx = Math.max(
      0,
      node.scrollHeight - node.clientHeight - node.scrollTop,
    );
    const spacerOveragePx = Math.max(
      0,
      responseSpacerHeightRef.current - trailingRegionMinPx,
    );
    return distanceFromBottomPx - spacerOveragePx <= AT_BOTTOM_TOLERANCE_PX;
  }, [trailingRegionMinPx]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current);
      if (manualScrollTimerRef.current) {
        clearTimeout(manualScrollTimerRef.current);
        manualScrollTimerRef.current = null;
      }
      if (scrollStateRafRef.current !== null) {
        cancelAnimationFrame(scrollStateRafRef.current);
        scrollStateRafRef.current = null;
      }
      if (prependRestoreRafRef.current !== null) {
        cancelAnimationFrame(prependRestoreRafRef.current);
        prependRestoreRafRef.current = null;
      }
      anchorStabilizerRef.current?.stop();
      anchorStabilizerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const olderTransition = paginationGateRef.current.syncGuards({
      hasMore: hasOlderEvents,
      isLoading: isLoadingOlder,
    });
    const newerTransition = newerPaginationGateRef.current.syncGuards({
      hasMore: hasNewerEvents,
      isLoading: isLoadingNewer,
    });
    if (
      jumpToLatestPendingRef.current &&
      hasNewerEvents &&
      !isLoadingOlder &&
      !isLoadingNewer
    ) {
      const loadLatest = historyOptionsRef.current.onLoadLatest;
      if (!loadLatest) {
        jumpToLatestPendingRef.current = false;
      } else {
        try {
          const accepted = loadLatest();
          if (accepted instanceof Promise) {
            void accepted.then(
              (succeeded) => {
                if (!succeeded) jumpToLatestPendingRef.current = false;
              },
              () => {
                jumpToLatestPendingRef.current = false;
              },
            );
          } else if (accepted === false) {
            jumpToLatestPendingRef.current = false;
          }
        } catch {
          jumpToLatestPendingRef.current = false;
        }
      }
    }
    if (jumpToLatestPendingRef.current && !hasNewerEvents && !isLoadingNewer) {
      jumpToLatestPendingRef.current = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          void listRef.current?.scrollToEnd({ animated: false });
        });
      });
    }
    emitChatHistoryPaginationDebug({
      type: "guards",
      surface,
      detail: {
        hasMore: hasOlderEvents,
        isLoading: isLoadingOlder,
        hasNewer: hasNewerEvents,
        isLoadingNewer,
        olderTransition,
        newerTransition,
        olderGate: paginationGateRef.current.snapshot(),
        newerGate: newerPaginationGateRef.current.snapshot(),
      },
    });

    if (!olderTransition.requestSettled && !newerTransition.requestSettled)
      return;
    const pending = prependAnchorRef.current;
    if (!pending) return;
    const pendingRequestSettled =
      (pending.gate === paginationGateRef.current &&
        olderTransition.requestSettled) ||
      (pending.gate === newerPaginationGateRef.current &&
        newerTransition.requestSettled);
    if (!pendingRequestSettled) return;
    if (
      pending.cancelledByUser ||
      pending.node !== attachedScrollNodeRef.current
    ) {
      emitChatHistoryPaginationDebug({
        type: "anchor-skip",
        surface,
        detail: {
          reason: pending.cancelledByUser
            ? "user-scrolled"
            : "scroll-node-replaced",
          rowId: pending.anchor.rowId,
        },
      });
      prependAnchorRef.current = null;
      anchorStabilizerRef.current?.stop();
      return;
    }

    let attempts = 0;
    const restore = () => {
      prependRestoreRafRef.current = null;
      const current = prependAnchorRef.current;
      if (!current || current.cancelledByUser) return;
      if (current.node !== attachedScrollNodeRef.current) {
        prependAnchorRef.current = null;
        return;
      }
      attempts += 1;
      const result = restoreChatPrependAnchor(current.node, current.anchor);
      if (!result.found && attempts < 8) {
        prependRestoreRafRef.current = requestAnimationFrame(restore);
        return;
      }
      emitChatHistoryPaginationDebug({
        type: "anchor-restored",
        surface,
        detail: {
          rowId: current.anchor.rowId,
          before: current.anchor,
          after: result,
          thresholdVisible:
            result.scrollTopAfter <= current.anchor.viewportHeight * 2,
          attempts,
        },
      });
      anchorStabilizerRef.current?.stop();
      anchorStabilizerRef.current = new ChatPrependAnchorStabilizer(
        current.node,
        current.anchor,
        (lateResult) => {
          emitChatHistoryPaginationDebug({
            type: "anchor-late-restored",
            surface,
            detail: { rowId: current.anchor.rowId, after: lateResult },
          });
        },
      );
      anchorStabilizerRef.current.start();
      prependAnchorRef.current = null;
    };

    prependRestoreRafRef.current = requestAnimationFrame(() => {
      prependRestoreRafRef.current = requestAnimationFrame(restore);
    });
  }, [
    hasNewerEvents,
    hasOlderEvents,
    isLoadingNewer,
    isLoadingOlder,
    paginationCompletionVersion,
    surface,
  ]);

  const releaseFollow = useCallback(() => {
    responseSpacerExpandedRef.current = false;
    followRearmBlockedRef.current = true;
    setFollow(false);
    followApi.current?.cancel();
    followApi.current?.clearResponseSpacer();
  }, [setFollow]);

  const nudgeBy = useCallback(
    (delta: number) => {
      setFollow(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          followApi.current?.nudgeBy(delta);
        });
      });
    },
    [setFollow],
  );

  const nudgeAfterSend = useCallback(() => {
    responseSpacerExpandedRef.current = true;
    setFollow(true);
    followApi.current?.activateResponseSpacer();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        followApi.current?.scrollLatestUserMessageIntoView();
      });
    });
  }, [setFollow]);

  const nudgeQueuedMessagesIntoView = useCallback(() => {
    responseSpacerExpandedRef.current = true;
    setFollow(true);
    followApi.current?.activateResponseSpacer();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        followApi.current?.scrollQueuedMessagesIntoView();
      });
    });
  }, [setFollow]);

  useEffect(() => {
    let attached: HTMLElement | null = null;
    let cleanup = () => {};
    let frame = 0;

    const tryAttach = (): boolean => {
      const node = listRef.current?.getScrollableNode() as
        | HTMLElement
        | undefined
        | null;
      if (!node || node === attached) return Boolean(attached);
      const previousNode = attached;
      cleanup();
      attached = node;
      attachedScrollNodeRef.current = node;

      const writeResponseSpacerHeight = (height: number) => {
        if (!attached) return;
        const clamped = Math.max(trailingRegionMinPx, height);
        responseSpacerHeightRef.current = clamped;
        attached.style.setProperty(
          "--chat-response-spacer-height",
          `${clamped}px`,
        );
      };
      const syncResponseSpacerTargetHeight = () => {
        if (!attached) return;
        const target = resolveResponseSpacerHeight({
          viewportHeight: attached.clientHeight,
          bottomInsetPx: responseSpacerBottomInsetPx,
          minimumHeightPx: trailingRegionMinPx,
        });
        responseSpacerTargetHeightRef.current = target;

        if (responseSpacerExpandedRef.current) {
          if (responseSpacerHeightRef.current < target) {
            writeResponseSpacerHeight(target);
          }
          return;
        }

        writeResponseSpacerHeight(
          Math.min(responseSpacerHeightRef.current, target),
        );
      };
      const activateResponseSpacer = () => {
        if (!attached) return;
        responseSpacerExpandedRef.current = true;

        const target = resolveResponseSpacerHeight({
          viewportHeight: attached.clientHeight,
          bottomInsetPx: responseSpacerBottomInsetPx,
          minimumHeightPx: trailingRegionMinPx,
        });
        responseSpacerTargetHeightRef.current = target;
        writeResponseSpacerHeight(target);
      };
      const clearResponseSpacer = () => {
        responseSpacerExpandedRef.current = false;
        writeResponseSpacerHeight(trailingRegionMinPx);
      };
      const consumeResponseSpacer = (distanceDeltaPx: number) => {
        const next = consumeResponseSpacerHeight({
          currentHeightPx: responseSpacerHeightRef.current,
          minimumHeightPx: trailingRegionMinPx,
          distanceDeltaPx,
        });
        writeResponseSpacerHeight(next);
        if (next <= trailingRegionMinPx) {
          responseSpacerExpandedRef.current = false;
        }
      };
      syncResponseSpacerTargetHeight();
      const responseSpacerResizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(syncResponseSpacerTargetHeight);
      responseSpacerResizeObserver?.observe(node);

      emitChatHistoryPaginationDebug({
        type: "scroll-node-attached",
        surface,
        detail: {
          replaced: Boolean(previousNode && previousNode !== node),
        },
      });

      const WHEEL_ACTION_IDLE_MS = 160;
      const INTENT_ACTIVE_MS = 240;
      let lastObservedScrollTop = node.scrollTop;
      let wheelActionId: number | null = null;
      let lastWheelAt = -Infinity;
      let lastWheelDirection: HistoryScrollDirection = "none";
      let pointerActionId: number | null = null;
      let keyActionId: number | null = null;
      let touchActionId: number | null = null;
      let touchStartY: number | null = null;
      let activeIntent: {
        id: number;
        direction: HistoryScrollDirection;
        expiresAt: number;
      } | null = null;

      const nextActionId = () => ++paginationActionIdRef.current;
      const markActiveIntent = (
        id: number,
        direction: HistoryScrollDirection,
      ) => {
        activeIntent = {
          id,
          direction,
          expiresAt: performance.now() + INTENT_ACTIVE_MS,
        };
      };
      const cancelPendingAnchorForUserScroll = () => {
        anchorStabilizerRef.current?.stop();
        anchorStabilizerRef.current = null;
        jumpToLatestPendingRef.current = false;
        if (prependAnchorRef.current) {
          prependAnchorRef.current.cancelledByUser = true;
        }
      };
      const readPaginationMetrics = (): HistoryPaginationMetrics | null => {
        const list = listRef.current;
        if (!list) return null;
        const state = list.getState();
        return {
          scrollTop: state.scroll,
          viewportHeight: state.scrollLength,
          contentHeight: state.contentLength,
        };
      };
      const attemptHistoryLoad = (
        actionId: number | null,
        direction: HistoryScrollDirection,
        source: string,
        edge: "older" | "newer" = "older",
      ) => {
        const metrics = readPaginationMetrics();
        if (!metrics) return;
        const options = historyOptionsRef.current;
        const gate =
          edge === "older"
            ? paginationGateRef.current
            : newerPaginationGateRef.current;
        const hasMore =
          edge === "older" ? options.hasOlderEvents : options.hasNewerEvents;
        const isLoading =
          edge === "older" ? options.isLoadingOlder : options.isLoadingNewer;
        const load =
          edge === "older" ? options.onLoadOlder : options.onLoadNewer;
        const decision = gate.consider(actionId, direction, metrics, {
          hasMore: hasMore && Boolean(load),
          isLoading:
            isLoading || options.isLoadingOlder || options.isLoadingNewer,
        });
        emitChatHistoryPaginationDebug({
          type: "threshold-check",
          surface,
          detail: {
            source,
            actionId,
            direction,
            edge,
            ...metrics,
            ...decision,
            gate: gate.snapshot(),
          },
        });
        if (!decision.request || !load) return;

        anchorStabilizerRef.current?.stop();
        anchorStabilizerRef.current = null;
        const anchor = captureChatPrependAnchor(node);
        if (anchor) {
          prependAnchorRef.current = {
            node,
            anchor,
            gate,
            cancelledByUser: false,
          };
        }
        emitChatHistoryPaginationDebug({
          type: "request",
          surface,
          detail: { source, actionId, edge, metrics, anchor },
        });
        try {
          const accepted = load();
          if (accepted === false) {
            gate.rejectRequest();
            if (prependAnchorRef.current?.gate === gate) {
              prependAnchorRef.current = null;
            }
          } else if (accepted instanceof Promise) {
            void accepted.then(
              (succeeded) => {
                if (!mountedRef.current) return;
                const isCurrentGate =
                  gate === paginationGateRef.current ||
                  gate === newerPaginationGateRef.current;
                if (!isCurrentGate) return;
                const settled = gate.settleRequest();
                if (
                  (!succeeded || !node.isConnected) &&
                  prependAnchorRef.current?.gate === gate
                ) {
                  prependAnchorRef.current = null;
                }
                if (settled) {
                  setPaginationCompletionVersion((version) => version + 1);
                }
              },
              () => {
                if (!mountedRef.current) return;
                const isCurrentGate =
                  gate === paginationGateRef.current ||
                  gate === newerPaginationGateRef.current;
                if (!isCurrentGate) return;
                const settled = gate.settleRequest();
                if (prependAnchorRef.current?.gate === gate) {
                  prependAnchorRef.current = null;
                }
                if (settled) {
                  setPaginationCompletionVersion((version) => version + 1);
                }
              },
            );
          }
        } catch (error) {
          gate.rejectRequest();
          if (prependAnchorRef.current?.gate === gate) {
            prependAnchorRef.current = null;
          }
          emitChatHistoryPaginationDebug({
            type: "request-error",
            surface,
            detail: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      };

      let followTarget: number | null = null;
      let followRaf = 0;
      let followGentle = false;
      let followVel = 0;
      let lastFrameTime = 0;
      let lastTargetTime = 0;
      const stopLoop = () => {
        if (followRaf) cancelAnimationFrame(followRaf);
        followRaf = 0;
        followTarget = null;
        followGentle = false;
        followVel = 0;
        lastFrameTime = 0;
        lastTargetTime = 0;
      };

      const stepFollow = () => {
        followRaf = 0;
        if (!attached || followTarget === null) return;
        if (!followRef.current) {
          followTarget = null;
          followVel = 0;
          lastFrameTime = 0;
          return;
        }
        const maxScroll = Math.max(
          0,
          attached.scrollHeight - attached.clientHeight,
        );
        const target = Math.max(0, Math.min(maxScroll, followTarget));
        const current = attached.scrollTop;
        const diff = target - current;
        const absDiff = Math.abs(diff);

        if (absDiff < FOLLOW_MIN_STEP_PX) {
          attached.scrollTop = target;
          followVel = 0;
          lastFrameTime = 0;
          if (
            followGentle ||
            performance.now() - lastTargetTime > FOLLOW_STREAM_IDLE_MS
          ) {
            followTarget = null;
            return;
          }
          followRaf = requestAnimationFrame(stepFollow);
          return;
        }

        if (followGentle) {
          const lerpStep = diff * FOLLOW_GENTLE_LERP_FACTOR;
          const stepPx =
            Math.abs(lerpStep) >= FOLLOW_MIN_STEP_PX
              ? lerpStep
              : Math.sign(diff) * FOLLOW_MIN_STEP_PX;
          attached.scrollTop = current + stepPx;
          followRaf = requestAnimationFrame(stepFollow);
          return;
        }

        if (absDiff > FOLLOW_HARD_SNAP_PX) {
          attached.scrollTop = target;
          followVel = 0;
          lastFrameTime = 0;
          if (performance.now() - lastTargetTime > FOLLOW_STREAM_IDLE_MS) {
            followTarget = null;
            return;
          }
          followRaf = requestAnimationFrame(stepFollow);
          return;
        }

        const now = performance.now();
        const dt = lastFrameTime
          ? Math.min(FOLLOW_MAX_FRAME_MS, Math.max(1, now - lastFrameTime))
          : FOLLOW_DEFAULT_FRAME_MS;
        lastFrameTime = now;
        const accel =
          FOLLOW_SPRING_STIFFNESS * diff - FOLLOW_SPRING_DAMPING * followVel;

        followVel = Math.max(0, followVel + accel * dt);
        let step = followVel * dt;
        if (step < FOLLOW_MIN_STEP_PX) step = FOLLOW_MIN_STEP_PX;
        if (step >= diff) {

          attached.scrollTop = target;
          followVel = diff / dt;
        } else {
          attached.scrollTop = current + step;
        }
        followRaf = requestAnimationFrame(stepFollow);
      };

      const setTarget = (
        newTarget: number,
        options: FollowTargetOptions = {},
      ) => {
        if (!attached) return;
        if (!followRef.current) return;
        const maxScroll = Math.max(
          0,
          attached.scrollHeight - attached.clientHeight,
        );
        const clamped = Math.max(0, Math.min(maxScroll, newTarget));

        if (!options.allowBackward && clamped <= attached.scrollTop + 0.5) {
          return;
        }
        const gentle = Boolean(options.gentle);

        if (gentle !== followGentle) followVel = 0;
        followTarget = clamped;
        followGentle = gentle;

        if (!gentle) lastTargetTime = performance.now();
        if (!followRaf) followRaf = requestAnimationFrame(stepFollow);
      };

      const nudgeBy = (delta: number, options: FollowTargetOptions = {}) => {
        if (!attached) return;
        if (!followRef.current) return;
        const base = followTarget !== null ? followTarget : attached.scrollTop;
        setTarget(base + delta, options);
      };

      const scrollLatestUserMessageIntoView = () => {
        if (!attached) return;
        if (!followRef.current) return;
        const userRow = attached.querySelector<HTMLElement>(
          ".event-row--user--just-sent",
        );
        if (!userRow) {

          const maxScroll = Math.max(
            0,
            attached.scrollHeight - attached.clientHeight,
          );
          setTarget(maxScroll, { gentle: true });
          return;
        }

        let rowTop = 0;
        let node: HTMLElement | null = userRow;
        while (node && node !== attached) {
          rowTop += node.offsetTop;
          node = node.offsetParent as HTMLElement | null;
        }
        const rowBottom = rowTop + userRow.offsetHeight;
        const target = resolvePostSendTarget({
          rowTop,
          rowBottom,
          viewportHeight: attached.clientHeight,
          responseSpacerHeightPx: responseSpacerHeightRef.current,
        });
        setTarget(target, { allowBackward: true, gentle: true });
      };

      const scrollQueuedMessagesIntoView = () => {
        if (!attached) return;
        if (!followRef.current) return;
        const queuedMessages = attached.querySelectorAll<HTMLElement>(
          ".composer-queued-message:not(.composer-queued-message--leaving)",
        );
        const queuedMessage =
          queuedMessages.length > 0
            ? queuedMessages[queuedMessages.length - 1]!
            : null;
        if (!queuedMessage) return;
        const messageRect = queuedMessage.getBoundingClientRect();
        const containerRect = attached.getBoundingClientRect();
        const messageBottom =
          messageRect.bottom - containerRect.top + attached.scrollTop;
        const target =
          messageBottom -
          attached.clientHeight +
          POST_SEND_USER_MESSAGE_BREATHING_PX;
        setTarget(target);
      };

      followApi.current = {
        setTarget,
        nudgeBy,
        scrollLatestUserMessageIntoView,
        scrollQueuedMessagesIntoView,
        activateResponseSpacer,
        clearResponseSpacer,
        cancel: stopLoop,
      };

      const followIdleContentGrowth = () => {
        if (!attached || !followRef.current) return;
        const trailing = attached.querySelector<HTMLElement>(
          ".event-list-trailing-region",
        );
        const containerRect = attached.getBoundingClientRect();
        const contentBottom = trailing
          ? trailing.getBoundingClientRect().top -
            containerRect.top +
            attached.scrollTop
          : attached.scrollHeight;
        const target = resolveIdleTailTarget({
          contentBottom,
          clientHeight: attached.clientHeight,
        });
        const distFromTarget = target - attached.scrollTop;
        if (distFromTarget <= 0) return;

        if (
          !isAtBottomRef.current &&
          distFromTarget > attached.clientHeight / 2
        ) {
          return;
        }
        setTarget(target, { gentle: true });
      };
      let idleGrowthRaf = 0;
      const scheduleFollowIdleContentGrowth = () => {
        if (idleGrowthRaf) return;
        idleGrowthRaf = requestAnimationFrame(() => {
          idleGrowthRaf = 0;
          followIdleContentGrowth();
        });
      };

      const releaseLocalFollow = () => {
        followRearmBlockedRef.current = true;
        setFollow(false);
        stopLoop();
      };
      const handleWheel = (event: WheelEvent) => {
        noteManualScroll();
        const now = performance.now();
        const direction: HistoryScrollDirection =
          event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : "none";
        if (
          wheelActionId === null ||
          now - lastWheelAt > WHEEL_ACTION_IDLE_MS ||
          direction !== lastWheelDirection
        ) {
          wheelActionId = nextActionId();
        }
        lastWheelAt = now;
        lastWheelDirection = direction;
        markActiveIntent(wheelActionId, direction);
        cancelPendingAnchorForUserScroll();
        if (direction === "up") {
          releaseLocalFollow();
          attemptHistoryLoad(wheelActionId, direction, "wheel");
        } else {
          if (direction === "down") {
            followRearmBlockedRef.current = false;
            attemptHistoryLoad(wheelActionId, direction, "wheel", "newer");
          }
          stopLoop();
        }
      };
      const handleTouchStart = (event: TouchEvent) => {
        noteManualScroll();

        setFollow(false);
        stopLoop();
        cancelPendingAnchorForUserScroll();
        touchActionId = nextActionId();
        touchStartY = event.touches[0]?.clientY ?? null;
      };
      const handleTouchMove = (event: TouchEvent) => {
        noteManualScroll();
        if (touchActionId === null || touchStartY === null) return;
        const y = event.touches[0]?.clientY;
        if (y === undefined) return;
        const direction: HistoryScrollDirection =
          y > touchStartY ? "up" : "down";
        markActiveIntent(touchActionId, direction);
        if (direction === "up") {
          attemptHistoryLoad(touchActionId, direction, "touch");
        } else {
          followRearmBlockedRef.current = false;
          attemptHistoryLoad(touchActionId, direction, "touch", "newer");
        }
      };
      const handleKeyDown = (event: KeyboardEvent) => {

        if (isTextEditingTarget(event.target)) return;
        if (
          event.key === "ArrowUp" ||
          event.key === "ArrowDown" ||
          event.key === "PageUp" ||
          event.key === "PageDown" ||
          event.key === "Home" ||
          event.key === "End" ||
          event.key === " "
        ) {
          noteManualScroll();
        }
        if (
          event.key === "ArrowUp" ||
          event.key === "PageUp" ||
          event.key === "Home" ||
          (event.key === " " && event.shiftKey)
        ) {
          releaseLocalFollow();
          cancelPendingAnchorForUserScroll();
          if (!event.repeat || keyActionId === null)
            keyActionId = nextActionId();
          markActiveIntent(keyActionId, "up");
          attemptHistoryLoad(keyActionId, "up", `key:${event.key}`);
        } else {
          if (
            event.key === "ArrowDown" ||
            event.key === "PageDown" ||
            event.key === "End" ||
            (event.key === " " && !event.shiftKey)
          ) {
            followRearmBlockedRef.current = false;
            if (!event.repeat || keyActionId === null)
              keyActionId = nextActionId();
            markActiveIntent(keyActionId, "down");
            attemptHistoryLoad(
              keyActionId,
              "down",
              `key:${event.key}`,
              "newer",
            );
          }
          stopLoop();
        }
      };
      const handleKeyUp = () => {
        keyActionId = null;
      };
      const handlePointerDown = () => {
        pointerActionId = nextActionId();
        cancelPendingAnchorForUserScroll();
      };
      const handlePointerUp = () => {
        pointerActionId = null;
      };
      const handleDocumentPointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(".chat-scrollbar__thumb")
        ) {
          handlePointerDown();
        }
      };
      const handlePaginationScroll = () => {
        const metrics = readPaginationMetrics();
        if (!metrics) return;
        const delta = metrics.scrollTop - lastObservedScrollTop;
        const direction: HistoryScrollDirection =
          delta < -0.5 ? "up" : delta > 0.5 ? "down" : "none";
        lastObservedScrollTop = metrics.scrollTop;

        const now = performance.now();
        let intent =
          activeIntent && activeIntent.expiresAt >= now ? activeIntent : null;
        if (direction !== "none" && pointerActionId !== null) {
          markActiveIntent(pointerActionId, direction);
          intent = activeIntent;
        }
        if (direction === "up" && intent?.direction === "up") {
          releaseLocalFollow();
          consumeResponseSpacer(-delta);
          attemptHistoryLoad(intent.id, direction, "native-scroll");
        } else if (direction === "down" && intent?.direction === "down") {
          followRearmBlockedRef.current = false;
          attemptHistoryLoad(intent.id, direction, "native-scroll", "newer");
        }
      };
      node.addEventListener("wheel", handleWheel, { passive: true });
      node.addEventListener("touchstart", handleTouchStart, { passive: true });
      node.addEventListener("touchmove", handleTouchMove, { passive: true });
      node.addEventListener("keydown", handleKeyDown);
      node.addEventListener("keyup", handleKeyUp);
      node.addEventListener("pointerdown", handlePointerDown);
      window.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointerdown", handleDocumentPointerDown, true);
      node.addEventListener("scroll", scheduleScrollStateUpdate, {
        passive: true,
      });
      node.addEventListener("scroll", handlePaginationScroll, {
        passive: true,
      });

      const unsubscribeGrowth = subscribeChatContentGrowth(() => {
        if (!followRef.current) return;
        scheduleFollowIdleContentGrowth();
      });

      cleanup = () => {
        if (!attached) return;
        responseSpacerResizeObserver?.disconnect();
        attached.style.removeProperty("--chat-response-spacer-height");
        unsubscribeGrowth();
        if (idleGrowthRaf) {
          cancelAnimationFrame(idleGrowthRaf);
          idleGrowthRaf = 0;
        }
        attached.removeEventListener("wheel", handleWheel);
        attached.removeEventListener("touchstart", handleTouchStart);
        attached.removeEventListener("touchmove", handleTouchMove);
        attached.removeEventListener("keydown", handleKeyDown);
        attached.removeEventListener("keyup", handleKeyUp);
        attached.removeEventListener("pointerdown", handlePointerDown);
        window.removeEventListener("pointerup", handlePointerUp);
        document.removeEventListener(
          "pointerdown",
          handleDocumentPointerDown,
          true,
        );
        attached.removeEventListener("scroll", scheduleScrollStateUpdate);
        attached.removeEventListener("scroll", handlePaginationScroll);
        stopLoop();
        followApi.current = null;
        if (attachedScrollNodeRef.current === attached) {
          attachedScrollNodeRef.current = null;
        }
        attached = null;
      };
      return true;
    };

    const ATTACH_CHECK_INTERVAL_MS = 120;
    let lastAttachCheck = 0;
    const watch = (now: number) => {
      if (!attached || now - lastAttachCheck >= ATTACH_CHECK_INTERVAL_MS) {
        lastAttachCheck = now;
        tryAttach();
      }
      frame = requestAnimationFrame(watch);
    };
    frame = requestAnimationFrame(watch);

    return () => {
      cancelAnimationFrame(frame);
      cleanup();
    };
  }, [
    noteManualScroll,
    responseSpacerBottomInsetPx,
    scheduleScrollStateUpdate,
    setFollow,
    surface,
    trailingRegionMinPx,
  ]);

  return {
    listRef,
    isAtBottom,
    isNearBottom,
    isFollowingLatest,
    isUserScrolling,
    noteManualScroll,
    showScrollButton: showScrollButton || hasNewerEvents,
    scrollToBottom,
    releaseFollow,
    nudgeAfterSend,
    nudgeQueuedMessagesIntoView,
    nudgeBy,
    getIsFollowing,
    getShouldPlaceLatestTurn,
    getIsEffectivelyAtBottom,
    thumbRef: setThumbRef,
  };
}
