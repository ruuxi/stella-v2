import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { ShimmerText } from "./ShimmerText";
import {
  StellaAnimation,
  WORKING_INDICATOR_DISPLAY_PT,
  WORKING_INDICATOR_GRID,
  getWorkingIndicatorLayout,
} from "./stella-animation";
import { computeWorkingIndicatorStatus } from "./working-indicator-status";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

const indicatorLayout = getWorkingIndicatorLayout();
const ENTER_DURATION_MS = 320;
const EXIT_HOLD_MS = 300;
const EXIT_ANIMATION_MS = 480;
const SWAP_DURATION_MS = 240;
const INDICATOR_PAD_TOP = 0;
const INDICATOR_PAD_BOTTOM = 0;

/**
 * Reserved vertical space above the composer. Intentionally smaller than the
 * creature viewport — the row is `overflow: visible`, so the creature extends
 * a few pt above and below the slot, letting us claim less layout space while
 * keeping Stella at her chosen size.
 */
export const WORKING_INDICATOR_SLOT_HEIGHT = Math.round(
  indicatorLayout.viewport * 0.6,
);

interface WorkingIndicatorProps {
  /** When true, the indicator is visible and the creature animates. */
  active: boolean;
  /** Optional explicit status. Defaults to the same reasoning copy as desktop. */
  status?: string;
  toolName?: string;
  toolCallId?: string;
  isReasoning?: boolean;
  /**
   * Skip the brief exit hold when deactivating. Set once answer text starts
   * streaming so the indicator gets out of the way immediately instead of
   * trailing the growing reply (mirrors the desktop handoff).
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
      {previous ? (
        <Animated.View style={[styles.swapLayer, outStyle]} pointerEvents="none">
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
 * Stella above the composer.
 *
 * Entrance/exit is a plain opacity fade on the whole row, and the row is
 * unmounted after the desktop-matched hold so the GLView never sits invisible
 * in the tree consuming GPU time.
 */
export const WorkingIndicator = memo(function WorkingIndicator({
  active,
  status,
  toolName,
  toolCallId,
  isReasoning = true,
  exitImmediately = false,
}: WorkingIndicatorProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { viewport, display } = indicatorLayout;
  // Per-activation seed so the no-tool reasoning/idle label varies across
  // turns instead of always reading "Thinking" (mirrors the desktop's
  // `reasoningSeed`). Refreshed on each rising edge of `active` below.
  const [reasoningSeed, setReasoningSeed] = useState(() => String(Date.now()));
  const wasActiveRef = useRef(active);
  const liveStatus = computeWorkingIndicatorStatus({
    status,
    toolName,
    seed: toolCallId ?? reasoningSeed,
    isReasoning,
  });
  // Snapshot the label while active so the exit animation shows a stable
  // last-known phrase even though the upstream activity clears the moment
  // `active` flips false (mirrors the desktop's frozen props).
  const frozenStatusRef = useRef(liveStatus);
  if (active) frozenStatusRef.current = liveStatus;
  const displayStatus = active ? liveStatus : frozenStatusRef.current;
  const [renderShell, setRenderShell] = useState(active);
  const shellProgress = useRef(new Animated.Value(active ? 1 : 0)).current;
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

    const startExit = () => {
      holdTimerRef.current = null;
      Animated.timing(shellProgress, {
        toValue: 0,
        duration: EXIT_ANIMATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = null;
        setRenderShell(false);
      }, EXIT_ANIMATION_MS);
    };

    // Skip the hold when answer text has started streaming so the indicator
    // doesn't trail the growing reply; otherwise hold briefly so a fast turn
    // still flashes the indicator.
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
          <View
            style={[styles.viewport, { width: viewport, height: viewport }]}
            collapsable={false}
          >
            <View
              style={[styles.canvasSlot, { width: display, height: display }]}
              collapsable={false}
            >
              <StellaAnimation
                width={WORKING_INDICATOR_GRID}
                height={WORKING_INDICATOR_GRID}
                displayWidth={WORKING_INDICATOR_DISPLAY_PT}
                displayHeight={WORKING_INDICATOR_DISPLAY_PT}
                frameSkip={2}
                paused={!active}
              />
            </View>
          </View>
          <SwapText
            text={displayStatus}
            active={active}
            colors={colors}
            styles={styles}
          />
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
      overflow: "visible",
    },
    // Inline at the chat tail the slot must take no space once the indicator
    // has fully left, otherwise it leaves a permanent gap above the composer.
    slotCollapsed: {
      height: 0,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      height: WORKING_INDICATOR_SLOT_HEIGHT,
      justifyContent: "flex-start",
      overflow: "visible",
      paddingBottom: INDICATOR_PAD_BOTTOM,
      // Inline at the chat tail this row already inherits the list's horizontal
      // inset, so its creature must hug the left to line up with the assistant
      // message text rather than floating in with an extra indent. Keep a right
      // inset only so the status label has room before the edge.
      paddingLeft: 0,
      paddingRight: 18,
      paddingTop: INDICATOR_PAD_TOP,
    },
    viewport: {
      borderRadius: 999,
      overflow: "hidden",
      position: "relative",
    },
    canvasSlot: {
      alignItems: "center",
      justifyContent: "center",
    },
    swapText: {
      flex: 1,
      height: 20,
      minWidth: 0,
      overflow: "hidden",
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
