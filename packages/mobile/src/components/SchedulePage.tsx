import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { useT } from "../i18n";
import {
  useMobileSchedules,
  useScheduleAction,
  type MobileSchedule,
  type MobileScheduleAction,
} from "../lib/schedules";
import { useAccountSession } from "../lib/auth-client";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { useColors } from "../theme/theme-context";
import { ScheduleRow, makeActivityRowStyles } from "./sidebar/activity-rows";

/**
 * The Schedule tab: every schedule the owner has, whichever computer or the
 * cloud runs it, read live from the backend. Pause / resume / delete write back
 * the same way, so the list updates on every device at once.
 */
export function SchedulePage() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const rowStyles = useMemo(() => makeActivityRowStyles(colors), [colors]);
  const bottomInset = useSafeAreaInsets().bottom;
  const session = useAccountSession();
  const signedIn = Boolean(session.data?.user);

  const loaded = useMobileSchedules(signedIn);
  const schedules = loaded ?? EMPTY;
  const loading = signedIn && loaded === undefined;
  const runAction = useScheduleAction();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const applyAction = useCallback(
    async (schedule: MobileSchedule, action: MobileScheduleAction) => {
      setBusyKey(`${schedule.kind}:${schedule.id}`);
      try {
        await runAction(action, schedule);
      } catch (e) {
        Alert.alert(
          t("mobile.activityHub.schedule.alertTitle"),
          e instanceof Error
            ? e.message
            : t("mobile.activityHub.schedule.actionFailed"),
        );
      } finally {
        setBusyKey(null);
      }
    },
    [runAction, t],
  );

  const onAction = useCallback(
    (schedule: MobileSchedule, action: MobileScheduleAction) => {
      if (busyKey) return;
      if (action === "remove") {
        // Destructive actions confirm first — deleting stops future runs.
        Alert.alert(
          t("mobile.activityHub.schedule.deleteSchedule"),
          t("mobile.activityHub.schedule.deleteConfirm", {
            title: schedule.title,
          }),
          [
            { text: t("mobile.common.cancel"), style: "cancel" },
            {
              text: t("mobile.common.delete"),
              style: "destructive",
              onPress: () => {
                void applyAction(schedule, action);
              },
            },
          ],
        );
        return;
      }
      void applyAction(schedule, action);
    },
    [busyKey, applyAction, t],
  );

  // Frozen per load so relative badges ("in 5m") don't flicker as the list
  // re-renders; refreshed each time the schedule list reloads.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [schedules]);

  const renderBody = () => {
    if (!signedIn) {
      return <Text style={styles.empty}>{t("mobile.sidebar.signedOutHint")}</Text>;
    }
    if (loading) {
      return (
        <View style={[styles.centered, { paddingBottom: bottomInset }]}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      );
    }
    return (
      <LegendList<MobileSchedule>
        style={styles.list}
        contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
        data={schedules}
        keyExtractor={(row) => `${row.kind}:${row.id}`}
        renderItem={({ item }: LegendListRenderItemProps<MobileSchedule>) => (
          <ScheduleRow
            schedule={item}
            nowMs={nowMs}
            busy={busyKey === `${item.kind}:${item.id}`}
            styles={rowStyles}
            colors={colors}
            onAction={(action) => onAction(item, action)}
          />
        )}
        ListEmptyComponent={
          <Text
            style={styles.empty}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {t("mobile.activityHub.schedule.empty")}
          </Text>
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        showsVerticalScrollIndicator={false}
        estimatedItemSize={60}
        recycleItems
      />
    );
  };

  return (
    <View style={styles.root}>
      <Text style={styles.title} accessibilityRole="header">
        {t("mobile.activityHub.tabs.schedule")}
      </Text>
      {renderBody()}
    </View>
  );
}

const EMPTY: MobileSchedule[] = [];

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      flex: 1,
      minHeight: 0,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 32,
      letterSpacing: -1.2,
      marginBottom: 16,
      marginTop: 4,
    },
    list: {
      flex: 1,
    },
    centered: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      paddingHorizontal: 20,
      paddingVertical: 36,
      textAlign: "center",
    },
    separator: {
      height: 2,
    },
  });
