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
  Keyboard,
  LayoutChangeEvent,
  LayoutAnimation,
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
import { appendOfflineChatAttachments } from "../lib/offline-chat-request";
import Reanimated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./Icon";
import { GlassSurface, liquidGlassSupported } from "./glass";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { AssistantTextSelection } from "./AssistantTextSelection";
import { AppBackdrop, TOP_BAR_BAR_HEIGHT } from "./AppBackdrop";
import { ArtifactCard } from "./ArtifactCard";
import { AgentWorkCard } from "./AgentWorkCard";
import { MapRouteCard } from "./MapRouteCard";
import { ToolActivityTrace } from "./ToolActivityTrace";
import { ActivityPill } from "./ActivityPill";
import { deriveToolActivity } from "../lib/tool-activity";
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
  settledAgentWorkCards,
  consolidateRowArtifacts,
} from "../lib/agent-artifact-consolidation";
import { DictationRecordingBar } from "./DictationRecordingBar";
import {
  WorkingIndicator,
  WORKING_INDICATOR_SLOT_HEIGHT,
} from "./WorkingIndicator";
import type { WorkingIndicatorState } from "./working-indicator-state";
import { useDictation } from "../lib/dictation";
import { useChatSearch } from "../lib/chat-search";
import { notifySuccess, tapMedium, tapLight } from "../lib/haptics";
import {
  pauseReadAloud,
  resumeReadAloud,
  speakReply,
  stopReadAloud,
  useReadAloudPreference,
  useReadAloudState,
} from "../lib/read-aloud";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fadeHex } from "../theme/oklch";
import { fonts } from "../theme/fonts";
import type { ChatArtifact, ChatMessage, MobileTask } from "../types";

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
/** Small upward nudge after send so the user bubble clears room for the reply. */
const POST_SEND_NUDGE_PX = 128;
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

