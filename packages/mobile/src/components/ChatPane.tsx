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
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./Icon";
import { GlassSurface, liquidGlassSupported } from "./glass";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { AssistantTextSelection } from "./AssistantTextSelection";
import { AppBackdrop, TOP_BAR_BAR_HEIGHT } from "./AppBackdrop";
import { ArtifactCard } from "./ArtifactCard";
import { stellaFileChatArtifact } from "../lib/stella-file-links";
import { AgentWorkCard } from "./AgentWorkCard";
import { AgentCompletionCard } from "./AgentCompletionCard";
import { MapRouteCard } from "./MapRouteCard";
import { ToolActivityTrace } from "./ToolActivityTrace";
import { ActivityPill } from "./ActivityPill";
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
import type { DesktopConnection } from "../lib/top-bar-status";
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
  resolveResponseSpacerHeight,
  shouldPlaceLatestTurn,
} from "../lib/chat-response-spacer";
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

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const EXPAND_THRESHOLD = 30;

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

const SCROLL_NEAR_BOTTOM_BASE_PX = 96;

const SCROLL_AWAY_FROM_BOTTOM_BASE_PX = 96;

const SCROLL_AT_BOTTOM_THRESHOLD = 8;

const MANUAL_SCROLL_SETTLE_MS = 140;

const FOOTER_SHRINK_SETTLE_MS = 140;

const FOLLOW_NATIVE_ANIMATION_GUARD_MS = 320;
const FOLLOW_HARD_SNAP_PX = 240;
const FOLLOW_TARGET_EPSILON_PX = 0.5;
const FOLLOW_TOP_PEEK_PX = 56;

const FOLLOW_SPRING_STIFFNESS = 0.00026;
const FOLLOW_SPRING_DAMPING = 0.0322;

const FOLLOW_STREAM_IDLE_MS = 200;

const FOLLOW_MAX_FRAME_MS = 48;

const FOLLOW_DEFAULT_FRAME_MS = 16;

const FOLLOW_MIN_STEP_PX = 0.5;

const FOLLOW_GENTLE_LERP_FACTOR = 0.12;

const POST_SEND_REANCHOR_WINDOW_MS = 1500;

const ASSISTANT_BUBBLE_ENTRANCE_MS = 300;

const EDGE_FADE = 48;
const MESSAGE_LIST_GAP = 20;

const CHAT_TAIL_GAP = WORKING_INDICATOR_SLOT_HEIGHT + 12;

const FLOATING_CONTROL_LIFT = WORKING_INDICATOR_SLOT_HEIGHT;

const FLOATING_CONTROL_ROW_LIFT = (FLOATING_CONTROL_LIFT - 20) / 2;

const SHELL_CONTENT_PADDING = 20;

const CHAT_HORIZONTAL_INSET = 12;

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

  const composerBottomPad = 6 + insets.bottom;

  return { height, open, composerBottomPad };
}

