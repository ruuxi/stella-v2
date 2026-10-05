import { useEffect, useMemo, useRef, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import {
  ACTIVITY_INDICATOR_LABEL_IN_DELAY_MS,
  ACTIVITY_INDICATOR_LABEL_IN_MS,
  ACTIVITY_INDICATOR_LABEL_OUT_MS,
  ACTIVITY_INDICATOR_MARK_IN_MS,
  ACTIVITY_INDICATOR_MARK_OUT_MS,
  ACTIVITY_INDICATOR_POP_RISE_MS,
  ACTIVITY_INDICATOR_POP_SCALE,
  ACTIVITY_INDICATOR_POP_SETTLE_SPRING,
  ACTIVITY_INDICATOR_SPAWN_BEAT_MS,
  activityIndicatorTransition,
  selectActivityIndicatorLabel,
  type ActivityIndicatorEntry,
  type ActivityIndicatorPhase,
} from "@stella/contracts/activity-indicator";
import { StellaMarkHero } from "./stella-mark/StellaMarkHero";
import { StellaMarkIndicator } from "./stella-mark/StellaMarkIndicator";
import {
  pickWorkingIndicatorToolPose,
  type WorkingIndicatorCharacterState,
} from "./working-indicator-character";
import { StatusPill } from "./StatusPill";
import {
  STATUS_PILL_HEIGHT,
  STATUS_PILL_INSET,
  STATUS_PILL_SPRING,
} from "./StatusPill.types";
import { runningActivityIndicatorEntries } from "../lib/activity-hub-model";
import { useActivityHub } from "../lib/main-shell-store";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { useT } from "../i18n";

const MARK_SIZE = STATUS_PILL_HEIGHT - STATUS_PILL_INSET * 2;
const LABEL_GAP = 8;
const LABEL_TRAILING = 16;
/**
 * Bar padding + a side button + the gap: the pill keeps at least this much
 * room from the menu button on the left and the settings button on the right.
 */
const SIDE_CLEARANCE = 10 + 44 + 8;
/** Long enough for a shrinking pill to settle before its slot narrows. */
const SLOT_SETTLE_MS = 560;

const NO_RUNNING_AGENTS: ActivityIndicatorEntry[] = [];

/**
 * Stella's presence in the chat's top bar: the mark inside a glass pill
 * that matches the side buttons. At rest the pill is a circle around the
 * mark's idle eyes. While background work runs it grows, centred, to carry
 * the work beside the mark: the task's own description for one, a short
 * count for several. A new task plays the thinking bounce before settling
 * into a work pose; when everything finishes the mark pops once and the
 * pill closes back around it. Pressing it opens the menu of what is running.
 *
 * The timings, the phase machine and the choice of label come from
 * `@stella/contracts/activity-indicator`; desktop's own top-bar indicator
 * reads the same module, so the two can't drift into different behaviour.
 * Desktop renders without the pill — the window chrome stands in for it.
 */
export function StellaStatusHeader({
  onPress,
}: {
  /** Opens the menu of in-progress agents. Inert while nothing runs. */
  onPress: (running: readonly ActivityIndicatorEntry[]) => void;
}) {
  const t = useT();
  const colors = useColors();
  const hub = useActivityHub();
  const running = useMemo(
    () =>
      hub?.tasks
        ? runningActivityIndicatorEntries(hub.tasks)
        : NO_RUNNING_AGENTS,
    [hub?.tasks],
  );
  const count = running.length;
  const label = selectActivityIndicatorLabel(running, (total) =>
    t("mobile.chat.workingMany", { count: total }),
  );

  const [phase, setPhase] = useState<ActivityIndicatorPhase>(
    count > 0 ? "working" : "idle",
  );
  const previousCount = useRef(count);
  const pop = useSharedValue(1);

  useEffect(() => {
    const previous = previousCount.current;
    previousCount.current = count;
    const transition = activityIndicatorTransition(count, previous);
    if (transition === "spawn") {
      setPhase("spawn");
      const timer = setTimeout(
        () => setPhase("working"),
        ACTIVITY_INDICATOR_SPAWN_BEAT_MS,
      );
      return () => clearTimeout(timer);
    }
    if (transition === "settle") {
      setPhase("idle");
      pop.value = withSequence(
        withTiming(ACTIVITY_INDICATOR_POP_SCALE, {
          duration: ACTIVITY_INDICATOR_POP_RISE_MS,
          easing: Easing.out(Easing.cubic),
        }),
        withSpring(1, { ...ACTIVITY_INDICATOR_POP_SETTLE_SPRING }),
      );
    }
    return undefined;
  }, [count, pop]);

  const pose: WorkingIndicatorCharacterState =
    phase === "spawn"
      ? "thinking"
      : pickWorkingIndicatorToolPose(running[0]?.id ?? "stella");
  const busy = phase !== "idle" && label !== null;

  const { width: windowWidth } = useWindowDimensions();
  const [laneWidth, setLaneWidth] = useState(windowWidth);
  const onLaneLayout = (event: LayoutChangeEvent) =>
    setLaneWidth(event.nativeEvent.layout.width);
  const [measured, setMeasured] = useState<{ label: string; width: number } | null>(
    null,
  );
  const labelWidth =
    busy && label !== null && measured?.label === label ? measured.width : null;

  const maxWidth = Math.max(STATUS_PILL_HEIGHT, laneWidth - SIDE_CLEARANCE * 2);
  const [settledBusyWidth, setSettledBusyWidth] = useState(STATUS_PILL_HEIGHT);
  const busyWidth =
    labelWidth === null
      ? settledBusyWidth
      : Math.min(
          maxWidth,
          Math.ceil(
            STATUS_PILL_INSET + MARK_SIZE + LABEL_GAP + labelWidth + LABEL_TRAILING,
          ),
        );
  useEffect(() => {
    if (busy && labelWidth !== null) setSettledBusyWidth(busyWidth);
    if (!busy) setSettledBusyWidth(STATUS_PILL_HEIGHT);
  }, [busy, busyWidth, labelWidth]);
  const width = busy ? busyWidth : STATUS_PILL_HEIGHT;
  const showLabel = busy && width > STATUS_PILL_HEIGHT;

  const [lingerWidth, setLingerWidth] = useState(width);
  useEffect(() => {
    if (width >= lingerWidth) {
      if (width !== lingerWidth) setLingerWidth(width);
      return undefined;
    }
    const timer = setTimeout(() => setLingerWidth(width), SLOT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [width, lingerWidth]);
  const slotWidth = Math.max(width, lingerWidth);

  const markOffset = useSharedValue(0);
  useEffect(() => {
    markOffset.value = withSpring(
      STATUS_PILL_INSET + MARK_SIZE / 2 - width / 2,
      STATUS_PILL_SPRING,
    );
  }, [markOffset, width]);
  const markStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: markOffset.value }, { scale: pop.value }],
  }));

  const contentWidth = slotWidth - STATUS_PILL_INSET * 2;
  const labelLeft =
    contentWidth / 2 - width / 2 + STATUS_PILL_INSET + MARK_SIZE + LABEL_GAP;
  const labelSpace = Math.max(
    0,
    width - STATUS_PILL_INSET - MARK_SIZE - LABEL_GAP - LABEL_TRAILING,
  );
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View pointerEvents="box-none" style={styles.lane} onLayout={onLaneLayout}>
      {label !== null ? (
        <Text
          key={label}
          numberOfLines={1}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.label, styles.measure]}
          onLayout={(event) =>
            setMeasured({ label, width: event.nativeEvent.layout.width })
          }
        >
          {label}
        </Text>
      ) : null}
      <StatusPill
        width={width}
        slotWidth={slotWidth}
        onPress={() => {
          if (busy) onPress(running);
        }}
        accessibilityLabel={busy && label ? label : "Stella"}
      >
        <Animated.View style={[styles.mark, markStyle]}>
          {busy ? (
            <Animated.View
              key="working"
              entering={FadeIn.duration(ACTIVITY_INDICATOR_MARK_IN_MS)}
              exiting={FadeOut.duration(ACTIVITY_INDICATOR_MARK_OUT_MS)}
              style={StyleSheet.absoluteFill}
            >
              <StellaMarkIndicator
                active
                size={MARK_SIZE}
                state={pose}
                faceColor={colors.background}
              />
            </Animated.View>
          ) : (
            <Animated.View
              key="idle"
              entering={FadeIn.duration(ACTIVITY_INDICATOR_MARK_IN_MS)}
              exiting={FadeOut.duration(ACTIVITY_INDICATOR_MARK_OUT_MS)}
              style={StyleSheet.absoluteFill}
            >
              <StellaMarkHero
                size={MARK_SIZE}
                faceColor={colors.background}
                shape="soft"
              />
            </Animated.View>
          )}
        </Animated.View>
        {showLabel ? (
          <View
            style={[styles.labelSlot, { left: labelLeft, width: labelSpace }]}
          >
            <Animated.Text
              key={label}
              entering={FadeIn.duration(ACTIVITY_INDICATOR_LABEL_IN_MS).delay(
                ACTIVITY_INDICATOR_LABEL_IN_DELAY_MS,
              )}
              exiting={FadeOut.duration(ACTIVITY_INDICATOR_LABEL_OUT_MS)}
              numberOfLines={1}
              style={styles.label}
            >
              {label}
            </Animated.Text>
          </View>
        ) : null}
      </StatusPill>
    </View>
  );
}

const makeStyles = (colors: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    lane: {
      ...StyleSheet.absoluteFill,
      alignItems: "center",
      justifyContent: "center",
    },
    mark: {
      height: MARK_SIZE,
      left: "50%",
      marginLeft: -MARK_SIZE / 2,
      position: "absolute",
      top: 0,
      width: MARK_SIZE,
    },
    labelSlot: {
      bottom: 0,
      justifyContent: "center",
      position: "absolute",
      top: 0,
    },
    label: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.15,
    },
    measure: {
      left: 0,
      opacity: 0,
      position: "absolute",
      top: 0,
    },
  });
