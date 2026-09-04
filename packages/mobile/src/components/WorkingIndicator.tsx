import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { ShimmerText } from "./ShimmerText";
import { StellaMarkIndicator } from "./stella-mark/StellaMarkIndicator";
import { computeWorkingIndicatorStatus } from "./working-indicator-status";
import {
  getWorkingIndicatorCharacterState,
  type WorkingIndicatorCharacterState,
} from "./working-indicator-character";
import { useMinimumVisibleValue } from "../lib/use-minimum-visible-value";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

const ENTER_DURATION_MS = 320;
const ENTER_DELAY_MS = 200;
const EXIT_HOLD_MS = 300;
const EXIT_ANIMATION_MS = 480;
/** The assistant's message has already landed above the indicator, so the
 *  bubble has to be gone almost at once: a lingering indicator under a finished
 *  reply reads as a bug. Matches the desktop handoff. */
const EXIT_HANDOFF_MS = 200;
const SWAP_DURATION_MS = 240;
const STATUS_MIN_VISIBLE_MS = 2000;
const INDICATOR_PAD_TOP = 0;
const INDICATOR_PAD_BOTTOM = 0;
const INDICATOR_VIEWPORT_SIZE = 28;
const BUBBLE_PAD_VERTICAL = 4;

/**
 * Reserved vertical space above the composer for the working indicator,
 * including the bubble's own padding and hairline border.
 */
export const WORKING_INDICATOR_SLOT_HEIGHT =
  INDICATOR_VIEWPORT_SIZE + BUBBLE_PAD_VERTICAL * 2 + 2;

interface WorkingIndicatorProps {
  /** When true, the indicator is visible and the mark animates. */
  active: boolean;
  /** Optional explicit status. Defaults to the same reasoning copy as desktop. */
  status?: string;
  toolName?: string;
  toolCallId?: string;
  /**
   * Skip the brief exit hold when deactivating. Set once this turn's answer
   * message has landed so the indicator gets out of the way immediately
   * instead of trailing the delivered reply (mirrors the desktop handoff).
   */
  exitImmediately?: boolean;
}

