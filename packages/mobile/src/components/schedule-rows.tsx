import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "./Icon";
import {
  scheduleCadence,
  scheduleRowBadge,
  type MobileSchedule,
  type MobileScheduleAction,
} from "../lib/schedules";
import { tapLight } from "../lib/haptics";
import { useT } from "../i18n";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";

export type ScheduleRowStyles = ReturnType<typeof makeScheduleRowStyles>;

/**
 * One schedule in the Schedule list: a cadence line with a leading clock or
 * waveform, the next run (or "Paused"), and pause/delete controls for cron
 * schedules. Ported from the retired activity-hub sheet, whose other row kinds
 * (agents and their files) went away with the sidebar's activity list.
 */
export function ScheduleRow({
  schedule,
  nowMs,
  busy,
  styles,
  colors,
  onAction,
}: {
  schedule: MobileSchedule;
  nowMs: number;
  busy: boolean;
  styles: ScheduleRowStyles;
  colors: Colors;
  onAction: (action: MobileScheduleAction) => void;
}) {
  const t = useT();
  const cadence =
    scheduleCadence(schedule) || t("mobile.activityHub.schedule.customCadence");
  const badge = scheduleRowBadge(schedule, nowMs);
  const paused = badge.kind === "paused";

  return (
    <View style={[styles.scheduleGroup, busy && styles.scheduleRowBusy]}>
      <View style={styles.scheduleRow}>
        <View style={styles.scheduleGlyph}>
          <Icon
            name={schedule.kind === "heartbeat" ? "waveform" : "clock"}
            size={14}
            color={paused ? colors.textMuted : colors.accent}
          />
        </View>
        <View style={styles.scheduleText}>
          <Text
            style={styles.scheduleTitle}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {schedule.title}
          </Text>
          <Text
            style={[
              styles.scheduleSub,
              ...(paused ? [styles.scheduleBadgePaused] : []),
            ]}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {[
              cadence,
              badge.kind === "paused"
                ? t("mobile.activityHub.schedule.paused")
                : t("mobile.activityHub.schedule.next", { when: badge.label }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {!paused && schedule.lastError ? (
            <Text
              style={styles.scheduleError}
              numberOfLines={2}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {t("mobile.activityHub.schedule.lastRunFailed", {
                error: schedule.lastError,
              })}
            </Text>
          ) : null}
        </View>
        {schedule.kind === "cron" ? (
          <View style={styles.scheduleActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                paused
                  ? t("mobile.activityHub.schedule.resumeSchedule")
                  : t("mobile.activityHub.schedule.pauseSchedule")
              }
              disabled={busy}
              hitSlop={8}
              onPress={() => {
                tapLight();
                onAction(paused ? "resume" : "pause");
              }}
              style={({ pressed }) => [
                styles.scheduleActionButton,
                pressed && styles.scheduleActionButtonPressed,
              ]}
            >
              <Icon
                name={paused ? "play" : "pause"}
                size={13}
                color={colors.textMuted}
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(
                "mobile.activityHub.schedule.deleteSchedule",
              )}
              disabled={busy}
              hitSlop={8}
              onPress={() => {
                tapLight();
                onAction("remove");
              }}
              style={({ pressed }) => [
                styles.scheduleActionButton,
                pressed && styles.scheduleActionButtonPressed,
              ]}
            >
              <Icon name="x" size={13} color={colors.danger} />
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export const makeScheduleRowStyles = (colors: Colors) =>
  StyleSheet.create({
    scheduleGroup: {
      gap: 2,
    },
    scheduleRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 2,
      paddingVertical: 10,
    },
    scheduleGlyph: {
      alignItems: "center",
      height: 20,
      justifyContent: "center",
      width: 20,
    },
    scheduleText: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
    },
    scheduleTitle: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14.5,
      letterSpacing: -0.2,
    },
    scheduleSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12.5,
      letterSpacing: -0.1,
      marginTop: 1,
    },
    scheduleError: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12.5,
      letterSpacing: -0.1,
      lineHeight: 16,
      marginTop: 2,
    },
    scheduleRowBusy: {
      opacity: 0.5,
    },
    scheduleBadgePaused: {
      color: colors.accent,
    },
    scheduleActions: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
    },
    scheduleActionButton: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      height: 24,
      justifyContent: "center",
      width: 24,
    },
    scheduleActionButtonPressed: {
      backgroundColor: fadeHex(colors.text, 0.08),
    },
  });
