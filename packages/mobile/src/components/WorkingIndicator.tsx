import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { ShimmerText } from "./ShimmerText";
import { StellaMarkIndicator } from "./stella-mark/StellaMarkIndicator";
import { computeWorkingIndicatorStatus } from "./working-indicator-status";
import { useMinimumVisibleValue } from "../lib/use-minimum-visible-value";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

const ENTER_DURATION_MS = 320;
const EXIT_HOLD_MS = 300;
const EXIT_ANIMATION_MS = 480;
const SWAP_DURATION_MS = 240;
const STATUS_MIN_VISIBLE_MS = 2000;
const INDICATOR_PAD_TOP = 0;
const INDICATOR_PAD_BOTTOM = 0;
const INDICATOR_VIEWPORT_SIZE = 34;

export const WORKING_INDICATOR_SLOT_HEIGHT = INDICATOR_VIEWPORT_SIZE;

interface WorkingIndicatorProps {

  active: boolean;

  status?: string;
  toolName?: string;
  toolCallId?: string;

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

export const WorkingIndicator = memo(function WorkingIndicator({
  active,
  status,
  toolName,
  toolCallId,
  exitImmediately = false,
}: WorkingIndicatorProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [reasoningSeed, setReasoningSeed] = useState(() => String(Date.now()));
  const wasActiveRef = useRef(active);
  const liveStatus = computeWorkingIndicatorStatus({
    status,
    toolName,
    seed: toolCallId ?? reasoningSeed,
  });
  const heldStatus = useMinimumVisibleValue(liveStatus, STATUS_MIN_VISIBLE_MS);

  const frozenStatusRef = useRef(heldStatus);
  if (active) frozenStatusRef.current = heldStatus;
  const displayStatus = active ? heldStatus : frozenStatusRef.current;
  const hasLabel = displayStatus.length > 0;
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
          <StellaMarkIndicator
            active={active}
            size={INDICATOR_VIEWPORT_SIZE}
            mode={hasLabel ? "star" : "dots"}
          />
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
    },

    slotCollapsed: {
      height: 0,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      height: WORKING_INDICATOR_SLOT_HEIGHT,
      justifyContent: "flex-start",
      paddingBottom: INDICATOR_PAD_BOTTOM,

      paddingLeft: 0,
      paddingRight: 18,
      paddingTop: INDICATOR_PAD_TOP,
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
