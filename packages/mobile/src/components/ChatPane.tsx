import { BubbleMorphProvider, MorphingAssistantBubble } from "./BubbleMorph";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import { ReplyFocus, replyTitle } from "./ReplyFocus";
import { mobileReplyContexts } from "../lib/mobile-reply-context";
import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Keyboard,
  LayoutChangeEvent,
  LayoutAnimation,
  type ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  type TextLayoutEventData,
  TextInput,
  UIManager,
  useWindowDimensions,
  View,
} from "react-native";
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import MaskedView from "@react-native-masked-view/masked-view";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import {
  CHAT_ATTACHMENT_MAX_COUNT,
  driveFileNameFor,
  type ComposerAttachment,
  type PickedAttachment,
} from "../lib/chat-attachments";
import { useT } from "../i18n";
import Reanimated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./Icon";
import { GlassSurface, liquidGlassSupported } from "./glass";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { assistantBubbleNeedsBoundedWidth } from "../lib/assistant-bubble-layout";
import { AssistantTextSelection } from "./AssistantTextSelection";
import { AppBackdrop, TOP_BAR_BAR_HEIGHT } from "./AppBackdrop";
import { ArtifactCard } from "./ArtifactCard";
import { stellaFileChatArtifact } from "../lib/stella-file-links";
import { AgentWorkCard } from "./AgentWorkCard";
import { AgentCompletionCard } from "./AgentCompletionCard";
import { MapRouteCard } from "./MapRouteCard";
import { ToolActivityTrace } from "./ToolActivityTrace";
import { RunningTasksPill, runningTaskCount } from "./RunningTasksPill";
import { deriveToolActivity } from "../lib/tool-activity";
import { scheduleReceiptText } from "../lib/schedule-receipt-summary";
import {
  deriveFloatingHidden,
  type FloatingScrollMetrics,
} from "../lib/floating-button-visibility";
import { useCatchUpIndicatorVisible } from "../lib/catch-up-indicator";
import {
  isStandInArtifactRow,
  shouldAnimateMessageEntry,
  visibleChatMessages,
} from "../lib/message-row-identity";
import {
  inlineAgentWorkCardSections,
  consolidateRowArtifacts,
} from "../lib/agent-artifact-consolidation";
import { DictationRecordingBar } from "./DictationRecordingBar";
import { RealtimeVoiceOverlay } from "./RealtimeVoiceOverlay";
import {
  WorkingIndicator,
  WORKING_INDICATOR_SLOT_HEIGHT,
} from "./WorkingIndicator";
import type { WorkingIndicatorState } from "./working-indicator-state";
import { useDictation } from "../lib/dictation";
import { canSubmitFinalizedDictation } from "../lib/dictation-send";
import { hasAiConsent, requestAiConsent } from "../lib/ai-consent";
import type { RealtimeVoiceActionDispatch } from "../lib/realtime-voice-protocol";
import type { StoredPhoneAccess } from "../lib/phone-access";
import {
  bytesToDataUri,
  readDesktopArtifactFile,
  resolveArtifactBridge,
} from "../lib/desktop-artifact-data";
import { useChatSearch } from "../lib/chat-search";
import { resolveComposerExpanded } from "../lib/composer-model-layout";
import {
  consumeResponseSpacerHeight,
  resolvePostSendPlacement,
  resolveReplyOverflow,
  resolveResponseSpacerHeight,
  shouldPlaceLatestTurn,
} from "../lib/chat-response-spacer";
import { resolveChatDataChangeScrollOwner } from "../lib/chat-scroll-ownership";
import { notifySuccess, tapMedium, tapLight } from "../lib/haptics";
import {
  pauseReadAloud,
  resumeReadAloud,
  speakReply,
  stopReadAloud,
  startAfterStoppingReadAloud,
  useReadAloudPreference,
  useReadAloudState,
} from "../lib/read-aloud";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import {
  isUserMessageTruncatable,
  shouldRemeasureUserMessageWidth,
  userMessageNumberOfLines,
} from "../lib/user-message-clamp";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fadeHex } from "../theme/oklch";
import { fonts } from "../theme/fonts";
import type {
  ChatArtifact,
  ChatMessage,
  ComposerQuote,
  MobileTask,
} from "../types";

// Required for LayoutAnimation on Android.
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ---------------------------------------------------------------------------
// Constants — mapped from desktop full-shell.composer.css
// ---------------------------------------------------------------------------

/**
 * Content-height threshold for pill → expanded.
 * RN `onContentSizeChange` reports raw text height (no padding).
 * fontSize 16 × lineHeight ~22 ≈ 22 per line; trip on the second line so
 * wrapping immediately grows the composer instead of clipping behind the
 * send button.
 */
const EXPAND_THRESHOLD = 30;
/** LayoutAnimation config matching the same 350ms critically-damped spring. */
const LAYOUT_SPRING = {
  duration: 350,
  update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
  create: {
    type: LayoutAnimation.Types.spring,
    springDamping: 1,
    property: LayoutAnimation.Properties.opacity,
  },
  delete: {
    type: LayoutAnimation.Types.spring,
    springDamping: 1,
    property: LayoutAnimation.Properties.opacity,
  },
};

/**
 * Extra breathing room beyond the list's trailing slack (`EDGE_FADE` +
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
/**
 * Quiet window after the footer stops shrinking before we commit the smaller
 * height to the list inset. A collapse animation emits a burst of intermediate
 * `onLayout` heights; committing each one re-renders the list padding and
 * re-targets the scroll-follow math every frame. Slightly longer than a 350ms
 * spring's tail so we settle on the resting height, not a mid-animation one.
 */
const FOOTER_SHRINK_SETTLE_MS = 140;
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

const EDGE_FADE = 48;
const MESSAGE_LIST_GAP = 20;
/**
 * Fixed reading-area floor below the last message (desktop's
 * `.event-list-trailing-region` `min-height`). The inline working indicator
 * lives inside this footer region; reserving a constant height means the
 * indicator fading in/out never grows or shrinks the chat's content, so the
 * tail never jumps when a reply starts or finishes. Sized to fully contain the
 * indicator slot plus a few pt so it reads as a deliberate gap when idle.
 */
const CHAT_TAIL_GAP = WORKING_INDICATOR_SLOT_HEIGHT + 12;
/**
 * The working indicator used to live inside the footer overlay (above the
 * composer), so its reserved slot height was baked into the measured
 * `footerHeight` that the floating controls anchor their bottom offset against.
 * It now rides inline at the chat tail, which shrank `footerHeight` by that
 * slot height and dropped both floating buttons low enough for the composer to
 * overlap them. Re-add the slot height to the buttons' bottom anchor so they
 * sit exactly where they did before the indicator moved, without bringing back
 * the fixed indicator. `footerHeight` still includes the composer's safe-area
 * inset, so the buttons keep clearing the home indicator.
 */
const FLOATING_CONTROL_LIFT = WORKING_INDICATOR_SLOT_HEIGHT;
/**
 * Vertical gap between the activity-pill/settings row and the composer directly
 * below it. Halved from the previous `FLOATING_CONTROL_LIFT - 20` (14pt) so the
 * row sits noticeably closer to the composer. Scoped to that row only — the
 * scroll-to-bottom FAB keeps its own `- 24` offset.
 */
const FLOATING_CONTROL_ROW_LIFT = (FLOATING_CONTROL_LIFT - 20) / 2;
/** Cancels the shell `content` padding so chat owns its horizontal inset. */
const SHELL_CONTENT_PADDING = 20;
/** Horizontal inset from the true screen edge once shell padding is cancelled. */
const CHAT_HORIZONTAL_INSET = 12;

// ---------------------------------------------------------------------------
// Keyboard inset — keeps the composer and message list above the OS keyboard.
//
// The composer's *motion* is driven separately, on the UI thread, by
// reanimated's `useAnimatedKeyboard` (see `composerKeyboardStyle`), so it stays
// glued to the keyboard frame-for-frame in both directions. This hook only
// tracks the settled height as JS state, used to reserve the message list's
// bottom inset — that reserve doesn't need frame-perfect smoothness (content
// just scrolls under the composer), so no `LayoutAnimation` is needed here.
// ---------------------------------------------------------------------------

function useKeyboardInset() {
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const onShow = (e: { endCoordinates: { height: number } }) => {
      setHeight(e.endCoordinates.height);
    };
    const onHide = () => setHeight(0);

    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const open = height > 0;
  // The composer's bottom pad is keyboard-independent: it always reserves the
  // home-indicator safe area. When the keyboard is up the composer is lifted
  // clear of it by `composerKeyboardStyle` (by `keyboardHeight - insets.bottom`),
  // so that reserved band lands inside the keyboard region — a constant 6pt gap
  // sits above the keyboard either way, with no per-state padding swap to animate.
  const composerBottomPad = 6 + insets.bottom;

  return { height, open, composerBottomPad };
}

// ---------------------------------------------------------------------------
// Scroll — manual by default; smooth auto-follow while assistant streams in
// near the bottom.
// ---------------------------------------------------------------------------

function useChatScroll(
  listTrailingSlackPx: number,
  responseSpacerHeightPx: number,
  trailingMessageId: string | null,
  onConsumeResponseSpacer: (distanceDeltaPx: number) => void,
  onClearResponseSpacer: () => void,
) {
  const listRef = useRef<LegendListRef>(null);
  const listTrailingSlackRef = useRef(listTrailingSlackPx);
  listTrailingSlackRef.current = listTrailingSlackPx;
  const responseSpacerHeightRef = useRef(responseSpacerHeightPx);
  responseSpacerHeightRef.current = responseSpacerHeightPx;
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
  /** Holds through drag momentum so the spacer keeps consuming after release. */
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

      if (manualScrollActiveRef.current) {
        scheduleManualScrollSettle();
        if (offsetDelta < -0.5) {
          followRearmBlockedRef.current = true;
          onConsumeResponseSpacer(-offsetDelta);
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
      onConsumeResponseSpacer,
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
    stopFollowLoop();
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
    if (distFromBottom <= atBottomLimit && !followRearmBlockedRef.current) {
      setFollowArmed(true);
    }
  }, [atBottomLimit, scheduleManualScrollSettle, setFollowArmed]);

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
    const desiredScrollTop = resolveReplyOverflow({
      contentHeightPx: contentHeight,
      viewportHeightPx: layoutHeight,
      responseSpacerHeightPx: responseSpacerHeightRef.current,
    });
    const pinnedTop = Math.max(0, rowTop - FOLLOW_TOP_PEEK_PX);
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
    onClearResponseSpacer();
    resetAssistantAutoScroll();
    requestAnimationFrame(() =>
      listRef.current?.scrollToEnd({ animated: true }),
    );
  }, [onClearResponseSpacer, resetAssistantAutoScroll, setFollowArmed]);

  const getShouldPlaceLatestTurn = useCallback(() => {
    const { offsetY, layoutHeight } = metricsRef.current;
    const distanceFromBottomPx = Math.max(
      0,
      contentHeightRef.current - offsetY - layoutHeight,
    );
    return shouldPlaceLatestTurn({
      distanceFromBottomPx,
      responseSpacerHeightPx: responseSpacerHeightRef.current,
      isFollowingLatest: followArmedRef.current,
    });
  }, []);

  /**
   * Place the newest user row above the current trailing slack (response
   * spacer + reserved bottom inset). The same gentle loop owns
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
      contentHeightRef.current = height;
      metricsRef.current.contentHeight = height;

      // Composer collapse and footer/spacer changes can settle after the user
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
        followActiveAssistantRow();
        return;
      }

      assistantLayoutBaselineRef.current = null;
      if (activeAssistantHeightRef.current > 0) {
        followActiveAssistantRow();
      } else {
        setFollowTarget(resolveReplyOverflow({
          contentHeightPx: height,
          viewportHeightPx: metricsRef.current.layoutHeight,
          responseSpacerHeightPx: responseSpacerHeightRef.current,
        }));
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

// ---------------------------------------------------------------------------
// Animated message wrapper — mirrors desktop stream-fade-blur-in.
// ---------------------------------------------------------------------------

function FadeInMessage({
  children,
  onLayout,
  animate,
}: {
  children: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  animate: boolean;
}) {
  const opacity = useRef(new Animated.Value(animate ? 0 : 1)).current;
  const translateY = useRef(new Animated.Value(animate ? 5 : 0)).current;

  const animatedStyle = useMemo(
    () => ({ opacity, transform: [{ translateY }] }),
    [opacity, translateY],
  );

  useEffect(() => {
    if (!animate) return;
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 450,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        damping: 14,
        stiffness: 180,
        mass: 0.8,
        useNativeDriver: true,
      }),
    ]).start();
  }, [animate, opacity, translateY]);

  return (
    <Animated.View onLayout={onLayout} style={animatedStyle}>
      {children}
    </Animated.View>
  );
}

const copyMessageText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  void Clipboard.setStringAsync(trimmed).then((ok) => {
    if (ok) notifySuccess();
  });
};

const shareMessageText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  void Share.share({ message: trimmed }).catch(() => {});
};

/**
 * Renders `text` as a markdown blockquote (each line prefixed with "> "), the
 * quote convention understood by the composer's markdown. Used by the message
 * menu's "Quote" action to reply to a specific message.
 */
const quoteMessageText = (text: string): string =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/**
 * The context-menu timestamp header, e.g. "Aug 7, 12:56 PM". Mirrors ChatGPT's
 * long-press menu, which floats the message time above the action rows. Returns
 * null when the row has no local timestamp (in-flight/legacy rows) so the header
 * is simply omitted.
 */
