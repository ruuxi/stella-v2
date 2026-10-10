import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";
import type { LegendListRef } from "@legendapp/list/react-native";
import {
  resolvePostSendPlacement,
  shouldPlaceLatestTurn,
} from "./chat-post-send-placement";

/**
 * Extra breathing room beyond the list's trailing slack (the chat tail +
 * measured composer height). The slack is empty scrollable padding so messages
 * can sit above the overlay — without adding it, "near bottom" never engages
 * in the normal reading position (desktop `followRearmThreshold` does the same).
 */
const SCROLL_NEAR_BOTTOM_BASE_PX = 96;
/** Base distance before showing the scroll-to-bottom FAB (plus trailing slack). */
const SCROLL_AWAY_FROM_BOTTOM_BASE_PX = 96;
/** Re-arm stream auto-follow once the user scrolls back to the true bottom. */
const SCROLL_AT_BOTTOM_THRESHOLD = 8;
/** Quiet window after the last gesture frame before momentum is considered done. */
const MANUAL_SCROLL_SETTLE_MS = 140;

/** Native animation guard so stream-follow lag is not mistaken for scrollback. */
const FOLLOW_NATIVE_ANIMATION_GUARD_MS = 320;
const FOLLOW_HARD_SNAP_PX = 240;
const FOLLOW_TARGET_EPSILON_PX = 0.5;
const FOLLOW_TOP_PEEK_PX = 56;

/**
 * Auto-follow motion model — ported from desktop's "continuous spring glide".
 *
 * Streaming content grows in discrete, irregular bursts (a line / a few tokens
 * at a time). A naive "ease toward the new bottom with an animated scroll, then
 * stop" follow restarts a native ease per chunk and crawls the last few pixels
 * asymptotically, so back-to-back short bumps read as a start/stop stutter.
 *
 * Instead we drive the offset ourselves each frame from a critically-damped
 * spring whose velocity *persists* across frames and across chunk boundaries: a
 * new chunk just moves the target, and because the spring is still carrying
 * velocity from the previous chunk the motion blends into one continuous glide.
 * Acceleration scales with the gap (`stiffness · diff`), so a big burst still
 * catches up quickly while a slow trickle glides gently — no asymptotic crawl,
 * no per-chunk restart. Critical damping (`damping ≈ 2·√stiffness`) settles
 * without overshoot. The loop stays warm for `FOLLOW_STREAM_IDLE_MS` after the
 * last growth so a slow stream doesn't re-settle per line, then eases to rest.
 * Above `FOLLOW_HARD_SNAP_PX` we land directly — that far off, any glide would
 * leave the streamed text below the viewport for too many frames.
 */
const FOLLOW_SPRING_STIFFNESS = 0.00026; // px/ms² per px of gap (~250ms settle)
const FOLLOW_SPRING_DAMPING = 0.0322; // ≈ 2·√stiffness → critically damped
/** Keep gliding this long after the last content growth before settling to rest. */
const FOLLOW_STREAM_IDLE_MS = 200;
/** Clamp per-frame dt so a JS-thread / GC pause can't fling the viewport. */
const FOLLOW_MAX_FRAME_MS = 48;
/** Assumed dt for the first frame of a glide (before two timestamps exist). */
const FOLLOW_DEFAULT_FRAME_MS = 16;
/** Minimum per-frame step so the loop never stalls on sub-pixel rounding. */
const FOLLOW_MIN_STEP_PX = 0.5;
/**
 * Gentle one-shot profile for the post-send nudge — a single settle into the
 * reading position with no streaming pressure, so a slow constant ease-out
 * reads better than the stream-tuned spring. If a stream chunk arrives mid-nudge
 * its (non-gentle) target update clears the gentle flag and the spring takes
 * over on the same loop instead of fighting.
 */
const FOLLOW_GENTLE_LERP_FACTOR = 0.12;
/**
 * How long after a send the latest user row's layout changes may re-run the
 * post-send placement. Covers the four-line clamp collapsing a long message a
 * few frames after the anchor was first computed, without letting much later
 * layout churn (e.g. a "Show more" tap) yank the scroll position around.
 */
