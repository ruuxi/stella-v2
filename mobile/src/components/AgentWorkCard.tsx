import { useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Icon } from "./Icon";
import { ShimmerText } from "./ShimmerText";
import type { MobileDisplayPayload } from "../types";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";

type AgentWorkPayload = Extract<MobileDisplayPayload, { kind: "agent-work" }>;

type AgentWorkCardProps = {
  payload: AgentWorkPayload;
  colors: Colors;
};

/** A touch quicker than the base shimmer so the in-progress state reads as
 *  lively — mirrors the desktop `BackgroundWorkCard` title sweep. */
const TITLE_SHIMMER_MS = 1900;

/**
 * Inline "background work" marker — work the computer kicked off in the
 * background. Mirrors the desktop `BackgroundWorkCard`: a quiet, elevated row
 * (not an openable artifact card) whose title shimmers while running and
 * settles to a check + status once everything wraps up. State is sync-time, so
 * a running row flips to its finished copy on the next sync.
 */
export function AgentWorkCard({ payload, colors }: AgentWorkCardProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(3)).current;
  const running = payload.state === "running";

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        damping: 18,
        stiffness: 220,
        mass: 0.7,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  return (
    <Animated.View
      style={[styles.row, { opacity, transform: [{ translateY }] }]}
      accessibilityRole="text"
      accessibilityLabel={`${payload.title}. ${payload.subtitle}`}
    >
      {!running ? (
        <View style={styles.glyph}>
          <Icon name="check" size={16} color={colors.text} />
        </View>
      ) : null}
      <View style={styles.text}>
        <ShimmerText
          text={payload.title}
          active={running}
          color={colors.text}
          textStyle={styles.title}
          durationMs={TITLE_SHIMMER_MS}
          dimAlpha={0.32}
        />
        <Text
          style={styles.subtitle}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {payload.subtitle}
        </Text>
      </View>
    </Animated.View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: {
      alignItems: "center",
      alignSelf: "flex-start",
      maxWidth: "100%",
      flexDirection: "row",
      gap: 10,
      minHeight: 44,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.panel,
      paddingTop: 8,
      paddingBottom: 8,
      paddingLeft: 11,
      paddingRight: 14,
    },
    glyph: {
      width: 22,
      height: 22,
      alignItems: "center",
      justifyContent: "center",
    },
    text: {
      flexShrink: 1,
      minWidth: 0,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      lineHeight: 19,
      letterSpacing: -0.2,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11.5,
      letterSpacing: 0.1,
      marginTop: 1,
      fontVariant: ["tabular-nums"],
    },
  });
