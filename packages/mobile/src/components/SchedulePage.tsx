import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { useIsFocused } from "expo-router";
import { useT } from "../i18n";
import {
  fetchMobileSchedules,
  mutateMobileSchedule,
  subscribeMobileScheduleUpdates,
  type MobileSchedule,
  type MobileScheduleAction,
} from "../lib/desktop-schedules";
import { authClient } from "../lib/auth-client";
import { isGuest } from "../lib/guest-mode";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { useShellBottomInset } from "../lib/shell-bottom-inset";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { useColors } from "../theme/theme-context";
import { ScheduleRow, makeActivityRowStyles } from "./sidebar/activity-rows";

/**
 * The Schedule tab: the paired computer's recurring jobs and heartbeats, with
 * pause / resume / delete for cron jobs. Loads while the tab is on screen (a
 * cheap authenticated read through the desktop bridge) and stays live via the
 * desktop's `schedule:updated` broadcast for as long as it is.
 */
export function SchedulePage() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const rowStyles = useMemo(() => makeActivityRowStyles(colors), [colors]);
  const bottomInset = useShellBottomInset();
  const focused = useIsFocused();
  const session = authClient.useSession();
  const signedIn = Boolean(session.data?.user) && !isGuest();

  const [schedules, setSchedules] = useState<MobileSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // True until unmount; loads and mutations check it before touching state
  // so a slow bridge round-trip can't set state on a torn-down page.
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );
  // Monotonic load epoch: a response only lands if it is still the newest
  // request, so overlapping loads can't interleave into last-write-wins.
  const loadEpochRef = useRef(0);

  const load = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    const isCurrent = () => aliveRef.current && loadEpochRef.current === epoch;
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchMobileSchedules();
      if (isCurrent()) setSchedules(rows);
    } catch (e) {
      if (isCurrent()) {
        setError(
          e instanceof Error
            ? e.message
            : t("mobile.activityHub.schedule.loadFailed"),
        );
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [t]);

  const live = focused && signedIn;
  useEffect(() => {
    if (!live) return;
    void load();
    const subscription = subscribeMobileScheduleUpdates(() => {
      void load();
    });
    return () => subscription.close();
  }, [live, load]);

  const applyAction = useCallback(
    async (schedule: MobileSchedule, action: MobileScheduleAction) => {
      setBusyKey(`${schedule.kind}:${schedule.id}`);
      try {
        await mutateMobileSchedule(action, schedule);
        // Re-read so enabled/nextRunAtMs come back authoritative.
        await load();
      } catch (e) {
        if (aliveRef.current) {
          Alert.alert(
            t("mobile.activityHub.schedule.alertTitle"),
            e instanceof Error
              ? e.message
              : t("mobile.activityHub.schedule.actionFailed"),
          );
        }
      } finally {
        if (aliveRef.current) setBusyKey(null);
      }
    },
    [load, t],
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
    if (loading && schedules.length === 0) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      );
    }
    if (error && schedules.length === 0) {
      return <Text style={styles.empty}>{error}</Text>;
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