const formatMessageTimestamp = (createdAt?: number): string | null => {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  try {
    return new Date(createdAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
};

type ChatStyles = ReturnType<typeof makeStyles>;

/**
 * The always-visible action row under a finished assistant message: copy, read
 * aloud (a pause/play toggle while a clip is loaded), and share. These mirror
 * the long-press menu so the common actions are one tap away instead of a hold.
 * The row reads the singleton playback state directly so only it re-renders as
 * playback starts/pauses/stops, not the whole transcript.
 */
const AssistantActions = memo(function AssistantActions({
  text,
  messageId,
  styles,
  colors,
}: {
  text: string;
  messageId: string;
  styles: ChatStyles;
  colors: Colors;
}) {
  const playback = useReadAloudState();
  const status = playback?.messageId === messageId ? playback.status : null;
  if (!text.trim()) return null;
  // Idle/loading show a speaker so the button reads as "read this aloud";
  // playing shows pause, and paused shows play to resume in place.
  const soundIcon =
    status === "playing" ? "pause" : status === "paused" ? "play" : "volume-2";
  const soundLabel =
    status === "playing"
      ? "Pause reading aloud"
      : status === "paused"
        ? "Resume reading aloud"
        : status === "loading"
          ? "Stop reading aloud"
          : "Read aloud";
  return (
    <View style={styles.messageActions}>
      <Pressable
        onPress={() => {
          tapLight();
          copyMessageText(text);
        }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Copy message"
        style={({ pressed }) => [
          styles.messageActionButton,
          pressed && styles.messageActionButtonPressed,
        ]}
      >
        <Icon name="copy" size={16} color={colors.textMuted} />
      </Pressable>
      <Pressable
        onPress={() => {
          tapLight();
          if (status === "playing") {
            pauseReadAloud();
          } else if (status === "paused") {
            resumeReadAloud();
          } else if (status === "loading") {
            stopReadAloud();
          } else {
            void speakReply(text, messageId);
          }
        }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={soundLabel}
        style={({ pressed }) => [
          styles.messageActionButton,
          pressed && styles.messageActionButtonPressed,
        ]}
      >
        <Icon
          name={soundIcon}
          size={16}
          color={status ? colors.text : colors.textMuted}
          effect={status === "loading" ? "pulse" : undefined}
        />
      </Pressable>
      <Pressable
        onPress={() => {
          tapLight();
          shareMessageText(text);
        }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Share message"
        style={({ pressed }) => [
          styles.messageActionButton,
          pressed && styles.messageActionButtonPressed,
        ]}
      >
        <Icon name="share" size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  );
});

/** Anchor passed to the message-actions popover (the long-press point). */
type MessageMenuRequest = { message: ChatMessage; anchor: AnchorRect };

/**
 * User message body with collapse/expand for long text — the mobile analogue
 * of desktop's `UserMessageBody`. Collapsed by default when the rendered text
 * exceeds `USER_MESSAGE_COLLAPSE_LINES`; a tappable "Show more" / "Show less"
 * toggle then reveals or re-hides the overflow.
 *
 * Overflow is detected from the native text-layout line boxes (not a
 * character count). The measuring pass renders at the collapse cap plus one
 * line — enough to distinguish "fits" from "overflows" without ever painting
 * a long message at full height (a full-height first paint used to inflate
 * the row after send and skew the post-send scroll anchor). Later width
 * changes remeasure so wrap at a new bubble width can grow or shrink the
 * toggle.
 */
function UserMessageText({
  text,
  styles,
}: {
  text: string;
  styles: ChatStyles;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const [totalLines, setTotalLines] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(true);
  const measuredWidthRef = useRef<number | null>(null);

  // Reset when the underlying message text changes (row reuse across items).
  useEffect(() => {
    setExpanded(false);
    setTotalLines(null);
    setMeasuring(true);
    measuredWidthRef.current = null;
  }, [text]);

  // Remeasure from the viewport width, not the text box itself. User bubbles
  // are width:fit-content, so clamping the first four lines can shrink the
  // box and would otherwise oscillate if we keyed off the text layout width.
  useEffect(() => {
    if (
      shouldRemeasureUserMessageWidth(measuredWidthRef.current, windowWidth)
    ) {
      measuredWidthRef.current = windowWidth;
      setMeasuring(true);
      return;
    }
    if (measuredWidthRef.current === null) {
      measuredWidthRef.current = windowWidth;
    }
  }, [windowWidth]);

  const handleTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const lines = event.nativeEvent.lines.length;
      if (measuring || totalLines === null) {
        setTotalLines(lines);
        setMeasuring(false);
      }
    },
    [measuring, totalLines],
  );

  const isTruncatable = isUserMessageTruncatable(totalLines);

  return (
    <>
      <Text
        style={styles.userText}
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        onTextLayout={handleTextLayout}
        numberOfLines={userMessageNumberOfLines({
          expanded,
          measuring,
          truncatable: isTruncatable,
        })}
      >
        {text}
      </Text>
      {isTruncatable ? (
        <Pressable
          onPress={() => setExpanded((prev) => !prev)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            expanded ? "Show less of this message" : "Show more of this message"
          }
        >
          {({ pressed }) => (
            <Text
              style={[styles.userToggle, pressed && styles.userTogglePressed]}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {expanded ? "Show less" : "Show more"}
            </Text>
          )}
        </Pressable>
      ) : null}
    </>
  );
}

const generatedImageAspectRatio = (value: string | undefined): number => {
  const match = value
    ?.trim()
    .match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return 4 / 3;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : 4 / 3;
};

const GeneratedImageTile = memo(function GeneratedImageTile({
  filePath,
  conversationId,
  access,
  aspectRatio,
  alt,
  generationState,
  colors,
}: {
  filePath?: string;
  conversationId: string;
  access?: StoredPhoneAccess;
  aspectRatio: number;
  alt: string;
  generationState?: "running" | "completed" | "failed" | "canceled";
  colors: Colors;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setUri(null);
    setFailed(false);
    if (!filePath) return () => undefined;
    if (/^(?:file|https?|data):/i.test(filePath)) {
      setUri(filePath);
      return () => undefined;
    }
    if (!access) {
      setFailed(true);
      return () => undefined;
    }
    void resolveArtifactBridge(access)
      .then((bridge) =>
        readDesktopArtifactFile(bridge, conversationId, filePath),
      )
      .then((result) => {
        if (cancelled) return;
        if (result.missing) {
          setFailed(true);
          return;
        }
        setUri(bytesToDataUri(result.bytes, result.mimeType));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [access, conversationId, filePath]);

  return (
    <View
      accessibilityLabel={failed ? "Generated image failed to load" : alt}
      accessibilityRole="image"
      style={[
        generatedImageStyles.tile,
        { aspectRatio, backgroundColor: colors.surface },
      ]}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={generatedImageStyles.image}
          contentFit="cover"
        />
      ) : (
        <View style={generatedImageStyles.placeholder}>
          {failed ||
          generationState === "failed" ||
          generationState === "canceled" ? (
            <Text style={{ color: colors.textMuted }}>
              {generationState === "canceled"
                ? "Image generation canceled"
                : generationState === "failed"
                  ? "Image generation failed"
                  : "Image unavailable"}
            </Text>
          ) : (
            <>
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text
                style={[
                  generatedImageStyles.placeholderText,
                  { color: colors.textMuted },
                ]}
              >
                Generating image...
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );
});

const GeneratedImageCard = memo(function GeneratedImageCard({
  artifact,
  access,
  colors,
  onPress,
}: {
  artifact: ChatArtifact;
  access?: StoredPhoneAccess;
  colors: Colors;
  onPress?: (artifact: ChatArtifact) => void;
}) {
  const payload = artifact.payload;
  if (payload.kind !== "media" || payload.asset.kind !== "image") return null;
  const paths =
    payload.asset.filePaths.length > 0 ? payload.asset.filePaths : [undefined];
  return (
    <Pressable
      accessibilityRole={
        payload.asset.filePaths.length > 0 ? "button" : undefined
      }
      accessibilityLabel={
        payload.generationState === "failed"
          ? "Image generation failed"
          : payload.asset.filePaths.length > 0
            ? "Open generated image"
            : "Generating image"
      }
      disabled={payload.asset.filePaths.length === 0}
      onPress={() => onPress?.(artifact)}
      style={generatedImageStyles.strip}
    >
      {paths.map((filePath, index) => (
        <GeneratedImageTile
          key={filePath ?? `${artifact.id}:${index}`}
          filePath={filePath}
          conversationId={artifact.conversationId}
          access={access}
          aspectRatio={generatedImageAspectRatio(payload.aspectRatio)}
          alt={payload.prompt ?? "Generated image"}
          generationState={payload.generationState}
          colors={colors}
        />
      ))}
    </Pressable>
  );
});

const generatedImageStyles = StyleSheet.create({
  image: { height: "100%", width: "100%" },
  placeholder: {
    alignItems: "center",
    flex: 1,
    gap: 8,
    justifyContent: "center",
  },
  placeholderText: { fontFamily: fonts.sans.regular, fontSize: 14 },
  strip: { gap: 8 },
  tile: { borderRadius: 14, maxWidth: 320, overflow: "hidden", width: "100%" },
});

const ChatMessageRow = memo(function ChatMessageRow({
  item,
  styles,
  colors,
  animate,
  menuActive,
  isSelecting,
  anySelecting,
  onOpenArtifact,
  onOpenStellaFile,
  onOpenMessageMenu,
  onEndSelecting,
  onOpenAgentActivity,
  contextRef,
  onOpenReply,
  desktopAccess,
}: {
  item: ChatMessage;
  styles: ChatStyles;
  colors: Colors;
  animate: boolean;
  /** True while this row's long-press menu is open — drives the focus lift. */
  menuActive: boolean;
  /** True while this row is in native text-selection mode. */
  isSelecting: boolean;
  /** True while ANY row is selecting — lets other rows tap-to-dismiss it. */
  anySelecting: boolean;
  onOpenArtifact?: (artifact: ChatArtifact) => void;
  /** Opens a tapped `stella://file/...` markdown link in the file viewer. */
  onOpenStellaFile?: (path: string) => void;
  onOpenMessageMenu: (request: MessageMenuRequest) => void;
  /** Leaves native text-selection mode for this row. */
  onEndSelecting: () => void;
  /** Opens the activity hub — the tap-through target for agent rows. */
  onOpenAgentActivity?: () => void;
  contextRef?: ReplyRef;
  onOpenReply?: (ref: ReplyRef) => void;
  desktopAccess?: StoredPhoneAccess | null;
}) {
  // The user bubble lifts (scales up + rises) while its long-press menu is open,
  // to mirror an iOS context menu. Driven by `menuActive`, which only reaches
  // this memoized row because the LegendList is given `extraData` keyed on the
  // active message — without that, the virtualized row never re-renders and the
  // spring stays inert (the bug where the bubble looked "exactly the same").
  // The scale/translate are deliberately generous so the lift reads under the
  // scrim. Spring settles back on dismiss.
  const lift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(lift, {
      toValue: menuActive ? 1 : 0,
      damping: 16,
      stiffness: 220,
      mass: 0.7,
      useNativeDriver: true,
    }).start();
  }, [menuActive, lift]);
  const liftStyle = useMemo(
    () => ({
      transform: [
        {
          scale: lift.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 1.06],
          }),
        },
        {
          translateY: lift.interpolate({
            inputRange: [0, 1],
            outputRange: [0, -6],
          }),
        },
      ],
    }),
    [lift],
  );
  const openMenu = (e: { nativeEvent: { pageX: number; pageY: number } }) => {
    // Open for a message with text OR attachments. The popover hides itself
    // when a message yields no applicable options.
    if (!item.text.trim() && (item.thumbnailUris?.length ?? 0) === 0) return;
    // Medium impact for the "lift" moment; action taps then fire a light tap.
    tapMedium();
    onOpenMessageMenu({
      message: item,
      anchor: {
        x: e.nativeEvent.pageX,
        y: e.nativeEvent.pageY,
        width: 0,
        height: 0,
      },
    });
  };

  // Keyed on the stable sub-objects: the trailing assistant row's `item` is
  // replaced whenever a message segment lands or a tool step updates, but its
  // artifacts/toolSteps keep their identity, so these derivations must not
  // re-run and mint fresh objects that defeat child memoization.
  const consolidated = useMemo(
    () => consolidateRowArtifacts(item.artifacts ?? [], item.tasks ?? []),
    [item.artifacts, item.tasks],
  );
  const toolActivity = useMemo(() => {
    const steps = item.toolSteps ?? [];
    return steps.length > 0 ? deriveToolActivity(steps) : undefined;
  }, [item.toolSteps]);
  // Schedule tool results render their human-readable summaries as plain
  // text lines in the flow (desktop parity — no chip/card). Every settled
  // Schedule call in the turn gets its line, in call order; unparseable or
  // side-channel-JSON results render nothing. Keyed by step id for the map.
  const scheduleReceipts = useMemo(() => {
    const receipts: { id: string; text: string }[] = [];
    for (const step of item.toolSteps ?? []) {
      if (step.toolName.toLowerCase() !== "schedule") continue;
      if (step.status === "error") continue;
      const text = scheduleReceiptText({ resultPreview: step.resultPreview });
      if (text) receipts.push({ id: step.id, text });
    }
    return receipts;
  }, [item.toolSteps]);
  const hasText = item.text.trim().length > 0;
  const boundedAssistantBubble = useMemo(
    () => item.role === "assistant" && assistantBubbleNeedsBoundedWidth(item.text),
    [item.role, item.text],
  );
  // The reply row is appended empty when the turn dispatches and gains its text
  // when the message lands, so "mounted empty" is exactly "this message arrived
  // while the user was watching" — the cue for the landing entrance. Rows
  // restored from history mount with their text and render settled.
  const mountedEmptyRef = useRef(!hasText);

  if (item.role === "user") {
    const thumbs = item.thumbnailUris ?? [];
    const showThumbs = thumbs.length > 0;
    const documentNames = item.documentNames ?? [];
    const showText = item.text.trim().length > 0;
    const quotedText = item.quotedText?.trim();
    return (
      <View style={styles.userRow}>
        <View style={styles.userColumn}>
          {quotedText ? (
            // Quoted / "Ask Stella" context rides to the model as a separate
            // field and shows here as a chip — never folded into the bubble
            // body — so internal framing/decoration can't leak into the text.
            <View style={[styles.quoteChip, styles.userQuoteChip]}>
              <Icon
                name="quote"
                size={13}
                color={colors.textMuted}
                style={styles.quoteChipIcon}
              />
              <Text
                style={styles.quoteChipText}
                numberOfLines={1}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {quotedText}
              </Text>
            </View>
          ) : null}
          {isSelecting && showText ? (
            // "Select text" mode: the bubble body becomes a native selection
            // surface (with a Copy pill), so a substring can be lifted out.
            <View style={styles.userBubble}>
              <AssistantTextSelection
                text={item.text}
                colors={{ ...colors, text: colors.userBubbleText }}
                onDismiss={onEndSelecting}
              />
            </View>
          ) : (
            <Animated.View style={liftStyle}>
              <Pressable
                onLongPress={openMenu}
                // While another message is selecting, a tap here exits selection
                // (and otherwise does nothing), so tapping away always dismisses.
                onPress={anySelecting ? onEndSelecting : undefined}
                delayLongPress={350}
                accessibilityLabel="Long press for message actions"
                style={[
                  styles.userBubble,
                  item.queued && styles.userBubbleQueued,
                ]}
              >
                {showThumbs ? (
                  <View
                    style={[
                      styles.userThumbStrip,
                      showText && styles.userThumbsAbove,
                    ]}
                  >
                    {thumbs.slice(0, 3).map((uri) => (
                      <Image
                        key={uri}
                        source={{ uri }}
                        style={styles.userThumbImage}
                        contentFit="cover"
                      />
                    ))}
                  </View>
                ) : null}
                {documentNames.length > 0 ? (
                  <View
                    style={[
                      styles.userDocumentStrip,
                      showText && styles.userThumbsAbove,
                    ]}
                  >
                    {documentNames.map((name) => (
                      <View key={name} style={styles.userDocumentChip}>
                        <Icon
                          name="file-text"
                          size={12}
                          color={colors.textMuted}
                        />
                        <Text
                          style={styles.userDocumentName}
                          numberOfLines={1}
                          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                        >
                          {name}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {showText ? (
                  <UserMessageText text={item.text} styles={styles} />
                ) : null}
              </Pressable>
            </Animated.View>
          )}
          {item.queued || item.stopped ? (
            <Text
              style={item.queued ? styles.queuedTag : styles.stoppedTag}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {item.queued ? "Queued" : "Stopped"}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }
  // Desktop-parity consolidation: agent lifecycle cards are expanded per
  // agent, noise writes are filtered and declared deliverables lead. The
  // minimal agent rows no longer surface file pills — agent-produced files
  // stay reachable through the activity hub — so `agentFiles` is unused here.
  const {
    agentWork: agentWorkArtifacts,
    maps: mapArtifacts,
    looseFiles,
  } = consolidated;
  const isStandIn = isStandInArtifactRow(item);
  // Assistant text no longer streams, so there is no partial-render window to
  // protect: every card mounts as soon as its artifact reaches the row.
  const showAgentWork = !isStandIn && agentWorkArtifacts.length > 0;
  const showMapArtifacts = !isStandIn && mapArtifacts.length > 0;
  const showFileArtifacts =
    !isStandIn && Boolean(onOpenArtifact) && looseFiles.length > 0;
  const generatedImages = looseFiles.filter(
    (artifact) =>
      artifact.payload.kind === "media" &&
      artifact.payload.asset.kind === "image",
  );
  const genericLooseFiles = looseFiles.filter(
    (artifact) => !generatedImages.includes(artifact),
  );
  const showGeneratedImages = !isStandIn && generatedImages.length > 0;
  const showArtifacts =
    showAgentWork ||
    showMapArtifacts ||
    showFileArtifacts ||
    showGeneratedImages;
  // Desktop renders the complete markdown body once, then attaches activity
  // and artifact cards at the row boundary. Keep the same shape on mobile:
  // bridge text offsets still describe event chronology, but must never become
  // character-level insertion points that split prose (or markdown) in two.
  const groupAgentWorkArtifacts = agentWorkArtifacts;
  const renderAssistantMarkdown = (text: string) => {
    const markdown = (
      <AssistantMarkdown
        text={text}
        colors={colors}
        selectable
        fill={boundedAssistantBubble}
        onStellaFileLink={onOpenStellaFile}
      />
    );
    // Keep the rendered text itself as the selection surface. A wrapper only
    // exists while a user-message selection is active so tapping away retains
    // that existing dismiss behavior without competing with markdown gestures.
    return anySelecting ? (
      <Pressable onPress={onEndSelecting}>{markdown}</Pressable>
    ) : (
      markdown
    );
  };
  return (
    <View style={styles.assistantRow}>
      {contextRef && onOpenReply && <Pressable accessibilityRole="button" accessibilityLabel={`Open ${replyTitle(contextRef)} conversation`} onPress={() => onOpenReply(contextRef)} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4, alignSelf: "flex-start", maxWidth: "100%" }}>
        <Text numberOfLines={1} style={{ color: colors.textMuted, fontSize: 12, flexShrink: 1 }}>{replyTitle(contextRef)}</Text>
        <Icon name="chevron-right" size={12} color={colors.textMuted} />
      </Pressable>}
      {hasText ? (
        <MorphingAssistantBubble
          style={[styles.assistantBubble, boundedAssistantBubble && styles.assistantBlockBubble]}
          animate={animate || mountedEmptyRef.current}
        >
          {renderAssistantMarkdown(item.text)}
        </MorphingAssistantBubble>
      ) : null}
      {toolActivity ? (
        <ToolActivityTrace group={toolActivity} colors={colors} />
      ) : null}
      {scheduleReceipts.map((receipt) => (
        <Text
          key={receipt.id}
          style={styles.scheduleReceipt}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {receipt.text}
        </Text>
      ))}
      {showArtifacts ? (
        <View
          style={[styles.artifactGroup, hasText && styles.artifactGroupSpaced]}
        >
          {groupAgentWorkArtifacts.map((artifact) => {
            // Desktop parity: the settled completion presentation REPLACES
            // the spawn row in its slot — per-agent check rows when the
            // bridge shipped sections, otherwise the settled spawn row
            // itself. A settled follow-up keeps the spawn row so its arrow
            // tell survives. Rows carry the description only; produced files
            // and result excerpts live in the activity hub.
            const completionSections =
              artifact.payload.state === "done" &&
              artifact.payload.followUp !== true
                ? (inlineAgentWorkCardSections(artifact) ?? [])
                : [];
            return completionSections.length > 0 ? (
              <AgentCompletionCard
                key={`${artifact.id}:completion`}
                sections={completionSections}
                colors={colors}
                onOpenAgent={onOpenReply ? (threadId, title) => onOpenReply({ kind: "agent", threadId, title }) : undefined}
                {...((onOpenReply && artifact.payload.agentIds?.[0])
                  ? { onPress: () => onOpenReply({ kind: "agent", threadId: artifact.payload.agentIds![0]!, title: artifact.payload.title }) }
                  : onOpenAgentActivity ? { onPress: onOpenAgentActivity } : {})}
                {...(onOpenArtifact ? { onOpenArtifact } : {})}
              />
            ) : (
              <AgentWorkCard
                key={artifact.id}
                payload={artifact.payload}
                colors={colors}
                {...((onOpenReply && artifact.payload.agentIds?.[0])
                  ? { onPress: () => onOpenReply({ kind: "agent", threadId: artifact.payload.agentIds![0]!, title: artifact.payload.title }) }
                  : onOpenAgentActivity ? { onPress: onOpenAgentActivity } : {})}
              />
            );
          })}
          {showMapArtifacts
            ? mapArtifacts.map((artifact) => (
                <MapRouteCard
                  key={artifact.id}
                  payload={artifact.payload}
                  colors={colors}
                />
              ))
            : null}
          {showGeneratedImages
            ? generatedImages.map((artifact) => {
                return (
                  <GeneratedImageCard
                    key={artifact.id}
                    artifact={artifact}
                    access={desktopAccess ?? undefined}
                    colors={colors}
                    onPress={onOpenArtifact}
                  />
                );
              })
            : null}
          {showFileArtifacts && onOpenArtifact
            ? genericLooseFiles.map((artifact) => (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  colors={colors}
                  onPress={onOpenArtifact}
                />
              ))
            : null}
        </View>
      ) : null}
      {item.stopped ? (
        <Text
          style={styles.stoppedTag}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          Stopped
        </Text>
      ) : null}
      {item.cloudFallback ? (
        <Text
          style={styles.cloudTag}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          Answered while your computer was offline
        </Text>
      ) : null}
      <AssistantActions
        text={item.text}
        messageId={item.id}
        styles={styles}
        colors={colors}
      />
    </View>
  );
});

/**
 * Submit button that springs between enabled/disabled states like the
 * desktop `motion.button` in `ComposerPrimitives.tsx`:
 *   animate={{ opacity: canSubmit ? 1 : 0.4, scale: canSubmit ? 1 : 0.92 }}
 *   transition={{ type: "spring", duration: 0.2, bounce: 0 }}
 */
function AnimatedSubmitButton({
  canSubmit,
  onPress,
  styles,
  colors,
  accessibilityLabel,
}: {
  canSubmit: boolean;
  onPress: () => void;
  styles: ChatStyles;
  colors: Colors;
  accessibilityLabel: string;
}) {
  const opacity = useRef(new Animated.Value(canSubmit ? 1 : 0.4)).current;
  const scale = useRef(new Animated.Value(canSubmit ? 1 : 0.92)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(opacity, {
        toValue: canSubmit ? 1 : 0.4,
        damping: 18,
        stiffness: 260,
        mass: 0.6,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: canSubmit ? 1 : 0.92,
        damping: 18,
        stiffness: 260,
        mass: 0.6,
        useNativeDriver: true,
      }),
    ]).start();
  }, [canSubmit, opacity, scale]);

  const animatedStyle = useMemo(
    () => ({ opacity, transform: [{ scale }] }),
    [opacity, scale],
  );

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        onPress={onPress}
        disabled={!canSubmit}
        accessibilityLabel={accessibilityLabel}
        style={styles.submitButton}
        hitSlop={4}
      >
        <Icon
          name="arrow-up"
          size={15}
          color={colors.accentForeground}
          weight="heavy"
        />
      </Pressable>
    </Animated.View>
  );
}

/**
 * Square stop affordance shown in place of the submit button while a reply is
 * streaming (chat) or pending (computer chat). Calling `onPress` cancels the
 * in-flight reply and cancels any queued messages. Canceled user bubbles stay
 * visible in the transcript with a Stopped label; resuming requires re-sending.
 */
function StopButton({
  onPress,
  styles,
  colors,
}: {
  onPress: () => void;
  styles: ChatStyles;
  colors: Colors;
}) {
  return (
    <Pressable
      onPress={() => {
        tapLight();
        onPress();
      }}
      accessibilityLabel="Stop reply"
      style={styles.submitButton}
      hitSlop={4}
    >
      <Icon
        name="stop"
        size={13}
        color={colors.accentForeground}
        weight="heavy"
        filled
      />
    </Pressable>
  );
}

/**
 * Transient "Catching up" pill — top-center overlay while a catch-up sync
 * (landing / foreground return / Force Sync) is pulling turns the phone may
 * have missed. Non-interactive and absolutely positioned so it never shifts
 * the transcript; appearance/disappearance mirror the floating glass controls'
 * materialize/dissolve language.
 */
function CatchUpPill({
  visible,
  styles,
  colors,
}: {
  visible: boolean;
  styles: ChatStyles;
  colors: Colors;
}) {
  // Stays mounted so the glass can run its native materialize/dissolve
  // transition; the JS anim fades the content along with it.
  const anim = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [anim, visible]);

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden={!visible}
      style={[
        styles.catchUpPill,
        {
          // Opacity on a Liquid Glass ancestor makes iOS drop the glass
          // material, so only fade the wrapper on the (non-glass) fallback.
          opacity: liquidGlassSupported ? 1 : anim,
          transform: [
            {
              translateY: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [-8, 0],
              }),
            },
          ],
        },
      ]}
    >
      <GlassSurface
        glass="regular"
        legible
        present={visible}
        radius={15}
        fallbackColor={colors.surface}
        style={styles.catchUpPillGlass}
      >
        {/* Border + content are children of the glass, so fading them is safe. */}
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.catchUpPillRing,
            { opacity: anim },
          ]}
        />
        <Animated.View style={[styles.catchUpPillRow, { opacity: anim }]}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text
            style={styles.catchUpPillText}
            accessibilityLabel="Catching up with your computer"
          >
            Catching up
          </Text>
        </Animated.View>
      </GlassSurface>
    </Animated.View>
  );
}

