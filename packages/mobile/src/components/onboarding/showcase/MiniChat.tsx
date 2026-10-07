/**
 * A scaled-down copy of the real chat for the showcase: the same bubbles,
 * working pill, activity rows and composer, at demo size. Every piece takes
 * its colors from the theme so the demo re-tints with the app.
 *
 * Like the desktop films, a piece arrives by fading into place and nothing
 * already on screen springs around to make room for it.
 */
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  interpolate,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { Icon, type IconName } from "../../Icon";
import { StellaStarGlyph } from "../../AgentActivityGlyph";
import { StellaMarkIndicator } from "../../stella-mark/StellaMarkIndicator";
import { type Colors } from "../../../theme/colors";
import { fonts } from "../../../theme/fonts";
import { fadeHex } from "../../../theme/oklch";
import { useColors } from "../../../theme/theme-context";
import {
  fadeEntering,
  fadeExiting,
  SPRING_SNAPPY,
  threadEntering,
  useSpringFlag,
} from "../motion";

export function useMiniStyles() {
  const colors = useColors();
  return useMemo(() => makeMiniStyles(colors), [colors]);
}

export function MiniUserBubble({ children }: { children: string }) {
  const styles = useMiniStyles();
  return (
    <Animated.View entering={threadEntering()} style={styles.userBubble}>
      <Text style={styles.userText}>{children}</Text>
    </Animated.View>
  );
}

export function MiniAssistantBubble({ children }: { children: string }) {
  const colors = useColors();
  const styles = useMiniStyles();
  return (
    <Animated.View entering={threadEntering()} style={styles.assistantBubble}>
      <LinearGradient
        pointerEvents="none"
        colors={[colors.assistantBubbleFillTop, colors.assistantBubbleFillBottom]}
        style={StyleSheet.absoluteFill}
      />
      <Text style={styles.assistantText}>{children}</Text>
    </Animated.View>
  );
}

/** The working pill: the mark doing its thing beside a status line. */
export function MiniWorking({
  label,
  animating,
}: {
  label: string;
  animating: boolean;
}) {
  const colors = useColors();
  const styles = useMiniStyles();
  return (
    <Animated.View
      entering={fadeEntering(0, 240)}
      exiting={fadeExiting(140)}
      style={styles.working}
    >
      <View style={styles.workingMark}>
        <StellaMarkIndicator
          active={animating}
          size={18}
          state="working"
          faceColor={colors.card}
        />
      </View>
      <Text style={styles.workingText} numberOfLines={1}>
        {label}
      </Text>
    </Animated.View>
  );
}

/**
 * One agent activity line: a quiet star while it runs, a check that pops in
 * when it lands.
 */
export function MiniReceipt({
  icon,
  label,
  done,
}: {
  icon: IconName;
  label: string;
  done: boolean;
}) {
  const colors = useColors();
  const styles = useMiniStyles();
  const settle = useSpringFlag(done, SPRING_SNAPPY);
  const starStyle = useAnimatedStyle(() => ({
    opacity: 1 - settle.value,
    transform: [{ scale: 1 - 0.4 * settle.value }, { rotate: `${settle.value * 90}deg` }],
  }));
  const checkStyle = useAnimatedStyle(() => ({
    opacity: settle.value,
    transform: [{ scale: 0.5 + 0.5 * settle.value }],
  }));
  return (
    <Animated.View entering={fadeEntering(0, 220)} style={styles.receipt}>
      <View style={styles.receiptGlyph}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, starStyle]}>
          <StellaStarGlyph size={11} color={colors.textStrong} />
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, checkStyle]}>
          <Icon name="check" size={11} color={colors.ok} weight="bold" />
        </Animated.View>
      </View>
      <Icon name={icon} size={11} color={colors.textMuted} />
      <Text style={styles.receiptText} numberOfLines={1}>
        {label}
      </Text>
    </Animated.View>
  );
}

/** A live window onto what an agent is doing, inline in the thread. */
export function MiniAgentWindow({
  title,
  icon,
  live,
  children,
}: {
  title: string;
  icon: IconName;
  live: boolean;
  children: ReactNode;
}) {
  const colors = useColors();
  const styles = useMiniStyles();
  return (
    <Animated.View entering={threadEntering()} style={styles.window}>
      <View style={styles.windowBar}>
        <Icon name={icon} size={10} color={colors.textMuted} />
        <Text style={styles.windowTitle} numberOfLines={1}>
          {title}
        </Text>
        <LiveDot live={live} />
      </View>
      <View style={styles.windowBody}>{children}</View>
    </Animated.View>
  );
}