const POST_SEND_REANCHOR_WINDOW_MS = 1500;

// ---------------------------------------------------------------------------
// Scroll — manual by default; smooth auto-follow while assistant streams in
// near the bottom.
// ---------------------------------------------------------------------------

export function useChatScroll(
  listTrailingSlackPx: number,
  trailingMessageId: string | null,
  listLeadingInsetPx: number,
) {
  const listRef = useRef<LegendListRef>(null);
  const listTrailingSlackRef = useRef(listTrailingSlackPx);
  listTrailingSlackRef.current = listTrailingSlackPx;
  const listLeadingInsetRef = useRef(listLeadingInsetPx);
  listLeadingInsetRef.current = listLeadingInsetPx;
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const nearBottomLimit = SCROLL_NEAR_BOTTOM_BASE_PX + listTrailingSlackPx;
  const atBottomLimit = SCROLL_AT_BOTTOM_THRESHOLD + listTrailingSlackPx;
  const awayFromBottomLimit =
    SCROLL_AWAY_FROM_BOTTOM_BASE_PX + listTrailingSlackPx;
  const metricsRef = useRef({ offsetY: 0, contentHeight: 0, layoutHeight: 0 });
  const contentHeightRef = useRef(0);
  const followArmedRef = useRef(true);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const followRearmBlockedRef = useRef(false);
  const followTargetOffsetRef = useRef<number | null>(null);
  const followRafRef = useRef(0);
  const followAnimatingUntilMsRef = useRef(0);
  const activeAssistantHeightRef = useRef(0);
  const latestUserLayoutRef = useRef<{ id: string; height: number } | null>(
    null,
  );
  /**
   * Live post-send anchor. Placement re-runs from the latest user row's own
   * `onLayout` and list content-size events until its geometry settles. Both
   * the four-line clamp and composer collapse can change the target after
   * the initial paint.
   */
  const pendingSendAnchorRef = useRef<{
    userMessageId: string;
    placedRowHeightPx: number | null;
    staleAtMs: number;
  } | null>(null);
  const placeLatestTurnRafRef = useRef(0);
  const trailingMessageIdRef = useRef(trailingMessageId);
  trailingMessageIdRef.current = trailingMessageId;
  /** Content height before the next assistant-driven layout pass. */
  const assistantLayoutBaselineRef = useRef<number | null>(null);
  /** True while the user's finger is actively dragging the list. */
  const isDraggingRef = useRef(false);
  /** Holds through drag momentum so an upward fling still blocks re-arming. */
  const manualScrollActiveRef = useRef(false);
  const manualScrollSettleTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  /** Spring velocity (px/ms) — persists across frames and chunk boundaries. */
  const followVelRef = useRef(0);
  /** Offset we last committed; the spring integrates from here, not laggy native. */
  const followCurrentRef = useRef(0);
  /** Timestamp of the previous glide frame, for dt. 0 = first frame. */
  const lastFrameTimeRef = useRef(0);
  /** Timestamp of the last content growth, to keep the loop warm between lines. */
  const lastTargetTimeRef = useRef(0);
  /** Gentle one-shot (post-send) vs. stream spring profile. */
  const followGentleRef = useRef(false);

  const setFollowArmed = useCallback((armed: boolean) => {
    if (followArmedRef.current === armed) return;
    followArmedRef.current = armed;
    setIsFollowingLatest(armed);
  }, []);

  const stopFollowLoop = useCallback(() => {
    if (followRafRef.current) {
      cancelAnimationFrame(followRafRef.current);
      followRafRef.current = 0;
    }
    followTargetOffsetRef.current = null;
    followAnimatingUntilMsRef.current = 0;
    followVelRef.current = 0;
    lastFrameTimeRef.current = 0;
    lastTargetTimeRef.current = 0;
    followGentleRef.current = false;
  }, []);

  useEffect(
    () => () => {
      stopFollowLoop();
      if (manualScrollSettleTimerRef.current) {
        clearTimeout(manualScrollSettleTimerRef.current);
      }
      if (placeLatestTurnRafRef.current) {
        cancelAnimationFrame(placeLatestTurnRafRef.current);
      }
    },
    [stopFollowLoop],
  );

  const scheduleManualScrollSettle = useCallback(() => {
    if (manualScrollSettleTimerRef.current) {
      clearTimeout(manualScrollSettleTimerRef.current);
    }
    manualScrollSettleTimerRef.current = setTimeout(() => {
      manualScrollSettleTimerRef.current = null;
      if (!isDraggingRef.current) {
        manualScrollActiveRef.current = false;
      }
    }, MANUAL_SCROLL_SETTLE_MS);
  }, []);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const previousOffsetY = metricsRef.current.offsetY;
      const offsetDelta = contentOffset.y - previousOffsetY;
      metricsRef.current = {
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        layoutHeight: layoutMeasurement.height,
      };
      contentHeightRef.current = contentSize.height;

      // iOS rubber-band: after overscrolling past the tail the list springs
      // back upward. That return is not a scrollback and must not block
      // re-arming, or follow stays released while the user sits at the end.
      const maxOffsetY = Math.max(
        0,
        contentSize.height - layoutMeasurement.height,
      );
      const bouncingBackFromTail = previousOffsetY > maxOffsetY + 0.5;

      if (manualScrollActiveRef.current) {
        scheduleManualScrollSettle();
        if (offsetDelta < -0.5 && !bouncingBackFromTail) {
          followRearmBlockedRef.current = true;
        } else if (offsetDelta > 0.5) {
          followRearmBlockedRef.current = false;
        }
      }

      const hasOverflow = contentSize.height > layoutMeasurement.height + 2;
      const distFromBottom = Math.max(
        0,
        contentSize.height - contentOffset.y - layoutMeasurement.height,
      );

      // Re-arm the follow latch when the user returns to the true tail. The
      // wider near-bottom band can still follow while armed, but it should not
      // re-enable follow after an intentional scrollback. Never re-arm while a
      // drag is in flight — otherwise the first few pixels of an upward drag
      // (still inside the at-bottom band) re-engage follow and the next
      // streaming layout yanks the user straight back down.
      if (distFromBottom <= atBottomLimit) {
        if (!isDraggingRef.current && !followRearmBlockedRef.current) {
          setFollowArmed(true);
        }
      } else if (
        distFromBottom > nearBottomLimit &&
        pendingSendAnchorRef.current === null &&
        followTargetOffsetRef.current === null &&
        !followRafRef.current &&
        Date.now() > followAnimatingUntilMsRef.current
      ) {
        setFollowArmed(false);
        stopFollowLoop();
      }

      setAwayFromBottom(hasOverflow && distFromBottom > awayFromBottomLimit);
    },
    [
      atBottomLimit,
      awayFromBottomLimit,
      nearBottomLimit,
      scheduleManualScrollSettle,
      setFollowArmed,
      stopFollowLoop,
    ],
  );

  const resetAssistantAutoScroll = useCallback(() => {
    // Reset per-row measurements without claiming follow ownership. A fresh
    // assistant row may arrive while the user is reading history; only an
    // explicit tail action may re-arm that released latch.
    assistantLayoutBaselineRef.current = null;
    activeAssistantHeightRef.current = 0;
    if (!pendingSendAnchorRef.current) stopFollowLoop();
  }, [stopFollowLoop]);

  const releaseFollow = useCallback(() => {
    pendingSendAnchorRef.current = null;
    followRearmBlockedRef.current = true;
    setFollowArmed(false);
    stopFollowLoop();
  }, [setFollowArmed, stopFollowLoop]);

  // The user grabbed the list — drop follow immediately and remember the drag
  // is live so `onScroll` won't re-arm until the gesture settles.
  const onScrollBeginDrag = useCallback(() => {
    isDraggingRef.current = true;
    manualScrollActiveRef.current = true;
    // The user owns the scroll now — a late post-send re-anchor must not
    // fight the gesture.
    pendingSendAnchorRef.current = null;
    if (manualScrollSettleTimerRef.current) {
      clearTimeout(manualScrollSettleTimerRef.current);
      manualScrollSettleTimerRef.current = null;
    }
    // Pause follow immediately, but only an actual upward delta should block
    // it from re-arming when a tap/drag gesture ends at the live tail.
    setFollowArmed(false);
    stopFollowLoop();
  }, [setFollowArmed, stopFollowLoop]);

  // Gesture settled (lift, or end of momentum). Clear the drag flag and re-arm
  // only if the user came to rest at the true tail.
  const onScrollSettle = useCallback(() => {
    isDraggingRef.current = false;
    scheduleManualScrollSettle();
    const { offsetY, contentHeight, layoutHeight } = metricsRef.current;
    const distFromBottom = Math.max(0, contentHeight - offsetY - layoutHeight);
    // Coming to rest anywhere inside the near-bottom band re-arms follow —
    // the same band `onScroll` uses to release it. Re-arming only at the
    // exact tail left a dead zone where the user was visibly at the bottom
    // but new messages never scrolled into view.
    if (distFromBottom <= nearBottomLimit) {
      followRearmBlockedRef.current = false;
      setFollowArmed(true);
    }
  }, [nearBottomLimit, scheduleManualScrollSettle, setFollowArmed]);

  /** Call when assistant text grows, before layout measures the new height. */
  const prepareAssistantLayoutFollow = useCallback(() => {
    assistantLayoutBaselineRef.current = contentHeightRef.current;
  }, []);

  // Drive the list to `offset` directly (no native animation) — the spring owns
  // the motion, so each frame just commits the integrated position. We treat the
  // committed offset as the source of truth during a glide because native
  // `onScroll` read-back lags a frame or two behind.
  const commitOffset = useCallback((offset: number) => {
    followCurrentRef.current = offset;
    metricsRef.current.offsetY = offset;
    followAnimatingUntilMsRef.current =
      Date.now() + FOLLOW_NATIVE_ANIMATION_GUARD_MS;
    listRef.current?.scrollToOffset({ offset, animated: false });
  }, []);

  const updateAwayFromBottom = useCallback(
    (offset: number) => {
      const { layoutHeight } = metricsRef.current;
      const contentHeight = contentHeightRef.current;
      const dist = Math.max(0, contentHeight - offset - layoutHeight);
      setAwayFromBottom(
        contentHeight > layoutHeight + 2 && dist > awayFromBottomLimit,
      );
    },
    [awayFromBottomLimit],
  );

  const stepFollow = useCallback(() => {
    followRafRef.current = 0;
    if (!followArmedRef.current || followTargetOffsetRef.current === null) {
      followTargetOffsetRef.current = null;
      return;
    }

    const { layoutHeight } = metricsRef.current;
    const contentHeight = contentHeightRef.current;
    const maxOffset = Math.max(0, contentHeight - layoutHeight);
    const target = Math.max(
      0,
      Math.min(maxOffset, followTargetOffsetRef.current),
    );
    const current = followCurrentRef.current;
    const diff = target - current;
    const absDiff = Math.abs(diff);
    const now = Date.now();

    // Caught up. The gentle one-shot ends here; a stream glide idles in place
    // (velocity bled off) and stays warm so the next chunk continues without a
    // restart — until the stream has been quiet for FOLLOW_STREAM_IDLE_MS.
    if (absDiff < FOLLOW_MIN_STEP_PX) {
      commitOffset(target);
      followVelRef.current = 0;
      lastFrameTimeRef.current = 0;
      if (
        followGentleRef.current ||
        now - lastTargetTimeRef.current > FOLLOW_STREAM_IDLE_MS
      ) {
        followTargetOffsetRef.current = null;
        updateAwayFromBottom(target);
        return;
      }
      followRafRef.current = requestAnimationFrame(stepFollow);
      return;
    }

    // Gentle post-send reframe: constant low-factor ease-out, no velocity carry,
    // no hard snap — a single smooth settle.
    if (followGentleRef.current) {
      const lerpStep = diff * FOLLOW_GENTLE_LERP_FACTOR;
      const stepPx =
        Math.abs(lerpStep) >= FOLLOW_MIN_STEP_PX
          ? lerpStep
          : Math.sign(diff) * FOLLOW_MIN_STEP_PX;
      commitOffset(current + stepPx);
      updateAwayFromBottom(current + stepPx);
      followRafRef.current = requestAnimationFrame(stepFollow);
      return;
    }

    // Massive gap (post-tool dump, resumed conversation jumping to the latest
    // reply) — land directly rather than glide hundreds of px with text
    // off-screen the whole time. Stay warm so the trickle that follows glides.
    if (absDiff > FOLLOW_HARD_SNAP_PX) {
      commitOffset(target);
      followVelRef.current = 0;
      lastFrameTimeRef.current = 0;
      if (now - lastTargetTimeRef.current > FOLLOW_STREAM_IDLE_MS) {
        followTargetOffsetRef.current = null;
        updateAwayFromBottom(target);
        return;
      }
      followRafRef.current = requestAnimationFrame(stepFollow);
      return;
    }

    // Critically-damped spring step. Velocity persists across frames (and across
    // chunk boundaries via setFollowTarget), so the motion is a continuous glide
    // rather than a per-chunk ease-out-to-stop.
    const dt = lastFrameTimeRef.current
      ? Math.min(
          FOLLOW_MAX_FRAME_MS,
          Math.max(1, now - lastFrameTimeRef.current),
        )
      : FOLLOW_DEFAULT_FRAME_MS;
    lastFrameTimeRef.current = now;
    const accel =
      FOLLOW_SPRING_STIFFNESS * diff -
      FOLLOW_SPRING_DAMPING * followVelRef.current;
    // Stream-follow never runs backward, so clamp velocity ≥ 0.
    followVelRef.current = Math.max(0, followVelRef.current + accel * dt);
    let step = followVelRef.current * dt;
    if (step < FOLLOW_MIN_STEP_PX) step = FOLLOW_MIN_STEP_PX;
    if (step >= diff) {
      // Would reach/overshoot this frame — land exactly and keep velocity
      // consistent with the distance actually covered.
      commitOffset(target);
      followVelRef.current = diff / dt;
    } else {
      commitOffset(current + step);
    }
    updateAwayFromBottom(followCurrentRef.current);
    followRafRef.current = requestAnimationFrame(stepFollow);
  }, [commitOffset, updateAwayFromBottom]);

  const setFollowTarget = useCallback(
    (target: number, gentle = false) => {
      if (!followArmedRef.current) return;

      const { layoutHeight } = metricsRef.current;
      const contentHeight = contentHeightRef.current;
      const maxOffset = Math.max(0, contentHeight - layoutHeight);
      const clamped = Math.max(0, Math.min(maxOffset, target));

      // Seed the spring's current offset from the real position when starting
      // cold, so the first frame integrates from where the list actually sits.
      if (!followRafRef.current && followTargetOffsetRef.current === null) {
        followCurrentRef.current = metricsRef.current.offsetY;
      }

      // Don't follow backwards during a stream glide — that would scroll the
      // user up against their intent. The gentle post-send nudge opts in.
      if (
        !gentle &&
        clamped <= followCurrentRef.current + FOLLOW_TARGET_EPSILON_PX
      ) {
        return;
      }

      // Switching motion profile shouldn't carry stale velocity between them.
      if (gentle !== followGentleRef.current) followVelRef.current = 0;
      followGentleRef.current = gentle;
      followTargetOffsetRef.current = clamped;
      // Mark content growth so the spring stays warm across the irregular gaps
      // of a slow stream (gentle nudges don't extend it).
      if (!gentle) lastTargetTimeRef.current = Date.now();
      if (!followRafRef.current) {
        followRafRef.current = requestAnimationFrame(stepFollow);
      }
    },
    [stepFollow],
  );

  const followActiveAssistantRow = useCallback(() => {
    const assistantHeight = activeAssistantHeightRef.current;
    if (assistantHeight <= 0) return;

    const { layoutHeight } = metricsRef.current;
    if (layoutHeight <= 0) return;

    const contentHeight = contentHeightRef.current;
    const rowBottom = Math.max(0, contentHeight - listTrailingSlackPx);
    const rowTop = Math.max(0, rowBottom - assistantHeight);
    const desiredScrollTop = Math.max(0, contentHeight - layoutHeight);
    const pinnedTop = Math.max(
      0,
      rowTop - FOLLOW_TOP_PEEK_PX - listLeadingInsetRef.current,
    );
    setFollowTarget(Math.min(pinnedTop, desiredScrollTop));
  }, [listTrailingSlackPx, setFollowTarget]);

  const onActiveAssistantLayout = useCallback(
    (event: LayoutChangeEvent) => {
      activeAssistantHeightRef.current = event.nativeEvent.layout.height;
      followActiveAssistantRow();
    },
    [followActiveAssistantRow],
  );

  const clearActiveAssistantLayout = useCallback(() => {
    activeAssistantHeightRef.current = 0;
    assistantLayoutBaselineRef.current = null;
    stopFollowLoop();
  }, [stopFollowLoop]);

  const scrollToBottom = useCallback(() => {
    pendingSendAnchorRef.current = null;
    followRearmBlockedRef.current = false;
    setFollowArmed(true);
    resetAssistantAutoScroll();
    requestAnimationFrame(() =>
      listRef.current?.scrollToEnd({ animated: true }),
    );
  }, [resetAssistantAutoScroll, setFollowArmed]);

  const getShouldPlaceLatestTurn = useCallback(() => {
    const { offsetY, layoutHeight } = metricsRef.current;
    const distanceFromBottomPx = Math.max(
      0,
      contentHeightRef.current - offsetY - layoutHeight,
    );
    return shouldPlaceLatestTurn({
      distanceFromBottomPx,
      isFollowingLatest: followArmedRef.current,
    });
  }, []);

  /**
   * Place the newest user row above the current trailing slack (chat tail +
   * reserved bottom inset). The same gentle loop owns
   * this motion and streaming follow, so the two movements blend if reply text
   * arrives before placement settles.
   */
  const placeLatestTurn = useCallback(() => {
    const pending = pendingSendAnchorRef.current;
    if (!pending) return;
    if (Date.now() > pending.staleAtMs) {
      pendingSendAnchorRef.current = null;
      return;
    }
    const metrics = metricsRef.current;
    const contentHeight = contentHeightRef.current;
    const maxOffset = Math.max(0, contentHeight - metrics.layoutHeight);
    const measurement = latestUserLayoutRef.current;
    const isInitialPlacement = pending.placedRowHeightPx === null;

    // If the optimistic row is no longer the list tail (for example, an
    // assistant placeholder landed immediately after it), settling forward
    // once is safer than using another row's height and framing the wrong
    // turn — and later row-height changes must not re-anchor either.
    if (trailingMessageIdRef.current !== pending.userMessageId) {
      pendingSendAnchorRef.current = null;
      if (isInitialPlacement) setFollowTarget(maxOffset, true);
      return;
    }

    // The row hasn't reported its layout yet — `onLatestUserLayout` schedules
    // placement again as soon as (and whenever) its height commits.
    if (measurement?.id !== pending.userMessageId) return;

    pending.placedRowHeightPx = measurement.height;
    const target = resolvePostSendPlacement({
      contentHeightPx: contentHeight,
      viewportHeightPx: metrics.layoutHeight,
      trailingSlackPx: listTrailingSlackRef.current,
      rowHeightPx: measurement.height,
      leadingInsetPx: listLeadingInsetRef.current,
    });

    // Gentle one-shot ease-out on the shared spring loop. If the reply starts
    // streaming mid-nudge, its (non-gentle) target update takes over the same
    // loop — the two motions blend instead of fighting separate animations.
    setFollowTarget(target, true);
  }, [setFollowTarget]);

  /** Coalesced two-frame delay so placement reads post-layout list metrics. */
  const schedulePlaceLatestTurn = useCallback(() => {
    if (placeLatestTurnRafRef.current) {
      cancelAnimationFrame(placeLatestTurnRafRef.current);
    }
    placeLatestTurnRafRef.current = requestAnimationFrame(() => {
      placeLatestTurnRafRef.current = requestAnimationFrame(() => {
        placeLatestTurnRafRef.current = 0;
        placeLatestTurn();
      });
    });
  }, [placeLatestTurn]);

  const onListContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const previousHeight = contentHeightRef.current;
      contentHeightRef.current = height;
      metricsRef.current.contentHeight = height;

      // Composer collapse and footer changes can settle after the user
      // row measures. Re-anchor from this committed geometry as well.
      const pending = pendingSendAnchorRef.current;
      if (
        pending &&
        pending.userMessageId === trailingMessageIdRef.current &&
        Date.now() <= pending.staleAtMs
      ) {
        schedulePlaceLatestTurn();
        return;
      }
      pendingSendAnchorRef.current = null;

      const baseline = assistantLayoutBaselineRef.current;
      if (baseline === null || height <= baseline) {
        if (activeAssistantHeightRef.current > 0) {
          followActiveAssistantRow();
        } else if (previousHeight > 0 && height > previousHeight) {
          // A settled append at the live tail (a reply that lands whole as the
          // turn ends, a synced message, a row finishing its layout): keep
          // the new end in view. Released follow ignores this.
          setFollowTarget(
            Math.max(0, height - metricsRef.current.layoutHeight),
          );
        }
        return;
      }

      assistantLayoutBaselineRef.current = null;
      if (activeAssistantHeightRef.current > 0) {
        followActiveAssistantRow();
      } else {
        setFollowTarget(Math.max(0, height - metricsRef.current.layoutHeight));
      }
    },
    [followActiveAssistantRow, schedulePlaceLatestTurn, setFollowTarget],
  );

  const onLatestUserLayout = useCallback(
    (messageId: string, event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      latestUserLayoutRef.current = { id: messageId, height };
      const pending = pendingSendAnchorRef.current;
      if (!pending || pending.userMessageId !== messageId) return;
      if (Date.now() > pending.staleAtMs) return;
      // First layout after a send, or a post-anchor height change (the
      // four-line clamp collapsing a long message) — (re)place against the
      // settled height so the committed target never outlives the geometry
      // it was computed from.
      if (
        pending.placedRowHeightPx === null ||
        Math.abs(pending.placedRowHeightPx - height) > 1
      ) {
        schedulePlaceLatestTurn();
      }
    },
    [schedulePlaceLatestTurn],
  );

  const nudgeAfterSend = useCallback(
    (userMessageId: string) => {
      pendingSendAnchorRef.current = {
        userMessageId,
        placedRowHeightPx: null,
        staleAtMs: Date.now() + POST_SEND_REANCHOR_WINDOW_MS,
      };
      followRearmBlockedRef.current = false;
      setFollowArmed(true);
      stopFollowLoop();
      // The row may already be mounted and measured (a keyboard-deferred
      // nudge runs well after the optimistic append), in which case no new
      // `onLayout` will arrive — so kick off the first placement from here.
      schedulePlaceLatestTurn();
    },
    [schedulePlaceLatestTurn, setFollowArmed, stopFollowLoop],
  );

  return {
    listRef,
    onScroll,
    onListContentSizeChange,
    onActiveAssistantLayout,
    clearActiveAssistantLayout,
    scrollToBottom,
    resetAssistantAutoScroll,
    prepareAssistantLayoutFollow,
    onLatestUserLayout,
    onScrollBeginDrag,
    onScrollSettle,
    getShouldPlaceLatestTurn,
    releaseFollow,
    nudgeAfterSend,
    awayFromBottom,
    isFollowingLatest,
  };
}
