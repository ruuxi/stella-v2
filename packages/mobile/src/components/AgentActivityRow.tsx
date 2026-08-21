import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { Icon } from "./Icon";
import { ShimmerText } from "./ShimmerText";
import { StellaStarGlyph } from "./AgentActivityGlyph";
import type { AgentActivityGlyph } from "../lib/agent-activity-presentation";
import { fadeHex } from "../theme/oklch";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";

/** Sweep duration for the title shimmer — a touch quicker than the base
 *  ShimmerText so the in-progress state reads as lively (desktop parity). */
const TITLE_SHIMMER_MS = 1900;

/** Resting strength of the running title — the shimmer's bright band lifts
 *  the dimmed glyphs up to full ink as it passes (inverted polarity). */
const RUNNING_REST_ALPHA = 0.45;

/**
 * One minimal, chrome-less agent activity line — the mobile analogue of the
 * desktop `agent-activity-row`. No card surface, no border, no badges, no
 * provider icons: a leading slot that doubles as the status tell (static
 * star while the shimmering title carries the running motion, a quiet grey
 * check once done, an arrow for `send_input` follow-ups; failed rows keep
 * the plain star), the task DESCRIPTION on a single line, and a trailing
 * chevron as the tap-through affordance.
 */
export function AgentActivityRow({
  title,
  glyph,
  working,
  colors,
  onPress,
}: {
  title: string;
  glyph: AgentActivityGlyph;
  working: boolean;
  colors: Colors;
  /** Opens the agent detail (activity hub). Row is inert when absent. */
  onPress?: () => void;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // OS reduce-motion: the sweep stills entirely — static dimmed text remains
  // the running tell (the star still marks the row as agent work).
  const reduceMotion = useReducedMotion();
  const shimmerActive = working && !reduceMotion;
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={title}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && onPress ? styles.rowPressed : null]}
    >
      <View style={styles.glyph}>
        {glyph === "star" ? (
          <StellaStarGlyph size={13} color={colors.textMuted} />
        ) : (
          <Icon
            name={glyph === "arrow" ? "arrow-right" : "check"}
            size={13}
            color={colors.textMuted}
          />
        )}
      </View>
      <View style={styles.titleWrap}>
        <ShimmerText
          text={title}
          active={shimmerActive}
          variant="highlight"
          color={colors.text}
          textStyle={
            // Running rows read through the shimmer's stronger ink; with the
            // sweep stilled (reduce motion) the same dimmed resting color
            // renders statically so the state still reads as in-progress.
            working
              ? [styles.title, { color: fadeHex(colors.text, RUNNING_REST_ALPHA) }]
              : styles.title
          }
          durationMs={TITLE_SHIMMER_MS}
          dimAlpha={RUNNING_REST_ALPHA}
        />
      </View>
      <Icon
        name="chevron-right"
        size={13}
        color={colors.textMuted}
        style={styles.chevron}
      />
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: {
      alignSelf: "flex-start",
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      maxWidth: "100%",
      minHeight: 24,
      paddingVertical: 2,
    },
    rowPressed: {
      opacity: 0.72,
    },
    glyph: {
      width: 16,
      height: 16,
      alignItems: "center",
      justifyContent: "center",
    },
    titleWrap: {
      flexShrink: 1,
      minWidth: 0,
    },
    title: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      lineHeight: 19,
      letterSpacing: -0.2,
    },
    chevron: {
      opacity: 0.7,
    },
  });
