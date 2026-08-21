import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AgentActivityRow } from "./AgentActivityRow";
import { Icon, type IconName } from "./Icon";
import type { ChatArtifact } from "../types";
import { artifactIconName, artifactTitle } from "../lib/mobile-artifacts";
import type { AgentWorkCardSection } from "../lib/agent-artifact-consolidation";
import { deriveFilePillRow } from "../lib/agent-activity-presentation";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";

/**
 * The settled presentation of a spawn-anchored card — the mobile analogue of
 * the redesigned desktop `AgentCompletionCard`. Each completed agent renders
 * as one quiet chrome-less line — grey check, the task DESCRIPTION, trailing
 * chevron — and, when the agent produced files, a row of pill-shaped file
 * chips directly under that line (no card container). Up to `FILE_PILL_CAP`
 * chips show, then a "+N more" chip expands the rest; tapping a chip opens
 * the file exactly as the old card's pills did. Several agents completing at
 * the same slot stack as sibling rows. Result excerpts stay in the activity
 * hub — the row face carries the description and files only.
 */
export function AgentCompletionCard({
  sections,
  colors,
  onPress,
  onOpenArtifact,
}: {
  /** Per-agent completion rollups (title = the agent's task description). */
  sections: AgentWorkCardSection[];
  colors: Colors;
  /** Opens the agent detail (activity hub). */
  onPress?: () => void;
  /** Opens a tapped produced-file chip. Chips hide when absent. */
  onOpenArtifact?: (artifact: ChatArtifact) => void;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  if (sections.length === 0) return null;
  return (
    <View>
      {sections.map((section) => {
        const showPills =
          Boolean(onOpenArtifact) && section.files.length > 0;
        const { visible, hiddenCount } = deriveFilePillRow(
          section.files,
          expandedKeys[section.key] === true,
        );
        return (
          <View key={section.key}>
            <AgentActivityRow
              title={section.title || "Finished"}
              glyph="check"
              working={false}
              colors={colors}
              {...(onPress ? { onPress } : {})}
            />
            {showPills ? (
              <View style={styles.pills}>
                {visible.map((artifact) => (
                  <Pressable
                    key={artifact.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${artifactTitle(artifact.payload)}`}
                    onPress={() => onOpenArtifact?.(artifact)}
                    style={({ pressed }) => [
                      styles.pill,
                      pressed ? styles.pillPressed : null,
                    ]}
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
                {hiddenCount > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Show ${hiddenCount} more files`}
                    onPress={() =>
                      setExpandedKeys((prev) => ({
                        ...prev,
                        [section.key]: true,
                      }))
                    }
                    style={({ pressed }) => [
                      styles.pill,
                      pressed ? styles.pillPressed : null,
                    ]}
                  >
                    <Text
                      style={styles.pillLabel}
                      maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                    >
                      +{hiddenCount} more
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pills: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      marginTop: 4,
      marginBottom: 4,
      // Align the chip row under the description, past the glyph slot
      // (16px glyph + 8px gap), matching the desktop treatment.
      paddingLeft: 24,
      maxWidth: "100%",
    },
    pill: {
      alignItems: "center",
      flexDirection: "row",
      gap: 5,
      maxWidth: "100%",
      // Fully-rounded pill shape (not a rounded square) — desktop parity.
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    pillPressed: {
      opacity: 0.72,
    },
    pillLabel: {
      color: colors.text,
      flexShrink: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
    },
  });
