/**
 * Scroll management for chat surfaces backed by Legend List v3 (web entry).
 *
 * The list owns scrolling and viewport measurement; this hook layers
 * surface-level UI concerns on top:
 *   - scroll-to-bottom button visibility from distance off the end,
 *   - custom scrollbar thumb position/height, written **imperatively** to
 *     the thumb DOM node (via `thumbRef`) rather than through React state.
 *     Middle-click autoscroll (and the scrollbar drag) are driven on the
 *     main thread, not the compositor — re-rendering the whole chat tree
 *     once per scroll frame just to reposition the thumb starves that
 *     main-thread pan and makes it stutter. Writing `style.top`/`height`
 *     straight to the node keeps every steady-state scroll frame
 *     setState-free, so the pan stays smooth.
 *   - `scrollToBottom` via the list ref,
 *   - intent-gated older-history pagination from the passive native listener,
 *   - **auto-follow** during streaming, driven by a continuous rAF lerp
 *     loop that smoothly chases a moving target (the bottom of the
 *     growing streaming row). Legend's built-in `maintainScrollAtEnd`
 *     fights user wheel input on the same frame as content growth: by
 *     the time React re-renders with the disable flag, the user has
 *     already been yanked back to the bottom. Owning the follow
 *     ourselves means the user's wheel always wins — the loop yields
 *     immediately on any user input and only resumes when the user is
 *     near the bottom again.
 *   - **post-send scroll** routed through the same lerp loop so the
 *     user-message reveal blends with any concurrent stream-follow
 *     motion rather than fighting it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import {
  clearAssistantScrollFollow,
  getAssistantScrollFollowKey,
  subscribeAssistantScrollFollow,
  subscribeChatContentGrowth,
} from "@/shell/chat-scroll-follow";
import {
  AT_BOTTOM_TOLERANCE_PX,
  CHAT_VIEWPORT_BOTTOM_FADE_PX,
  POST_SEND_USER_MESSAGE_BREATHING_PX,
  consumeResponseSpacerHeight,
  resolveIdleTailTarget,
  resolvePostSendTarget,
  resolveResponseSpacerHeight,
  resolveStreamFollowTarget,
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
/**
 * Suppress thumb-state setState calls when nothing visible has moved.
 * Sub-pixel jitter from Legend's continuous content-length measurements
 * during streaming would otherwise re-render every scroll frame.
 */
const THUMB_EPSILON_PX = 0.5;

/**
 * Auto-follow motion model.
 *
 * Streaming content grows in discrete, irregular bursts (a line / a few
 * tokens at a time). A naive "ease toward the new bottom, then stop"
 * follow restarts an ease-in/ease-out per chunk and crawls the last few
 * pixels asymptotically, so back-to-back short bumps read as a start/stop
 * stutter.
 *
 * Instead we model the follow as a critically-damped spring whose
 * velocity *persists* across frames and across chunk boundaries: a new
 * chunk just moves the spring's target, and because the spring is still
 * carrying velocity from the previous chunk the motion blends into one
 * continuous glide. Acceleration scales with the gap (`stiffness · diff`),
 * so a big burst still catches up quickly while a slow trickle glides
 * gently — no asymptotic crawl, no per-chunk restart. Critical damping
 * (`damping ≈ 2·√stiffness`) means it settles without overshoot. The loop
 * stays warm for `FOLLOW_STREAM_IDLE_MS` after the last growth so a slow
 * stream doesn't re-settle per line, then eases to rest. Above
 * `FOLLOW_HARD_SNAP_PX` we land directly — that far off, any glide would
 * leave the streamed text below the viewport for too many frames.
 */
