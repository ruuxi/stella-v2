/**
 * The files a reply hands over, as pills at the bottom of its bubble: icon
 * and name, tap to open, at most `FILE_PILL_CAP` before a "+N more" pill
 * expands the rest (desktop `FilePills` parity).
 */
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import type { ChatArtifact } from "../types";
import { artifactIconName, artifactTitle } from "../lib/mobile-artifacts";
import { AGENT_ACTIVITY_INK, deriveFilePillRow } from "../lib/agent-activity-presentation";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { Icon, type IconName } from "./Icon";

export function ReplyFilePills({
  files,
  colors,
  onOpenArtifact,
  style,
}: {
  files: readonly ChatArtifact[];
  colors: Colors;
  onOpenArtifact: (artifact: ChatArtifact) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const row = deriveFilePillRow(files, expanded);
  return (
    <View style={[styles.pills, style]}>
      {row.visible.map((artifact) => (
        <Pressable
          key={artifact.id}
          accessibilityRole="button"
          accessibilityLabel={`Open ${artifactTitle(artifact.payload)}`}
          onPress={() => onOpenArtifact(artifact)}
          style={({ pressed }) => [styles.pill, pressed ? styles.pillPressed : null]}
        >
          <Icon
            name={artifactIconName(artifact.payload) as IconName}
            size={13}
            color={colors.textMuted}
          />
          <Text
            style={styles.pillLabel}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {artifactTitle(artifact.payload)}
          </Text>
        </Pressable>
      ))}
      {row.hiddenCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show ${row.hiddenCount} more files`}
          onPress={() => setExpanded(true)}
          style={({ pressed }) => [styles.pill, pressed ? styles.pillPressed : null]}
        >
          <Text style={styles.pillLabel} maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}>
            +{row.hiddenCount} more
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pills: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      maxWidth: "100%",
    },
    pill: {
      alignItems: "center",
      flexDirection: "row",
      gap: 5,
      maxWidth: "100%",
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: fadeHex(colors[AGENT_ACTIVITY_INK.pillBorderInk], AGENT_ACTIVITY_INK.pillBorderAlpha),
      backgroundColor: fadeHex(colors[AGENT_ACTIVITY_INK.pillBorderInk], 0.03),
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    pillPressed: { opacity: 0.72 },
    pillLabel: {
      color: colors.text,
      flexShrink: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
    },
  });