function ScrollToBottomFab({
  visible,
  hasUnread,
  onPress,
  styles,
  colors,
  bottomOffset,
}: {
  visible: boolean;
  hasUnread: boolean;
  onPress: () => void;
  styles: ChatStyles;
  colors: Colors;
  /** Distance in pt from the bottom of the viewport — sit just above the composer. */
  bottomOffset?: number;
}) {
  // Stays mounted across visibility changes so the glass can run its native
  // materialize/dissolve transition; the JS anim fades the icon along with it.
  const anim = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [anim, visible]);

  return (
    <Animated.View
      pointerEvents={visible ? "box-none" : "none"}
      style={[
        styles.scrollToBottomFab,
        bottomOffset !== undefined && { bottom: bottomOffset },
        {
          // Opacity on a Liquid Glass ancestor makes iOS drop the glass
          // material, so only fade the wrapper on the (non-glass) fallback. On
          // glass the material fades via `present` and the icon fades below.
          opacity: liquidGlassSupported ? 1 : anim,
          transform: [
            {
              translateY: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [8, 0],
              }),
            },
          ],
        },
      ]}
    >
      <Pressable
        accessibilityLabel={
          hasUnread
            ? "Scroll to latest messages, new replies below"
            : "Scroll to latest messages"
        }
        accessibilityRole="button"
        hitSlop={6}
        onPress={onPress}
        style={({ pressed }) => [
          styles.scrollToBottomFabInner,
          pressed && styles.scrollToBottomFabPressed,
        ]}
      >
        <GlassSurface
          glass="clear"
          interactive
          present={visible}
          radius={16}
          fallbackColor={colors.surface}
          style={styles.scrollToBottomFabGlass}
        >
          {/* Border + icon are children of the glass, so fading them is safe —
              keeps the outline from lingering after the material dissolves. */}
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              styles.scrollToBottomFabRing,
              { opacity: anim },
            ]}
          />
          <Animated.View style={{ opacity: anim }}>
            <Icon
              name="chevron-down"
              size={16}
              color={colors.accent}
              weight="semibold"
            />
          </Animated.View>
        </GlassSurface>
        {hasUnread ? (
          <Animated.View
            style={[styles.scrollToBottomDot, { opacity: anim }]}
          />
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// "+" menu — single source of truth for composer attach actions across both
// the chat and the computer chat. The chat has both Attach + View computer;
// the computer chat skips Attach since it doesn't accept image input.
//
// The menu renders as a small popover anchored just above the `+` button
// (drop-up, since the composer is at the bottom of the screen) rather than
// a center-screen action sheet. This mirrors the desktop's `+` menu
// behavior and feels more native for an inline composer affordance.
// ---------------------------------------------------------------------------

type PlusMenuOption = {
  id: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
  disabled?: boolean;
  selected?: boolean;
  trailingLabel?: string;
  /** When set, tapping opens this list instead of calling `onSelect`. */
  submenu?: PlusMenuOption[];
  /** Header shown above a submenu (defaults to the parent row label). */
  submenuTitle?: string;
};

type PlusMenuLevel = {
  title: string;
  options: PlusMenuOption[];
};

type AnchorRect = { x: number; y: number; width: number; height: number };

const PLUS_MENU_GAP = 10;
const PLUS_MENU_MIN_WIDTH = 200;
// Roomier minimum for the focused message context menu (the `large` variant).
const PLUS_MENU_LARGE_MIN_WIDTH = 268;
const PLUS_MENU_EDGE_PADDING = 12;

function PlusMenuPopover({
  visible,
  anchor,
  options,
  onDismiss,
  colors,
  containerRef,
  headerLabel = null,
  scrim = false,
  large = false,
  wrapLabels = false,
  minWidth,
}: {
  visible: boolean;
  anchor: AnchorRect | null;
  options: PlusMenuOption[];
  onDismiss: () => void;
  colors: Colors;
  /**
   * The chat root the menu overlays. Anchors are captured in window space; we
   * render *in-tree* (not in a `Modal`) so Liquid Glass can actually sample the
   * chat behind the menu — a `Modal` is a separate window with nothing to
   * refract, which leaves the glass clear and its materialize animation inert.
   * We translate window anchors into this container's local space.
   */
  containerRef: React.RefObject<View | null>;
  /**
   * Non-interactive header shown above the options (the message menu passes the
   * message timestamp, e.g. "Aug 7, 12:56 PM"). Omitted when null.
   */
  headerLabel?: string | null;
  /**
   * Focused context-menu treatment (message menu): a LIGHT non-glass scrim
   * behind the card plus a frostier tint on the card's Liquid Glass, so the
   * menu itself is the authentic frosted-glass surface. The backdrop stays a
   * plain scrim (never a `GlassView`): a second glass layer beneath the in-tree
   * menu triggers Apple's glass-on-glass suppression and renders the menu clear,
   * so the frost must come from the single glass card, not the backdrop.
   */
  scrim?: boolean;
  /**
   * Roomier rows/typography/width for the focused message context menu, to match
   * the reference (a small dense popover like the +/model menus reads too
   * cramped as a primary context menu).
   */
  large?: boolean;
  /** Allow long model names to remain readable. */
  wrapLabels?: boolean;
  minWidth?: number;
}) {
  const styles = useMemo(() => makePlusMenuStyles(colors), [colors]);
  const [menuLayout, setMenuLayout] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [submenuStack, setSubmenuStack] = useState<PlusMenuLevel[]>([]);
  // Snappy entrance: the menu springs up from the anchor once it has been
  // measured, instead of the slow flat fade of the RN Modal.
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      setMenuLayout(null);
      setSubmenuStack([]);
      anim.setValue(0);
      return;
    }
    // Snapshot the container's window offset so window-space anchors land in
    // the right spot once we re-base them into local coordinates.
    containerRef.current?.measureInWindow((x, y) => setOrigin({ x, y }));
  }, [visible, anim, containerRef]);

  useEffect(() => {
    if (visible && menuLayout) {
      Animated.spring(anim, {
        toValue: 1,
        damping: 24,
        stiffness: 520,
        mass: 0.5,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, menuLayout, anim]);

  const activeLevel = submenuStack[submenuStack.length - 1];
  const visibleOptions = activeLevel?.options ?? options;
  const submenuTitle = activeLevel?.title ?? null;

  const handleRequestClose = useCallback(() => {
    if (submenuStack.length > 0) {
      setSubmenuStack((prev) => prev.slice(0, -1));
      setMenuLayout(null);
      return;
    }
    onDismiss();
  }, [onDismiss, submenuStack.length]);

  const goBack = useCallback(() => {
    setSubmenuStack((prev) => prev.slice(0, -1));
    setMenuLayout(null);
  }, []);

  const onSelectOption = useCallback(
    (option: PlusMenuOption) => {
      const submenu = option.submenu;
      if (submenu && submenu.length > 0) {
        setSubmenuStack((prev) => [
          ...prev,
          {
            title: option.submenuTitle ?? option.label,
            options: submenu,
          },
        ]);
        setMenuLayout(null);
        return;
      }
      setSubmenuStack([]);
      onDismiss();
      option.onSelect();
    },
    [onDismiss],
  );

  if (!visible || !anchor) {
    return null;
  }

  const screen = Dimensions.get("window");
  const measured = menuLayout;
  const menuMinWidth = minWidth ?? (large ? PLUS_MENU_LARGE_MIN_WIDTH : PLUS_MENU_MIN_WIDTH);
  // Cap the options list so a tall menu scrolls instead of overflowing the
  // screen; short menus (the common case) still size to their content.
  const menuMaxOptionsHeight = Math.round(screen.height * 0.55);
  const desiredWidth = Math.max(menuMinWidth, measured?.width ?? 0);
  // Left-align with the anchor, clamped inside the screen so the bubble
  // never spills past the edge of the device. Computed in window space, then
  // re-based into the container's local space (we render in-tree, not modal).
  const windowLeft = Math.min(
    Math.max(PLUS_MENU_EDGE_PADDING, anchor.x),
    screen.width - desiredWidth - PLUS_MENU_EDGE_PADDING,
  );
  const left = windowLeft - origin.x;
  // Drop-up by default; fall back to drop-down if the menu wouldn't fit
  // above the anchor.
  const menuHeight = measured?.height ?? 0;
  const dropUpTop = anchor.y - menuHeight - PLUS_MENU_GAP;
  const isDropDown = Boolean(measured) && dropUpTop < PLUS_MENU_EDGE_PADDING;
  const windowTop = isDropDown
    ? anchor.y + anchor.height + PLUS_MENU_GAP
    : dropUpTop;
  const top = windowTop - origin.y;
  // Emerge from the anchor: a drop-up menu rises into place, a drop-down
  // menu settles down into place.
  const enterTranslateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [isDropDown ? -8 : 8, 0],
  });
  const enterScale = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.96, 1],
  });

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {scrim ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.scrim, { opacity: anim }]}
        />
      ) : null}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={handleRequestClose}
        accessibilityLabel="Dismiss menu"
      />
      <Animated.View
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setMenuLayout({ width, height });
        }}
        style={[
          styles.menu,
          {
            left,
            minWidth: menuMinWidth,
            top: measured ? top : anchor.y - PLUS_MENU_GAP - origin.y,
            transform: [{ translateY: enterTranslateY }, { scale: enterScale }],
          },
        ]}
      >
        <GlassSurface
          glass="regular"
          // The menu card is the ONE Liquid Glass surface (expo-glass-effect
          // GlassView / UIGlassEffect on iOS 26). The focused message menu
          // (`scrim` variant) leans into a frostier, more refractive tint so it
          // reads as genuine Liquid Glass — its backdrop scrim keeps labels
          // legible, so it needn't carry `legible`'s heavier opaque surface tint
          // the way the inline +/model menus (over undimmed live chat) do.
          {...(scrim
            ? { tintColor: fadeHex(colors.surface, 0.66) }
            : { legible: true })}
          present={Boolean(measured)}
          radius={large ? 18 : 14}
          ringed
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        />
        {/* Fade the menu *contents* — never the glass or its parent. Animating
              opacity on a GlassView ancestor makes iOS drop the Liquid Glass
              material entirely (renders clear). The glass itself fades via its
              own `present`-driven materialize animation; the spring lives on the
              transform above. */}
        <Animated.View style={{ opacity: measured ? anim : 0 }}>
          {headerLabel && !submenuTitle ? (
            <View
              style={[
                styles.menuItem,
                large && styles.menuItemLarge,
                styles.menuHeader,
              ]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text
                style={[
                  styles.menuHeaderLabel,
                  large && styles.menuHeaderLabelLarge,
                ]}
                numberOfLines={1}
              >
                {headerLabel}
              </Text>
            </View>
          ) : null}
          {submenuTitle ? (
            <Pressable
              accessibilityLabel="Back to menu"
              onPress={goBack}
              style={({ pressed }) => [
                styles.menuItem,
                styles.menuItemFirst,
                styles.submenuHeader,
                pressed && styles.menuItemPressed,
              ]}
            >
              <Icon
                name="chevron-left"
                size={16}
                color={colors.textMuted}
                style={styles.menuItemIcon}
              />
              <Text style={styles.submenuHeaderLabel} numberOfLines={1}>
                {submenuTitle}
              </Text>
            </Pressable>
          ) : null}
          <ScrollView
            style={{ maxHeight: menuMaxOptionsHeight }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {visibleOptions.map((option, index) => {
              const isFirst = !submenuTitle && index === 0;
              const isLast = index === visibleOptions.length - 1;
              const hasSubmenu = Boolean(option.submenu?.length);
              return (
                <Pressable
                  key={option.id}
                  accessibilityLabel={option.label}
                  disabled={option.disabled}
                  onPress={() => onSelectOption(option)}
                  style={({ pressed }) => [
                    styles.menuItem,
                    large && styles.menuItemLarge,
                    isFirst && styles.menuItemFirst,
                    isLast && styles.menuItemLast,
                    pressed && styles.menuItemPressed,
                    option.disabled && styles.menuItemDisabled,
                  ]}
                >
                  <Icon
                    name={option.icon}
                    size={large ? 20 : 16}
                    color={option.disabled ? colors.textMuted : colors.text}
                    style={
                      large ? styles.menuItemIconLarge : styles.menuItemIcon
                    }
                  />
                  <Text
                    style={[
                      styles.menuItemLabel,
                      large && styles.menuItemLabelLarge,
                      option.disabled && styles.menuItemLabelMuted,
                    ]}
                    numberOfLines={wrapLabels ? 2 : 1}
                  >
                    {option.label}
                  </Text>
                  {option.trailingLabel ? (
                    <Text style={styles.menuItemTrailing} numberOfLines={1}>
                      {option.trailingLabel}
                    </Text>
                  ) : hasSubmenu ? (
                    <Icon
                      name="chevron-right"
                      size={15}
                      color={colors.textMuted}
                      style={styles.menuItemCheck}
                    />
                  ) : option.selected ? (
                    <Icon
                      name="check"
                      size={15}
                      color={colors.accent}
                      style={styles.menuItemCheck}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const makePlusMenuStyles = (colors: Colors) =>
  StyleSheet.create({
    overlay: {
      // In-tree overlay covering the chat root (no Modal), so Liquid Glass can
      // sample the content behind the menu. `box-none` lets taps fall through
      // to the backdrop / menu children only.
      ...StyleSheet.absoluteFill,
      zIndex: 50,
    },
    scrim: {
      // Non-glass backdrop behind the focused message menu: a LIGHT plain dark
      // scrim (the app's sheet/modal convention — see TopSheet), kept subtle so
      // the menu's Liquid Glass refracts near-live chat and reads as authentic
      // frost instead of a muddied dark panel. It must NOT be a GlassView — a
      // second glass layer beneath the menu triggers Apple's glass-on-glass
      // suppression and renders the menu clear — so the frost comes entirely
      // from the single glass surface (the menu card), never from the backdrop.
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0, 0, 0, 0.2)",
    },
    menuHeader: {
      borderBottomColor: fadeHex(colors.border, 0.55),
      borderBottomWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      marginBottom: 4,
      paddingBottom: 10,
      paddingVertical: 8,
    },
    menuHeaderLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
      textAlign: "center",
    },
    menuHeaderLabelLarge: { fontSize: 13, paddingVertical: 2 },
    // `large` variant — roomier rows/typography for the focused message menu.
    menuItemLarge: {
      gap: 14,
      paddingHorizontal: 18,
      paddingVertical: 15,
    },
    menuItemIconLarge: { width: 24 },
    menuItemLabelLarge: { fontSize: 17, letterSpacing: -0.3 },
    menu: {
      borderRadius: 14,
      paddingVertical: 6,
      position: "absolute",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 6,
      elevation: 2,
    },
    menuItem: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    menuItemFirst: {},
    menuItemLast: {},
    menuItemPressed: { backgroundColor: fadeHex(colors.text, 0.06) },
    menuItemDisabled: { opacity: 0.55 },
    menuItemIcon: { width: 20 },
    menuItemLabel: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    menuItemLabelMuted: { color: colors.textMuted },
    menuItemTrailing: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.15,
      marginLeft: 12,
      maxWidth: 136,
    },
    menuItemCheck: { marginLeft: 12 },
    submenuHeader: {
      borderBottomColor: fadeHex(colors.border, 0.55),
      borderBottomWidth: StyleSheet.hairlineWidth,
      marginBottom: 4,
      paddingBottom: 10,
    },
    submenuHeaderLabel: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.15,
    },
  });

// Case- and accent-insensitive fold for matching: decompose, drop combining
// diacritics (the U+0300–U+036F block covers Latin accents), and lowercase. So
// "Café" and "cafe" match. Uses the combining-marks range rather than the
// `\p{Diacritic}` property escape for broad RN engine compatibility.
const foldText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

// Split a raw query into folded terms for multi-word (AND) matching.
const foldQueryTerms = (query: string): string[] =>
  foldText(query).split(/\s+/).filter(Boolean);

// Fold a string while tracking, for each folded character, the original index
// it came from. Lets the snippet highlight map a match found in folded space
// back onto the original (accented/cased) text. `map[k]` is the original UTF-16
// index of folded char `k`; the trailing entry maps to the string end.
function foldWithMap(text: string): { folded: string; map: number[] } {
  const folded: string[] = [];
  const map: number[] = [];
  let originalIndex = 0;
  for (const char of text) {
    const dec = char
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    for (const f of dec) {
      folded.push(f);
      map.push(originalIndex);
    }
    originalIndex += char.length;
  }
  map.push(text.length);
  return { folded: folded.join(""), map };
}

// A short preview of a matched message, windowed around the earliest matching
// term so the hit is visible (and can be emphasised) in the row — accent- and
// case-insensitively, mapping the folded match back onto the original text.
function buildSearchSnippet(
  text: string,
  query: string,
): { before: string; match: string; after: string } {
  const terms = foldQueryTerms(query);
  const { folded, map } = foldWithMap(text);
  let foldIdx = -1;
  let termLen = 0;
  for (const term of terms) {
    const at = folded.indexOf(term);
    if (at >= 0 && (foldIdx < 0 || at < foldIdx)) {
      foldIdx = at;
      termLen = term.length;
    }
  }
  if (foldIdx < 0) {
    return {
      before: text.slice(0, 120),
      match: "",
      after: text.length > 120 ? "…" : "",
    };
  }
  const matchStart = map[foldIdx] ?? 0;
  const matchEnd = map[foldIdx + termLen] ?? text.length;
  const start = Math.max(0, matchStart - 28);
  const before = (start > 0 ? "…" : "") + text.slice(start, matchStart);
  const match = text.slice(matchStart, matchEnd);
  const tailEnd = matchEnd + 90;
  const after =
    text.slice(matchEnd, tailEnd) + (tailEnd < text.length ? "…" : "");
  return { before, match, after };
}

type ChatSearchResult = { message: ChatMessage; index: number };

const searchResultKey = (result: ChatSearchResult) => result.message.id;

const SearchResultRow = memo(function SearchResultRow({
  message,
  index,
  query,
  styles,
  colors,
  onPress,
}: {
  message: ChatMessage;
  index: number;
  query: string;
  styles: ChatStyles;
  colors: Colors;
  onPress: (index: number) => void;
}) {
  const handlePress = useCallback(() => onPress(index), [index, onPress]);
  const snippet = useMemo(
    () => buildSearchSnippet(message.text, query),
    [message.text, query],
  );
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Jump to message: ${message.text.slice(0, 80)}`}
      style={({ pressed }) => [
        styles.searchResultRow,
        pressed && styles.searchResultRowPressed,
      ]}
    >
      <Text
        style={styles.searchResultText}
        numberOfLines={2}
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
      >
        {snippet.before}
        <Text style={styles.searchResultMatch}>{snippet.match}</Text>
        {snippet.after}
      </Text>
      <Icon name="chevron-right" size={16} color={colors.textMuted} />
    </Pressable>
  );
});

// ---------------------------------------------------------------------------
// ChatPane — full chat screen surface (list + composer + scroll model).
// Used by both the chat and the computer chat so both render visually
// identically; the parent just owns message state and submission.
// ---------------------------------------------------------------------------

export type ChatPaneProps = {
  /** Visible message list (parent-owned). */
  messages: ChatMessage[];
  /** True while a reply is streaming — controls composer stop button. */
  streaming: boolean;
  /**
   * Live working-indicator props derived from the run (active state + the
   * dynamic, tool-aware label), mirroring the desktop indicator.
   */
  workingIndicator?: WorkingIndicatorState;
  /** Shows a quiet offline notice above the composer. */
  offline?: boolean;
  /** Empty-state body. Rendered centered when there are no messages. */
  emptyContent: ReactNode;
  /**
   * True while history is still hydrating (e.g. AsyncStorage load on mount or
   * an unknown pairing state). Suppresses the empty state so it doesn't flash
   * during tab transitions before the real messages arrive.
   */
  historyLoading?: boolean;
  /** Durable pages adjacent to the bounded in-memory message window. */
  hasOlderHistory?: boolean;
  hasNewerHistory?: boolean;
  historyPageLoading?: boolean;
  onLoadOlderHistory?: () => Promise<void> | void;
  onLoadNewerHistory?: () => Promise<void> | void;

  /** Composer input value. */
  draft: string;
  /** Composer input change handler. */
  onChangeDraft: (next: string) => void;
  /** Whether the composer accepts text (typing + sending). */
  composerEnabled?: boolean;
  /**
   * Optional paired-computer model control. When pinned, it keeps the composer
   * expanded and renders a compact model picker in the toolbar.
   */
  composerModelPicker?: ComposerModelPickerConfig;
  /** Visible placeholder when not transcribing. */
  placeholder: string;

  /** Owner-approved intervention pinned immediately above the composer. */
  composerIntervention?: ReactNode;

  /** Computed once per parent re-render; controls submit button enabled. */
  canSubmit: boolean;
  /** Triggered by the send button or `return` key. */
  onSubmit: () => { userMessageId: string } | null;
  /**
   * Optional stop handler. When provided AND `streaming` is true, the send
   * button is replaced by a stop button that calls this. Used to cancel the
   * in-flight reply (and cancels any queued messages without deleting their
   * bubbles) for both the local chat stream and computer-chat round trip.
   */
  onStop?: () => void;

  /** Stable id of the text chat to which realtime voice is attached. */
  realtimeVoiceConversationId?: string | null;
  /** Where voice-request actions should execute. */
  realtimeVoiceExecution?: "phone" | "computer";
  /** Paired desktop credentials used only by Computer realtime voice. */
  realtimeVoiceDesktopAccess?: StoredPhoneAccess | null;
  /** Show sign-in before starting capture for an anonymous cloud user. */
  realtimeVoiceSignInRequired?: boolean;
  /** Dispatches one action request into the attached text chat. */
  onRealtimeVoiceAction?: (
    request: string,
  ) => Promise<RealtimeVoiceActionDispatch>;

  /** Show a small `+` menu entry for attaching photos and files. */
  enableAttachments: boolean;
  /** Current attachments — only meaningful when `enableAttachments`. */
  attachments?: ComposerAttachment[];
  /** Hands picked files to the owner, which uploads them and reports overflow. */
  onAddAttachments?: (picked: readonly PickedAttachment[]) => {
    rejected: number;
  };
  onRemoveAttachment?: (id: string) => void;
  /** Retries one failed upload. Absent means a failed chip can only be removed. */
  onRetryAttachment?: (id: string) => void;
  /**
   * Optional overall cap for this transport. Picker-level limits reset per
   * launch, so the chat supplies its backend request limit here.
   */
  maxAttachments?: number;

  /**
   * Quoted-text chips pending in the composer — added by the message menu's
   * "Quote" and assistant selection's "Ask Stella", rendered as removable chips
   * above the input, and folded into the sent message by `useChatThread`. When
   * `onAddQuote` is absent those actions fall back to inline draft text.
   */
  quotes?: ComposerQuote[];
  onAddQuote?: (text: string) => void;
  onRemoveQuote?: (id: string) => void;

  /** Headers passed to the dictation upload (e.g. mobile device id for guests). */
  dictationAnonymous: boolean;
  dictationHeaders?: Record<string, string>;

  /** Opens a desktop artifact linked from an assistant message. */
  onOpenArtifact?: (artifact: ChatArtifact) => void;

  /**
   * Conversation the transcript belongs to. Used to key artifacts built from
   * tapped `stella://file/...` links so the viewer's bridge file reads are
   * scoped like inline artifact cards. Optional — link taps still open the
   * viewer without it.
   */
  conversationId?: string | null;

  /**
   * Background tasks for the floating running-count pill. The cloud chat
   * omits it.
   */
  activityTasks?: MobileTask[];

  /**
   * Reveals the activity (the sidebar, where tasks, schedules and files
   * live). While anything runs, a "N in progress" pill floats above the
   * composer and taps through to it; message rows with agent work use it
   * too. The cloud chat omits it.
   */
  onOpenActivity?: () => void;

  /**
   * True while a catch-up sync is pulling turns the phone may have missed
   * (landing, foreground/refocus, Force Sync — see `useChatThread`). Renders a
   * small transient "Catching up" pill at the top of the transcript, debounced
   * by `useCatchUpIndicatorVisible` so instant pulls never flash it.
   * Steady-state polls and send-path pulls must not set this.
   */
  catchingUp?: boolean;
};

export type ComposerModelPickerConfig = {
  pinned: boolean;
  label: string;
  loading?: boolean;
  saving?: boolean;
  effortLabel: string;
  effortOptions: readonly {
    id: string;
    label: string;
    selected: boolean;
  }[];
  recentModels: readonly {
    id: string;
    label: string;
    selected: boolean;
  }[];
  onOpen: () => void;
  onSelectEffort: (id: string) => void;
  onSelectModel: (id: string) => void;
};

export function ChatPane({
  messages,
  streaming,
  workingIndicator,
  offline = false,
  emptyContent,
  historyLoading = false,
  hasOlderHistory = false,
  hasNewerHistory = false,
  historyPageLoading = false,
  onLoadOlderHistory,
  onLoadNewerHistory,
  draft,
  onChangeDraft,
  composerEnabled = true,
  composerModelPicker,
  placeholder,
  composerIntervention,
  canSubmit,
  onSubmit,
  onStop,
  realtimeVoiceConversationId = null,
  realtimeVoiceExecution = "phone",
  realtimeVoiceDesktopAccess = null,
  realtimeVoiceSignInRequired = false,
  onRealtimeVoiceAction,
  enableAttachments,
  attachments,
  onAddAttachments,
  onRemoveAttachment,
  onRetryAttachment,
  maxAttachments,
  quotes,
  onAddQuote,
  onRemoveQuote,
  dictationAnonymous,
  dictationHeaders,
  onOpenArtifact,
  conversationId = null,
  activityTasks,
  onOpenActivity,
  catchingUp = false,
}: ChatPaneProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const t = useT();
  const readAloud = useReadAloudPreference();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  const inputRef = useRef<TextInput>(null);
  const { height: keyboardHeight, composerBottomPad } = useKeyboardInset();
  // UI-thread keyboard frame. Drives the composer's lift directly so it tracks
  // the keyboard exactly — both rising and falling — instead of chasing it via
  // a JS-scheduled layout animation that the OS curve always out-runs.
  const keyboard = useAnimatedKeyboard();
  // The composer rests at `composerBottomPad` (home-indicator safe area) above
  // the screen bottom. Lift it by the keyboard height *minus* that already-
  // reserved band so its content lands a constant gap above the keyboard.
  const composerKeyboardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -Math.max(0, keyboard.height.value - insets.bottom) },
    ],
  }));
  // Extra reading area the message list must reserve below its content while the
  // keyboard is up, mirroring the composer's lift (JS side, for the list inset).
  const keyboardExtra = Math.max(0, keyboardHeight - insets.bottom);

  // The composer + working indicator overlay the bottom of the chat. We
  // measure their actual height so the list can reserve matching
  // bottom inset, letting messages scroll under the composer (visible
  // through transparent margins around the glass shell) instead of being
  // clipped by it. The composer's keyboard lift is a transform, so this
  // measured height stays constant across keyboard show/hide.
  const [footerHeight, setFooterHeight] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(0);
  const [chatTailHeightPx, setChatTailHeightPx] = useState(CHAT_TAIL_GAP);
  const listBottomInsetPx = EDGE_FADE + footerHeight + keyboardExtra;
  // The target is viewport-derived, but the current tail starts at its real
  // working-indicator floor. An accepted send expands it; upward user scroll
  // consumes it one-for-one until only that floor remains.
  const responseSpacerTargetHeightPx = resolveResponseSpacerHeight({
    viewportHeight: listViewportHeight,
    bottomInsetPx: listBottomInsetPx,
    minimumHeightPx: listBottomInsetPx + CHAT_TAIL_GAP,
  });
  const chatTailTargetHeightPx = Math.max(
    CHAT_TAIL_GAP,
    responseSpacerTargetHeightPx - listBottomInsetPx,
  );
  const listTrailingSlackPx = listBottomInsetPx + chatTailHeightPx;
  const responseSpacerHeightPx = Math.max(0, chatTailHeightPx - CHAT_TAIL_GAP);
  // Accepts an explicit chat-tail height: a send activates the spacer against
  // the keyboard-DOWN inset (it dismisses the keyboard in the same breath), so
  // it cannot use this render's keyboard-inflated `chatTailTargetHeightPx`.
  const activateResponseSpacer = useCallback((chatTailPx: number) => {
    setChatTailHeightPx(Math.max(CHAT_TAIL_GAP, chatTailPx));
  }, []);
  const clearResponseSpacer = useCallback(() => {
    setChatTailHeightPx(CHAT_TAIL_GAP);
  }, []);
  const consumeResponseSpacer = useCallback((distanceDeltaPx: number) => {
    setChatTailHeightPx((currentHeightPx) =>
      consumeResponseSpacerHeight({
        currentHeightPx,
        minimumHeightPx: CHAT_TAIL_GAP,
        distanceDeltaPx,
      }),
    );
  }, []);
  // A viewport/keyboard shrink may cap the current spacer, but growing the
  // viewport never recreates space the user already consumed.
  useEffect(() => {
    setChatTailHeightPx((current) =>
      Math.max(CHAT_TAIL_GAP, Math.min(current, chatTailTargetHeightPx)),
    );
  }, [chatTailTargetHeightPx]);
  const onViewportLayout = useCallback((event: LayoutChangeEvent) => {
    setListViewportHeight(Math.round(event.nativeEvent.layout.height));
  }, []);

  // The footer (working indicator + composer) re-measures on every frame of any
  // layout animation it runs. Each measurement re-renders the list padding and
  // nudges the scroll-follow target, so tracking every intermediate frame turns
  // a composer collapse into churn at the bottom of the screen. Grow the inset
  // immediately — too little reserved space lets the composer overlap the last
  // message — but defer a shrink until the animation settles, since extra slack
  // for a beat is invisible.
  const footerShrinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const onFooterLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (footerShrinkTimerRef.current) {
      clearTimeout(footerShrinkTimerRef.current);
      footerShrinkTimerRef.current = null;
    }
    setFooterHeight((prev) => {
      if (h > prev) return h;
      if (h < prev) {
        footerShrinkTimerRef.current = setTimeout(() => {
          footerShrinkTimerRef.current = null;
          setFooterHeight(h);
        }, FOOTER_SHRINK_SETTLE_MS);
      }
      return prev;
    });
  }, []);
  useEffect(
    () => () => {
      if (footerShrinkTimerRef.current) {
        clearTimeout(footerShrinkTimerRef.current);
      }
    },
    [],
  );

  const assistantTextLenRef = useRef(0);
  const assistantIdRef = useRef<string | null>(null);
  const visibleMessages = useMemo(
    () => visibleChatMessages(messages),
    [messages],
  );
  // A conversation first observed empty mounts its list on the optimistic
  // send. Our post-send owner already places that row; starting Legend's
  // footer-preserving end bootstrap as well would move it a second time.
  // Existing history still bootstraps at its tail once hydration completes.
  const initialScrollAtEndRef = useRef<boolean | null>(null);
  if (!historyLoading && initialScrollAtEndRef.current === null) {
    initialScrollAtEndRef.current = visibleMessages.length > 0;
  }
  const [replyFocus, setReplyFocus] = useState<ReplyRef | null>(null);
  const replyContexts = useMemo(() => mobileReplyContexts(visibleMessages), [visibleMessages]);
  const closeReplyFocus = useCallback(() => setReplyFocus(null), []);
  useEffect(() => setReplyFocus(null), [conversationId]);
  const lastMessage = visibleMessages[visibleMessages.length - 1];
  const scroll = useChatScroll(
    listTrailingSlackPx,
    responseSpacerHeightPx,
    lastMessage?.id ?? null,
    consumeResponseSpacer,
    clearResponseSpacer,
  );

  const [unread, setUnread] = useState(false);
  const prevLenRef = useRef(0);
  const sawTurnRef = useRef(false);
  const spokenAssistantIdsRef = useRef<Set<string>>(new Set());
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  if (lastMessage?.role === "assistant") {
    const isNewAssistant = lastMessage.id !== assistantIdRef.current;
    const grewText = lastMessage.text.length > assistantTextLenRef.current;
    if (isNewAssistant) {
      scroll.resetAssistantAutoScroll();
    }
    // Only engage the animated catch-up while a reply is actively streaming
    // (or pending, for the computer chat). Without this gate, hydrating saved
    // history on tab mount looks like a fresh assistant message with huge
    // "growth" (baseline=0 before the list lays out), and the follow loop
    // animates a ~400px scroll on top of the initial scrollToEnd — the chat
    // visibly readjusts every time the user switches to the tab.
    if (streaming && (isNewAssistant || grewText)) {
      scroll.prepareAssistantLayoutFollow();
    }
    assistantTextLenRef.current = lastMessage.text.length;
    assistantIdRef.current = lastMessage.id;
  } else {
    assistantTextLenRef.current = 0;
    assistantIdRef.current = null;
  }

  // Assistant identity changes reset its measurements above. A busy-state
  // transition alone must not cancel the in-flight post-send placement.

  // When the keyboard rises while the user is at/near the bottom, pull the
  // chat up so the keyboard doesn't cover the latest messages. If the user
  // is reading further up, leave their scroll position alone.
  //
  // The list's reserved bottom inset grows with `keyboardExtra` in the same
  // render as `keyboardHeight` changes, but the layout pass that applies the
  // larger inset only commits the following frame. Scrolling immediately here
  // would race that pass and land short — the keyboard ends up covering the
  // tail. So we record the intent and do the authoritative scroll once the
  // inset has actually grown (the effect keyed on `keyboardExtra` below).
  const prevKeyboardHeightRef = useRef(0);
  const pinTailForKeyboardRef = useRef(false);
  useEffect(() => {
    const prev = prevKeyboardHeightRef.current;
    prevKeyboardHeightRef.current = keyboardHeight;
    if (keyboardHeight > prev && !scroll.awayFromBottom) {
      pinTailForKeyboardRef.current = true;
      requestAnimationFrame(() =>
        scroll.listRef.current?.scrollToEnd({ animated: true }),
      );
    } else if (keyboardHeight === 0) {
      pinTailForKeyboardRef.current = false;
    }
  }, [keyboardHeight, scroll.awayFromBottom, scroll.listRef]);

  // The list's bottom inset just grew to include the keyboard — this is the
  // layout pass the keyboard effect above was racing, so finish pinning to the
  // tail now that there's actually room to scroll into.
  useEffect(() => {
    if (!pinTailForKeyboardRef.current) return;
    pinTailForKeyboardRef.current = false;
    scroll.listRef.current?.scrollToEnd({ animated: true });
  }, [keyboardExtra, scroll.listRef]);

  // A send anchors its scroll target against the keyboard-DOWN inset (submit
  // dismisses the keyboard), but the list's padding only sheds `keyboardExtra`
  // once the dismissal commits. Nudging immediately would measure content that
  // still carries the keyboard-inflated padding and land ~keyboard-height past
  // the tail — the same race `pinTailForKeyboardRef` above solves for the
  // keyboard rising. Record the intent here and fire the nudge on the render
  // where the inset has actually collapsed.
  const pendingSendNudgeRef = useRef<{
    userMessageId: string;
  } | null>(null);
  useEffect(() => {
    const pending = pendingSendNudgeRef.current;
    if (!pending || keyboardExtra > 0) return;
    pendingSendNudgeRef.current = null;
    scroll.nudgeAfterSend(pending.userMessageId);
  }, [keyboardExtra, scroll.nudgeAfterSend]);

  // LegendList's `dataChange` auto-pin fires on the optimistic send append —
  // `streaming` is often still false at that render (always over the computer
  // bridge) — and scrolls to the literal content end, full response spacer
  // included, fighting the custom post-send nudge that owns the tail. Suppress
  // it while a send-nudge is in flight; streaming or the next appended row
  // releases this identity latch. The custom owner remains active for the
  // reserved response space, including the final idle answer append.
  const [sendPinSuppressForId, setSendPinSuppressForId] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (!sendPinSuppressForId) return;
    if (streaming || lastMessage?.id !== sendPinSuppressForId) {
      setSendPinSuppressForId(null);
    }
  }, [sendPinSuppressForId, streaming, lastMessage?.id]);

  const dataChangeScrollOwner = resolveChatDataChangeScrollOwner({
    isFollowingLatest: scroll.isFollowingLatest,
    isStreaming: streaming,
    postSendPlacementPending: sendPinSuppressForId !== null,
    // Completion can append the final answer in the same render that busy
    // becomes false. End-pinning here would scroll into reserved blank space.
    hasResponseSpacer: responseSpacerHeightPx > 0,
  });
  const maintainVisibleContentPosition = useMemo(
    () => ({
      // Native + Legend data and size anchoring are reserved for history.
      // Even size-only anchoring enables native MVCP. Enabling it at
      // the live tail would introduce a second writer beside the stream/send
      // loop or Legend's end pin.
      data: dataChangeScrollOwner === "history-anchor",
      size: dataChangeScrollOwner === "history-anchor",
    }),
    [dataChangeScrollOwner],
  );

  useEffect(() => {
    const grew = visibleMessages.length > prevLenRef.current;
    prevLenRef.current = visibleMessages.length;
    if (visibleMessages.length === 0) {
      setUnread(false);
      return;
    }
    if (grew && scroll.awayFromBottom) setUnread(true);
  }, [visibleMessages.length, scroll.awayFromBottom]);

  useEffect(() => {
    if (!scroll.awayFromBottom) setUnread(false);
  }, [scroll.awayFromBottom]);

  // Read aloud now fires when the assistant MESSAGE arrives rather than on the
  // falling edge of a stream: there is no stream to end. `sawTurnRef` keeps the
  // original behaviour's boundary — only a reply produced by a turn this pane
  // watched is spoken, never a transcript restored from history or pulled by a
  // background sync. It is armed while a turn is in flight and consumed by the
  // first assistant text that lands after it.
  useEffect(() => {
    if (!readAloud.enabled) {
      // Drop the latch, or a turn that landed while read-aloud was off would
      // speak a stale reply the moment the preference is re-enabled.
      sawTurnRef.current = false;
      return;
    }
    if (streaming && !sawTurnRef.current) {
      // Rising edge of a turn: every reply already on screen predates it, so
      // mark them handled. Only a message that lands from here on is eligible,
      // which is what the old stream-end latch effectively guaranteed.
      for (const message of visibleMessages) {
        if (message.role === "assistant" && message.text.trim()) {
          spokenAssistantIdsRef.current.add(message.id);
        }
      }
      sawTurnRef.current = true;
    }
    if (!sawTurnRef.current) return;
    const latestAssistant = [...visibleMessages]
      .reverse()
      .find((message) => message.role === "assistant" && message.text.trim());
    if (
      !latestAssistant ||
      spokenAssistantIdsRef.current.has(latestAssistant.id)
    ) {
      return;
    }
    // A landed message consumes the latch: a multi-segment turn speaks its
    // first segment as it arrives, exactly as the old stream-end latch spoke
    // the one reply the turn produced.
    sawTurnRef.current = false;
    spokenAssistantIdsRef.current.add(latestAssistant.id);
    void speakReply(latestAssistant.text, latestAssistant.id);
  }, [visibleMessages, readAloud.enabled, streaming]);

  const [expanded, setExpanded] = useState(false);
  const [realtimeVoiceOpen, setRealtimeVoiceOpen] = useState(false);

  // When the parent clears draft after send, collapse back to pill shape.
  useEffect(() => {
    if (expanded && draft.length === 0) {
      LayoutAnimation.configureNext(LAYOUT_SPRING);
      setExpanded(false);
    }
  }, [draft, expanded]);

  // Expansion is one-way while the user is typing: the pill and expanded
  // shapes give the text different widths, so a 2-line pill can re-flow to
  // 1 line in expanded shape — flipping back to pill would re-wrap and
  // oscillate forever. Collapse happens only when the parent clears the
  // draft (see the `useEffect` above) or via dedicated dictation handlers.
  // Trigger expand purely on measured content height crossing the threshold.
  // We used to gate on a `hasMounted` ref to skip the first event, but on
  // screens where the composer's host re-renders shortly after mount (e.g.
  // Computer tab settling `paired: null → true`) the *useful* first event —
  // the one that already exceeds the threshold — could be the one that got
  // swallowed, leaving the pill stuck at one line forever.
  const handleContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      if (expanded) return;
      // Ignore measurements once the draft is empty. On send the draft clears
      // and the collapse effect drops us back to the pill, but the native
      // TextInput can still emit one more `onContentSizeChange` carrying the
      // *old* tall height before it renders the cleared value. Acting on that
      // would re-expand an empty composer, the collapse effect would collapse
      // it again, and the two LayoutAnimation springs ping-pong — the composer
      // (and the working indicator stacked above it) shake violently. An empty
      // composer is never expanded, so there is nothing to grow for here.
      if (draft.length === 0) return;
      const h = e.nativeEvent.contentSize.height;
      if (h > EXPAND_THRESHOLD) {
        LayoutAnimation.configureNext(LAYOUT_SPRING);
        setExpanded(true);
      }
    },
    [expanded, draft],
  );

  const submit = useCallback(() => {
    tapMedium();
    const shouldPlaceLatestTurn = scroll.getShouldPlaceLatestTurn();
    const submitted = onSubmit();
    if (submitted && shouldPlaceLatestTurn) {
      // Spacer and scroll anchor are computed against the keyboard-DOWN
      // inset: `Keyboard.dismiss()` below collapses `keyboardExtra` a few
      // frames from now, and a target derived from the inflated inset would
      // be left ~keyboard-height past the content end once the padding
      // shrinks.
      const restingBottomInsetPx = EDGE_FADE + footerHeight;
      const restingSpacerTargetPx = resolveResponseSpacerHeight({
        viewportHeight: listViewportHeight,
        bottomInsetPx: restingBottomInsetPx,
        minimumHeightPx: restingBottomInsetPx + CHAT_TAIL_GAP,
      });
      activateResponseSpacer(restingSpacerTargetPx - restingBottomInsetPx);
      setSendPinSuppressForId(submitted.userMessageId);
      if (keyboardExtra > 0) {
        // Defer the nudge until the keyboard-driven inset change commits
        // (the `pendingSendNudgeRef` effect above).
        pendingSendNudgeRef.current = {
          userMessageId: submitted.userMessageId,
        };
      } else {
        scroll.nudgeAfterSend(submitted.userMessageId);
      }
    } else if (submitted) {
      clearResponseSpacer();
      scroll.releaseFollow();
    }
    Keyboard.dismiss();
  }, [
    onSubmit,
    activateResponseSpacer,
    clearResponseSpacer,
    footerHeight,
    keyboardExtra,
    listViewportHeight,
    scroll.getShouldPlaceLatestTurn,
    scroll.nudgeAfterSend,
    scroll.releaseFollow,
  ]);

  const dictationHeadersMemo = useMemo(
    () => dictationHeaders,
    // We trust the parent to memoize these.
    [dictationHeaders],
  );

  // Use a ref so the dictation transcript callback always sees the latest
  // draft, even when a transcription chunk lands after the parent re-renders.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Auto-send-after-dictation coordination (see `stopAndSendVoice` below).
  // When a voice-send is armed we stash the exact draft the transcript produces
  // so the send effect can wait for the draft state to actually reflect it,
  // rather than racing the (separately-committed) status → idle update.
  const pendingVoiceSendRef = useRef(false);
  const voiceSendTargetRef = useRef<string | null>(null);
  const voiceSendResultReadyRef = useRef(false);
  const [voiceSendResultVersion, setVoiceSendResultVersion] = useState(0);

  const appendTranscript = useCallback(
    (text: string) => {
      const trimmedPrev = draftRef.current.trimEnd();
      const next = trimmedPrev ? `${trimmedPrev} ${text}` : text;
      if (pendingVoiceSendRef.current) voiceSendTargetRef.current = next;
      onChangeDraft(next);
    },
    [onChangeDraft],
  );

  const dictation = useDictation({
    anonymous: dictationAnonymous,
    headers: dictationHeadersMemo,
    onTranscript: appendTranscript,
  });

  const isListening = dictation.isRecording;

  const toggleVoice = useCallback(async () => {
    if (dictation.status === "idle") {
      tapLight();
      // In-flight progressive TTS can otherwise apply Expo's playback audio
      // mode after recording starts. On iOS that mode stops every recorder.
      await startAfterStoppingReadAloud(() => dictation.start());
      return;
    }
    await dictation.toggle();
  }, [dictation]);

  const openRealtimeVoice = useCallback(() => {
    if (!realtimeVoiceSignInRequired && !hasAiConsent()) {
      requestAiConsent();
      return;
    }
    tapMedium();
    stopReadAloud();
    Keyboard.dismiss();
    setRealtimeVoiceOpen(true);
  }, [realtimeVoiceSignInRequired]);

  const performRealtimeVoiceAction = useCallback(
    async (request: string) =>
      onRealtimeVoiceAction ? onRealtimeVoiceAction(request) : null,
    [onRealtimeVoiceAction],
  );

  // "Stop dictation and send": stop recording, then auto-submit once the
  // transcript has landed in the draft. `dictation.stop()` resolves after the
  // round-trip, but `onTranscript` updates the draft through the parent, so we
  // can't read it back synchronously here. Arm a flag and let the effect below
  // fire submit on the render where the transcript has committed and dictation
  // has returned to idle.
  const stopAndSendVoice = useCallback(() => {
    if (pendingVoiceSendRef.current) return;
    pendingVoiceSendRef.current = true;
    voiceSendTargetRef.current = null;
    voiceSendResultReadyRef.current = false;
    void dictation
      .stop()
      .then((transcript) => {
        if (!pendingVoiceSendRef.current) return;
        // Never send a stale typed prefix when recording/transcription failed.
        if (transcript && voiceSendTargetRef.current !== null) {
          voiceSendResultReadyRef.current = true;
          // The transcript callback updates parent-owned draft state. Force one
          // render after stop() has fully resolved so the effect can verify that
          // exact target was committed before calling submit.
          setVoiceSendResultVersion((version) => version + 1);
          return;
        }
        pendingVoiceSendRef.current = false;
        voiceSendTargetRef.current = null;
      })
      .catch(() => {
        pendingVoiceSendRef.current = false;
        voiceSendTargetRef.current = null;
      });
  }, [dictation]);

  useEffect(() => {
    const target = voiceSendTargetRef.current;
    if (
      !canSubmitFinalizedDictation({
        armed: pendingVoiceSendRef.current,
        resultReady: voiceSendResultReadyRef.current,
        status: dictation.status,
        draft,
        target,
        attachmentCount: attachments?.length ?? 0,
      })
    ) {
      return;
    }
    pendingVoiceSendRef.current = false;
    voiceSendResultReadyRef.current = false;
    voiceSendTargetRef.current = null;
    submit();
  }, [dictation.status, draft, attachments, submit, voiceSendResultVersion]);

  const attachmentLimit = maxAttachments ?? CHAT_ATTACHMENT_MAX_COUNT;
  const acceptPicked = useCallback(
    (picked: readonly PickedAttachment[]) => {
      if (!onAddAttachments || picked.length === 0) return;
      tapLight();
      const { rejected } = onAddAttachments(picked);
      if (rejected > 0) {
        Alert.alert(
          t("chat.attachments.tooManyTitle"),
          t("chat.attachments.tooManyBody", { count: attachmentLimit }),
        );
      }
    },
    [attachmentLimit, onAddAttachments, t],
  );

  const imagePickAsAttachment = useCallback(
    (asset: ImagePicker.ImagePickerAsset): PickedAttachment => ({
      id: asset.assetId ?? asset.uri,
      uri: asset.uri,
      name: driveFileNameFor(asset.fileName ?? asset.uri, "image"),
      mimeType: asset.mimeType ?? "image/jpeg",
      sizeBytes: asset.fileSize ?? 0,
      kind: "image",
    }),
    [],
  );

  const pickImage = useCallback(async () => {
    if (!enableAttachments || !onAddAttachments) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t("chat.attachments.photosDeniedTitle"),
        t("chat.attachments.photosDeniedBody"),
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 0.75,
      selectionLimit: attachmentLimit,
      // HEIC bypasses the picker's `quality` JPEG re-encode (raw bytes pass
      // through), and desktop model providers can't decode HEIC. Ask PhotoKit
      // for the most compatible representation so library picks arrive as
      // JPEG at the picker level.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (!result.canceled) {
      acceptPicked(result.assets.map(imagePickAsAttachment));
    }
  }, [
    acceptPicked,
    attachmentLimit,
    enableAttachments,
    imagePickAsAttachment,
    onAddAttachments,
    t,
  ]);

  const takePhoto = useCallback(async () => {
    if (!enableAttachments || !onAddAttachments) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t("chat.attachments.cameraDeniedTitle"),
        t("chat.attachments.cameraDeniedBody"),
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.75,
    });
    if (!result.canceled) {
      acceptPicked(result.assets.map(imagePickAsAttachment));
    }
  }, [
    acceptPicked,
    enableAttachments,
    imagePickAsAttachment,
    onAddAttachments,
    t,
  ]);

  const pickDocument = useCallback(async () => {
    if (!enableAttachments || !onAddAttachments) return;
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      // Copied into the app's cache so the URI stays readable after the
      // picker's security-scoped access is released.
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    acceptPicked(
      result.assets.map((asset) => {
        const mimeType = asset.mimeType ?? "application/octet-stream";
        const kind = mimeType.startsWith("image/") ? "image" : "file";
        return {
          id: asset.uri,
          uri: asset.uri,
          name: driveFileNameFor(asset.name, kind),
          mimeType,
          sizeBytes: asset.size ?? 0,
          kind,
        };
      }),
    );
  }, [acceptPicked, enableAttachments, onAddAttachments]);

  // Root the in-tree menu overlays measure against (see PlusMenuPopover).
  const rootRef = useRef<View>(null);
  const plusAnchorRef = useRef<View>(null);
  const modelPickerAnchorRef = useRef<View>(null);
  const [plusMenuAnchor, setPlusMenuAnchor] = useState<AnchorRect | null>(null);
  const [modelPickerAnchor, setModelPickerAnchor] = useState<AnchorRect | null>(
    null,
  );

  const plusMenuOptions = useMemo<PlusMenuOption[]>(() => {
    const out: PlusMenuOption[] = [];
    if (enableAttachments) {
      out.push({
        id: "attach-photo",
        label: t("chat.attachments.attachPhoto"),
        icon: "image",
        onSelect: () => void pickImage(),
      });
      out.push({
        id: "take-photo",
        label: t("chat.attachments.takePhoto"),
        icon: "camera",
        onSelect: () => void takePhoto(),
      });
      out.push({
        id: "attach-file",
        label: t("chat.attachments.attachFile"),
        icon: "file-text",
        onSelect: () => void pickDocument(),
      });
    }
    out.push({
      id: "read-aloud",
      label: readAloud.enabled ? "Stop reading aloud" : "Read replies aloud",
      icon: readAloud.enabled ? "volume-2" : "volume-x",
      onSelect: () => void readAloud.setEnabled(!readAloud.enabled),
    });
    return out;
  }, [enableAttachments, pickDocument, pickImage, readAloud, t, takePhoto]);

  // Debounced catch-up indicator (show delay + minimum visible time), so
  // instant no-op pulls on every tab return never flash the pill.
  const catchUpVisible = useCatchUpIndicatorVisible(catchingUp);

  // Floating running-count pill: only while background work is in flight,
  // and only when there is somewhere (the sidebar) to take it.
  const runningTasks = runningTaskCount(activityTasks ?? []);
  const hasRunningPill = Boolean(onOpenActivity) && runningTasks > 0;
  const onPressRunningPill = useCallback(() => {
    if (!onOpenActivity) return;
    tapLight();
    Keyboard.dismiss();
    onOpenActivity();
  }, [onOpenActivity]);

  // Hide the floating button while scrolling up (reading back through
  // history) and bring it back when scrolling down toward the latest. The
  // derivation is position-first ("near bottom ⇒ visible", see
  // `deriveFloatingHidden`) and is re-evaluated not only per scroll event but
  // also when a gesture settles and when content grows — direction deltas
  // alone are unreliable (slow drags emit sub-threshold deltas; flings and
  // auto-scrolls can end without a final downward event).
  const [floatingHidden, setFloatingHidden] = useState(false);
  const floatingHiddenRef = useRef(false);
  const floatingMetricsRef = useRef<FloatingScrollMetrics>({
    offsetY: 0,
    contentHeight: 0,
    layoutHeight: 0,
  });
  const floatingAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(floatingAnim, {
      toValue: floatingHidden ? 0 : 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [floatingHidden, floatingAnim]);
  const applyFloatingHidden = useCallback((hidden: boolean) => {
    floatingHiddenRef.current = hidden;
    setFloatingHidden(hidden);
  }, []);
  const handleListScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      scroll.onScroll(e);
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const prevOffsetY = floatingMetricsRef.current.offsetY;
      floatingMetricsRef.current = {
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        layoutHeight: layoutMeasurement.height,
      };
      applyFloatingHidden(
        deriveFloatingHidden(
          floatingHiddenRef.current,
          prevOffsetY,
          floatingMetricsRef.current,
        ),
      );
    },
    [applyFloatingHidden, scroll.onScroll],
  );
  // Re-derive from the resting position alone (zero-delta pass keeps the
  // hidden latch mid-list but enforces the near-bottom invariant).
  const refreshFloatingFromPosition = useCallback(() => {
    const metrics = floatingMetricsRef.current;
    applyFloatingHidden(
      deriveFloatingHidden(floatingHiddenRef.current, metrics.offsetY, metrics),
    );
  }, [applyFloatingHidden]);
  // Gesture settled (drag end / momentum end) — the last scroll event may not
  // have fired or may have carried a sub-threshold delta.
  const handleListScrollSettle = useCallback(() => {
    scroll.onScrollSettle();
    refreshFloatingFromPosition();
  }, [refreshFloatingFromPosition, scroll.onScrollSettle]);
  // Content growth (new/streamed messages) changes the distance from the
  // bottom without a scroll event; keep the invariant honest here too.
  const handleListContentSizeChange = useCallback(
    (width: number, height: number) => {
      scroll.onListContentSizeChange(width, height);
      floatingMetricsRef.current.contentHeight = height;
      refreshFloatingFromPosition();
    },
    [refreshFloatingFromPosition, scroll.onListContentSizeChange],
  );

  const onPressPlus = useCallback(() => {
    if (plusMenuOptions.length === 0) return;
    if (
      plusMenuOptions.length === 1 &&
      plusMenuOptions[0].id === "attach-photo"
    ) {
      // Single-action: fall straight through so the menu doesn't add friction.
      void pickImage();
      return;
    }
    if (!plusAnchorRef.current) return;
    tapLight();
    const measureAnchor = () => {
      plusAnchorRef.current?.measureInWindow((x, y, width, height) => {
        setPlusMenuAnchor({ x, y, width, height });
      });
    };
    if (Keyboard.isVisible()) {
      // The composer rides the keyboard (composerKeyboardStyle), so measuring
      // at dismiss time would anchor the menu a keyboard-height above the
      // button's settled position. Measure once the hide animation completes.
      const sub = Keyboard.addListener("keyboardDidHide", () => {
        sub.remove();
        measureAnchor();
      });
      Keyboard.dismiss();
    } else {
      measureAnchor();
    }
  }, [pickImage, plusMenuOptions]);

  const dismissPlusMenu = useCallback(() => setPlusMenuAnchor(null), []);

  const modelPickerOptions = useMemo<PlusMenuOption[]>(() => {
    if (!composerModelPicker?.pinned) return [];
    const disabled = Boolean(
      composerModelPicker.loading || composerModelPicker.saving,
    );
    const options: PlusMenuOption[] = [
      {
        id: "model-thinking",
        label: t("app.chat.miniModelPicker.reasoningEffortLabel"),
        icon: "sparkles",
        trailingLabel: composerModelPicker.effortLabel,
        disabled: composerModelPicker.loading,
        submenuTitle: t("app.chat.miniModelPicker.reasoningEffortLabel"),
        submenu: composerModelPicker.effortOptions.map((effort) => ({
          id: `model-effort-${effort.id}`,
          label: effort.label,
          icon: "sparkles",
          selected: effort.selected,
          disabled,
          onSelect: () => composerModelPicker.onSelectEffort(effort.id),
        })),
        onSelect: () => undefined,
      },
      ...composerModelPicker.recentModels.map((model) => ({
        id: `model-recent-${model.id}`,
        label: model.label,
        icon: "cpu" as const,
        selected: model.selected,
        disabled: disabled || model.selected,
        onSelect: () => composerModelPicker.onSelectModel(model.id),
      })),
    ];
    return options;
  }, [composerModelPicker, t]);

  const onPressModelPicker = useCallback(() => {
    if (!composerModelPicker?.pinned || !modelPickerAnchorRef.current) return;
    tapLight();
    composerModelPicker.onOpen();
    const measureAnchor = () => {
      modelPickerAnchorRef.current?.measureInWindow((x, y, width, height) => {
        setModelPickerAnchor({ x, y, width, height });
      });
    };
    if (Keyboard.isVisible()) {
      const sub = Keyboard.addListener("keyboardDidHide", () => {
        sub.remove();
        measureAnchor();
      });
      Keyboard.dismiss();
    } else {
      measureAnchor();
    }
  }, [composerModelPicker]);

  const dismissModelPicker = useCallback(() => setModelPickerAnchor(null), []);

  // Long-press message actions — a popover anchored at the touch point so it
  // matches the app's menu language instead of a native sheet takeover.
  const [messageMenu, setMessageMenu] = useState<MessageMenuRequest | null>(
    null,
  );
  // The message currently in "Select text" mode (id), entered from the menu's
  // Select text action. At most one row selects at a time.
  const [selectingMessageId, setSelectingMessageId] = useState<string | null>(
    null,
  );
  const startSelectingMessage = useCallback((id: string) => {
    setSelectingMessageId(id);
  }, []);
  const stopSelectingMessage = useCallback(() => {
    setSelectingMessageId(null);
  }, []);
  const dismissMessageMenu = useCallback(() => {
    setMessageMenu(null);
  }, []);

  // "Quote" a message: drop it into the composer as a removable quote chip (so
  // the input isn't stuffed with the paragraph), then focus so the reply is
  // typed alongside it. On send the chip folds back in as a blockquote (see
  // `useChatThread`). Falls back to inline blockquote text if the surface didn't
  // wire quote state.
  const quoteMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (onAddQuote) {
        onAddQuote(trimmed);
      } else {
        const quoted = quoteMessageText(trimmed);
        const current = draftRef.current;
        onChangeDraft(
          current.trim() ? `${quoted}\n\n${current}` : `${quoted}\n\n`,
        );
      }
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [onAddQuote, onChangeDraft],
  );

  // Long-press action menu for USER messages (assistant long-press does native
  // text selection instead). Copy / Select text / Share / Quote apply to any
  // message with text. Each action fires a light tap on selection (the
  // menu-open medium tap is in ChatMessageRow.openMenu).
  const messageMenuOptions = useMemo<PlusMenuOption[]>(() => {
    if (!messageMenu) return [];
    const message = messageMenu.message;
    const text = message.text;
    const options: PlusMenuOption[] = [];
    // Copy / Select text / Share / Quote all act on text, so they're offered
    // only when there is any (both roles).
    if (text.trim()) {
      options.push(
        {
          id: "copy",
          label: "Copy",
          icon: "copy",
          onSelect: () => {
            tapLight();
            copyMessageText(text);
          },
        },
        {
          id: "select-text",
          label: "Select text",
          icon: "text-cursor",
          onSelect: () => {
            tapLight();
            startSelectingMessage(message.id);
          },
        },
        {
          id: "share",
          label: "Share…",
          icon: "share",
          onSelect: () => {
            tapLight();
            shareMessageText(text);
          },
        },
        {
          id: "quote",
          label: "Quote",
          icon: "quote",
          onSelect: () => {
            tapLight();
            quoteMessage(text);
          },
        },
      );
    }
    return options;
  }, [messageMenu, quoteMessage, startSelectingMessage]);

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);
  // The in-flight turn's reply row: appended empty on dispatch, then grown by
  // whole message segments. It owns the autoscroll follow so a landing message
  // scrolls itself into view; nothing else about it is per-row state now that
  // text arrives complete.
  const activeAssistantId =
    streaming && lastMessage?.role === "assistant" ? lastMessage.id : null;
  const latestUserMessageId =
    lastMessage?.role === "user" ? lastMessage.id : null;
  useEffect(() => {
    if (!activeAssistantId) {
      scroll.clearActiveAssistantLayout();
    }
  }, [activeAssistantId, scroll.clearActiveAssistantLayout]);

  const activeMenuMessageId = messageMenu?.message.id ?? null;
  // Tapped `stella://file/<path>` links in assistant markdown resolve into
  // the same artifact shape inline cards carry, then open the same viewer.
  const onOpenStellaFile = useMemo(
    () =>
      onOpenArtifact
        ? (path: string) =>
            onOpenArtifact(stellaFileChatArtifact(path, conversationId ?? ""))
        : undefined,
    [onOpenArtifact, conversationId],
  );
  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<ChatMessage>) => {
      const isActiveAssistant = item.id === activeAssistantId;
      const isLatestUser = item.id === latestUserMessageId;
      const animate = shouldAnimateMessageEntry(
        seenMessageIdsRef.current,
        item.id,
      );
      return (
        <FadeInMessage
          key={item.id}
          animate={animate && item.role !== "assistant"}
          onLayout={
            isActiveAssistant
              ? scroll.onActiveAssistantLayout
              : isLatestUser
                ? (event) => scroll.onLatestUserLayout(item.id, event)
                : undefined
          }
        >
          <ChatMessageRow
            item={item}
            animate={animate && item.id === lastMessage?.id && !historyLoading}
            styles={styles}
            colors={colors}
            menuActive={item.id === activeMenuMessageId}
            isSelecting={item.id === selectingMessageId}
            anySelecting={selectingMessageId != null}
            onOpenArtifact={onOpenArtifact}
            onOpenStellaFile={onOpenStellaFile}
            onOpenMessageMenu={setMessageMenu}
            onEndSelecting={stopSelectingMessage}
            onOpenAgentActivity={onOpenActivity}
            onOpenReply={setReplyFocus}
            contextRef={replyContexts.get(item.id)}
            desktopAccess={realtimeVoiceDesktopAccess}
          />
        </FadeInMessage>
      );
    },
    [
      replyContexts,
      lastMessage?.id,
      historyLoading,
      styles,
      colors,
      onOpenArtifact,
      onOpenStellaFile,
      latestUserMessageId,
      scroll.onLatestUserLayout,
      scroll.onActiveAssistantLayout,
      activeAssistantId,
      activeMenuMessageId,
      selectingMessageId,
      startSelectingMessage,
      stopSelectingMessage,
      onOpenActivity,
      realtimeVoiceDesktopAccess,
    ],
  );
  // Legend recycles memoized rows keyed on item data, so top-level focus state
  // (which row's menu is open / which is selecting) never reaches a mounted row
  // on its own. Feed it as `extraData` so opening the menu actually re-renders
  // the pressed row and its lift spring fires (and selection mode shows).
  const listExtraData = `${activeMenuMessageId ?? ""}|${selectingMessageId ?? ""}`;
  const renderSeparator = useCallback(
    () => <View style={styles.itemSeparator} />,
    [styles],
  );
  const getItemType = useCallback((item: ChatMessage) => item.role, []);

  // The working indicator rides at the tail of the chat (desktop-style) instead
  // of floating above the composer. Its viewport-derived tail reserves the
  // response area below the latest turn; the indicator itself keeps a stable
  // slot, so fading it in or out never changes the footer's height.
  const listFooter = useMemo(
    () => (
      <View style={[styles.chatTail, { minHeight: chatTailHeightPx }]}>
        <WorkingIndicator
          active={workingIndicator?.active ?? streaming}
          exitImmediately={workingIndicator?.exitImmediately}
          status={workingIndicator?.status}
          toolName={workingIndicator?.toolName}
          toolCallId={workingIndicator?.toolCallId}
        />
      </View>
    ),
    [chatTailHeightPx, streaming, workingIndicator, styles.chatTail],
  );

  // Search shows a separate results menu that overlays the chat (the chat
  // itself is never filtered). Matches are listed newest-first; tapping one
  // jumps to that message in the conversation.
  const search = useChatSearch();
  const searchOpen = search.isOpen;
  const searchQuery = search.query.trim();
  const searchActive = searchQuery.length > 0;
  // Fold each message once (recomputed only when messages change) so each
  // keystroke just filters precomputed strings instead of re-normalizing the
  // whole history. Gated on the search being open: during streaming,
  // `visibleMessages` gets a new identity every frame, and folding the full
  // transcript per frame is pure waste while the results are unread.
  const foldedMessages = useMemo(() => {
    if (!searchOpen) {
      return [] as { message: ChatMessage; index: number; folded: string }[];
    }
    return visibleMessages.map((message, index) => ({
      message,
      index,
      folded: foldText(message.text),
    }));
  }, [searchOpen, visibleMessages]);
  const searchResults = useMemo(() => {
    if (!searchActive) return [] as ChatSearchResult[];
    const terms = foldQueryTerms(searchQuery);
    if (terms.length === 0) {
      return [] as ChatSearchResult[];
    }
    const out: ChatSearchResult[] = [];
    // Newest first; a message matches when every term appears somewhere in it.
    for (let i = foldedMessages.length - 1; i >= 0; i -= 1) {
      const entry = foldedMessages[i];
      if (terms.every((term) => entry.folded.includes(term))) {
        out.push({ message: entry.message, index: entry.index });
      }
    }
    return out;
  }, [foldedMessages, searchActive, searchQuery]);

  const jumpToMessage = useCallback(
    (index: number) => {
      search.close();
      // Let the results overlay unmount before scrolling the list underneath.
      setTimeout(() => {
        scroll.listRef.current?.scrollToIndex({ index, animated: true });
      }, 60);
    },
    [search, scroll.listRef],
  );

  const renderSearchResult = useCallback(
    ({ item }: ListRenderItemInfo<ChatSearchResult>) => (
      <SearchResultRow
        message={item.message}
        index={item.index}
        query={searchQuery}
        styles={styles}
        colors={colors}
        onPress={jumpToMessage}
      />
    ),
    [searchQuery, styles, colors, jumpToMessage],
  );

  const empty = visibleMessages.length === 0;
  const hasText = draft.trim().length > 0;
  const composerHasContent = draft.length > 0 || (attachments?.length ?? 0) > 0;
  const dictationInline = isListening && !hasText;
  const dictationBelow = isListening && hasText;

  useEffect(() => {
    if (!composerModelPicker?.pinned || dictationInline) {
      setModelPickerAnchor(null);
    }
  }, [composerModelPicker?.pinned, dictationInline]);

  const isExpandedComposed = resolveComposerExpanded({
    expanded,
    dictationBelow,
    dictationInline,
    modelPickerPinned: Boolean(composerModelPicker?.pinned),
    hasAttachments: (attachments?.length ?? 0) > 0,
  });

  const hasPlusMenu = composerEnabled;

  const plusButton = hasPlusMenu ? (
    <View ref={plusAnchorRef} collapsable={false}>
      <Pressable
        style={styles.addButton}
        hitSlop={4}
        accessibilityLabel="Open add menu"
        onPress={onPressPlus}
      >
        <Icon
          name="plus"
          size={17}
          color={colors.textMuted}
          weight="semibold"
        />
      </Pressable>
    </View>
  ) : null;

  // Shared mic / dictation control. Reused across the collapsed pill and the
  // expanded toolbar. It is intentionally NOT gated on `streaming`: dictation
  // stays available mid-run so a voice message can steer the active turn,
  // exactly like typing + sending while busy. The branches that render it are
  // mutually exclusive per render, so reusing the same element is safe.
  const micButton = (
    <Pressable
      onPress={() => void toggleVoice()}
      accessibilityLabel={
        isListening ? "Stop voice input" : "Start voice input"
      }
      disabled={dictation.isTranscribing}
      style={[styles.micButton, isListening && styles.micButtonActive]}
      hitSlop={4}
    >
      <Icon
        name={isListening ? "mic-off" : "mic"}
        size={20}
        color={isListening ? colors.accentForeground : colors.textMuted}
        filled={isListening}
      />
    </Pressable>
  );

  // Realtime voice is a distinct live-conversation mode, not dictation. Keep
  // it immediately to the right of the mic only while the composer is empty;
  // once text or an attachment exists, send remains the unambiguous action.
  const realtimeVoiceButton =
    realtimeVoiceConversationId &&
    (onRealtimeVoiceAction || realtimeVoiceDesktopAccess) &&
    composerEnabled &&
    !offline &&
    !composerHasContent &&
    dictation.status === "idle" ? (
      <Pressable
        onPress={openRealtimeVoice}
        accessibilityRole="button"
        accessibilityLabel="Start realtime voice conversation"
        style={({ pressed }) => [
          styles.realtimeVoiceButton,
          pressed && styles.realtimeVoiceButtonPressed,
        ]}
        hitSlop={4}
      >
        <Icon name="waveform" size={19} color={colors.text} weight="semibold" />
      </Pressable>
    ) : null;

  const showAttachmentStrip =
    enableAttachments && (attachments?.length ?? 0) > 0;
  const quoteChips = quotes ?? [];
  const showQuoteStrip = quoteChips.length > 0;

  const listContentContainerStyle = useMemo(
    () => [styles.list, { paddingBottom: listBottomInsetPx }],
    [styles.list, listBottomInsetPx],
  );
  return (
    <View ref={rootRef} collapsable={false} style={styles.screen}>
      <View style={styles.viewport} onLayout={onViewportLayout}>
        {historyLoading ? (
          // Hold a stable blank surface while history hydrates so the empty
          // state never flashes during a tab transition.
          <View style={styles.emptyState} />
        ) : empty ? (
          <Pressable
            style={styles.emptyState}
            onPress={() => Keyboard.dismiss()}
          >
            {emptyContent}
          </Pressable>
        ) : (
          <>
            <BubbleMorphProvider key={conversationId}>
              <LegendList<ChatMessage>
                ref={scroll.listRef}
                pointerEvents={replyFocus ? "none" : "auto"}
                accessibilityElementsHidden={Boolean(replyFocus)}
                importantForAccessibility={replyFocus ? "no-hide-descendants" : "auto"}
                style={styles.messageList}
                contentContainerStyle={listContentContainerStyle}
                data={visibleMessages}
                extraData={listExtraData}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                getItemType={getItemType}
                ItemSeparatorComponent={renderSeparator}
                ListFooterComponent={listFooter}
                onStartReached={() => {
                  if (hasOlderHistory && !historyPageLoading) {
                    void onLoadOlderHistory?.();
                  }
                }}
                onStartReachedThreshold={0.35}
                onEndReached={() => {
                  if (hasNewerHistory && !historyPageLoading) {
                    void onLoadNewerHistory?.();
                  }
                }}
                onEndReachedThreshold={0.35}
                onScroll={handleListScroll}
                onScrollBeginDrag={() => {
                  // Scrolling the transcript exits any active text selection
                  // before the drag runs (inline so it adds no new deps warning).
                  if (selectingMessageId != null) stopSelectingMessage();
                  scroll.onScrollBeginDrag();
                }}
                onScrollEndDrag={handleListScrollSettle}
                onMomentumScrollEnd={handleListScrollSettle}
                onContentSizeChange={handleListContentSizeChange}
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                keyboardDismissMode="on-drag"
                fadingEdgeLength={EDGE_FADE}
                // Open at the latest message every time the tab mounts, instead
                // of landing at the top of history. Short conversations that
                // don't fill the viewport read top-down (no `alignItemsAtEnd`)
                // so the first message sits at the top rather than the bottom.
                initialScrollAtEnd={initialScrollAtEndRef.current === true}
                // Keep the visible message anchored when the data array changes
                // (e.g. messages syncing in from the desktop) so the list never
                // snaps back to the top.
                maintainVisibleContentPosition={maintainVisibleContentPosition}
                // Pin to the tail only when new/synced messages arrive while the
                // user is already near the bottom. Scoped to data changes so it
                // doesn't fight the custom streaming-follow target updates,
                // which own item-layout/size growth.
                //
                // While streaming, every token mutates the data array, so a
                // dataChange-pinned tail would fire `scrollToEnd` on each token —
                // overriding the custom "freeze once the message reaches the top"
                // target and snapping the user back down whenever they try to
                // scroll up. The custom follow loop already keeps the tail in view
                // during streaming, so disable the built-in pin for that window.
                // Position ownership is exclusive: history anchoring wins while
                // follow is released, the custom loop owns streams/post-send
                // placement, and this pin owns only ordinary live-tail appends.
                maintainScrollAtEnd={
                  dataChangeScrollOwner === "legend-tail"
                    ? {
                        animated: false,
                        on: {
                          dataChange: true,
                          itemLayout: false,
                          layout: false,
                        },
                      }
                    : false
                }
              />
            </BubbleMorphProvider>
            {/* Top taper — fades the list into the surface at the top edge so
                messages scrolling under the top bar dissolve instead of
                hard-cutting. Cross-platform (RN `fadingEdgeLength` is
                Android-only). Paints the *actual* app backdrop (aligned to the
                screen via the top-bar offset) and masks it to a vertical fade,
                so it matches the soft gradient seamlessly instead of stamping a
                flat `colors.background` band over it. */}
            <MaskedView
              style={styles.topTaper}
              pointerEvents="none"
              maskElement={
                <LinearGradient
                  colors={["#000", "rgba(0,0,0,0)"]}
                  locations={[0, 1]}
                  style={StyleSheet.absoluteFill}
                />
              }
            >
              <View
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: -(insets.top + TOP_BAR_BAR_HEIGHT),
                  height: screenHeight,
                }}
              >
                <AppBackdrop />
              </View>
            </MaskedView>
          </>
        )}
        {replyFocus && <ReplyFocus
          key={`${conversationId}:${replyFocus.kind === "agent" ? replyFocus.threadId : replyFocus.id}`}
          root={replyFocus} messages={visibleMessages} conversationId={conversationId ?? ""}
          colors={colors} onClose={closeReplyFocus} hasOlder={hasOlderHistory} onLoadOlder={onLoadOlderHistory}
          renderMessage={(item, contextRef) => <ChatMessageRow item={item} animate={false} styles={styles} colors={colors}
            menuActive={false} isSelecting={false} anySelecting={false}
            onOpenArtifact={onOpenArtifact} onOpenStellaFile={onOpenStellaFile}
            onOpenMessageMenu={setMessageMenu} onEndSelecting={stopSelectingMessage}
            onOpenReply={setReplyFocus} contextRef={contextRef}
            desktopAccess={realtimeVoiceDesktopAccess} />}
        />}
        {/* Floating glass controls (scroll-to-bottom FAB + computer-options
            button) sit in a pass-through absolute overlay. This MUST be a plain
            View, not a GlassGroup/GlassContainer: the native glass container is
            a raw view that ignores `pointerEvents`, so a full-screen one swallows
            every touch over the chat (no scroll/tap) and, as a screen-spanning
            glass layer beneath the in-tree menu popovers, triggers Apple's
            glass-on-glass suppression that renders those menus clear. A plain
            `box-none` View passes touches through to the list and lets each
            button — and the popovers — keep their own Liquid Glass. */}
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {!searchOpen ? (
            <CatchUpPill
              visible={catchUpVisible}
              styles={styles}
              colors={colors}
            />
          ) : null}
          {!historyLoading && !empty ? (
            <ScrollToBottomFab
              visible={scroll.awayFromBottom}
              hasUnread={unread}
              onPress={scroll.scrollToBottom}
              styles={styles}
              colors={colors}
              bottomOffset={footerHeight + FLOATING_CONTROL_LIFT - 24}
            />
          ) : null}
          {hasRunningPill && !searchOpen ? (
            <Animated.View
              pointerEvents={floatingHidden ? "none" : "auto"}
              style={[
                styles.floatingRunningPill,
                {
                  bottom: footerHeight + FLOATING_CONTROL_ROW_LIFT,
                  // See ScrollToBottomFab: never fade a Liquid Glass ancestor's
                  // opacity (it drops the material). Fade only on the fallback;
                  // on glass the material fades via `present` and the pill's
                  // own content fade.
                  opacity: liquidGlassSupported ? 1 : floatingAnim,
                  transform: [
                    {
                      translateY: floatingAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [12, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <RunningTasksPill
                running={runningTasks}
                colors={colors}
                onPress={onPressRunningPill}
                present={!floatingHidden}
                contentOpacity={floatingAnim}
              />
            </Animated.View>
          ) : null}
        </View>
        {searchOpen && searchActive ? (
          <View
            style={[
              styles.searchDropdown,
              { maxHeight: Math.max(160, screenHeight * 0.5) },
            ]}
          >
            <GlassSurface
              glass="regular"
              legible
              radius={14}
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
            />
            {searchResults.length === 0 ? (
              <Text style={styles.searchDropdownEmpty}>
                No messages match “{searchQuery}”
              </Text>
            ) : (
              <FlatList<ChatSearchResult>
                data={searchResults}
                renderItem={renderSearchResult}
                keyExtractor={searchResultKey}
                extraData={searchQuery}
                initialNumToRender={8}
                maxToRenderPerBatch={8}
                windowSize={3}
                style={styles.searchDropdownList}
                contentContainerStyle={styles.searchDropdownContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}
              />
            )}
          </View>
        ) : null}
      </View>

      <Reanimated.View
        style={[
          styles.footerOverlay,
          composerKeyboardStyle,
          searchOpen && styles.hiddenFooter,
        ]}
        onLayout={onFooterLayout}
        pointerEvents={searchOpen ? "none" : "box-none"}
      >
        {offline ? (
          <View style={styles.offlineNotice} pointerEvents="none">
            <Icon name="wifi-off" size={13} color={colors.textMuted} />
            <Text
              style={styles.offlineNoticeText}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              You're offline
            </Text>
          </View>
        ) : null}
        <View
          style={[styles.composerWrap, { paddingBottom: composerBottomPad }]}
        >
          {composerIntervention}
          {showQuoteStrip && (
            <View style={styles.quoteStrip}>
              {quoteChips.map((quote) => (
                <View key={quote.id} style={styles.quoteChip}>
                  <Icon
                    name="quote"
                    size={13}
                    color={colors.textMuted}
                    style={styles.quoteChipIcon}
                  />
                  <Text
                    style={styles.quoteChipText}
                    numberOfLines={1}
                    maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                  >
                    {quote.text}
                  </Text>
                  <Pressable
                    style={styles.quoteChipRemove}
                    accessibilityRole="button"
                    accessibilityLabel="Remove quoted text"
                    onPress={() => onRemoveQuote?.(quote.id)}
                    hitSlop={8}
                  >
                    <Icon name="x" size={13} color={colors.textMuted} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}
          <GlassSurface
            glass="regular"
            // Interactive so a touch on the composer draws Apple's glow inside
            // the glass, the way every other Liquid Glass control answers a
            // tap. It does not take the touches: the input and buttons inside
            // keep receiving them.
            interactive
            // Softer than the menu tint: enough contrast for the input text
            // while keeping the composer visibly glassy over scrolling chat.
            tintColor={fadeHex(colors.surface, 0.5)}
            radius={isExpandedComposed ? 20 : 999}
            fallbackColor={colors.surface}
            style={styles.shell}
          >
            {showAttachmentStrip ? (
              // Pending attachments sit inside the composer, above the text,
              // in a horizontal rail so any number of them stays one row.
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                style={styles.attachmentStrip}
                contentContainerStyle={styles.attachmentStripContent}
              >
                {(attachments ?? []).map((attachment) => (
                  <View key={attachment.id} style={styles.attachmentThumb}>
                    {attachment.kind === "image" ? (
                      <Image
                        source={{ uri: attachment.uri }}
                        style={styles.attachmentImage}
                        contentFit="cover"
                      />
                    ) : (
                      <View style={styles.attachmentFile}>
                        <Icon
                          name="file-text"
                          size={18}
                          color={colors.textMuted}
                        />
                        <Text style={styles.attachmentFileName} numberOfLines={2}>
                          {attachment.name}
                        </Text>
                      </View>
                    )}
                    {attachment.status !== "ready" && (
                      <Pressable
                        style={styles.attachmentStatusScrim}
                        disabled={attachment.status === "uploading"}
                        accessibilityRole="button"
                        accessibilityLabel={
                          attachment.status === "uploading"
                            ? t("chat.attachments.uploading")
                            : t("chat.attachments.retryUpload")
                        }
                        onPress={() => onRetryAttachment?.(attachment.id)}
                      >
                        {attachment.status === "uploading" ? (
                          <ActivityIndicator size="small" color="#ffffff" />
                        ) : (
                          <Icon
                            name="refresh-cw"
                            size={16}
                            color="#ffffff"
                            weight="bold"
                          />
                        )}
                      </Pressable>
                    )}
                    <Pressable
                      style={styles.attachmentRemove}
                      accessibilityLabel={t("chat.attachments.remove")}
                      onPress={() => onRemoveAttachment?.(attachment.id)}
                      hitSlop={4}
                    >
                      <Icon
                        name="x"
                        size={12}
                        // The button's scrim is a fixed dark wash (it sits over
                        // arbitrary photo content), so the glyph has to be a
                        // fixed light colour too — `accentForeground` inverts
                        // with the theme and goes near-black in every dark one.
                        color="#ffffff"
                        weight="bold"
                      />
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            ) : null}
            {dictationInline ? (
              <View style={styles.formPill}>
                {plusButton}
                <DictationRecordingBar
                  onCancel={() => void dictation.cancel()}
                  onConfirm={() => void dictation.stop()}
                  onSend={stopAndSendVoice}
                />
              </View>
            ) : (
              // Single TextInput, stable JSX position across pill ⇄ expanded so
              // React reuses the same native UITextView when the shape swaps.
              // Swapping between two separate <TextInput> instances dropped
              // focus, which collapsed and re-summoned the keyboard on every
              // expand — visible as a flicker whenever a line wrapped.
              <View>
                <View
                  style={
                    isExpandedComposed
                      ? styles.expandedInputBlock
                      : styles.formPill
                  }
                >
                  {isExpandedComposed ? null : plusButton}
                  <TextInput
                    ref={inputRef}
                    multiline
                    scrollEnabled={isExpandedComposed}
                    onChangeText={onChangeDraft}
                    onContentSizeChange={handleContentSizeChange}
                    onFocus={() => {
                      // Focusing the composer (keyboard opening) exits any
                      // active message text selection.
                      if (selectingMessageId != null) stopSelectingMessage();
                    }}
                    blurOnSubmit={false}
                    placeholder={
                      isExpandedComposed
                        ? placeholder
                        : dictation.isTranscribing
                          ? "Transcribing\u2026"
                          : placeholder
                    }
                    placeholderTextColor={fadeHex(colors.textMuted, 0.35)}
                    selectionColor={colors.accent}
                    underlineColorAndroid="transparent"
                    style={
                      isExpandedComposed
                        ? [styles.inputExpanded, draft.length === 0 && styles.inputExpandedEmpty]
                        : styles.inputPill
                    }
                    value={draft}
                    editable={composerEnabled}
                  />
                  {isExpandedComposed ? null : canSubmit ? (
                    <AnimatedSubmitButton
                      canSubmit={canSubmit}
                      onPress={submit}
                      styles={styles}
                      colors={colors}
                      accessibilityLabel="Send message"
                    />
                  ) : streaming && onStop ? (
                    // Busy with an empty composer: keep the mic available so a
                    // dictated message can steer the active turn, and keep Stop
                    // reachable alongside it (mirrors the expanded toolbar,
                    // which always shows the mic).
                    <View style={styles.pillTrailingCluster}>
                      {micButton}
                      {realtimeVoiceButton}
                      <StopButton
                        onPress={onStop}
                        styles={styles}
                        colors={colors}
                      />
                    </View>
                  ) : (
                    <View style={styles.pillTrailingCluster}>
                      {micButton}
                      {realtimeVoiceButton}
                    </View>
                  )}
                </View>
                {isExpandedComposed && !dictationBelow ? (
                  <View style={styles.toolbar}>
                    <View style={styles.toolbarLeft}>{plusButton}</View>
                    <View style={styles.toolbarRight}>
                      {composerModelPicker?.pinned ? (
                        <View ref={modelPickerAnchorRef} collapsable={false}>
                          <Pressable
                            onPress={onPressModelPicker}
                            disabled={composerModelPicker.loading}
                            accessibilityRole="button"
                            accessibilityLabel={t("app.chat.miniModelPicker.triggerLabel", { model: composerModelPicker.label })}
                            style={({ pressed }) => [
                              styles.miniModelPickerTrigger,
                              pressed && styles.miniModelPickerTriggerPressed,
                            ]}
                          >
                            <Text
                              style={styles.miniModelPickerLabel}
                              numberOfLines={1}
                            >
                              {composerModelPicker.loading
                                ? "Loading…"
                                : composerModelPicker.label}
                            </Text>
                            <Icon
                              name="chevron-down"
                              size={13}
                              color={colors.textMuted}
                            />
                          </Pressable>
                        </View>
                      ) : null}
                      {micButton}
                      {realtimeVoiceButton}
                      {streaming && onStop && !hasText ? (
                        <StopButton
                          onPress={onStop}
                          styles={styles}
                          colors={colors}
                        />
                      ) : (
                        <AnimatedSubmitButton
                          canSubmit={canSubmit}
                          onPress={submit}
                          styles={styles}
                          colors={colors}
                          accessibilityLabel="Send message"
                        />
                      )}
                    </View>
                  </View>
                ) : null}
                {dictationBelow ? (
                  <View style={styles.dictationRow}>
                    <DictationRecordingBar
                      onCancel={() => void dictation.cancel()}
                      onConfirm={() => void dictation.stop()}
                      onSend={stopAndSendVoice}
                    />
                  </View>
                ) : null}
              </View>
            )}
          </GlassSurface>
        </View>
      </Reanimated.View>
      <PlusMenuPopover
        visible={Boolean(plusMenuAnchor) && plusMenuOptions.length > 0}
        anchor={plusMenuAnchor}
        options={plusMenuOptions}
        onDismiss={dismissPlusMenu}
        colors={colors}
        containerRef={rootRef}
        large
      />
      <PlusMenuPopover
        // Guard against an empty menu: an attachment-only message yields no
        // options, so the popover stays hidden rather than flashing a blank
        // sheet.
        visible={Boolean(messageMenu) && messageMenuOptions.length > 0}
        anchor={messageMenu?.anchor ?? null}
        options={messageMenuOptions}
        onDismiss={dismissMessageMenu}
        colors={colors}
        containerRef={rootRef}
        headerLabel={
          messageMenu
            ? formatMessageTimestamp(messageMenu.message.createdAt)
            : null
        }
        scrim
        large
      />
      <PlusMenuPopover
        visible={Boolean(modelPickerAnchor) && modelPickerOptions.length > 0}
        anchor={modelPickerAnchor}
        options={modelPickerOptions}
        onDismiss={dismissModelPicker}
        colors={colors}
        containerRef={rootRef}
        minWidth={320}
        wrapLabels
      />
      <RealtimeVoiceOverlay
        visible={realtimeVoiceOpen}
        conversationId={realtimeVoiceConversationId}
        execution={realtimeVoiceExecution}
        desktopAccess={realtimeVoiceDesktopAccess}
        signInRequired={realtimeVoiceSignInRequired}
        messages={messages}
        tasks={activityTasks ?? []}
        chatBusy={streaming}
        onPerformAction={performRealtimeVoiceAction}
        onClose={() => setRealtimeVoiceOpen(false)}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      marginHorizontal: -SHELL_CONTENT_PADDING,
      position: "relative",
    },

    // Anchored at the bottom of the screen, above the message list. The list
    // gets matching bottom inset (via `footerHeight`) so content can still be
    // scrolled fully into view; the transparent gutters around the composer
    // shell let messages peek through as they pass underneath.
    footerOverlay: {
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
    },

    viewport: { flex: 1, minHeight: 0, position: "relative" },
    messageList: { flex: 1 },
    topTaper: {
      height: EDGE_FADE,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    scrollToBottomFab: {
      bottom: 8,
      height: 32,
      position: "absolute",
      left: "50%",
      marginLeft: -16,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 5,
      elevation: 2,
      width: 32,
    },
    scrollToBottomFabInner: { flex: 1 },
    scrollToBottomFabGlass: {
      alignItems: "center",
      borderRadius: 16,
      flex: 1,
      justifyContent: "center",
      overflow: "hidden",
      width: 32,
    },
    // Hairline definition rendered as a fading overlay (not on the glass view
    // itself) so it dissolves with the material instead of lingering as a
    // visible outline once the button is hidden on Liquid Glass.
    scrollToBottomFabRing: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
    },
    scrollToBottomFabPressed: { opacity: 0.88 },
    // Running-count pill: floats at the composer's trailing edge while
    // background work is in flight.
    floatingRunningPill: {
      position: "absolute",
      right: CHAT_HORIZONTAL_INSET,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 5,
      elevation: 2,
    },
    // "Catching up" pill — top-center, overlaid (no layout participation).
    catchUpPill: {
      alignSelf: "center",
      elevation: 2,
      position: "absolute",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 5,
      top: 10,
    },
    catchUpPillGlass: {
      alignItems: "center",
      borderRadius: 15,
      height: 30,
      justifyContent: "center",
      overflow: "hidden",
      paddingHorizontal: 12,
    },
    // See scrollToBottomFabRing: fading overlay so the hairline dissolves with
    // the material instead of lingering as an outline.
    catchUpPillRing: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
    },
    catchUpPillRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 7,
    },
    catchUpPillText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12.5,
    },
    scrollToBottomDot: {
      backgroundColor: colors.accent,
      borderColor: colors.surface,
      borderRadius: 4,
      borderWidth: 1.5,
      height: 8,
      position: "absolute",
      right: 4,
      top: 4,
      width: 8,
    },
    list: {
      paddingHorizontal: CHAT_HORIZONTAL_INSET,
      paddingTop: 80,
      paddingBottom: EDGE_FADE,
    },
    itemSeparator: { height: MESSAGE_LIST_GAP },
    // Fixed-height tail below the last message. Hosts the inline working
    // indicator and keeps its footprint constant whether or not it's showing.
    chatTail: {
      minHeight: CHAT_TAIL_GAP,
      paddingTop: 4,
      justifyContent: "flex-start",
    },

    emptyState: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },
    // Compact results popover that drops in just below the search field,
    // floating over the chat (which stays visible). Matches the `+` menu
    // surface so it reads as a menu, not a takeover.
    searchDropdown: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 4,
      left: 8,
      overflow: "hidden",
      position: "absolute",
      right: 8,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 12,
      top: 6,
    },
    searchDropdownList: {
      flexGrow: 0,
    },
    searchDropdownContent: {
      paddingVertical: 4,
    },
    searchDropdownEmpty: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      paddingHorizontal: 16,
      paddingVertical: 18,
      textAlign: "center",
    },
    searchResultRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    searchResultRowPressed: {
      backgroundColor: fadeHex(colors.text, 0.06),
    },
    searchResultText: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 19,
    },
    searchResultMatch: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
    },
    hiddenFooter: {
      display: "none",
    },

    userRow: { flexDirection: "row", justifyContent: "flex-end" },
    userColumn: { alignItems: "flex-end", maxWidth: "92%" },
    userBubble: {
      backgroundColor: colors.userBubbleFill,
      borderRadius: 18,
      borderBottomRightRadius: 4,
      padding: 12,
    },
    userBubbleQueued: { opacity: 0.55 },
    queuedTag: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 11,
      letterSpacing: 0.4,
      marginTop: 4,
      marginRight: 4,
      textTransform: "uppercase",
    },
    stoppedTag: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 11,
      letterSpacing: 0.4,
      marginTop: 6,
      textTransform: "uppercase",
    },
    cloudTag: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      letterSpacing: -0.1,
      marginTop: 6,
      opacity: 0.8,
    },
    offlineNotice: {
      alignItems: "center",
      alignSelf: "center",
      flexDirection: "row",
      gap: 6,
      paddingBottom: 2,
      paddingTop: 4,
    },
    offlineNoticeText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
    },

    userText: {
      color: colors.userBubbleText,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      letterSpacing: 0.03 * 17,
      lineHeight: 17 * 1.52,
    },
    userToggle: {
      alignSelf: "flex-end",
      // Muted version of the bubble's own text color (desktop: 68% alpha).
      color: fadeHex(colors.userBubbleText, 0.68),
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
      lineHeight: 16,
      marginTop: 6,
    },
    userTogglePressed: {
      color: colors.text,
    },
    userThumbStrip: {
      alignSelf: "flex-start",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
    },
    userThumbsAbove: { marginBottom: 8 },
    userThumbImage: {
      backgroundColor: colors.muted,
      borderRadius: 8,
      height: 84,
      width: 84,
    },
    userDocumentStrip: {
      alignSelf: "flex-start",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
    },
    userDocumentChip: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.textMuted, 0.14),
      borderRadius: 999,
      flexDirection: "row",
      gap: 4,
      maxWidth: 200,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    userDocumentName: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      letterSpacing: -0.1,
    },

    assistantRow: { paddingVertical: 4 },
    /**
     * Mirror of `userBubble`, flipped: same radius family with the tightened
     * corner on the bottom LEFT, the quieter elevated surface (`card`) instead
     * of the accent tint, and a hairline `border` rather than `borderStrong` so
     * the assistant reads as the calmer of the two speakers.
     *
     * Vertical padding is asymmetric on purpose: markdown blocks carry their
     * own trailing margin (a paragraph's is 10 — see `buildNodeStyles` in
     * AssistantMarkdown), so a small `paddingBottom` plus that margin lands at
     * the same ~10-12pt optical inset as the top, with no negative margins that
     * could clip a trailing code block.
     */
    assistantBubble: {
      alignSelf: "flex-start",
      overflow: "hidden",
      borderRadius: 18,
      borderBottomLeftRadius: 4,
      maxWidth: "100%",
      paddingBottom: 2,
      paddingHorizontal: 13,
      paddingTop: 10,
    },
    // Yoga stretches block Markdown to the measured list-cell width in the
    // same layout pass, giving nested list/scroller children a definite bound.
    // Plain text keeps the intrinsic hugging style above.
    assistantBlockBubble: { alignSelf: "stretch" },
    // Schedule tool receipt — a plain text line in the conversation flow
    // (desktop parity: no chip or card), slightly quieter than reply prose.
    scheduleReceipt: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      letterSpacing: -0.1,
      lineHeight: 20,
      marginTop: 6,
    },
    artifactGroup: { gap: 10 },
    artifactGroupSpaced: { marginTop: 10 },
    messageActions: {
      flexDirection: "row",
      gap: 2,
      marginLeft: -8,
      marginTop: 6,
    },
    messageActionButton: {
      alignItems: "center",
      borderRadius: 8,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    messageActionButtonPressed: {
      backgroundColor: colors.muted,
    },
    assistantText: {
      color: colors.assistantBubbleText,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      fontWeight: "400",
      letterSpacing: 0.03 * 17,
      lineHeight: 17 * 1.52,
    },

    composerWrap: {
      alignItems: "center",
      flexShrink: 0,
      gap: 8,
      paddingBottom: 6,
      paddingHorizontal: CHAT_HORIZONTAL_INSET,
      paddingTop: 12,
    },

    // Attachment rail inside the shell: sized by its content so the input
    // below keeps its own height, scrolling sideways once thumbs overflow.
    attachmentStrip: {
      flexGrow: 0,
      flexShrink: 0,
    },
    attachmentStripContent: {
      flexDirection: "row",
      gap: 8,
      paddingBottom: 2,
      paddingHorizontal: 12,
      paddingTop: 12,
    },
    // Removable quoted-text chips (message-menu Quote / assistant "Ask Stella").
    // Stretched left like the attachment strip; each chip collapses the quote to
    // a single line so the composer never fills with a pasted paragraph.
    quoteStrip: {
      alignSelf: "stretch",
      flexDirection: "column",
      gap: 6,
      paddingBottom: 10,
      paddingHorizontal: 4,
    },
    quoteChip: {
      alignItems: "center",
      alignSelf: "flex-start",
      // Opaque solid surface (not translucent) so the chip reads as a distinct
      // panel over the glass composer, matching the app's other solid surfaces.
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 6,
      maxWidth: "100%",
      paddingLeft: 10,
      paddingRight: 6,
      paddingVertical: 6,
    },
    quoteChipIcon: { opacity: 0.8 },
    quoteChipText: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    quoteChipRemove: {
      alignItems: "center",
      justifyContent: "center",
      height: 20,
      width: 20,
    },
    // Sent-message variant of the quote chip: right-aligned above the user
    // bubble (matching the bubble's trailing edge) with a little breathing room.
    userQuoteChip: {
      alignSelf: "flex-end",
      marginBottom: 6,
    },
    attachmentThumb: {
      borderRadius: 10,
      height: 64,
      overflow: "hidden",
      position: "relative",
      width: 64,
    },
    attachmentImage: { borderRadius: 10, height: 64, width: 64 },
    // A document has no preview to show, so the tile becomes its name.
    attachmentFile: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.textMuted, 0.12),
      borderRadius: 10,
      gap: 2,
      height: 64,
      justifyContent: "center",
      paddingHorizontal: 4,
      width: 64,
    },
    attachmentFileName: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 9,
      letterSpacing: -0.1,
      textAlign: "center",
    },
    // Covers the whole tile while an upload is in flight or broken, so a chip
    // never reads as ready when it is not.
    attachmentStatusScrim: {
      alignItems: "center",
      backgroundColor: "rgba(0,0,0,0.45)",
      borderRadius: 10,
      bottom: 0,
      justifyContent: "center",
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    attachmentRemove: {
      alignItems: "center",
      backgroundColor: "rgba(0,0,0,0.55)",
      borderRadius: 10,
      height: 20,
      justifyContent: "center",
      position: "absolute",
      right: 3,
      top: 3,
      width: 20,
    },

    shell: {
      borderColor: colors.panelSurfaceBorder,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
      width: "100%",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.08,
      shadowRadius: 24,
      elevation: 8,
    },

    formPill: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      minHeight: 50,
      paddingHorizontal: 8,
      paddingVertical: 8,
    },
    expandedInputBlock: { flexDirection: "column" },

    inputPill: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      letterSpacing: -0.2,
      lineHeight: 22,
      maxHeight: 32,
      paddingHorizontal: 4,
      paddingVertical: 0,
      ...(Platform.OS === "android"
        ? { textAlignVertical: "center" as const }
        : {}),
    },
    inputExpanded: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      letterSpacing: -0.2,
      lineHeight: 24,
      maxHeight: 200,
      minHeight: 40,
      paddingHorizontal: 16,
      paddingTop: 11,
      paddingBottom: 2,
    },
    // A pinned model picker keeps the same scrollable UITextView expanded
    // after send. Its old intrinsic content height can survive clearing value;
    // an empty draft has a known resting height, independent of that cache.
    inputExpandedEmpty: { height: 40 },

    toolbar: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingBottom: 6,
      paddingHorizontal: 8,
      paddingTop: 2,
    },
    toolbarLeft: { flexDirection: "row", alignItems: "center", gap: 4 },
    toolbarRight: { flexDirection: "row", alignItems: "center", gap: 8 },
    miniModelPickerTrigger: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      height: 30,
      maxWidth: 154,
      paddingHorizontal: 10,
    },
    miniModelPickerTriggerPressed: {
      opacity: 0.55,
    },
    miniModelPickerLabel: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.15,
    },
    pillTrailingCluster: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },

    dictationRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
      paddingBottom: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: fadeHex(colors.border, 0.5),
    },

    addButton: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.text, 0.06),
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    submitButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    micButton: {
      alignItems: "center",
      backgroundColor: "transparent",
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    micButtonActive: { backgroundColor: colors.accent },
    realtimeVoiceButton: {
      alignItems: "center",
      backgroundColor: "transparent",
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    realtimeVoiceButtonPressed: {
      opacity: 0.55,
      transform: [{ scale: 0.96 }],
    },
  } as const);