const FOLLOW_SPRING_STIFFNESS = 0.00026; // px/ms² per px of gap (~250ms settle)
const FOLLOW_SPRING_DAMPING = 0.0322; // ≈ 2·√stiffness → critically damped
/** Keep gliding this long after the last content growth before settling to rest. */
const FOLLOW_STREAM_IDLE_MS = 200;
/** Clamp per-frame dt so a tab-switch / GC pause can't fling the viewport. */
const FOLLOW_MAX_FRAME_MS = 48;
/** Assumed dt for the first frame of a glide (before two timestamps exist). */
const FOLLOW_DEFAULT_FRAME_MS = 16;
const FOLLOW_HARD_SNAP_PX = 240;
/**
 * Gentle one-shot motion profile for the post-send nudge.
 *
 * The post-send reframe is a single settle into the reading position with
 * no streaming pressure, so it reads better as a slow ease-out rather than
 * the spring's stream-tuned glide. A low constant factor gives an
 * exponential ease-out that decelerates into the target over ~20–30
 * frames, and it skips the hard snap entirely so even a tall just-sent
 * bubble eases instead of teleporting. If a stream chunk arrives mid-nudge
 * its (non-gentle) `setTarget` clears the gentle flag and the spring takes
 * over — the two motions blend on the same loop instead of fighting.
 */
const FOLLOW_GENTLE_LERP_FACTOR = 0.12;
/**
 * Minimum per-frame step when the lerp would otherwise produce a
 * sub-pixel movement. Prevents the loop from stalling near the target
 * because of scrollTop rounding (most engines floor to integer at
 * the OS-compositor boundary even when CSS-side scrollTop accepts
 * fractions).
 */
const FOLLOW_MIN_STEP_PX = 0.5;

// Where the follow lands — breathing margin, bottom-fade inset, top peek —
// lives in `chat-follow-target` as pure geometry. This module owns the motion
// that gets there.

/** Matches `.event-list-trailing-region` min-heights in full-shell.chat.css */
const TRAILING_REGION_MIN_PX = {
  full: 160,
  compact: 120,
} as const;

/** Extra slack beyond the trailing-region min-height for follow re-arm (less than post-send breathing). */
const FOLLOW_REARM_EXTRA_PX = 24;

/** Re-arm stream auto-follow after scroll-up within the footer stack below the last message. */
const followRearmThresholdPx = (trailingRegionMinPx: number): number =>
  trailingRegionMinPx + FOLLOW_REARM_EXTRA_PX;

/**
 * Turn identity (`userMessageId`) embedded in an assistant scroll-follow
 * key (`assistant-<userMessageId>-<indexInTurn>`). Used to tell "a new
 * turn started streaming" (gentle reframe) apart from "the same turn
 * grew or advanced to its next slot" (spring follow / hard snap).
 */
const followKeyTurnId = (followKey: string): string =>
  followKey.replace(/^assistant-/, "").replace(/-\d+$/, "");

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
  /** Compact chat surfaces use the compact trailing-region min-height. */
  surface?: ChatScrollSurface;
};

type FollowTargetOptions = {
  /** Post-send positioning may scroll up to reveal a tall user bubble. */
  allowBackward?: boolean;
  /**
   * Use the slow ease-out motion profile (post-send nudge) instead of
   * the snappy stream-follow lerp. Cleared automatically when a later
   * non-gentle `setTarget` (e.g. a streaming chunk) retargets the loop.
   */
  gentle?: boolean;
};