function SwapText({
  text,
  active,
  colors,
  styles,
}: {
  text: string;
  active: boolean;
  colors: Colors;
  styles: ReturnType<typeof makeStyles>;
}) {
  const [current, setCurrent] = useState(text);
  const [previous, setPrevious] = useState<string | null>(null);
  const lastTextRef = useRef(text);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inValue = useRef(new Animated.Value(1)).current;
  const outValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (text === lastTextRef.current) return;

    const old = lastTextRef.current;
    setPrevious(old);
    setCurrent(text);
    lastTextRef.current = text;
    inValue.setValue(0);
    outValue.setValue(1);

    Animated.parallel([
      Animated.timing(inValue, {
        toValue: 1,
        duration: SWAP_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(outValue, {
        toValue: 0,
        duration: SWAP_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setPrevious(null);
      timeoutRef.current = null;
    }, SWAP_DURATION_MS);

    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [inValue, outValue, text]);

  const inStyle = useMemo(
    () => ({
      opacity: inValue,
      transform: [
        {
          translateY: inValue.interpolate({
            inputRange: [0, 1],
            outputRange: [4, 0],
          }),
        },
      ],
    }),
    [inValue],
  );
  const outStyle = useMemo(
    () => ({
      opacity: outValue,
      transform: [
        {
          translateY: outValue.interpolate({
            inputRange: [0, 1],
            outputRange: [-4, 0],
          }),
        },
      ],
    }),
    [outValue],
  );

  return (
    <View style={styles.swapText}>
      {
        // Invisible sizer: the animated layers are absolutely positioned, so
        // this gives the bubble its intrinsic width for the current label.
      }
      <Text
        style={[styles.statusText, styles.swapSizer]}
        numberOfLines={1}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {current}
      </Text>
      {previous ? (
        <Animated.View
          style={[styles.swapLayer, outStyle]}
          pointerEvents="none"
        >
          <View style={styles.shimmerWrap}>
            <ShimmerText
              text={previous}
              active={false}
              color={colors.text}
              textStyle={styles.statusText}
            />
          </View>
        </Animated.View>
      ) : null}
      <Animated.View style={[styles.swapLayer, inStyle]}>
        <View style={styles.shimmerWrap}>
          <ShimmerText
            text={current}
            active={active}
            color={colors.text}
            textStyle={styles.statusText}
          />
        </View>
      </Animated.View>
    </View>
  );
}

/**
 * Stella's working state above the composer, wearing an assistant-style bubble
 * that hugs its content so it reads as an incoming message.
 *
 * Entrance/exit is a plain opacity fade on the whole row, and the row is
 * unmounted after the desktop-matched hold so no animation remains active.
 */
export const WorkingIndicator = memo(function WorkingIndicator({
  active,
  status,
  toolName,
  toolCallId,
  exitImmediately = false,
}: WorkingIndicatorProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Per-activation seed so the no-tool reasoning/idle label varies across
  // turns instead of always reading "Thinking" (mirrors the desktop's
  // `reasoningSeed`). Refreshed on each rising edge of `active` below.
  const [reasoningSeed, setReasoningSeed] = useState(() => String(Date.now()));
  const wasActiveRef = useRef(false);
  const liveDisplay = useMemo(
    () => ({
      status: computeWorkingIndicatorStatus({
        status,
        toolName,
        seed: toolCallId ?? reasoningSeed,
      }),
      characterState: getWorkingIndicatorCharacterState(toolName),
    }),
    [reasoningSeed, status, toolCallId, toolName],
  );
  // The hold covers the mark as well as the label. Without it the character
  // would flap between thinking and tool poses whenever a quick tool starts
  // and ends.
  const heldDisplay = useMinimumVisibleValue(
    liveDisplay,
    STATUS_MIN_VISIBLE_MS,
    (a, b) =>
      a.status === b.status && a.characterState === b.characterState,
  );

  // Snapshot the label while active so the exit animation shows a stable
  // last-known phrase even though the upstream activity clears the moment
  // `active` flips false (mirrors the desktop's frozen props).
  const frozenDisplayRef = useRef(heldDisplay);
  if (active) frozenDisplayRef.current = heldDisplay;
  const display = active ? heldDisplay : frozenDisplayRef.current;
  const displayStatus = display.status;
  // With no label there is nothing to read, so the mark itself carries the
  // state as the thinking ellipsis. A label gets the matching character pose.
  const hasLabel = displayStatus.length > 0;
  const characterState: WorkingIndicatorCharacterState = hasLabel
    ? display.characterState === "thinking"
      ? "working"
      : display.characterState
    : "thinking";
  const [renderShell, setRenderShell] = useState(false);
  const shellProgress = useRef(new Animated.Value(0)).current;
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearTimers = () => {
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (leaveTimerRef.current !== null) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
    };

    if (active) {
      clearTimers();
      if (!renderShell) {
        // A short run or cancellation clears this timer without showing dots.
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          setRenderShell(true);
        }, ENTER_DELAY_MS);
        return clearTimers;
      }
      if (!wasActiveRef.current) setReasoningSeed(String(Date.now()));
      wasActiveRef.current = true;
      setRenderShell(true);
      Animated.timing(shellProgress, {
        toValue: 1,
        duration: ENTER_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return clearTimers;
    }

    wasActiveRef.current = false;
    if (!renderShell) return clearTimers;

    const exitMs = exitImmediately ? EXIT_HANDOFF_MS : EXIT_ANIMATION_MS;
    const startExit = () => {
      holdTimerRef.current = null;
      Animated.timing(shellProgress, {
        toValue: 0,
        duration: exitMs,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = null;
        setRenderShell(false);
      }, exitMs);
    };

    // Skip the hold when the answer has landed so the indicator doesn't trail
    // the delivered reply; otherwise hold briefly so a fast turn still flashes
    // the indicator.
    if (exitImmediately) {
      startExit();
    } else {
      holdTimerRef.current = setTimeout(startExit, EXIT_HOLD_MS);
    }

    return clearTimers;
  }, [active, exitImmediately, renderShell, shellProgress]);

  const shellStyle = useMemo(
    () => ({ opacity: shellProgress }),
    [shellProgress],
  );

  return (
    <View
      style={[styles.slot, !renderShell && styles.slotCollapsed]}
      pointerEvents="none"
    >
      {renderShell ? (
        <Animated.View style={[styles.row, shellStyle]} collapsable={false}>
          <View style={[styles.bubble, !hasLabel && styles.bubbleDots]}>
            <View style={styles.markBox}>
              {
                // Kept active for as long as the shell is mounted: dropping it
                // on the exit would run the dots → star morph backwards in full
                // view while the bubble fades out.
              }
              <StellaMarkIndicator
                active
                size={INDICATOR_VIEWPORT_SIZE}
                state={characterState}
                faceColor={colors.card}
              />
            </View>
            {hasLabel ? (
              <SwapText
                text={displayStatus}
                active={active}
                colors={colors}
                styles={styles}
              />
            ) : null}
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
});

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    slot: {
      height: WORKING_INDICATOR_SLOT_HEIGHT,
      flexShrink: 0,
    },
    // Inline at the chat tail the slot must take no space once the indicator
    // has fully left, otherwise it leaves a permanent gap above the composer.
    slotCollapsed: {
      height: 0,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      height: WORKING_INDICATOR_SLOT_HEIGHT,
      justifyContent: "flex-start",
      paddingBottom: INDICATOR_PAD_BOTTOM,
      // Inline at the chat tail this row already inherits the list's horizontal
      // inset, so its bubble must hug the left to line up with the assistant
      // message text rather than floating in with an extra indent. Keep a right
      // inset only so the status label has room before the edge.
      paddingLeft: 0,
      paddingRight: 18,
      paddingTop: INDICATOR_PAD_TOP,
    },
    // The assistant bubble treatment, squared off at the bottom-left the same
    // way an incoming message is, sized to hug whatever the label currently is.
    bubble: {
      alignItems: "center",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 18,
      borderBottomLeftRadius: 4,
      flexDirection: "row",
      flexShrink: 1,
      gap: 8,
      maxWidth: "100%",
      paddingHorizontal: 13,
      paddingVertical: BUBBLE_PAD_VERTICAL,
    },
    bubbleDots: {
      paddingHorizontal: 8,
    },
    markBox: {
      alignItems: "center",
      height: INDICATOR_VIEWPORT_SIZE,
      justifyContent: "center",
      width: INDICATOR_VIEWPORT_SIZE,
    },
    swapText: {
      flexShrink: 1,
      height: 20,
      minWidth: 0,
      overflow: "hidden",
    },
    swapSizer: {
      opacity: 0,
    },
    swapLayer: {
      bottom: 0,
      justifyContent: "center",
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    shimmerWrap: {
      justifyContent: "center",
    },
    statusText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.1,
      lineHeight: 20,
    },
  });
