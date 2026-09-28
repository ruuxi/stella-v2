import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { StellaMarkHero } from "./stella-mark/StellaMarkHero";
import { StellaMarkIndicator } from "./stella-mark/StellaMarkIndicator";
import {
  pickWorkingIndicatorToolPose,
  type WorkingIndicatorCharacterState,
} from "./working-indicator-character";
import { GlassSurface } from "./glass";
import { useActivityHub } from "../lib/main-shell-store";
import { fadeHex } from "../theme/oklch";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { useT } from "../i18n";

const MARK_SIZE = 30;
/** The side buttons' size, so the capsule matches them. */
const CAPSULE_HEIGHT = 44;
/**
 * Bar padding + a side button + the gap: the capsule keeps the same distance
 * from the menu button on the left and the settings button on the right.
 */
const SIDE_CLEARANCE = 10 + 44 + 8;
/** How long the spawn beat (the thinking bounce) plays before a work pose. */
const SPAWN_BEAT_MS = 1100;
/** A smooth, barely-overshooting settle, like a UIKit spring. */
const SETTLE = LinearTransition.springify().damping(22).stiffness(190).mass(0.9);

type Phase = "idle" | "spawn" | "working";

/**
 * Stella's presence in the chat's top bar. At rest the mark floats centred
 * with idle eyes. While background work runs it glides left and a bubble
 * reads out the work: the task's own description for one, a short count for
 * several. A new task plays the thinking bounce before settling into a work
 * pose; when everything finishes the mark pops once and drifts back to centre.
 * This replaces the agent rows that used to sit in the transcript.
 */
export function StellaStatusHeader({ onPress }: { onPress?: () => void }) {
  const t = useT();
  const colors = useColors();
  const hub = useActivityHub();
  const running = useMemo(
    () => (hub?.tasks ?? []).filter((task) => task.status === "running"),
    [hub?.tasks],
  );
  const count = running.length;
  const label =
    count === 0
      ? null
      : count === 1
        ? running[0]!.title
        : t("mobile.chat.workingMany", { count });

  const [phase, setPhase] = useState<Phase>(count > 0 ? "working" : "idle");
  const previousCount = useRef(count);
  const pop = useSharedValue(1);

  useEffect(() => {
    const previous = previousCount.current;
    previousCount.current = count;
    if (count > previous) {
      setPhase("spawn");
      const timer = setTimeout(() => setPhase("working"), SPAWN_BEAT_MS);
      return () => clearTimeout(timer);
    }
    if (count === 0 && previous > 0) {
      setPhase("idle");
      pop.value = withSequence(
        withTiming(1.14, { duration: 160, easing: Easing.out(Easing.cubic) }),
        withSpring(1, { damping: 12, stiffness: 180 }),
      );
    }
    return undefined;
  }, [count, pop]);

  const pose: WorkingIndicatorCharacterState =
    phase === "spawn"
      ? "thinking"
      : pickWorkingIndicatorToolPose(running[0]?.id ?? "stella");
  const popStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pop.value }],
  }));

  const busy = phase !== "idle" && label !== null;
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.lane, busy ? styles.laneParked : styles.laneCentred]}
    >
      <Animated.View layout={SETTLE} style={[styles.group, busy && styles.groupBusy]}>
        {/* The side buttons' glass, materialising around the mark while work
            runs. No ring, to match them. */}
        {/* Liquid Glass stops rendering under a parent whose alpha is
            animated, so the capsule uses the material's own materialise
            animation (`present`) rather than a fade. */}
        <Capsule busy={busy} colors={colors}>
        <Pressable
          onPress={onPress}
          disabled={!onPress || !busy}
          accessibilityRole={busy ? "button" : "image"}
          accessibilityLabel={label ?? "Stella"}
          style={[styles.groupInner, busy && styles.groupInnerBusy]}
        >
          <Animated.View style={[styles.mark, popStyle]}>
            {busy ? (
              <Animated.View
                key="working"
                entering={FadeIn.duration(220)}
                exiting={FadeOut.duration(160)}
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
                entering={FadeIn.duration(220)}
                exiting={FadeOut.duration(160)}
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
          {busy ? (
            <Animated.Text
              key={label}
              entering={FadeIn.duration(260).delay(90)}
              exiting={FadeOut.duration(140)}
              numberOfLines={1}
              style={styles.label}
            >
              {label}
            </Animated.Text>
          ) : null}
        </Pressable>
        </Capsule>
      </Animated.View>
    </View>
  );
}

/**
 * The side buttons' glass around the mark while work runs, built the same
 * way as `GlassIconButton`: clear glass with its faint hairline ring (clear
 * glass alone disappears against a light page), content inside the glass.
 */
function Capsule({
  busy,
  colors,
  children,
}: {
  busy: boolean;
  colors: ReturnType<typeof useColors>;
  children: React.ReactNode;
}) {
  if (!busy) return <View style={capsuleStyles.idle}>{children}</View>;
  return (
    <GlassSurface
      glass="clear"
      interactive
      radius={CAPSULE_HEIGHT / 2}
      fallbackColor={colors.surface}
      style={capsuleStyles.glass}
    >
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          capsuleStyles.ring,
          { borderColor: fadeHex(colors.border, 0.6) },
        ]}
      />
      {children}
    </GlassSurface>
  );
}

const capsuleStyles = StyleSheet.create({
  idle: { flex: 1, justifyContent: "center" },
  glass: {
    borderRadius: CAPSULE_HEIGHT / 2,
    flex: 1,
    justifyContent: "center",
    overflow: "hidden",
  },
  ring: {
    borderRadius: CAPSULE_HEIGHT / 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
});

const makeStyles = (colors: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    lane: {
      ...StyleSheet.absoluteFill,
      alignItems: "center",
      flexDirection: "row",
    },
    laneCentred: { justifyContent: "center" },
    laneParked: { paddingHorizontal: SIDE_CLEARANCE },
    group: { height: CAPSULE_HEIGHT, justifyContent: "center" },
    groupBusy: { flex: 1 },
    groupInner: { alignItems: "center", flexDirection: "row", gap: 8 },
    groupInnerBusy: { paddingLeft: 7, paddingRight: 16 },
    mark: { height: MARK_SIZE, width: MARK_SIZE },
    label: {
      color: colors.text,
      flexShrink: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.15,
    },
  });