function useChatScroll(
  listTrailingSlackPx: number,
  responseSpacerHeightPx: number,
  trailingMessageId: string | null,
  onConsumeResponseSpacer: (distanceDeltaPx: number) => void,
  onClearResponseSpacer: () => void,
) {
  const listRef = useRef<LegendListRef>(null);
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
  const followRearmBlockedRef = useRef(false);
  const followTargetOffsetRef = useRef<number | null>(null);
  const followRafRef = useRef(0);
  const followAnimatingUntilMsRef = useRef(0);
  const activeAssistantHeightRef = useRef(0);
  const latestUserLayoutRef = useRef<{ id: string; height: number } | null>(
    null,
  );

  const pendingSendAnchorRef = useRef<{
    userMessageId: string;
    trailingSlackPx: number;
    placedRowHeightPx: number | null;
    staleAtMs: number;
  } | null>(null);
  const placeLatestTurnRafRef = useRef(0);
  const trailingMessageIdRef = useRef(trailingMessageId);
  trailingMessageIdRef.current = trailingMessageId;

  const assistantLayoutBaselineRef = useRef<number | null>(null);

  const isDraggingRef = useRef(false);

  const manualScrollActiveRef = useRef(false);
  const manualScrollSettleTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const followVelRef = useRef(0);

  const followCurrentRef = useRef(0);

  const lastFrameTimeRef = useRef(0);

  const lastTargetTimeRef = useRef(0);

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

      if (distFromBottom <= atBottomLimit) {
        if (!isDraggingRef.current && !followRearmBlockedRef.current) {
          followArmedRef.current = true;
        }
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
    [
      atBottomLimit,
      awayFromBottomLimit,
      nearBottomLimit,
      onConsumeResponseSpacer,
      scheduleManualScrollSettle,
      stopFollowLoop,
    ],
  );

  const resetAssistantAutoScroll = useCallback(() => {
    followRearmBlockedRef.current = false;
    followArmedRef.current = true;
    assistantLayoutBaselineRef.current = null;
    activeAssistantHeightRef.current = 0;
    stopFollowLoop();
  }, [stopFollowLoop]);

  const releaseFollow = useCallback(() => {
    pendingSendAnchorRef.current = null;
    followRearmBlockedRef.current = true;
    followArmedRef.current = false;
    stopFollowLoop();
  }, [stopFollowLoop]);

  const onScrollBeginDrag = useCallback(() => {
    isDraggingRef.current = true;
    manualScrollActiveRef.current = true;

    pendingSendAnchorRef.current = null;
    if (manualScrollSettleTimerRef.current) {
      clearTimeout(manualScrollSettleTimerRef.current);
      manualScrollSettleTimerRef.current = null;
    }

    followArmedRef.current = false;
    stopFollowLoop();
  }, [stopFollowLoop]);

  const onScrollSettle = useCallback(() => {
    isDraggingRef.current = false;
    scheduleManualScrollSettle();
    const { offsetY, contentHeight, layoutHeight } = metricsRef.current;
    const distFromBottom = Math.max(0, contentHeight - offsetY - layoutHeight);
    if (distFromBottom <= atBottomLimit && !followRearmBlockedRef.current) {
      followArmedRef.current = true;
    }
  }, [atBottomLimit, scheduleManualScrollSettle]);

  const prepareAssistantLayoutFollow = useCallback(() => {
    assistantLayoutBaselineRef.current = contentHeightRef.current;
  }, []);

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

    followVelRef.current = Math.max(0, followVelRef.current + accel * dt);
    let step = followVelRef.current * dt;
    if (step < FOLLOW_MIN_STEP_PX) step = FOLLOW_MIN_STEP_PX;
    if (step >= diff) {

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

      if (!followRafRef.current && followTargetOffsetRef.current === null) {
        followCurrentRef.current = metricsRef.current.offsetY;
      }

      if (
        !gentle &&
        clamped <= followCurrentRef.current + FOLLOW_TARGET_EPSILON_PX
      ) {
        return;
      }

      if (gentle !== followGentleRef.current) followVelRef.current = 0;
      followGentleRef.current = gentle;
      followTargetOffsetRef.current = clamped;

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
      if (activeAssistantHeightRef.current > 0) {
        followActiveAssistantRow();
      } else {
        setFollowTarget(metricsRef.current.offsetY + height - baseline);
      }
    },
    [followActiveAssistantRow, setFollowTarget],
  );

  const scrollToBottom = useCallback(() => {
    pendingSendAnchorRef.current = null;
    followRearmBlockedRef.current = false;
    onClearResponseSpacer();
    resetAssistantAutoScroll();
    requestAnimationFrame(() =>
      listRef.current?.scrollToEnd({ animated: true }),
    );
  }, [onClearResponseSpacer, resetAssistantAutoScroll]);

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

  const placeLatestTurn = useCallback(() => {
    const pending = pendingSendAnchorRef.current;
    if (!pending) return;
    const metrics = metricsRef.current;
    const contentHeight = contentHeightRef.current;
    const maxOffset = Math.max(0, contentHeight - metrics.layoutHeight);
    const measurement = latestUserLayoutRef.current;
    const isInitialPlacement = pending.placedRowHeightPx === null;

    if (trailingMessageIdRef.current !== pending.userMessageId) {
      pendingSendAnchorRef.current = null;
      if (isInitialPlacement) setFollowTarget(maxOffset, true);
      return;
    }

    if (measurement?.id !== pending.userMessageId) return;

    pending.placedRowHeightPx = measurement.height;
    const target = resolvePostSendPlacement({
      contentHeightPx: contentHeight,
      viewportHeightPx: metrics.layoutHeight,
      trailingSlackPx: pending.trailingSlackPx,
      rowHeightPx: measurement.height,
    });

    setFollowTarget(target, true);
  }, [setFollowTarget]);

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

  const onLatestUserLayout = useCallback(
    (messageId: string, event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      latestUserLayoutRef.current = { id: messageId, height };
      const pending = pendingSendAnchorRef.current;
      if (!pending || pending.userMessageId !== messageId) return;
      if (Date.now() > pending.staleAtMs) return;

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
    (userMessageId: string, trailingSlackPx: number) => {
      pendingSendAnchorRef.current = {
        userMessageId,
        trailingSlackPx,
        placedRowHeightPx: null,
        staleAtMs: Date.now() + POST_SEND_REANCHOR_WINDOW_MS,
      };
      followRearmBlockedRef.current = false;
      followArmedRef.current = true;
      stopFollowLoop();

      schedulePlaceLatestTurn();
    },
    [schedulePlaceLatestTurn, stopFollowLoop],
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
  };
}

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