type FollowApi = {
  /** Set an absolute target scrollTop. No-op if already past it. */
  setTarget: (target: number, options?: FollowTargetOptions) => void;
  /** Bump the current target (or scrollTop if idle) by `delta` px. */
  nudgeBy: (delta: number) => void;
  /** Scroll the latest user row into view with trailing reading space. */
  scrollLatestUserMessageIntoView: () => void;
  /** Scroll the active queued follow-up stack into view during streaming. */
  scrollQueuedMessagesIntoView: () => void;
  /** Expand the turn-scoped response area to its current viewport target. */
  activateResponseSpacer: () => void;
  /** Return the response area to the surface's real footer floor. */
  clearResponseSpacer: () => void;
  /** Stop the lerp loop and drop the pending target. */
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
  /**
   * A generous "at bottom" flag: true while the freshest turn is still on
   * screen (distance from the readable bottom within `AT_BOTTOM_TOLERANCE_PX`,
   * the response spacer discounted). Unlike `isFollowingLatest` — the motion
   * latch that drops the instant the user nudges upward — this stays true
   * through a barely-there scroll, so UI decisions gated on "is the user
   * genuinely scrolled up?" (the streaming reply peek) don't fire when the
   * user can still see the latest messages.
   */
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  /**
   * Imperative scrollbar-thumb plumbing. The thumb is positioned by
   * writing straight to the DOM node so a scroll frame never triggers a
   * React render (see the module header). `thumbElRef` is the node the
   * surface attaches via the returned `thumbRef` callback; surfaces that
   * don't render a custom thumb (sidebar, social) simply never attach it
   * and every thumb write below short-circuits.
   */
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

  /**
   * The follow latch. `true` means content growth should pull the
   * viewport down to the new bottom. Toggled off the instant the user
   * indicates upward intent, and back on once they're at/near the
   * bottom again (either by scrolling there themselves or hitting the
   * scroll-to-bottom button).
   */
  const followRef = useRef(true);
  const isFollowingLatestRef = useRef(true);
  // An upward gesture keeps follow released even if consuming the synthetic
  // spacer leaves the DOM at its literal end. Only a toward-bottom gesture or
  // an explicit latest-turn action may re-arm it.
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

  /**
   * Imperative bridge to the per-scroll-element follow loop. Populated
   * by the setup effect once Legend's scrollable node is attached, and
   * cleared on cleanup. Surfaces drive it indirectly through
   * `nudgeAfterSend` / `releaseFollow` / `scrollToBottom`.
   */
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

      // Skip the style write when nothing visible has moved — Legend's
      // sub-pixel content-length jitter during streaming would otherwise
      // touch the node every frame for no visual change.
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

  /**
   * Coalesce native scroll events without wiring Legend's public `onScroll`
   * prop. On web that prop builds a React Native-shaped event by reading the
   * content element's `scrollHeight`/`scrollWidth` every frame; those reads
   * force layout while virtualized markdown rows are mounting. We only need
   * Legend's already-maintained state snapshot, so listening passively on the
   * actual scroll node avoids that duplicate geometry pass.
   */
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
      // Discount the synthetic response spacer that inflates the physical end
      // during a turn, so "near bottom" tracks the readable content, not the
      // blank reading gutter below it.
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

      // Re-arm follow when back in the normal reading position above the
      // off-screen trailing footer (not only at the literal scroll end).
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
      // Legend's own scrollToEnd owns this motion; cancel any lerp
      // so we don't write scrollTop on the same frame Legend does.
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
        // Another cursor read may already be in flight. Do not jump to the
        // end of this older bounded window and pretend it is the live tail.
        // The guard effect retries this queued jump after that read settles.
        return;
      }
      void listRef.current?.scrollToEnd({ animated: behavior !== "instant" });
    },
    [setFollow],
  );

  /**
   * Reads the follow latch — true while content growth should pull
   * the viewport along with new content. This is the right signal
   * for "should I auto-nudge on the next send?" because the latch
   * survives the gap between when a short assistant reply finishes
   * (leaving the user above the absolute end with the trailing footer
   * off-screen) and when the next user message lands.
   */
  const getIsFollowing = useCallback(() => followRef.current, []);

  /**
   * Snapshot whether a new turn should be placed in the Codex-style reading
   * position. The physical end includes the synthetic response spacer, so
   * subtract it before applying the 300px scrollback gate.
   */
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

  /**
   * Snapshot whether the user is effectively at the bottom — the freshest turn
   * still on screen — regardless of the motion follow latch (a stray upward
   * nudge releases the latch but does not scroll the latest messages out of
   * view). Used by the send handler to treat a near-bottom send as an
   * at-bottom send: pin to the newest content rather than reframe the just-sent
   * message near the top. Purely distance-based, the response spacer discounted.
   */
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

  // Clear observers and animation work owned outside the attach lifecycle.
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

  // Track both cursor directions independently of list data identity. Older
  // prepends and newer-page appends can each evict the opposite edge once the
  // bounded window is full, so both settle through the same visual-anchor path.
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

    // Let Legend's MVCP/data pass and row ResizeObservers settle first. In the
    // normal case it lands exactly and `restore` performs no scroll write.
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

  /**
   * Explicitly release the auto-follow latch. Surfaces call this from
   * their send-message handler when the user fires a message from
   * scrollback (i.e. not near the bottom) — without it, `followRef`
   * stays armed across runs and the next assistant stream's content
   * growth auto-scrolls the user to the bottom even though they were
   * up in history. Paired with `scrollToBottom` (the existing arm-
   * the-latch op) so the send handler can express the user's intent
   * directly: nudge-to-bottom + arm follow, or stay-put + release
   * follow.
   */
  const releaseFollow = useCallback(() => {
    responseSpacerExpandedRef.current = false;
    followRearmBlockedRef.current = true;
    setFollow(false);
    clearAssistantScrollFollow();
    followApi.current?.cancel();
    followApi.current?.clearResponseSpacer();
  }, [setFollow]);

  /**
   * Smooth one-shot latest-turn placement used by send handlers when the
   * user fires a message from near the bottom. Routes through the same
   * lerp loop as the streaming auto-follow so the two motions blend
   * (nudge → stream-follow as the assistant reply arrives) rather
   * than fighting via separate concurrent rAF tweens writing
   * scrollTop on alternating frames.
   *
   * The two-rAF wait lets the optimistic user-message row lay out
   * and grow `scrollHeight` before we bump, so the target lands at
   * a real position rather than getting clamped to the old maxScroll.
   */
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

  /**
   * After send, scroll so the latest user bubble is fully visible and
   * the footer trailing region (empty reading area for the assistant)
   * sits below it — not just a fixed ~48px bump that leaves tall bubbles
   * clipped at the top while empty space exists off-screen below.
   */
  const nudgeAfterSend = useCallback(() => {
    responseSpacerExpandedRef.current = true;
    setFollow(true);
    clearAssistantScrollFollow();
    followApi.current?.activateResponseSpacer();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        followApi.current?.scrollLatestUserMessageIntoView();
      });
    });
  }, [setFollow]);

  /**
   * While a stream is active, additional sends render as queued chips in
   * the footer instead of as new event rows. Keep those chips in frame
   * without reusing the latest-user-row nudge, which would target the
   * previous turn and can scroll backward.
   */
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

  /**
   * Wheel/touch/keyboard listeners + auto-follow loop.
   *
   * - User wheel-up / touch-start / Up-arrow / PageUp / Home = explicit
   *   intent to leave the bottom; we drop the follow latch immediately
   *   and stop the lerp loop.
   * - User wheel-down / PageDown / End / Down-arrow = intent to lead
   *   the scroll themselves; we stop the loop so it doesn't fight the
   *   user's input on the next frame, but leave the latch armed so
   *   reaching the bottom re-engages auto-follow on the next chunk.
   * - Streaming row layout changes publish explicit assistant-follow
   *   notifications. When the follow latch is set and the streaming
   *   assistant row's bottom has dropped below the visible viewport,
   *   we update the lerp target. The loop tweens toward it smoothly
   *   across however many frames the catch-up takes, and absorbs
   *   follow-up target updates without restarting the easing — no
   *   per-chunk snap, no restart-on-every-frame jitter.
   */
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
        // While a latest-turn placement is live (`responseSpacerExpandedRef`),
        // the spacer height is exactly what the post-send nudge target is
        // measured against, so it must stay put. An incidental resize /
        // re-measure pass during the send (the composer clearing, virtualized
        // rows settling) would otherwise shrink it mid-nudge — dropping
        // `maxScroll`, clamping `scrollTop`, and stranding the just-sent row in
        // the middle of the viewport. So during a placement never shrink it;
        // only grow toward the (fresh) target if we somehow sit below it. The
        // user scrolling up (`consumeResponseSpacer`) or a scroll-to-bottom /
        // release still collapses it, and a fresh send re-establishes it.
        if (responseSpacerExpandedRef.current) {
          if (responseSpacerHeightRef.current < target) {
            writeResponseSpacerHeight(target);
          }
          return;
        }
        // Not placed: match Codex resize behavior — cap an existing spacer when
        // the viewport shrinks, but do not regrow consumed space on resize.
        writeResponseSpacerHeight(
          Math.min(responseSpacerHeightRef.current, target),
        );
      };
      const activateResponseSpacer = () => {
        if (!attached) return;
        responseSpacerExpandedRef.current = true;
        // Settle the spacer to its FINAL height for this placement up front,
        // measured from the CURRENT viewport (the composer has usually just
        // cleared), so the nudge target computed a couple of frames later lands
        // against a stable bottom-space and the row can reach the top in one
        // motion. Freezing above then keeps this height put through the nudge.
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

      // ---- continuous spring follow loop ---------------------------
      // `followTarget` is the absolute scrollTop the loop is chasing
      // (`null` = idle). `followVel` (px/ms) carries across frames so
      // consecutive streaming chunks blend into one glide instead of
      // restarting an ease per chunk. `lastTargetTime` marks the last
      // content growth so the loop can stay warm through the gaps
      // between slow lines, then settle once the stream pauses.
      let followTarget: number | null = null;
      let followRaf = 0;
      let followGentle = false;
      let followVel = 0;
      let lastFrameTime = 0;
      let lastTargetTime = 0;
      // Turn-start reframe latch. When the followed turn changes (a fresh
      // send, or a queued follow-up dispatching once its turn comes) the
      // first catch-up is a one-shot reframe with no reading continuity to
      // preserve, so it uses the gentle ease-out instead of the
      // stream-tuned spring — whose hard-snap branch is exactly the
      // jarring jump on queued-message dispatch. The latch holds gentle
      // across the per-chunk retargets until the loop first catches up,
      // then the spring owns the follow for the rest of the turn.
      let lastFollowedTurnId: string | null = null;
      let turnStartGlide = false;

      const stopLoop = () => {
        if (followRaf) cancelAnimationFrame(followRaf);
        followRaf = 0;
        followTarget = null;
        followGentle = false;
        followVel = 0;
        lastFrameTime = 0;
        lastTargetTime = 0;
        turnStartGlide = false;
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

        // Caught up. The gentle one-shot nudge ends here; a stream-follow
        // glide instead idles in place (velocity bled off) and stays warm
        // so the next chunk continues without a restart — until the stream
        // has been quiet for `FOLLOW_STREAM_IDLE_MS`, then it settles.
        if (absDiff < FOLLOW_MIN_STEP_PX) {
          attached.scrollTop = target;
          followVel = 0;
          lastFrameTime = 0;
          turnStartGlide = false;
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

        // Gentle post-send reframe: constant low-factor ease-out (no
        // velocity carry, no hard snap) — a single smooth settle.
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

        // Massive gap (post-tool dump, slow network catching up, resumed
        // conversation jumping to the latest reply) — land directly rather
        // than glide hundreds of px with text off-screen the whole time.
        // Stay warm so the trickle that follows the dump still glides.
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

        // Critically-damped spring step. Velocity persists across frames
        // (and across chunk boundaries via `setTarget`), so the motion is
        // a continuous glide rather than a per-chunk ease-out-to-stop.
        const now = performance.now();
        const dt = lastFrameTime
          ? Math.min(FOLLOW_MAX_FRAME_MS, Math.max(1, now - lastFrameTime))
          : FOLLOW_DEFAULT_FRAME_MS;
        lastFrameTime = now;
        const accel =
          FOLLOW_SPRING_STIFFNESS * diff - FOLLOW_SPRING_DAMPING * followVel;
        // Stream-follow never runs backward, so clamp velocity ≥ 0.
        followVel = Math.max(0, followVel + accel * dt);
        let step = followVel * dt;
        if (step < FOLLOW_MIN_STEP_PX) step = FOLLOW_MIN_STEP_PX;
        if (step >= diff) {
          // Would reach/overshoot the target this frame — land exactly and
          // keep velocity consistent with the distance actually covered.
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
        // Don't follow backwards during stream-follow (would scroll the
        // user up against their intent). Post-send positioning opts in.
        if (!options.allowBackward && clamped <= attached.scrollTop + 0.5) {
          return;
        }
        const gentle = Boolean(options.gentle);
        // Scroll placement is functional continuity rather than decorative
        // motion. Always use the same gentle send/turn reframe on every OS;
        // letting Windows' system animation setting replace this with a direct
        // scrollTop write made sends feel rigid compared with macOS.
        // Switching from a warm spring glide into a gentle one-shot (or
        // vice versa) shouldn't carry stale velocity between the two
        // motion profiles.
        if (gentle !== followGentle) followVel = 0;
        followTarget = clamped;
        followGentle = gentle;
        // Mark content growth so the spring loop stays warm between the
        // irregular gaps in a slow stream (gentle nudges don't extend it).
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
          // The optimistic just-sent row isn't in the DOM. This happens
          // when the user is parked far up in history (follow latch still
          // armed — e.g. they were following a reply taller than the
          // viewport, pinned near its top) and the new user row
          // virtualized off the bottom. We must NOT fall back to the last
          // *rendered* user row: that's an earlier turn's bubble up in the
          // current viewport, and framing it scrolls the viewport
          // *backward* — the "send scrolled me further up" bug. Instead
          // settle forward toward the end so the just-sent bubble (and the
          // assistant reply about to stream below it) come into view.
          const maxScroll = Math.max(
            0,
            attached.scrollHeight - attached.clientHeight,
          );
          setTarget(maxScroll, { gentle: true });
          return;
        }
        // Use offsetTop/offsetHeight (layout geometry) rather than
        // getBoundingClientRect (post-transform). The just-sent bubble
        // is mid-`user-message-enter` animation here (translateY 10→0,
        // scale 0.97→1, 360ms), so its rendered rect sits a few px
        // below its final layout position. Measuring the rect would
        // bake that transient offset into a static lerp target — the
        // bubble would end ~5–7px higher in the viewport than intended
        // and the residual transform would visibly settle after the
        // scroll lerp finished, reading as a tiny jagged "double
        // motion" right after send.
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

      /**
       * Returns whether it owned the motion. `false` means there is no live
       * streaming row to anchor to, and the caller should fall back to the
       * idle tail settle — the turn can still be alive (a tool running under a
       * settled assistant slot, with the working indicator below it), and that
       * growth has to be followed by something.
       */
      const followActiveAssistantRow = (): boolean => {
        if (!attached || !followRef.current) return false;
        const followKey = getAssistantScrollFollowKey();
        if (!followKey) return false;
        // A different turn started streaming — arm the gentle turn-start
        // reframe. Same-turn key changes (next slot after a tool call)
        // keep the spring so post-tool content dumps still hard-snap into
        // view instead of gliding with the text off-screen.
        const turnId = followKeyTurnId(followKey);
        if (turnId !== lastFollowedTurnId) {
          lastFollowedTurnId = turnId;
          turnStartGlide = true;
        }
        const streamingRow = attached.querySelector<HTMLElement>(
          `[data-scroll-follow-key="${CSS.escape(followKey)}"]`,
        );
        if (!streamingRow || streamingRow.offsetHeight <= 0) return false;
        // The follow key is intentionally kept active after a run's final
        // assistant message settles (so a *new* turn's first chunk can hand
        // off cleanly). But once that row has locked, `.event-row--streaming`
        // is gone and it is no longer growing. A late layout change on the
        // settled row — the reveal mask clearing, an inline image/card
        // mounting once artifacts render, a code block, or a timestamp settling —
        // still fires `notifyAssistantScrollFollowLayoutChange`, and following
        // the full (now static) row bottom re-applies the breathing inset,
        // pulling the viewport forward into the empty trailing region a beat
        // after the reply was already fully visible. The anticipatory follow
        // is only meaningful while content is actively streaming, so bail once
        // the row has settled and leave the view put. That path
        // (`scheduleFollowActiveAssistantRow`) ignores the return value, so a
        // settled row stays put; only real growth, which arrives through
        // `followIdleContentGrowth`, is picked up by the fallback.
        if (!streamingRow.classList.contains("event-row--streaming")) {
          return false;
        }
        const rowRect = streamingRow.getBoundingClientRect();
        const containerRect = attached.getBoundingClientRect();
        const rowTop = rowRect.top - containerRect.top + attached.scrollTop;
        const rowLayoutBottom =
          rowRect.bottom - containerRect.top + attached.scrollTop;
        let rowBottom = rowLayoutBottom;
        // The wrapper's DOM can extend below the soft mask frontier. Follow
        // what is actually revealed so the viewport never scrolls ahead of
        // the text the user can see.
        const revealElement = streamingRow.querySelector<HTMLElement>(
          "[data-reveal-visible-bottom]",
        );
        if (revealElement) {
          const frontier = Number(
            revealElement.getAttribute("data-reveal-visible-bottom"),
          );
          if (Number.isFinite(frontier)) {
            const revealRect = revealElement.getBoundingClientRect();
            const revealBottom =
              revealRect.top -
              containerRect.top +
              attached.scrollTop +
              frontier;
            // The mask hides only the wrapper's own unrevealed tail. Content
            // mounted BELOW the wrapper (agent spawn cards, inline strips) is
            // fully visible at its layout position, so clamp to the frontier
            // only while the wrapper is the row's last visible content —
            // otherwise the clamp would hold the viewport above a card the
            // user should be following.
            if (rowRect.bottom <= revealRect.bottom + 1) {
              rowBottom = Math.min(rowBottom, revealBottom);
            }
          }
        }
        // Everything below the row that is still part of this turn: the
        // working indicator is its own timeline item, and a card row can be
        // appended mid-turn. Measuring the first element *after* the live tail
        // — the queued stack, else the trailing footer — picks up whatever
        // that tail currently ends with without enumerating (and forcing a
        // rect read on) every rendered row each follow frame.
        const tailBoundary =
          attached.querySelector<HTMLElement>(".composer-queued-stack") ??
          attached.querySelector<HTMLElement>(".event-list-trailing-region");
        const tailBottom = tailBoundary
          ? tailBoundary.getBoundingClientRect().top -
            containerRect.top +
            attached.scrollTop
          : null;
        const queuedMessages = attached.querySelectorAll<HTMLElement>(
          ".composer-queued-message:not(.composer-queued-message--leaving)",
        );
        const queuedMessage =
          queuedMessages.length > 0
            ? queuedMessages[queuedMessages.length - 1]!
            : null;
        const queuedMessageBottom = queuedMessage
          ? queuedMessage.getBoundingClientRect().bottom -
            containerRect.top +
            attached.scrollTop
          : null;
        const target = resolveStreamFollowTarget({
          clientHeight: attached.clientHeight,
          rowTop,
          rowBottom,
          tailBottom,
          // The tail below the row is laid out past the row's unrevealed text,
          // so it carries that displacement; hand it over so the frontier
          // clamp survives being extended to the tail.
          unrevealedPx: rowLayoutBottom - rowBottom,
          queuedBottom: queuedMessageBottom,
        });
        setTarget(target, turnStartGlide ? { gentle: true } : undefined);
        return true;
      };
      let followAssistantRowRaf = 0;
      const scheduleFollowActiveAssistantRow = () => {
        if (followAssistantRowRaf) return;
        followAssistantRowRaf = requestAnimationFrame(() => {
          followAssistantRowRaf = 0;
          followActiveAssistantRow();
        });
      };

      /**
       * Follow content growth that no streaming row anchors — an agent
       * completion card mounting (or the spawn card settling into its taller
       * completed form) after the run ended, and the working indicator coming
       * up under an assistant slot that has already locked while a tool runs.
       * Both cases have no `.event-row--streaming` to key off, so settle toward
       * the new end of content (the trailing footer's top), the same reading
       * position a stream-follow would have landed on.
       */
      const followIdleContentGrowth = () => {
        if (!attached || !followRef.current) return;
        // A run may have started between the notify and this frame — the keyed
        // follow owns the motion then, but only while its row is actually
        // streaming. The key outlives the row it points at (it is held across
        // the gap between slots so the next turn hands off cleanly), so a
        // truthy key alone is not proof anything is anchoring the tail.
        if (followActiveAssistantRow()) return;
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
        // The follow latch alone isn't enough of a gate here: it also stays
        // armed while the user is pinned near the top of a taller-than-
        // viewport reply. Only chase idle growth when the user is effectively
        // at the end — either Legend still reports at-end (scroll events
        // don't fire on pure content growth, so this reflects the pre-growth
        // position) or the reading target is within half a viewport.
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

      // ---- user-input release handlers -----------------------------
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
        // Pause follow for the gesture, but do not permanently block
        // re-arming until the finger actually moves toward history.
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
        // Arrow/Home/End keys inside interactive message content belong to the
        // editor or control. They must not release follow or request history.
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

      const unsubscribeFollow = subscribeAssistantScrollFollow(() => {
        if (!followRef.current) return;
        scheduleFollowActiveAssistantRow();
      });

      // Agent card mounts and the working indicator route through their own
      // channel (not the keyed follow notify) because they must fire even when
      // no follow key is active — see `notifyChatContentGrowth`. Always go
      // through the idle path: it prefers the keyed follow when a row is
      // genuinely streaming and settles toward the tail when one isn't, which
      // a truthy-key check here can't distinguish (the key outlives its row).
      const unsubscribeGrowth = subscribeChatContentGrowth(() => {
        if (!followRef.current) return;
        scheduleFollowIdleContentGrowth();
      });

      // NOTE: We intentionally do NOT re-pin scrollTop on container *width*
      // changes (the display/sidebar panel sliding open/closed over 460ms).
      // Earlier versions re-ran `scrollToEnd`, or wrote `scrollTop` directly,
      // on every width tick to keep the bottom glued during the reflow — but
      // any external scroll write during the slide fights Legend's
      // `maintainVisibleContentPosition`, which independently re-anchors on
      // each reflow frame. The two controllers disagree frame-to-frame and
      // oscillate: the heavy vertical shake at the bottom while toggling the
      // sidebar. An isolated A/B harness confirmed it — with the per-frame
      // pin the reference row's on-screen Y oscillated (5 direction reversals,
      // 42px range); with no custom write Legend's MVCP held it smoothly (0
      // reversals, 21px monotonic settle). So we let MVCP own scroll position
      // across width reflows and write scrollTop only for the explicit motions
      // (send nudge, stream follow, scroll-to-bottom button).

      cleanup = () => {
        if (!attached) return;
        responseSpacerResizeObserver?.disconnect();
        attached.style.removeProperty("--chat-response-spacer-height");
        unsubscribeFollow();
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
        if (followAssistantRowRaf) {
          cancelAnimationFrame(followAssistantRowRaf);
          followAssistantRowRaf = 0;
        }
        stopLoop();
        followApi.current = null;
        if (attachedScrollNodeRef.current === attached) {
          attachedScrollNodeRef.current = null;
        }
        attached = null;
      };
      return true;
    };

    // Persistent attach watcher. `tryAttach` cleans up and re-binds
    // whenever the live scroll node differs from the one we're attached
    // to, so this loop handles two cases with the same code path:
    //   1. Initial mount — the scroll node may not exist for a few frames
    //      after the list mounts; poll every frame until it appears.
    //   2. Remount — navigating to home content unmounts the LegendList
    //      and returning remounts it with a *new* scroll DOM node. Without
    //      re-attaching, `followApi`/the wheel listeners stay bound to the
    //      old detached node and every `scrollTop` write (send-nudge and
    //      stream auto-follow) silently no-ops. Once attached we only need
    //      to notice the swap, so throttle the check to keep this cheap.
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
