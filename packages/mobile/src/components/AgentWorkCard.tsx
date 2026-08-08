import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { ShimmerText } from "./ShimmerText";
import type { ChatArtifact, MobileDisplayPayload } from "../types";
import { artifactIconName, artifactTitle } from "../lib/mobile-artifacts";
import type { AgentWorkCardSection } from "../lib/agent-artifact-consolidation";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";

type AgentWorkPayload = Extract<MobileDisplayPayload, { kind: "agent-work" }>;

type AgentWorkCardProps = {
  payload: AgentWorkPayload;
  colors: Colors;
  /**
   * Produced-file pill groups folded into the card (the mobile analogue of
   * the desktop `AgentCompletionCard`): one section per agent when the
   * bridge ships per-agent attribution, or a single untitled section from
   * the row-scoped fallback. Only passed once the files are revealable —
   * reveal-at-completion, never mid-run.
   */
  sections?: AgentWorkCardSection[];
  onOpenArtifact?: (artifact: ChatArtifact) => void;
};

/** Pills shown before the "+N more" toggle — mirrors the desktop PILL_CAP. */
const PILL_CAP = 5;

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
export function AgentWorkCard({
  payload,
  colors,
  sections,
  onOpenArtifact,
}: AgentWorkCardProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(3)).current;
  const [pillsExpanded, setPillsExpanded] = useState(false);
  const running = payload.state === "running";
  const fileSections =
    onOpenArtifact && sections
      ? sections.filter((section) => section.files.length > 0)
      : [];
  // Section headers earn their space only when the card carries several
  // agents' files — a single group is already named by the card title.
  const showSectionTitles = fileSections.length > 1;

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
      style={[styles.card, { opacity, transform: [{ translateY }] }]}
      accessibilityRole="text"
      accessibilityLabel={`${payload.title}. ${payload.subtitle}`}
    >
      <View style={styles.headerRow}>
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
      </View>
      {fileSections.length > 0 && onOpenArtifact
        ? fileSections.map((section) => {
            const visiblePills =
              pillsExpanded || section.files.length <= PILL_CAP
                ? section.files
                : section.files.slice(0, PILL_CAP);
            const hiddenPillCount = section.files.length - visiblePills.length;
            return (
              <View key={section.key}>
                {showSectionTitles && section.title ? (
                  <Text
                    style={styles.sectionTitle}
                    numberOfLines={1}
                    maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                  >
                    {section.title}
                  </Text>
                ) : null}
                <View
                  style={[
                    styles.pills,
                    showSectionTitles && section.title
                      ? styles.pillsTitled
                      : null,
                  ]}
                >
                  {visiblePills.map((artifact) => (
                    <Pressable
                      key={artifact.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${artifactTitle(artifact.payload)}`}
                      onPress={() => onOpenArtifact(artifact)}
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
                      onPress={() => setPillsExpanded(true)}
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
              </View>
            );
          })
        : null}
    </Animated.View>
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
    sectionTitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 11.5,
      letterSpacing: 0.1,
      marginTop: 8,
    },
    pills: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      marginTop: 8,
    },
    pillsTitled: {
      marginTop: 6,
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