function useChatScroll(listTrailingSlackPx: number) {
  const listRef = useRef<LegendListRef>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const nearBottomLimit = SCROLL_NEAR_BOTTOM_BASE_PX + listTrailingSlackPx;
  const atBottomLimit = SCROLL_AT_BOTTOM_THRESHOLD + listTrailingSlackPx;
  const awayFromBottomLimit =
    SCROLL_AWAY_FROM_BOTTOM_BASE_PX + listTrailingSlackPx;
  const metricsRef = useRef({ offsetY: 0, contentHeight: 0, layoutHeight: 0 });
  const contentHeightRef = useRef(0);
  const followArmedRef = useRef(true);
  const followTargetOffsetRef = useRef<number | null>(null);
  const followRafRef = useRef(0);
  const followAnimatingUntilMsRef = useRef(0);
  const streamingAssistantHeightRef = useRef(0);
  /** Content height before the next assistant-driven layout pass. */
  const assistantLayoutBaselineRef = useRef<number | null>(null);
  /** True while the user's finger is actively dragging the list. */
  const isDraggingRef = useRef(false);
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

  useEffect(() => () => stopFollowLoop(), [stopFollowLoop]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      metricsRef.current = {
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        layoutHeight: layoutMeasurement.height,
      };
      contentHeightRef.current = contentSize.height;

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
        if (!isDraggingRef.current) followArmedRef.current = true;
      } else if (
        distFromBottom > nearBottomLimit &&
        followTargetOffsetRef.current === null &&
        !followRafRef.current &&
        Date.now() > followAnimatingUntilMsRef.current
      ) {
        followArmedRef.current = false;
        stopFollowLoop();
      }

      setAwayFromBottom(hasOverflow && distFromBottom > awayFromBottomLimit);
    },
    [atBottomLimit, awayFromBottomLimit, nearBottomLimit, stopFollowLoop],
  );

  const resetAssistantAutoScroll = useCallback(() => {
    followArmedRef.current = true;
    assistantLayoutBaselineRef.current = null;
    streamingAssistantHeightRef.current = 0;
    stopFollowLoop();
  }, [stopFollowLoop]);

  const releaseFollow = useCallback(() => {
    followArmedRef.current = false;
    stopFollowLoop();
  }, [stopFollowLoop]);

  // The user grabbed the list — drop follow immediately and remember the drag
  // is live so `onScroll` won't re-arm until the gesture settles.
  const onScrollBeginDrag = useCallback(() => {
    isDraggingRef.current = true;
    releaseFollow();
  }, [releaseFollow]);

  // Gesture settled (lift, or end of momentum). Clear the drag flag and re-arm
  // only if the user came to rest at the true tail.
  const onScrollSettle = useCallback(() => {
    isDraggingRef.current = false;
    const { offsetY, contentHeight, layoutHeight } = metricsRef.current;
    const distFromBottom = Math.max(0, contentHeight - offsetY - layoutHeight);
    if (distFromBottom <= atBottomLimit) followArmedRef.current = true;
  }, [atBottomLimit]);

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
    const assistantHeight = streamingAssistantHeightRef.current;
    if (assistantHeight <= 0) return;

    const { layoutHeight } = metricsRef.current;
    if (layoutHeight <= 0) return;

    const contentHeight = contentHeightRef.current;
    const rowBottom = Math.max(0, contentHeight - listTrailingSlackPx);
    const rowTop = Math.max(0, rowBottom - assistantHeight);
    const desiredScrollTop = Math.max(0, contentHeight - layoutHeight);
    const pinnedTop = Math.max(0, rowTop - FOLLOW_TOP_PEEK_PX);
    setFollowTarget(Math.min(pinnedTop, desiredScrollTop));
  }, [listTrailingSlackPx, setFollowTarget]);

  const onStreamingAssistantLayout = useCallback(
    (event: LayoutChangeEvent) => {
      streamingAssistantHeightRef.current = event.nativeEvent.layout.height;
      followActiveAssistantRow();
    },
    [followActiveAssistantRow],
  );

  const clearStreamingAssistantLayout = useCallback(() => {
    streamingAssistantHeightRef.current = 0;
    assistantLayoutBaselineRef.current = null;
    stopFollowLoop();
  }, [stopFollowLoop]);

  const onListContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeightRef.current = height;
      metricsRef.current.contentHeight = height;

      const baseline = assistantLayoutBaselineRef.current;
      if (baseline === null || height <= baseline) {
        followActiveAssistantRow();
        return;
      }

      assistantLayoutBaselineRef.current = null;
      if (streamingAssistantHeightRef.current > 0) {
        followActiveAssistantRow();
      } else {
        setFollowTarget(metricsRef.current.offsetY + height - baseline);
      }
    },
    [followActiveAssistantRow, setFollowTarget],
  );

  const scrollToBottom = useCallback(() => {
    resetAssistantAutoScroll();
    requestAnimationFrame(() =>
      listRef.current?.scrollToEnd({ animated: true }),
    );
  }, [resetAssistantAutoScroll]);

  /**
   * After send, bump the viewport slightly when the user is already near the
   * bottom — mirrors desktop `nudgeAfterSend` / `POST_SEND_USER_MESSAGE_BREATHING_PX`.
   */
  const nudgeAfterSend = useCallback(() => {
    const { offsetY, layoutHeight } = metricsRef.current;
    const contentHeight = contentHeightRef.current;
    const distFromBottom = Math.max(0, contentHeight - offsetY - layoutHeight);
    if (distFromBottom > nearBottomLimit) return;

    followArmedRef.current = true;
    stopFollowLoop();

    const applyNudge = () => {
      const metrics = metricsRef.current;
      const height = contentHeightRef.current;
      const dist = Math.max(0, height - metrics.offsetY - metrics.layoutHeight);
      if (dist > nearBottomLimit) return;

      const maxOffset = Math.max(0, height - metrics.layoutHeight);
      const newOffset = Math.min(
        metrics.offsetY + POST_SEND_NUDGE_PX,
        maxOffset,
      );
      // Gentle one-shot ease-out on the shared spring loop. If the reply starts
      // streaming mid-nudge, its (non-gentle) target update takes over the same
      // loop — the two motions blend instead of fighting separate animations.
      setFollowTarget(newOffset, true);
    };

    requestAnimationFrame(() => requestAnimationFrame(applyNudge));
  }, [nearBottomLimit, setFollowTarget, stopFollowLoop]);

  return {
    listRef,
    onScroll,
    onListContentSizeChange,
    onStreamingAssistantLayout,
    clearStreamingAssistantLayout,
    scrollToBottom,
    resetAssistantAutoScroll,
    prepareAssistantLayoutFollow,
    onScrollBeginDrag,
    onScrollSettle,
    nudgeAfterSend,
    awayFromBottom,
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
 * Line count at which a user message collapses behind a "Show more" toggle.
 * Deliberately tighter than the desktop cap (12 lines on the full chat surface,
 * 8 on the compact one) because phone bubbles have far less vertical room.
 */
const USER_MESSAGE_COLLAPSE_LINES = 6;

/**
 * User message body with collapse/expand for long text — the mobile analogue
 * of desktop's `UserMessageBody`. Collapsed by default when the rendered text
 * exceeds `USER_MESSAGE_COLLAPSE_LINES`; a tappable "Show more" / "Show less"
 * toggle then reveals or re-hides the overflow.
 *
 * Overflow is detected by measuring the full line count on the first
 * (unclamped) text layout pass, after which `numberOfLines` clamps the
 * collapsed state.
 */
function UserMessageText({
  text,
  styles,
}: {
  text: string;
  styles: ChatStyles;
}) {
  const [expanded, setExpanded] = useState(false);
  const [totalLines, setTotalLines] = useState<number | null>(null);

  // Reset when the underlying message text changes (row reuse across items).
  useEffect(() => {
    setExpanded(false);
    setTotalLines(null);
  }, [text]);

  const handleTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const lines = event.nativeEvent.lines.length;
      setTotalLines((prev) => (prev === null ? lines : prev));
    },
    [],
  );

  const isTruncatable =
    totalLines !== null && totalLines > USER_MESSAGE_COLLAPSE_LINES;
  const clamp = totalLines !== null && isTruncatable && !expanded;

  return (
    <>
      <Text
        style={styles.userText}
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        onTextLayout={handleTextLayout}
        numberOfLines={clamp ? USER_MESSAGE_COLLAPSE_LINES : undefined}
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

const ChatMessageRow = memo(function ChatMessageRow({
  item,
  styles,
  colors,
  isStreaming,
  onOpenArtifact,
  onOpenMessageMenu,
  onAskStella,
}: {
  item: ChatMessage;
  styles: ChatStyles;
  colors: Colors;
  /** True for the trailing assistant message while a reply is mid-stream. */
  isStreaming: boolean;
  onOpenArtifact?: (artifact: ChatArtifact) => void;
  onOpenMessageMenu: (request: MessageMenuRequest) => void;
  /** Puts a selected assistant snippet into the composer ("Ask Stella"). */
  onAskStella: (text: string) => void;
}) {
  // Assistant-only: press-and-hold enters native text selection with a custom
  // Copy / Ask Stella / Select All row (see the assistant branch below). The
  // user-message long-press menu is unchanged.
  const [selecting, setSelecting] = useState(false);
  const openMenu = (e: { nativeEvent: { pageX: number; pageY: number } }) => {
    if (!item.text.trim()) return;
    tapLight();
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
  // replaced on every streamed append, but its artifacts/toolSteps keep their
  // identity, so these derivations must not re-run (and mint fresh objects
  // that defeat child memoization) once per frame.
  const consolidated = useMemo(
    () => consolidateRowArtifacts(item.artifacts ?? []),
    [item.artifacts],
  );
  const toolActivity = useMemo(
    () => (item.toolSteps ? deriveToolActivity(item.toolSteps) : undefined),
    [item.toolSteps],
  );

  if (item.role === "user") {
    const thumbs = item.thumbnailUris ?? [];
    const showThumbs = thumbs.length > 0;
    const showText = item.text.trim().length > 0;
    return (
      <View style={styles.userRow}>
        <View style={styles.userColumn}>
          <Pressable
            onLongPress={openMenu}
            delayLongPress={350}
            accessibilityLabel="Long press for message actions"
            style={[styles.userBubble, item.queued && styles.userBubbleQueued]}
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
            {showText ? (
              <UserMessageText text={item.text} styles={styles} />
            ) : null}
          </Pressable>
          {item.queued ? (
            <Text
              style={styles.queuedTag}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              Queued
            </Text>
          ) : null}
        </View>
      </View>
    );
  }
  const hasText = item.text.trim().length > 0;
  // Desktop-parity consolidation: on a turn that delegated background work,
  // the produced files fold INTO the agent-work card as pills (revealed
  // together at completion) instead of popping as loose file cards; noise
  // writes are filtered and declared deliverables lead. Rows without agent
  // work keep the classic loose cards for orchestrator-direct outputs.
  const {
    agentWork: agentWorkArtifacts,
    maps: mapArtifacts,
    agentFiles,
    looseFiles,
    agentWorkSettled,
  } = consolidated;
  const isStandIn = isStandInArtifactRow(item);
  // Agent-work is non-openable status UI, so it can mount as soon as the bridge
  // knows about the background task — including while the answer text is still
  // streaming. File artifacts stay conservative: only show them once the
  // assistant row has finalized so tapping never races a partial artifact.
  const showAgentWork = !isStandIn && agentWorkArtifacts.length > 0;
  // Agent-produced files reveal only once every covered agent settled — the
  // files ride the run's completion, so they're complete by then.
  const showAgentFiles =
    showAgentWork &&
    agentWorkSettled &&
    Boolean(onOpenArtifact) &&
    agentFiles.length > 0;
  // Map cards are self-contained payloads (no file to race), but wait for the
  // row to finalize so the card doesn't pop in mid-stream.
  const showMapArtifacts =
    !isStreaming && !isStandIn && mapArtifacts.length > 0;
  const showFileArtifacts =
    !isStreaming &&
    !isStandIn &&
    Boolean(onOpenArtifact) &&
    looseFiles.length > 0;
  const showArtifacts = showAgentWork || showMapArtifacts || showFileArtifacts;
  return (
    <View style={styles.assistantRow}>
      {hasText ? (
        selecting && !isStreaming ? (
          // Native text selection with a custom Copy / Ask Stella / Select All
          // row. Assistant messages never open the user-message menu.
          <AssistantTextSelection
            text={item.text}
            colors={colors}
            onAskStella={onAskStella}
            onDismiss={() => setSelecting(false)}
          />
        ) : (
          // Press-and-hold a finished reply to enter that selection mode. The
          // wrapping View in `AssistantMarkdown` lets this parent Pressable win
          // the long-press while taps still reach inline links; code blocks
          // keep their own native selection.
          <Pressable
            onLongPress={
              isStreaming
                ? undefined
                : () => {
                    tapLight();
                    setSelecting(true);
                  }
            }
            delayLongPress={350}
            accessibilityLabel="Press and hold to select this message"
          >
            <AssistantMarkdown
              text={item.text}
              colors={colors}
              isStreaming={isStreaming}
            />
          </Pressable>
        )
      ) : null}
      {toolActivity ? (
        <ToolActivityTrace group={toolActivity} colors={colors} />
      ) : null}
      {showArtifacts ? (
        <View
          style={[styles.artifactGroup, hasText && styles.artifactGroupSpaced]}
        >
          {agentWorkArtifacts.flatMap((artifact, index) => {
            // Desktop posts a distinct completion card per finished agent. A
            // settled multi-agent group splits into one card per agent so each
            // completion reads as its own card instead of the sibling
            // completions coalescing into — and overwriting — one grouped card.
            const splitCards = settledAgentWorkCards(artifact);
            if (splitCards.length > 1) {
              return splitCards.map((card) => (
                <AgentWorkCard
                  key={card.key}
                  payload={card.payload}
                  colors={colors}
                  {...(card.sections.length > 0 && onOpenArtifact
                    ? { sections: card.sections, onOpenArtifact }
                    : {})}
                />
              ));
            }
            // Single grouped card: prefer the bridge's per-agent sections
            // (desktop-computed attribution), gated so files appear on the
            // finish card only — never mid-run — matching desktop. Older
            // desktops omit the field — fall back to folding the row's own
            // files into the last card once every covered agent settled (with
            // several transitional per-agent cards on one row the consolidated
            // list rides the last; the sync path collapses them into one
            // grouped card per turn).
            const bridgeSections = inlineAgentWorkCardSections(artifact);
            const sections =
              bridgeSections ??
              (showAgentFiles && index === agentWorkArtifacts.length - 1
                ? [{ key: `${artifact.id}:files`, files: agentFiles }]
                : []);
            return [
              <AgentWorkCard
                key={artifact.id}
                payload={artifact.payload}
                colors={colors}
                {...(sections.length > 0 && onOpenArtifact
                  ? { sections, onOpenArtifact }
                  : {})}
              />,
            ];
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
          {showFileArtifacts && onOpenArtifact
            ? looseFiles.map((artifact) => (
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
      {item.cloudFallback && !isStreaming ? (
        <Text
          style={styles.cloudTag}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          Answered while your computer was offline
        </Text>
      ) : null}
      {!isStreaming ? (
        <AssistantActions
          text={item.text}
          messageId={item.id}
          styles={styles}
          colors={colors}
        />
      ) : null}
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
 * in-flight reply AND drops any queued follow-ups — the user explicitly asked
 * to halt the turn, so resuming requires re-sending.
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
const PLUS_MENU_EDGE_PADDING = 12;

function PlusMenuPopover({
  visible,
  anchor,
  options,
  onDismiss,
  colors,
  containerRef,
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
  const desiredWidth = Math.max(PLUS_MENU_MIN_WIDTH, measured?.width ?? 0);
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
            minWidth: PLUS_MENU_MIN_WIDTH,
            top: measured ? top : anchor.y - PLUS_MENU_GAP - origin.y,
            transform: [{ translateY: enterTranslateY }, { scale: enterScale }],
          },
        ]}
      >
        <GlassSurface
          glass="regular"
          legible
          present={Boolean(measured)}
          radius={14}
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
                  isFirst && styles.menuItemFirst,
                  isLast && styles.menuItemLast,
                  pressed && styles.menuItemPressed,
                  option.disabled && styles.menuItemDisabled,
                ]}
              >
                <Icon
                  name={option.icon}
                  size={16}
                  color={option.disabled ? colors.textMuted : colors.text}
                  style={styles.menuItemIcon}
                />
                <Text
                  style={[
                    styles.menuItemLabel,
                    option.disabled && styles.menuItemLabelMuted,
                  ]}
                  numberOfLines={1}
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
      ...StyleSheet.absoluteFillObject,
      zIndex: 50,
    },
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

const SearchResultRow = memo(function SearchResultRow({
  message,
  query,
  styles,
  colors,
  onPress,
}: {
  message: ChatMessage;
  query: string;
  styles: ChatStyles;
  colors: Colors;
  onPress: () => void;
}) {
  const snippet = useMemo(
    () => buildSearchSnippet(message.text, query),
    [message.text, query],
  );
  return (
    <Pressable
      onPress={onPress}
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

  /** Composer input value. */
  draft: string;
  /** Composer input change handler. */
  onChangeDraft: (next: string) => void;
  /** Whether the composer accepts text (typing + sending). */
  composerEnabled?: boolean;
  /** Visible placeholder when not transcribing. */
  placeholder: string;

  /** Computed once per parent re-render; controls submit button enabled. */
  canSubmit: boolean;
  /** Triggered by the send button or `return` key. */
  onSubmit: () => void;
  /**
   * Optional stop handler. When provided AND `streaming` is true, the send
   * button is replaced by a stop button that calls this. Used to cancel the
   * in-flight reply (and any queued follow-ups) for both the local chat
   * stream and the computer-chat round trip.
   */
  onStop?: () => void;

  /** Show a small `+` menu entry for attaching photos. */
  enableAttachments: boolean;
  /** Current attachments — only meaningful when `enableAttachments`. */
  attachments?: ImagePicker.ImagePickerAsset[];
  /** Replace the attachment list (e.g. add picked or remove one). */
  onChangeAttachments?: (next: ImagePicker.ImagePickerAsset[]) => void;
  /**
   * Optional overall cap for this transport. Picker-level limits reset per
   * launch, so normal chat supplies its backend request limit here.
   */
  maxAttachments?: number;

  /**
   * Opens the computer device sheet (status, wake, view-screen,
   * model settings). When provided, a floating gear button renders above the
   * composer. The cloud chat omits it.
   */
  onOpenDeviceSheet?: () => void;

  /** Headers passed to the dictation upload (e.g. mobile device id for guests). */
  dictationAnonymous: boolean;
  dictationHeaders?: Record<string, string>;

  /** Opens a desktop artifact linked from an assistant message. */
  onOpenArtifact?: (artifact: ChatArtifact) => void;

  /**
   * Background tasks for the floating activity pill (running count). The
   * cloud chat omits it.
   */
  activityTasks?: MobileTask[];

  /**
   * Opens the activity hub sheet (tasks + files + search). When provided, the
   * always-present activity pill renders to the left of the floating settings
   * button with the same visibility rules. The cloud chat omits it.
   */
  onOpenActivityHub?: () => void;

  /**
   * True while a catch-up sync is pulling turns the phone may have missed
   * (landing, foreground/refocus, Force Sync — see `useChatThread`). Renders a
   * small transient "Catching up" pill at the top of the transcript, debounced
   * by `useCatchUpIndicatorVisible` so instant pulls never flash it.
   * Steady-state polls and send-path pulls must not set this.
   */
  catchingUp?: boolean;
};

export function ChatPane({
  messages,
  streaming,
  workingIndicator,
  offline = false,
  emptyContent,
  historyLoading = false,
  draft,
  onChangeDraft,
  composerEnabled = true,
  placeholder,
  canSubmit,
  onSubmit,
  onStop,
  enableAttachments,
  attachments,
  onChangeAttachments,
  maxAttachments,
  onOpenDeviceSheet,
  dictationAnonymous,
  dictationHeaders,
  onOpenArtifact,
  activityTasks,
  onOpenActivityHub,
  catchingUp = false,
}: ChatPaneProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
  // The reserved tail region is real list content below the last row, so the
  // scroll-follow math must count it as trailing slack alongside the edge fade,
  // composer inset, and the keyboard reserve — otherwise the stream-follow
  // target lands a tail-gap too low and over-scrolls past the assistant row.
  const listTrailingSlackPx =
    EDGE_FADE + footerHeight + keyboardExtra + CHAT_TAIL_GAP;

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
  const scroll = useChatScroll(listTrailingSlackPx);

  const [unread, setUnread] = useState(false);
  const prevLenRef = useRef(0);
  const wasStreamingRef = useRef(false);
  const spokenAssistantIdsRef = useRef<Set<string>>(new Set());
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  const visibleMessages = useMemo(() => visibleChatMessages(messages), [messages]);
  const lastMessage = visibleMessages[visibleMessages.length - 1];
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

  useEffect(() => {
    if (streaming) scroll.resetAssistantAutoScroll();
  }, [streaming, scroll.resetAssistantAutoScroll]);

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

  useEffect(() => {
    if (!readAloud.enabled) {
      // Drop the latch, or a stream that ended while read-aloud was off would
      // speak a stale reply the moment the preference is re-enabled.
      wasStreamingRef.current = false;
      return;
    }
    if (streaming) {
      wasStreamingRef.current = true;
      return;
    }
    if (!wasStreamingRef.current) return;
    wasStreamingRef.current = false;
    const latestAssistant = [...visibleMessages]
      .reverse()
      .find((message) => message.role === "assistant" && message.text.trim());
    if (
      !latestAssistant ||
      spokenAssistantIdsRef.current.has(latestAssistant.id)
    ) {
      return;
    }
    spokenAssistantIdsRef.current.add(latestAssistant.id);
    void speakReply(latestAssistant.text, latestAssistant.id);
  }, [visibleMessages, readAloud.enabled, streaming]);

  const [expanded, setExpanded] = useState(false);

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
    onSubmit();
    scroll.nudgeAfterSend();
    Keyboard.dismiss();
  }, [onSubmit, scroll.nudgeAfterSend]);

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
    if (dictation.status === "idle") tapLight();
    await dictation.toggle();
  }, [dictation]);

  // "Stop dictation and send": stop recording, then auto-submit once the
  // transcript has landed in the draft. `dictation.stop()` resolves after the
  // round-trip, but `onTranscript` updates the draft through the parent, so we
  // can't read it back synchronously here. Arm a flag and let the effect below
  // fire submit on the render where the transcript has committed and dictation
  // has returned to idle.
  const stopAndSendVoice = useCallback(() => {
    pendingVoiceSendRef.current = true;
    voiceSendTargetRef.current = null;
    void dictation.stop();
  }, [dictation]);

  useEffect(() => {
    if (!pendingVoiceSendRef.current) return;
    // Wait until transcription has fully finished (idle), not just stopped.
    if (dictation.status !== "idle") return;
    // If a transcript landed, hold off until the draft state actually reflects
    // it — `appendTranscript` and the status update can commit separately.
    const target = voiceSendTargetRef.current;
    if (target !== null && draft !== target) return;
    pendingVoiceSendRef.current = false;
    voiceSendTargetRef.current = null;
    // A too-short clip or failed transcription leaves nothing new to send;
    // don't fire on an empty composer.
    if (draft.trim().length > 0 || (attachments?.length ?? 0) > 0) {
      submit();
    }
  }, [dictation.status, draft, attachments, submit]);

  const pickImage = useCallback(async () => {
    if (!enableAttachments || !onChangeAttachments) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Photos",
        "Allow Stella to access your photo library in Settings so you can attach images.",
        [{ text: "OK" }],
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 0.75,
      selectionLimit: 5,
      base64: true,
      // HEIC bypasses the picker's `quality` JPEG re-encode (raw bytes pass
      // through), and desktop model providers can't decode HEIC. Ask PhotoKit
      // for the most compatible representation so library picks arrive as
      // JPEG at the picker level.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (!result.canceled && result.assets.length > 0) {
      tapLight();
      const current = attachments ?? [];
      const next = appendOfflineChatAttachments(
        current,
        result.assets,
        maxAttachments ?? Number.MAX_SAFE_INTEGER,
      );
      onChangeAttachments(next.attachments);
      if (next.rejected > 0 && maxAttachments !== undefined) {
        Alert.alert(
          "Too many photos",
          `You can attach up to ${maxAttachments} photos at a time.`,
        );
      }
    }
  }, [attachments, enableAttachments, maxAttachments, onChangeAttachments]);

  const takePhoto = useCallback(async () => {
    if (!enableAttachments || !onChangeAttachments) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Camera",
        "Allow Stella to use the camera in Settings so you can snap a photo.",
        [{ text: "OK" }],
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.75,
      base64: true,
    });
    if (!result.canceled && result.assets.length > 0) {
      tapLight();
      const current = attachments ?? [];
      const next = appendOfflineChatAttachments(
        current,
        result.assets,
        maxAttachments ?? Number.MAX_SAFE_INTEGER,
      );
      onChangeAttachments(next.attachments);
      if (next.rejected > 0 && maxAttachments !== undefined) {
        Alert.alert(
          "Too many photos",
          `You can attach up to ${maxAttachments} photos at a time.`,
        );
      }
    }
  }, [attachments, enableAttachments, maxAttachments, onChangeAttachments]);

  const removeAttachment = useCallback(
    (uri: string) => {
      if (!onChangeAttachments) return;
      onChangeAttachments((attachments ?? []).filter((a) => a.uri !== uri));
    },
    [attachments, onChangeAttachments],
  );

  // Root the in-tree menu overlays measure against (see PlusMenuPopover).
  const rootRef = useRef<View>(null);
  const plusAnchorRef = useRef<View>(null);
  const [plusMenuAnchor, setPlusMenuAnchor] = useState<AnchorRect | null>(null);

  const plusMenuOptions = useMemo<PlusMenuOption[]>(() => {
    const out: PlusMenuOption[] = [];
    if (enableAttachments) {
      out.push({
        id: "attach-photo",
        label: "Attach a photo",
        icon: "image",
        onSelect: () => void pickImage(),
      });
      out.push({
        id: "take-photo",
        label: "Take a photo",
        icon: "camera",
        onSelect: () => void takePhoto(),
      });
    }
    out.push({
      id: "read-aloud",
      label: readAloud.enabled ? "Stop reading aloud" : "Read replies aloud",
      icon: readAloud.enabled ? "volume-2" : "volume-x",
      onSelect: () => void readAloud.setEnabled(!readAloud.enabled),
    });
    return out;
  }, [enableAttachments, pickImage, readAloud, takePhoto]);

  // Floating gear button (computer chat only): opens the device sheet — status,
  // wake, view-screen, model settings. The cloud chat passes no
  // handler, so nothing renders.
  const floatingAnchorRef = useRef<View>(null);
  const hasFloatingMenu = Boolean(onOpenDeviceSheet);

  // Debounced catch-up indicator (show delay + minimum visible time), so
  // instant no-op pulls on every tab return never flash the pill.
  const catchUpVisible = useCatchUpIndicatorVisible(catchingUp);

  const onPressFloating = useCallback(() => {
    if (!onOpenDeviceSheet) return;
    tapLight();
    Keyboard.dismiss();
    onOpenDeviceSheet();
  }, [onOpenDeviceSheet]);

  // Floating activity pill (left of the gear): always present alongside it,
  // opens the activity hub sheet — tasks, files, and search.
  const hasActivityPill = Boolean(onOpenActivityHub);
  const onPressActivityPill = useCallback(() => {
    if (!onOpenActivityHub) return;
    tapLight();
    Keyboard.dismiss();
    onOpenActivityHub();
  }, [onOpenActivityHub]);

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

  // Long-press message actions — a popover anchored at the touch point so it
  // matches the app's menu language instead of a native sheet takeover.
  const [messageMenu, setMessageMenu] = useState<MessageMenuRequest | null>(
    null,
  );
  const dismissMessageMenu = useCallback(() => setMessageMenu(null), []);

  // Long-press copy/share menu for user AND assistant messages. Assistant
  // messages also keep their inline actions (copy / read aloud / share) under
  // the bubble; read-aloud lives only there. The menu just needs copy + share.
  const messageMenuOptions = useMemo<PlusMenuOption[]>(() => {
    if (!messageMenu) return [];
    const text = messageMenu.message.text;
    return [
      {
        id: "copy",
        label: "Copy",
        icon: "copy",
        onSelect: () => copyMessageText(text),
      },
      {
        id: "share",
        label: "Share\u2026",
        icon: "share",
        onSelect: () => shareMessageText(text),
      },
    ];
  }, [messageMenu]);

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);
  // Stream fade is driven per-row: only the trailing assistant message
  // animates while `streaming` is true. AssistantMarkdown itself latches
  // this flag for the row's lifetime, so the per-phrase fade keeps running
  // through the brief render where `streaming` flips false at end-of-turn.
  const streamingAssistantId =
    streaming && lastMessage?.role === "assistant" ? lastMessage.id : null;
  useEffect(() => {
    if (!streamingAssistantId) {
      scroll.clearStreamingAssistantLayout();
    }
  }, [streamingAssistantId, scroll.clearStreamingAssistantLayout]);

  // "Ask Stella" from an assistant text selection: drop the snippet into the
  // composer (appended to any existing draft) and focus it. `draftRef` keeps
  // this stable so rows don't re-render as the draft changes.
  const askStella = useCallback(
    (selected: string) => {
      const snippet = selected.trim();
      if (!snippet) return;
      const current = draftRef.current;
      onChangeDraft(current.trim() ? `${current.trimEnd()} ${snippet}` : snippet);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [onChangeDraft],
  );

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<ChatMessage>) => {
      const isStreamingAssistant = item.id === streamingAssistantId;
      const animate = shouldAnimateMessageEntry(
        seenMessageIdsRef.current,
        item.id,
      );
      return (
        <FadeInMessage
          key={item.id}
          animate={animate}
          onLayout={
            isStreamingAssistant ? scroll.onStreamingAssistantLayout : undefined
          }
        >
          <ChatMessageRow
            item={item}
            styles={styles}
            colors={colors}
            isStreaming={isStreamingAssistant}
            onOpenArtifact={onOpenArtifact}
            onOpenMessageMenu={setMessageMenu}
            onAskStella={askStella}
          />
        </FadeInMessage>
      );
    },
    [
      styles,
      colors,
      onOpenArtifact,
      askStella,
      scroll.onStreamingAssistantLayout,
      streamingAssistantId,
    ],
  );
  const renderSeparator = useCallback(
    () => <View style={styles.itemSeparator} />,
    [styles],
  );
  const getItemType = useCallback((item: ChatMessage) => item.role, []);

  // The working indicator rides at the tail of the chat (desktop-style) instead
  // of floating above the composer. It's wrapped in a fixed-height tail region
  // so the indicator collapsing to nothing when idle — or growing back in when
  // a reply starts — never changes the footer's height, and the chat tail never
  // jumps. The constant gap doubles as a reading-area floor below the last row.
  const listFooter = useMemo(
    () => (
      <View style={styles.chatTail}>
        <WorkingIndicator
          active={workingIndicator?.active ?? streaming}
          exitImmediately={workingIndicator?.exitImmediately}
          status={workingIndicator?.status}
          toolName={workingIndicator?.toolName}
          toolCallId={workingIndicator?.toolCallId}
          isReasoning={workingIndicator?.isReasoning ?? true}
        />
      </View>
    ),
    [streaming, workingIndicator, styles.chatTail],
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
    if (!searchActive) return [] as { message: ChatMessage; index: number }[];
    const terms = foldQueryTerms(searchQuery);
    if (terms.length === 0) {
      return [] as { message: ChatMessage; index: number }[];
    }
    const out: { message: ChatMessage; index: number }[] = [];
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

  const empty = visibleMessages.length === 0;
  const hasText = draft.trim().length > 0;
  const dictationInline = isListening && !hasText;
  const dictationBelow = isListening && hasText;
  const isExpandedComposed = expanded || dictationBelow;

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
  // stays available mid-run so a voice message can be queued as a follow-up,
  // exactly like typing + sending while busy (matches desktop's
  // "dictation-while-busy" behavior). The branches that render it are mutually
  // exclusive per render, so reusing the same element is safe.
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

  const showAttachmentStrip =
    enableAttachments && (attachments?.length ?? 0) > 0;

  const listContentContainerStyle = useMemo(
    () => [
      styles.list,
      { paddingBottom: EDGE_FADE + footerHeight + keyboardExtra },
    ],
    [styles.list, footerHeight, keyboardExtra],
  );

  return (
    <View ref={rootRef} collapsable={false} style={styles.screen}>
      <View style={styles.viewport}>
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
            <LegendList<ChatMessage>
              ref={scroll.listRef}
              style={styles.messageList}
              contentContainerStyle={listContentContainerStyle}
              data={visibleMessages}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              getItemType={getItemType}
              ItemSeparatorComponent={renderSeparator}
              ListFooterComponent={listFooter}
              onScroll={handleListScroll}
              onScrollBeginDrag={scroll.onScrollBeginDrag}
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
              initialScrollAtEnd
              // Keep the visible message anchored when the data array changes
              // (e.g. messages syncing in from the desktop) so the list never
              // snaps back to the top.
              maintainVisibleContentPosition
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
              maintainScrollAtEnd={
                streaming
                  ? {
                      animated: false,
                      on: {
                        dataChange: false,
                        itemLayout: false,
                        layout: false,
                      },
                    }
                  : {
                      animated: false,
                      on: {
                        dataChange: true,
                        itemLayout: false,
                        layout: false,
                      },
                    }
              }
            />
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
          {hasActivityPill && !searchOpen ? (
            <Animated.View
              pointerEvents={floatingHidden ? "none" : "auto"}
              style={[
                styles.floatingActivityPill,
                {
                  bottom: footerHeight + FLOATING_CONTROL_LIFT - 20,
                  // See the settings button below: never fade a Liquid Glass
                  // ancestor's opacity (it drops the material). Fade only on
                  // the fallback; on glass the material fades via `present`
                  // and the pill's own content fade.
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
              <ActivityPill
                tasks={activityTasks ?? []}
                colors={colors}
                onPress={onPressActivityPill}
                present={!floatingHidden}
                contentOpacity={floatingAnim}
              />
            </Animated.View>
          ) : null}
          {hasFloatingMenu && !searchOpen ? (
            <Animated.View
              ref={floatingAnchorRef}
              collapsable={false}
              pointerEvents={floatingHidden ? "none" : "auto"}
              style={[
                styles.floatingMenuButton,
                {
                  bottom: footerHeight + FLOATING_CONTROL_LIFT - 20,
                  // See ScrollToBottomFab: never fade a Liquid Glass ancestor's
                  // opacity (it drops the material). Fade only on the fallback;
                  // on glass the material fades via `present` and the icon below.
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
              <Pressable
                accessibilityLabel="Computer settings"
                accessibilityRole="button"
                hitSlop={6}
                onPress={onPressFloating}
                style={({ pressed }) => [
                  styles.floatingMenuPressable,
                  pressed && styles.scrollToBottomFabPressed,
                ]}
              >
                <GlassSurface
                  glass="clear"
                  interactive
                  present={!floatingHidden}
                  radius={20}
                  fallbackColor={colors.surface}
                  style={styles.floatingMenuGlass}
                >
                  {/* Fading border overlay so the hairline dissolves with the
                      glass instead of lingering as an outline when hidden. */}
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      StyleSheet.absoluteFill,
                      styles.floatingMenuRing,
                      { opacity: floatingAnim },
                    ]}
                  />
                  <Animated.View style={{ opacity: floatingAnim }}>
                    <Icon
                      name="settings"
                      size={20}
                      color={colors.textMuted}
                      weight="semibold"
                    />
                  </Animated.View>
                </GlassSurface>
              </Pressable>
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
              <ScrollView
                contentContainerStyle={styles.searchDropdownContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}
              >
                {searchResults.map((result) => (
                  <SearchResultRow
                    key={result.message.id}
                    message={result.message}
                    query={searchQuery}
                    styles={styles}
                    colors={colors}
                    onPress={() => jumpToMessage(result.index)}
                  />
                ))}
              </ScrollView>
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
          {showAttachmentStrip && (
            <View style={styles.attachmentStrip}>
              {(attachments ?? []).map((asset) => (
                <View key={asset.uri} style={styles.attachmentThumb}>
                  <Image
                    source={{ uri: asset.uri }}
                    style={styles.attachmentImage}
                    contentFit="cover"
                  />
                  <Pressable
                    style={styles.attachmentRemove}
                    accessibilityLabel="Remove attached photo"
                    onPress={() => removeAttachment(asset.uri)}
                    hitSlop={4}
                  >
                    <Icon
                      name="x"
                      size={12}
                      color={colors.accentForeground}
                      weight="bold"
                    />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <GlassSurface
            glass="regular"
            // Softer than the menu tint: enough contrast for the input text
            // while keeping the composer visibly glassy over scrolling chat.
            tintColor={fadeHex(colors.surface, 0.5)}
            radius={isExpandedComposed ? 20 : 999}
            fallbackColor={colors.surface}
            style={styles.shell}
          >
            {dictationInline ? (
              <View style={styles.formPill}>
                {plusButton}
                <DictationRecordingBar
                  levels={dictation.levels}
                  elapsedMs={dictation.elapsedMs}
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
                        ? styles.inputExpanded
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
                      accessibilityLabel={
                        streaming ? "Queue follow-up message" : "Send message"
                      }
                    />
                  ) : streaming && onStop ? (
                    // Busy with an empty composer: keep the mic available so a
                    // dictated message can be queued as a follow-up, and keep
                    // Stop reachable alongside it (mirrors the expanded
                    // toolbar, which always shows the mic).
                    <View style={styles.pillTrailingCluster}>
                      {micButton}
                      <StopButton
                        onPress={onStop}
                        styles={styles}
                        colors={colors}
                      />
                    </View>
                  ) : (
                    micButton
                  )}
                </View>
                {isExpandedComposed && !dictationBelow ? (
                  <View style={styles.toolbar}>
                    <View style={styles.toolbarLeft}>{plusButton}</View>
                    <View style={styles.toolbarRight}>
                      {micButton}
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
                          accessibilityLabel={
                            streaming
                              ? "Queue follow-up message"
                              : "Send message"
                          }
                        />
                      )}
                    </View>
                  </View>
                ) : null}
                {dictationBelow ? (
                  <View style={styles.dictationRow}>
                    <DictationRecordingBar
                      levels={dictation.levels}
                      elapsedMs={dictation.elapsedMs}
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
      />
      <PlusMenuPopover
        visible={Boolean(messageMenu)}
        anchor={messageMenu?.anchor ?? null}
        options={messageMenuOptions}
        onDismiss={dismissMessageMenu}
        colors={colors}
        containerRef={rootRef}
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
    floatingMenuButton: {
      position: "absolute",
      right: CHAT_HORIZONTAL_INSET,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 5,
      elevation: 2,
    },
    // Activity pill: same floating language as the settings button, sitting
    // just to its left (button is 40pt wide + an 8pt gutter).
    floatingActivityPill: {
      position: "absolute",
      right: CHAT_HORIZONTAL_INSET + 48,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 5,
      elevation: 2,
    },
    floatingMenuPressable: {
      height: 40,
      width: 40,
    },
    floatingMenuGlass: {
      alignItems: "center",
      borderRadius: 20,
      flex: 1,
      justifyContent: "center",
      overflow: "hidden",
      width: 40,
    },
    // See scrollToBottomFabRing: fading overlay so the hairline dissolves with
    // the glass rather than lingering as an outline when the button hides.
    floatingMenuRing: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
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
      backgroundColor: colors.accentSoft,
      borderColor: colors.borderStrong,
      borderWidth: StyleSheet.hairlineWidth,
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
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      letterSpacing: 0.03 * 17,
      lineHeight: 17 * 1.52,
    },
    userToggle: {
      alignSelf: "flex-end",
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
      marginTop: 8,
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

    assistantRow: { paddingVertical: 4 },
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
      color: colors.text,
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

    attachmentStrip: {
      flexDirection: "row",
      gap: 8,
      paddingBottom: 10,
      paddingHorizontal: 4,
    },
    attachmentThumb: {
      borderRadius: 10,
      height: 64,
      overflow: "hidden",
      position: "relative",
      width: 64,
    },
    attachmentImage: { borderRadius: 10, height: 64, width: 64 },
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
      borderColor: fadeHex(colors.border, 0.6),
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
  } as const);