function LiveDot({ live }: { live: boolean }) {
  const colors = useColors();
  const styles = useMiniStyles();
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (!live) {
      cancelAnimation(pulse);
      pulse.value = withTiming(0, { duration: 200 });
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 700, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.System,
    );
    return () => cancelAnimation(pulse);
  }, [live, pulse]);
  const dotStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.value, [0, 1], [0.55, 1]),
    transform: [{ scale: interpolate(pulse.value, [0, 1], [0.85, 1.1]) }],
  }));
  return (
    <Animated.View
      style={[
        styles.liveDot,
        { backgroundColor: live ? colors.ok : colors.textWeaker },
        dotStyle,
      ]}
    />
  );
}

/**
 * The "with your OK" moment: the purchase waits on an approval card, the
 * button takes a press, and it settles to confirmed.
 */
export function MiniConfirm({
  title,
  detail,
  amount,
  action,
  doneLabel,
  pressed,
  done,
}: {
  title: string;
  detail: string;
  amount: string;
  action: string;
  doneLabel: string;
  pressed: boolean;
  done: boolean;
}) {
  const colors = useColors();
  const styles = useMiniStyles();
  const press = useSpringFlag(pressed && !done, SPRING_SNAPPY);
  const settle = useSpringFlag(done, SPRING_SNAPPY);
  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - 0.1 * press.value }],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: press.value * 0.5,
    transform: [{ scale: 1 + 0.35 * press.value }],
  }));
  const confirmLabelStyle = useAnimatedStyle(() => ({
    opacity: 1 - settle.value,
  }));
  const doneLabelStyle = useAnimatedStyle(() => ({
    opacity: settle.value,
    transform: [{ scale: 0.7 + 0.3 * settle.value }],
  }));
  return (
    <Animated.View
      entering={threadEntering()}
      style={[
        styles.confirm,
        done && { borderColor: fadeHex(colors.ok, 0.45) },
      ]}
    >
      <View style={styles.confirmIcon}>
        <Icon name={done ? "check" : "sparkles"} size={12} color={done ? colors.ok : colors.accent} />
      </View>
      <View style={styles.confirmText}>
        <Text style={styles.confirmTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.confirmDetail} numberOfLines={1}>
          {detail} · {amount}
        </Text>
      </View>
      <View>
        <Animated.View style={[styles.confirmRing, ringStyle]} />
        <Animated.View
          style={[
            styles.confirmButton,
            done && { backgroundColor: fadeHex(colors.ok, 0.16) },
            buttonStyle,
          ]}
        >
          <Animated.Text
            style={[styles.confirmButtonText, confirmLabelStyle]}
            numberOfLines={1}
          >
            {action}
          </Animated.Text>
          <Animated.View
            style={[StyleSheet.absoluteFill, styles.center, styles.row, doneLabelStyle]}
          >
            <Icon name="check" size={10} color={colors.ok} weight="bold" />
            <Text style={[styles.confirmButtonText, { color: colors.ok }]} numberOfLines={1}>
              {doneLabel}
            </Text>
          </Animated.View>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

/**
 * The composer, typing the request out a few characters at a time. Isolated
 * so only this line re-renders while it types.
 */
export const MiniComposer = memo(function MiniComposer({
  text,
  placeholder,
  typing,
  sent,
  charMs,
  startDelayMs,
}: {
  text: string;
  placeholder: string;
  typing: boolean;
  sent: boolean;
  charMs: number;
  startDelayMs: number;
}) {
  const colors = useColors();
  const styles = useMiniStyles();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!typing || sent) return;
    if (count >= text.length) return;
    const timer = setTimeout(
      () => setCount((previous) => Math.min(text.length, previous + 2)),
      count === 0 ? startDelayMs : charMs * 2,
    );
    return () => clearTimeout(timer);
  }, [charMs, count, sent, startDelayMs, text.length, typing]);

  const shown = sent ? "" : text.slice(0, count);
  const ready = !sent && count >= text.length;
  const sendFlag = useSpringFlag(ready, SPRING_SNAPPY);
  const sendStyle = useAnimatedStyle(() => ({
    opacity: 0.35 + 0.65 * sendFlag.value,
    transform: [{ scale: 0.86 + 0.14 * sendFlag.value }],
  }));

  return (
    <View style={styles.composer}>
      <View style={styles.composerField}>
        {shown ? (
          <Text style={styles.composerText} numberOfLines={1} ellipsizeMode="head">
            {shown}
          </Text>
        ) : (
          <Text style={styles.composerPlaceholder} numberOfLines={1}>
            {placeholder}
          </Text>
        )}
        {typing && !sent ? <Caret /> : null}
      </View>
      <Animated.View style={[styles.composerSend, sendStyle]}>
        <Icon name="arrow-up" size={11} color={colors.accentForeground} weight="heavy" />
      </Animated.View>
    </View>
  );
});