const quoteMessageText = (text: string): string =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

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

type MessageMenuRequest = { message: ChatMessage; anchor: AnchorRect };

const REWIND_CONFIRM_TIMEOUT_MS = 3000;

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

  useEffect(() => {
    setExpanded(false);
    setTotalLines(null);
    setMeasuring(true);
    measuredWidthRef.current = null;
  }, [text]);

  useEffect(() => {
    if (shouldRemeasureUserMessageWidth(measuredWidthRef.current, windowWidth)) {
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
          {failed || generationState === "failed" || generationState === "canceled" ? (
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

function AssistantBubble({
  children,
  styles,
  animate,
}: {
  children: ReactNode;
  styles: ChatStyles;
  animate: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const shouldAnimate = animate && !reduceMotion;
  const entrance = useRef(
    new Animated.Value(shouldAnimate ? 0 : 1),
  ).current;

  useEffect(() => {
    if (!shouldAnimate) return;
    Animated.timing(entrance, {
      toValue: 1,
      duration: ASSISTANT_BUBBLE_ENTRANCE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance, shouldAnimate]);

  const entranceStyle = useMemo(
    () => ({
      opacity: entrance,
      transform: [
        {
          translateY: entrance.interpolate({
            inputRange: [0, 1],
            outputRange: [6, 0],
          }),
        },
      ],
    }),
    [entrance],
  );

  return (
    <Animated.View style={[styles.assistantBubble, entranceStyle]}>
      {children}
    </Animated.View>
  );
}

const ChatMessageRow = memo(function ChatMessageRow({
  item,
  styles,
  colors,
  menuActive,
  isSelecting,
  anySelecting,
  onOpenArtifact,
  onOpenStellaFile,
  onOpenMessageMenu,
  onEndSelecting,
  onOpenAgentActivity,
  desktopAccess,
}: {
  item: ChatMessage;
  styles: ChatStyles;
  colors: Colors;

  menuActive: boolean;

  isSelecting: boolean;

  anySelecting: boolean;
  onOpenArtifact?: (artifact: ChatArtifact) => void;

  onOpenStellaFile?: (path: string) => void;
  onOpenMessageMenu: (request: MessageMenuRequest) => void;

  onEndSelecting: () => void;

  onOpenAgentActivity?: () => void;
  desktopAccess?: StoredPhoneAccess | null;
}) {

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

    if (!item.text.trim() && (item.thumbnailUris?.length ?? 0) === 0) return;

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

  const consolidated = useMemo(
    () => consolidateRowArtifacts(item.artifacts ?? [], item.tasks ?? []),
    [item.artifacts, item.tasks],
  );
  const toolActivity = useMemo(() => {
    const steps = item.toolSteps ?? [];
    return steps.length > 0 ? deriveToolActivity(steps) : undefined;
  }, [item.toolSteps]);

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
  const mountedEmptyRef = useRef(!hasText);

  if (item.role === "user") {
    const thumbs = item.thumbnailUris ?? [];
    const showThumbs = thumbs.length > 0;
    const showText = item.text.trim().length > 0;
    const quotedText = item.quotedText?.trim();
    return (
      <View style={styles.userRow}>
        <View style={styles.userColumn}>
          {quotedText ? (

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

            <View style={styles.userBubble}>
              <AssistantTextSelection
                text={item.text}
                colors={colors}
                onDismiss={onEndSelecting}
              />
            </View>
          ) : (
            <Animated.View style={liftStyle}>
              <Pressable
                onLongPress={openMenu}

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

  const {
    agentWork: agentWorkArtifacts,
    maps: mapArtifacts,
    looseFiles,
  } = consolidated;
  const isStandIn = isStandInArtifactRow(item);

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

  const groupAgentWorkArtifacts = agentWorkArtifacts;
  const renderAssistantMarkdown = (text: string) => {
    const markdown = (
      <AssistantMarkdown
        text={text}
        colors={colors}
        selectable
        fill={false}
        onStellaFileLink={onOpenStellaFile}
      />
    );

    return anySelecting ? (
      <Pressable onPress={onEndSelecting}>{markdown}</Pressable>
    ) : (
      markdown
    );
  };
  return (
    <View style={styles.assistantRow}>
      {hasText ? (
        <AssistantBubble styles={styles} animate={mountedEmptyRef.current}>
          {renderAssistantMarkdown(item.text)}
        </AssistantBubble>
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
                {...(onOpenAgentActivity
                  ? { onPress: onOpenAgentActivity }
                  : {})}
                {...(onOpenArtifact ? { onOpenArtifact } : {})}
              />
            ) : (
              <AgentWorkCard
                key={artifact.id}
                payload={artifact.payload}
                colors={colors}
                {...(onOpenAgentActivity
                  ? { onPress: onOpenAgentActivity }
                  : {})}
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

function CatchUpPill({
  visible,
  styles,
  colors,
}: {
  visible: boolean;
  styles: ChatStyles;
  colors: Colors;
}) {

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
        {}
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

  bottomOffset?: number;
}) {

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
          {
}
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

type PlusMenuOption = {
  id: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
  disabled?: boolean;
  selected?: boolean;

  destructive?: boolean;

  keepOpenOnSelect?: boolean;
  trailingLabel?: string;

  submenu?: PlusMenuOption[];

  submenuTitle?: string;
};

type PlusMenuLevel = {
  title: string;
  options: PlusMenuOption[];
};

type AnchorRect = { x: number; y: number; width: number; height: number };

const PLUS_MENU_GAP = 10;
const PLUS_MENU_MIN_WIDTH = 200;

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
}: {
  visible: boolean;
  anchor: AnchorRect | null;
  options: PlusMenuOption[];
  onDismiss: () => void;
  colors: Colors;

  containerRef: React.RefObject<View | null>;

  headerLabel?: string | null;

  scrim?: boolean;

  large?: boolean;
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

  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      setMenuLayout(null);
      setSubmenuStack([]);
      anim.setValue(0);
      return;
    }

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

      if (option.keepOpenOnSelect) {
        option.onSelect();
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
  const menuMinWidth = large ? PLUS_MENU_LARGE_MIN_WIDTH : PLUS_MENU_MIN_WIDTH;

  const menuMaxOptionsHeight = Math.round(screen.height * 0.55);
  const desiredWidth = Math.max(menuMinWidth, measured?.width ?? 0);

  const windowLeft = Math.min(
    Math.max(PLUS_MENU_EDGE_PADDING, anchor.x),
    screen.width - desiredWidth - PLUS_MENU_EDGE_PADDING,
  );
  const left = windowLeft - origin.x;

  const menuHeight = measured?.height ?? 0;
  const dropUpTop = anchor.y - menuHeight - PLUS_MENU_GAP;
  const isDropDown = Boolean(measured) && dropUpTop < PLUS_MENU_EDGE_PADDING;
  const windowTop = isDropDown
    ? anchor.y + anchor.height + PLUS_MENU_GAP
    : dropUpTop;
  const top = windowTop - origin.y;

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

          {...(scrim
            ? { tintColor: fadeHex(colors.surface, 0.66) }
            : { legible: true })}
          present={Boolean(measured)}
          radius={large ? 18 : 14}
          ringed
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        />
        {

}
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
                    color={
                      option.disabled
                        ? colors.textMuted
                        : option.destructive
                          ? colors.danger
                          : colors.text
                    }
                    style={
                      large ? styles.menuItemIconLarge : styles.menuItemIcon
                    }
                  />
                  <Text
                    style={[
                      styles.menuItemLabel,
                      large && styles.menuItemLabelLarge,
                      option.destructive && styles.menuItemLabelDanger,
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
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const makePlusMenuStyles = (colors: Colors) =>
  StyleSheet.create({
    overlay: {

      ...StyleSheet.absoluteFillObject,
      zIndex: 50,
    },
    scrim: {

      ...StyleSheet.absoluteFillObject,
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
    menuItemLabelDanger: { color: colors.danger },
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

const foldText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const foldQueryTerms = (query: string): string[] =>
  foldText(query).split(/\s+/).filter(Boolean);

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

export type ChatPaneProps = {

  messages: ChatMessage[];

  streaming: boolean;

  workingIndicator?: WorkingIndicatorState;

  offline?: boolean;

  emptyContent: ReactNode;

  historyLoading?: boolean;
  /** Durable pages adjacent to the bounded in-memory message window. */
  hasOlderHistory?: boolean;
  hasNewerHistory?: boolean;
  historyPageLoading?: boolean;
  onLoadOlderHistory?: () => Promise<void> | void;
  onLoadNewerHistory?: () => Promise<void> | void;

  draft: string;

  onChangeDraft: (next: string) => void;

  composerEnabled?: boolean;

  composerModelPicker?: ComposerModelPickerConfig;

  placeholder: string;

  canSubmit: boolean;

  onSubmit: () => { userMessageId: string } | null;

  onStop?: () => void;

  realtimeVoiceConversationId?: string | null;

  realtimeVoiceExecution?: "phone" | "computer";

  realtimeVoiceDesktopAccess?: StoredPhoneAccess | null;

  realtimeVoiceSignInRequired?: boolean;

  onRealtimeVoiceAction?: (
    request: string,
  ) => Promise<RealtimeVoiceActionDispatch>;

  enableAttachments: boolean;

  attachments?: ImagePicker.ImagePickerAsset[];

  onChangeAttachments?: (next: ImagePicker.ImagePickerAsset[]) => void;

  maxAttachments?: number;

  quotes?: ComposerQuote[];
  onAddQuote?: (text: string) => void;
  onRemoveQuote?: (id: string) => void;

  onOpenDeviceSheet?: () => void;

  computerConnection?: DesktopConnection;

  computerConnectionLabel?: string;

  dictationAnonymous: boolean;
  dictationHeaders?: Record<string, string>;

  onOpenArtifact?: (artifact: ChatArtifact) => void;

  conversationId?: string | null;

  activityTasks?: MobileTask[];

  onOpenActivityHub?: () => void;

  catchingUp?: boolean;

  onRewindMessage?: (messageId: string) => void;
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
  onChangeAttachments,
  maxAttachments,
  quotes,
  onAddQuote,
  onRemoveQuote,
  onOpenDeviceSheet,
  computerConnection,
  computerConnectionLabel,
  dictationAnonymous,
  dictationHeaders,
  onOpenArtifact,
  conversationId = null,
  activityTasks,
  onOpenActivityHub,
  catchingUp = false,
  onRewindMessage,
}: ChatPaneProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const readAloud = useReadAloudPreference();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  const inputRef = useRef<TextInput>(null);
  const { height: keyboardHeight, composerBottomPad } = useKeyboardInset();

  const keyboard = useAnimatedKeyboard();

  const composerKeyboardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -Math.max(0, keyboard.height.value - insets.bottom) },
    ],
  }));

  const keyboardExtra = Math.max(0, keyboardHeight - insets.bottom);

  const [footerHeight, setFooterHeight] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(0);
  const [chatTailHeightPx, setChatTailHeightPx] = useState(CHAT_TAIL_GAP);
  const listBottomInsetPx = EDGE_FADE + footerHeight + keyboardExtra;

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

  useEffect(() => {
    setChatTailHeightPx((current) =>
      Math.max(CHAT_TAIL_GAP, Math.min(current, chatTailTargetHeightPx)),
    );
  }, [chatTailTargetHeightPx]);
  const onViewportLayout = useCallback((event: LayoutChangeEvent) => {
    setListViewportHeight(Math.round(event.nativeEvent.layout.height));
  }, []);

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
  const lastMessage = visibleMessages[visibleMessages.length - 1];
  const {
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
  } = useChatScroll(
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
      resetAssistantAutoScroll();
    }

    if (streaming && (isNewAssistant || grewText)) {
      prepareAssistantLayoutFollow();
    }
    assistantTextLenRef.current = lastMessage.text.length;
    assistantIdRef.current = lastMessage.id;
  } else {
    assistantTextLenRef.current = 0;
    assistantIdRef.current = null;
  }

  useEffect(() => {
    if (streaming) resetAssistantAutoScroll();
  }, [streaming, resetAssistantAutoScroll]);

  const prevKeyboardHeightRef = useRef(0);
  const pinTailForKeyboardRef = useRef(false);
  useEffect(() => {
    const prev = prevKeyboardHeightRef.current;
    prevKeyboardHeightRef.current = keyboardHeight;
    if (keyboardHeight > prev && !awayFromBottom) {
      pinTailForKeyboardRef.current = true;
      requestAnimationFrame(() =>
        listRef.current?.scrollToEnd({ animated: true }),
      );
    } else if (keyboardHeight === 0) {
      pinTailForKeyboardRef.current = false;
    }
  }, [keyboardHeight, awayFromBottom, listRef]);

  useEffect(() => {
    if (!pinTailForKeyboardRef.current) return;
    pinTailForKeyboardRef.current = false;
    listRef.current?.scrollToEnd({ animated: true });
  }, [keyboardExtra, listRef]);

  const pendingSendNudgeRef = useRef<{
    userMessageId: string;
    trailingSlackPx: number;
  } | null>(null);
  useEffect(() => {
    const pending = pendingSendNudgeRef.current;
    if (!pending || keyboardExtra > 0) return;
    pendingSendNudgeRef.current = null;
    nudgeAfterSend(pending.userMessageId, pending.trailingSlackPx);
  }, [keyboardExtra, nudgeAfterSend]);

  const [sendPinSuppressForId, setSendPinSuppressForId] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (!sendPinSuppressForId) return;
    if (streaming || lastMessage?.id !== sendPinSuppressForId) {
      setSendPinSuppressForId(null);
    }
  }, [sendPinSuppressForId, streaming, lastMessage?.id]);

  useEffect(() => {
    const grew = visibleMessages.length > prevLenRef.current;
    prevLenRef.current = visibleMessages.length;
    if (visibleMessages.length === 0) {
      setUnread(false);
      return;
    }
    if (grew && awayFromBottom) setUnread(true);
  }, [visibleMessages.length, awayFromBottom]);

  useEffect(() => {
    if (!awayFromBottom) setUnread(false);
  }, [awayFromBottom]);

  useEffect(() => {
    if (!readAloud.enabled) {

      sawTurnRef.current = false;
      return;
    }
    if (streaming && !sawTurnRef.current) {

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

    sawTurnRef.current = false;
    spokenAssistantIdsRef.current.add(latestAssistant.id);
    void speakReply(latestAssistant.text, latestAssistant.id);
  }, [visibleMessages, readAloud.enabled, streaming]);

  const [expanded, setExpanded] = useState(false);
  const [realtimeVoiceOpen, setRealtimeVoiceOpen] = useState(false);

  useEffect(() => {
    if (expanded && draft.length === 0) {
      LayoutAnimation.configureNext(LAYOUT_SPRING);
      setExpanded(false);
    }
  }, [draft, expanded]);

  const handleContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      if (expanded) return;

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
    const shouldPlaceLatestTurn = getShouldPlaceLatestTurn();
    const submitted = onSubmit();
    if (submitted && shouldPlaceLatestTurn) {

      const restingBottomInsetPx = EDGE_FADE + footerHeight;
      const restingSpacerTargetPx = resolveResponseSpacerHeight({
        viewportHeight: listViewportHeight,
        bottomInsetPx: restingBottomInsetPx,
        minimumHeightPx: restingBottomInsetPx + CHAT_TAIL_GAP,
      });
      activateResponseSpacer(restingSpacerTargetPx - restingBottomInsetPx);
      setSendPinSuppressForId(submitted.userMessageId);
      if (keyboardExtra > 0) {

        pendingSendNudgeRef.current = {
          userMessageId: submitted.userMessageId,
          trailingSlackPx: restingSpacerTargetPx,
        };
      } else {
        nudgeAfterSend(submitted.userMessageId, restingSpacerTargetPx);
      }
    } else if (submitted) {
      clearResponseSpacer();
      releaseFollow();
    }
    Keyboard.dismiss();
  }, [
    onSubmit,
    activateResponseSpacer,
    clearResponseSpacer,
    footerHeight,
    keyboardExtra,
    listViewportHeight,
    getShouldPlaceLatestTurn,
    nudgeAfterSend,
    releaseFollow,
  ]);

  const dictationHeadersMemo = useMemo(
    () => dictationHeaders,

    [dictationHeaders],
  );

  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

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

  const stopAndSendVoice = useCallback(() => {
    if (pendingVoiceSendRef.current) return;
    pendingVoiceSendRef.current = true;
    voiceSendTargetRef.current = null;
    voiceSendResultReadyRef.current = false;
    void dictation
      .stop()
      .then((transcript) => {
        if (!pendingVoiceSendRef.current) return;

        if (transcript && voiceSendTargetRef.current !== null) {
          voiceSendResultReadyRef.current = true;

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
  }, [
    dictation.status,
    draft,
    attachments,
    submit,
    voiceSendResultVersion,
  ]);

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

  const floatingAnchorRef = useRef<View>(null);
  const hasFloatingMenu = Boolean(onOpenDeviceSheet);

  const catchUpVisible = useCatchUpIndicatorVisible(catchingUp);

  const onPressFloating = useCallback(() => {
    if (!onOpenDeviceSheet) return;
    tapLight();
    Keyboard.dismiss();
    onOpenDeviceSheet();
  }, [onOpenDeviceSheet]);

  const hasActivityPill = Boolean(onOpenActivityHub);
  const onPressActivityPill = useCallback(() => {
    if (!onOpenActivityHub) return;
    tapLight();
    Keyboard.dismiss();
    onOpenActivityHub();
  }, [onOpenActivityHub]);

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
      onScroll(e);
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
    [applyFloatingHidden, onScroll],
  );

  const refreshFloatingFromPosition = useCallback(() => {
    const metrics = floatingMetricsRef.current;
    applyFloatingHidden(
      deriveFloatingHidden(floatingHiddenRef.current, metrics.offsetY, metrics),
    );
  }, [applyFloatingHidden]);

  const handleListScrollSettle = useCallback(() => {
    onScrollSettle();
    refreshFloatingFromPosition();
  }, [refreshFloatingFromPosition, onScrollSettle]);

  const handleListContentSizeChange = useCallback(
    (width: number, height: number) => {
      onListContentSizeChange(width, height);
      floatingMetricsRef.current.contentHeight = height;
      refreshFloatingFromPosition();
    },
    [refreshFloatingFromPosition, onListContentSizeChange],
  );

  const onPressPlus = useCallback(() => {
    if (plusMenuOptions.length === 0) return;
    if (
      plusMenuOptions.length === 1 &&
      plusMenuOptions[0].id === "attach-photo"
    ) {

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
        label: "Thinking",
        icon: "sparkles",
        trailingLabel: composerModelPicker.effortLabel,
        disabled: composerModelPicker.loading,
        submenuTitle: "Thinking",
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
  }, [composerModelPicker]);

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

  const [messageMenu, setMessageMenu] = useState<MessageMenuRequest | null>(
    null,
  );

  const [selectingMessageId, setSelectingMessageId] = useState<string | null>(
    null,
  );
  const startSelectingMessage = useCallback((id: string) => {
    setSelectingMessageId(id);
  }, []);
  const stopSelectingMessage = useCallback(() => {
    setSelectingMessageId(null);
  }, []);

  const [rewindArmed, setRewindArmed] = useState(false);
  const rewindTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmRewind = useCallback(() => {
    if (rewindTimerRef.current) {
      clearTimeout(rewindTimerRef.current);
      rewindTimerRef.current = null;
    }
    setRewindArmed(false);
  }, []);
  const dismissMessageMenu = useCallback(() => {
    setMessageMenu(null);
    disarmRewind();
  }, [disarmRewind]);

  useEffect(() => {
    if (streaming) disarmRewind();
  }, [streaming, disarmRewind]);
  useEffect(() => () => disarmRewind(), [disarmRewind]);

  const handleRewindOption = useCallback(
    (message: ChatMessage) => {
      if (!onRewindMessage) return;
      if (rewindTimerRef.current) {
        clearTimeout(rewindTimerRef.current);
        rewindTimerRef.current = null;
      }
      if (rewindArmed) {

        setRewindArmed(false);
        onRewindMessage(message.id);
        return;
      }
      setRewindArmed(true);
      rewindTimerRef.current = setTimeout(() => {
        rewindTimerRef.current = null;
        setRewindArmed(false);
      }, REWIND_CONFIRM_TIMEOUT_MS);
    },
    [onRewindMessage, rewindArmed],
  );

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

  const messageMenuOptions = useMemo<PlusMenuOption[]>(() => {
    if (!messageMenu) return [];
    const message = messageMenu.message;
    const text = message.text;
    const options: PlusMenuOption[] = [];

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

    if (onRewindMessage && message.role === "user" && !streaming) {
      options.push({
        id: "rewind",
        label: rewindArmed ? "Tap again to rewind" : "Rewind here",
        icon: "rotate-ccw",
        destructive: rewindArmed,

        keepOpenOnSelect: !rewindArmed,
        onSelect: () => handleRewindOption(message),
      });
    }
    return options;
  }, [
    messageMenu,
    onRewindMessage,
    streaming,
    rewindArmed,
    handleRewindOption,
    quoteMessage,
    startSelectingMessage,
  ]);

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  const activeAssistantId =
    streaming && lastMessage?.role === "assistant" ? lastMessage.id : null;
  const latestUserMessageId =
    lastMessage?.role === "user" ? lastMessage.id : null;
  useEffect(() => {
    if (!activeAssistantId) {
      clearActiveAssistantLayout();
    }
  }, [activeAssistantId, clearActiveAssistantLayout]);

  const activeMenuMessageId = messageMenu?.message.id ?? null;

  const onOpenStellaFile = useMemo(
    () =>
      onOpenArtifact
        ? (path: string) =>
            onOpenArtifact(
              stellaFileChatArtifact(
                path,
                conversationId ?? "",
              ) as ChatArtifact,
            )
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
          animate={animate}
          onLayout={
            isActiveAssistant
              ? onActiveAssistantLayout
              : isLatestUser
                ? (event) => onLatestUserLayout(item.id, event)
                : undefined
          }
        >
          <ChatMessageRow
            item={item}
            styles={styles}
            colors={colors}
            menuActive={item.id === activeMenuMessageId}
            isSelecting={item.id === selectingMessageId}
            anySelecting={selectingMessageId != null}
            onOpenArtifact={onOpenArtifact}
            onOpenStellaFile={onOpenStellaFile}
            onOpenMessageMenu={setMessageMenu}
            onEndSelecting={stopSelectingMessage}
            onOpenAgentActivity={onOpenActivityHub}
            desktopAccess={realtimeVoiceDesktopAccess}
          />
        </FadeInMessage>
      );
    },
    [
      styles,
      colors,
      onOpenArtifact,
      onOpenStellaFile,
      latestUserMessageId,
      onLatestUserLayout,
      onActiveAssistantLayout,
      activeAssistantId,
      activeMenuMessageId,
      selectingMessageId,
      stopSelectingMessage,
      onOpenActivityHub,
      realtimeVoiceDesktopAccess,
    ],
  );

  const listExtraData = `${activeMenuMessageId ?? ""}|${selectingMessageId ?? ""}`;
  const renderSeparator = useCallback(
    () => <View style={styles.itemSeparator} />,
    [styles],
  );
  const getItemType = useCallback((item: ChatMessage) => item.role, []);

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

  const search = useChatSearch();
  const searchOpen = search.isOpen;
  const searchQuery = search.query.trim();
  const searchActive = searchQuery.length > 0;

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

      setTimeout(() => {
        listRef.current?.scrollToIndex({ index, animated: true });
      }, 60);
    },
    [search, listRef],
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
              ref={listRef}
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

                if (selectingMessageId != null) stopSelectingMessage();
                onScrollBeginDrag();
              }}
              onScrollEndDrag={handleListScrollSettle}
              onMomentumScrollEnd={handleListScrollSettle}
              onContentSizeChange={handleListContentSizeChange}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              keyboardDismissMode="on-drag"
              fadingEdgeLength={EDGE_FADE}

              initialScrollAtEnd

              maintainVisibleContentPosition

              maintainScrollAtEnd={{
                animated: false,
                on: {
                  dataChange: !streaming && sendPinSuppressForId === null,
                  itemLayout: false,
                  layout: false,
                },
              }}
            />
            {

}
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
        {

}
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
              visible={awayFromBottom}
              hasUnread={unread}
              onPress={scrollToBottom}
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
                  bottom: footerHeight + FLOATING_CONTROL_ROW_LIFT,

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
                  bottom: footerHeight + FLOATING_CONTROL_ROW_LIFT,

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
                accessibilityLabel={
                  computerConnectionLabel ?? "Computer connection status"
                }
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
                  {
}
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      StyleSheet.absoluteFill,
                      styles.floatingMenuRing,
                      { opacity: floatingAnim },
                    ]}
                  />
                  <Animated.View
                    style={[styles.connectionBadge, { opacity: floatingAnim }]}
                  >
                    {computerConnection === "connecting" ? (
                      <ActivityIndicator
                        size="small"
                        color={colors.textMuted}
                      />
                    ) : (
                      <>
                        <Icon
                          name="monitor"
                          size={20}
                          color={colors.text}
                          weight="regular"
                        />
                        <View
                          style={[
                            styles.connectionDot,
                            {
                              backgroundColor:
                                computerConnection === "connected"
                                  ? colors.ok
                                  : colors.danger,
                            },
                          ]}
                        />
                      </>
                    )}
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

                      color="#ffffff"
                      weight="bold"
                    />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <GlassSurface
            glass="regular"

            tintColor={fadeHex(colors.surface, 0.5)}
            radius={isExpandedComposed ? 20 : 999}
            fallbackColor={colors.surface}
            style={styles.shell}
          >
            {dictationInline ? (
              <View style={styles.formPill}>
                {plusButton}
                <DictationRecordingBar
                  recorder={dictation.recorder}
                  onCancel={() => void dictation.cancel()}
                  onConfirm={() => void dictation.stop()}
                  onSend={stopAndSendVoice}
                />
              </View>
            ) : (

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
                      accessibilityLabel="Send message"
                    />
                  ) : streaming && onStop ? (

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
                            accessibilityLabel={`Model: ${composerModelPicker.label}`}
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
                      recorder={dictation.recorder}
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      marginHorizontal: -SHELL_CONTENT_PADDING,
      position: "relative",
    },

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
    connectionBadge: {
      alignItems: "center",
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    connectionDot: {
      borderColor: colors.surface,
      borderRadius: 4,
      borderWidth: 1.5,
      bottom: 1,
      height: 8,
      position: "absolute",
      right: 1,
      width: 8,
    },

    floatingMenuRing: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
    },

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

    assistantRow: { paddingVertical: 4 },

    assistantBubble: {
      alignSelf: "flex-start",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 18,
      borderBottomLeftRadius: 4,
      maxWidth: "100%",
      paddingBottom: 2,
      paddingHorizontal: 13,
      paddingTop: 10,
    },

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

      alignSelf: "stretch",
      flexDirection: "row",
      gap: 8,
      paddingBottom: 10,
      paddingHorizontal: 4,
    },

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
