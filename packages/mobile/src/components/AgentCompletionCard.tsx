import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AgentActivityRow } from "./AgentActivityRow";
import { Icon, type IconName } from "./Icon";
import type { ChatArtifact } from "../types";
import { artifactIconName, artifactTitle } from "../lib/mobile-artifacts";
import type { AgentWorkCardSection } from "../lib/agent-artifact-consolidation";
import {
  AGENT_ACTIVITY_INK,
  deriveFilePillRow,
} from "../lib/agent-activity-presentation";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";

export function AgentCompletionCard({
  sections,
  colors,
  onPress,
  onOpenArtifact,
}: {

  sections: AgentWorkCardSection[];
  colors: Colors;

  onPress?: () => void;

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

      paddingLeft: 24,
      maxWidth: "100%",
    },
    pill: {
      alignItems: "center",
      flexDirection: "row",
      gap: 5,
      maxWidth: "100%",

      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,

      borderColor: colors[AGENT_ACTIVITY_INK.pillBorderInk],
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