function Caret() {
  const styles = useMiniStyles();
  const blink = useSharedValue(1);
  useEffect(() => {
    blink.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 380 }),
        withTiming(0, { duration: 320 }),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.System,
    );
    return () => cancelAnimation(blink);
  }, [blink]);
  const style = useAnimatedStyle(() => ({ opacity: blink.value }));
  return <Animated.View style={[styles.caret, style]} />;
}

export const makeMiniStyles = (colors: Colors) =>
  StyleSheet.create({
    center: { alignItems: "center", justifyContent: "center" },
    row: { flexDirection: "row", gap: 3 },
    userBubble: {
      alignSelf: "flex-end",
      backgroundColor: colors.userBubbleFill,
      borderCurve: "continuous",
      borderRadius: 16,
      maxWidth: "84%",
      paddingHorizontal: 11,
      paddingVertical: 7,
    },
    userText: {
      color: colors.userBubbleText,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: 0.1,
      lineHeight: 18,
    },
    assistantBubble: {
      alignSelf: "flex-start",
      borderCurve: "continuous",
      borderRadius: 16,
      maxWidth: "88%",
      overflow: "hidden",
      paddingHorizontal: 11,
      paddingVertical: 7,
    },
    assistantText: {
      color: colors.assistantBubbleText,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: 0.1,
      lineHeight: 18,
    },
    working: {
      alignItems: "center",
      alignSelf: "flex-start",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderCurve: "continuous",
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 6,
      paddingLeft: 5,
      paddingRight: 10,
      paddingVertical: 3,
    },
    workingMark: {
      alignItems: "center",
      height: 20,
      justifyContent: "center",
      width: 20,
    },
    workingText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
    },
    receipt: {
      alignItems: "center",
      alignSelf: "flex-start",
      flexDirection: "row",
      gap: 6,
      maxWidth: "100%",
      paddingLeft: 2,
    },
    receiptGlyph: {
      height: 12,
      width: 12,
    },
    receiptText: {
      color: colors.textBase,
      flexShrink: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 11.5,
      letterSpacing: -0.1,
    },
    window: {
      alignSelf: "stretch",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderCurve: "continuous",
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
    },
    windowBar: {
      alignItems: "center",
      backgroundColor: colors.muted,
      flexDirection: "row",
      gap: 5,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    windowTitle: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.mono.regular,
      fontSize: 10,
    },
    liveDot: {
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    windowBody: {
      padding: 9,
    },
    confirm: {
      alignItems: "center",
      alignSelf: "stretch",
      backgroundColor: colors.card,
      borderColor: colors.selectBorder,
      borderCurve: "continuous",
      borderRadius: 14,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 9,
      paddingVertical: 8,
    },
    confirmIcon: {
      alignItems: "center",
      backgroundColor: colors.accentSoft,
      borderRadius: 11,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    confirmText: {
      flex: 1,
      minWidth: 0,
    },
    confirmTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 12,
      letterSpacing: -0.15,
    },
    confirmDetail: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
    },
    confirmRing: {
      ...StyleSheet.absoluteFill,
      backgroundColor: colors.accent,
      borderRadius: 13,
    },
    confirmButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 13,
      height: 26,
      justifyContent: "center",
      minWidth: 78,
      paddingHorizontal: 10,
    },
    confirmButtonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 11.5,
      letterSpacing: -0.1,
    },
    composer: {
      alignItems: "center",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 6,
      height: 36,
      margin: 8,
      paddingLeft: 12,
      paddingRight: 5,
    },
    composerField: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      minWidth: 0,
    },
    composerText: {
      color: colors.text,
      flexShrink: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
    },
    composerPlaceholder: {
      color: fadeHex(colors.textMuted, 0.6),
      fontFamily: fonts.sans.regular,
      fontSize: 13,
    },
    caret: {
      backgroundColor: colors.accent,
      borderRadius: 1,
      height: 15,
      marginLeft: 1,
      width: 1.5,
    },
    composerSend: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 13,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
  });

export type MiniStyles = ReturnType<typeof makeMiniStyles>;
