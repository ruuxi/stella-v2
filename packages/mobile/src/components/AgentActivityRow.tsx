import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "./Icon";
import { ShimmerText } from "./ShimmerText";
import { StellaStarGlyph } from "./AgentActivityGlyph";
import {
  AGENT_ACTIVITY_INK,
  type AgentActivityGlyph,
} from "../lib/agent-activity-presentation";
import { fadeHex } from "../theme/oklch";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";

/** Sweep duration for the title shimmer — a touch quicker than the base
 *  ShimmerText so the in-progress state reads as lively (desktop parity). */
const TITLE_SHIMMER_MS = 1900;

/** Resting strength of the running title — the shimmer's bright band lifts
 *  the dimmed glyphs up to full ink as it passes (inverted polarity). Sits
 *  at the settled title's own strength (desktop `--text-shimmer-from:
 *  --text-base`) so settled and running rows agree; the passing wave alone
 *  carries the motion. */
const RUNNING_REST_ALPHA = AGENT_ACTIVITY_INK.runningRestAlpha;

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

  return (
    <Pressable
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={title}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && onPress ? styles.rowPressed : null]}
    >
      {/* Status glyph at FULL strength — solid strong ink, no dimming
          (desktop parity); only the description keeps the muted/shimmer
          treatment. */}
      <View style={styles.glyph}>
        {glyph === "star" ? (
          <StellaStarGlyph size={13} color={colors[AGENT_ACTIVITY_INK.glyphInk]} />
        ) : (
          <Icon
            name={glyph === "arrow" ? "arrow-right" : "check"}
            size={13}
            color={colors[AGENT_ACTIVITY_INK.glyphInk]}
          />
        )}
      </View>
      <View style={styles.titleWrap}>
        <ShimmerText
          text={title}
          active={working}
          variant="highlight"
          // Sweep peak lifts to full strong ink (desktop
          // `--text-shimmer-via: --text-strong`); the resting base below is
          // the same ink faded to the settled title's strength.
          color={colors.textStrong}
          textStyle={
            // Running rows rest at the settled title's strength and the sweep
            // lifts them to full strong ink; ShimmerText renders the same
            // resting color statically when motion is off, so the state still
            // reads as in-progress.
            working
              ? [
                  styles.title,
                  {
                    color: fadeHex(colors.textStrong, RUNNING_REST_ALPHA),
                  },
                ]
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
      // One notch up from muted (desktop --text-weak -> --text-base):
      // comfortably readable, still clearly secondary to main-chat body
      // text, and matching the running shimmer's resting base.
      color: colors[AGENT_ACTIVITY_INK.titleInk],
      fontFamily: fonts.sans.medium,
      // Matches desktop's bumped row text size — one step up from the old
      // 14pt so the description reads comfortably without moving the glyphs.
      fontSize: 15,
      lineHeight: 20,
      letterSpacing: -0.2,
    },
    chevron: {
      opacity: 0.7,
    },
  });
