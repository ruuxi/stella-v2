import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import type { ChatArtifact } from "../types";
import { artifactIconName, artifactTitle } from "../lib/mobile-artifacts";
import type { AgentWorkCardSection } from "../lib/agent-artifact-consolidation";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";

/** Pills shown before the "+N more" toggle — mirrors the desktop PILL_CAP. */
const PILL_CAP = 5;

type AgentCompletionCardProps = {
  /** Per-agent completion rollups (files and/or a result excerpt). */
  sections: AgentWorkCardSection[];
  colors: Colors;
  onOpenArtifact?: (artifact: ChatArtifact) => void;
};

/**
 * The mobile analogue of the desktop `AgentCompletionCard`: a distinct
 * completion card, SEPARATE from the spawn/working `AgentWorkCard`, posted when
 * a delegated agent finishes. It mirrors the desktop card's structure — a muted
 * checkmark header, then per-agent sections that show produced-file pills OR,
 * for a fileless completion, the result excerpt as a stand-in (never both).
 */
export function AgentCompletionCard({
  sections,
  colors,
  onOpenArtifact,
}: AgentCompletionCardProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  const visible = sections.filter(
    (section) =>
      (onOpenArtifact && section.files.length > 0) ||
      (section.summary?.length ?? 0) > 0,
  );
  if (visible.length === 0) return null;
  const showSectionTitles = visible.length > 1;
  const headerTitle =
    visible.length > 1
      ? `${visible.length} tasks finished`
      : (visible[0]?.title ?? "Finished");
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.glyph}>
          <Icon name="check" size={16} color={colors.text} />
        </View>
        <Text
          style={styles.title}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {headerTitle}
        </Text>
      </View>
      {visible.map((section) => {
        const showPills =
          Boolean(onOpenArtifact) && section.files.length > 0;
        const expanded = expandedKeys[section.key] === true;
        const visiblePills =
          expanded || section.files.length <= PILL_CAP
            ? section.files
            : section.files.slice(0, PILL_CAP);
        const hiddenPillCount = section.files.length - visiblePills.length;
        return (
          <View key={section.key} style={styles.section}>
            {showSectionTitles && section.title ? (
              <Text
                style={styles.sectionTitle}
                numberOfLines={1}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {section.title}
              </Text>
            ) : null}
            {section.summary && !showPills ? (
              <Text
                style={styles.summary}
                numberOfLines={4}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {section.summary}
              </Text>
            ) : null}
            {showPills ? (
              <View style={styles.pills}>
                {visiblePills.map((artifact) => (
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
                {hiddenPillCount > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Show ${hiddenPillCount} more files`}
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
                      +{hiddenPillCount} more
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
    card: {
      alignSelf: "flex-start",
      maxWidth: "100%",
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
    headerRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      minHeight: 28,
    },
    glyph: {
      width: 22,
      height: 22,
      alignItems: "center",
      justifyContent: "center",
    },
    title: {
      flexShrink: 1,
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      lineHeight: 19,
      letterSpacing: -0.2,
    },
    section: {
      marginTop: 2,
    },
    sectionTitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 11.5,
      letterSpacing: 0.1,
      marginTop: 8,
    },
    summary: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12.5,
      lineHeight: 17,
      letterSpacing: -0.1,
      marginTop: 6,
    },
    pills: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      marginTop: 8,
    },
    pill: {
      alignItems: "center",
      flexDirection: "row",
      gap: 5,
      maxWidth: "100%",
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: 8,
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
