import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { activityIndicatorMenuEntries } from "@stella/contracts/activity-indicator";
import type { ActivityIndicatorEntry } from "@stella/contracts/activity-indicator";
import { AgentActivityRow } from "./AgentActivityRow";
import { TopSheet } from "./TopSheet";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { useT } from "../i18n";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { useColors } from "../theme/theme-context";

/**
 * What the top-bar indicator opens: the agents that are in progress right now,
 * one line each, capped at the shared menu cap. The desktop indicator opens
 * the same list with the same cap.
 *
 * It lists only running work on purpose — it is the detail behind "N things in
 * progress", not the activity index. Everything else (settled agents, their
 * files, the conversation's own files) still lives in the sidebar, which a row
 * tap opens.
 */
export function StellaActivityMenu({
  visible,
  running,
  onClose,
  onOpenActivity,
}: {
  visible: boolean;
  running: readonly ActivityIndicatorEntry[];
  onClose: () => void;
  /** Hands off to the sidebar, where the agent's own detail lives. */
  onOpenActivity: () => void;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const entries = useMemo(
    () => activityIndicatorMenuEntries(running),
    [running],
  );

  return (
    <TopSheet visible={visible} onClose={onClose} contentSized glass>
      <View style={styles.sheet}>
        <Text
          style={styles.heading}
          accessibilityRole="header"
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {t("mobile.activityHub.tabs.activity")}
        </Text>
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {entries.map((entry) => (
            <AgentActivityRow
              key={entry.id}
              title={entry.title}
              glyph="star"
              working
              colors={colors}
              onPress={() => {
                onClose();
                onOpenActivity();
              }}
            />
          ))}
        </ScrollView>
      </View>
    </TopSheet>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sheet: {
      gap: 10,
      paddingBottom: 18,
      paddingHorizontal: 18,
      paddingTop: 10,
    },
    heading: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },
    list: {
      flexGrow: 0,
    },
    listContent: {
      gap: 6,
    },
  });
