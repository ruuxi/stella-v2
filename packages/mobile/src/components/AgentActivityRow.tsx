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

const TITLE_SHIMMER_MS = 1900;

const RUNNING_REST_ALPHA = AGENT_ACTIVITY_INK.runningRestAlpha;

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
      {

}
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

          color={colors.textStrong}
          textStyle={

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

      color: colors[AGENT_ACTIVITY_INK.titleInk],
      fontFamily: fonts.sans.medium,

      fontSize: 15,
      lineHeight: 20,
      letterSpacing: -0.2,
    },
    chevron: {
      opacity: 0.7,
    },
  });
