import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useT } from "../i18n";
import {
  useMobileSchedules,
  useScheduleAction,
  type MobileSchedule,
  type MobileScheduleAction,
} from "../lib/schedules";
import { authClient } from "../lib/auth-client";
import { isGuest } from "../lib/guest-mode";
import { startChatWith } from "../lib/ask-stella";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "../theme/theme-context";
import { EmptyState } from "./EmptyState";
import { ScheduleRow, makeScheduleRowStyles } from "./schedule-rows";

/**
 * The Schedule tab: every schedule the owner has, whichever computer or the
 * cloud runs it, read live from the backend. Pause / resume / delete write back
 * the same way, so the list updates on every device at once.
 */
export function SchedulePage() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(), []);
  const router = useRouter();
  const rowStyles = useMemo(() => makeScheduleRowStyles(colors), [colors]);
  const bottomInset = useSafeAreaInsets().bottom;
  const session = authClient.useSession();
  const signedIn = Boolean(session.data?.user) && !isGuest();

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
      return (
        <EmptyState motif="schedule" message={t("mobile.sidebar.signedOutHint")} />
      );
    }
    if (loading) {
      return (
        <View style={[styles.centered, { paddingBottom: bottomInset }]}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      );
    }
    if (schedules.length === 0) {
      return (
        <EmptyState
          motif="schedule"
          message={t("mobile.activityHub.schedule.empty")}
          action={{
            label: t("mobile.activityHub.schedule.emptyAction"),
            onPress: () =>
              startChatWith(
                router,
                t("mobile.activityHub.schedule.emptyActionPrompt"),
              ),
          }}
        />
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
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        showsVerticalScrollIndicator={false}
        estimatedItemSize={60}
        recycleItems
      />
    );
  };

  return <View style={styles.root}>{renderBody()}</View>;
}

const EMPTY: MobileSchedule[] = [];

const makeStyles = () =>
  StyleSheet.create({
    root: {
      flex: 1,
      minHeight: 0,
    },
    list: {
      flex: 1,
      marginTop: 8,
    },
    centered: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },
    separator: {
      height: 2,
    },
  });
