import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ArtifactCard } from "../ArtifactCard";
import { Icon } from "../Icon";
import { ShimmerText } from "../ShimmerText";
import { summarizeHubSubagents } from "../../lib/activity-hub-model";
import {
  scheduleCadence,
  scheduleRowBadge,
  type MobileSchedule,
  type MobileScheduleAction,
} from "../../lib/desktop-schedules";
import { tapLight } from "../../lib/haptics";
import { useT, useTPlural } from "../../i18n";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import type { ChatArtifact, MobileTask } from "../../types";

const SHIMMER_MS = 1900;

const TERMINAL_SUBTITLE_KEY: Record<
  Exclude<MobileTask["status"], "running">,
  string
> = {
  completed: "mobile.activityHub.task.finished",
  error: "mobile.activityHub.task.failed",
  canceled: "mobile.activityHub.task.stopped",
};

export type GroupSubagent = { task: MobileTask; artifacts: ChatArtifact[] };

export type ActivityRowStyles = ReturnType<typeof makeActivityRowStyles>;

/**
 * The rows the sidebar's Activity, Schedule and Files lists are made of.
 * Ported from the retired activity-hub sheet and tightened for a 300pt
 * column: the same glyph/title/subtitle anatomy at one size step smaller.
 */
export function TaskRow({
  task,
  artifacts,
  onOpenArtifact,
  colors,
  styles,
}: {
  task: MobileTask;
  artifacts: readonly ChatArtifact[];
  onOpenArtifact: (artifact: ChatArtifact) => void;
  colors: Colors;
  styles: ActivityRowStyles;
}) {
  const t = useT();
  const running = task.status === "running";
  const isError = task.status === "error";
  const subtitle =
    task.status === "running"
      ? task.statusText?.trim() || t("mobile.activityHub.task.working")
      : t(TERMINAL_SUBTITLE_KEY[task.status]);
  // Newest reasoning summary (oldest→newest order), shown under the agent while
  // it's active. Defensive against the field being absent on older desktops.
  const reasoningSummary = running
    ? task.reasoningSummaries?.[task.reasoningSummaries.length - 1]?.trim()
    : undefined;

  return (
    <View style={styles.taskGroup}>
      <View style={styles.taskRow}>
        <View style={styles.taskGlyph}>
          {running ? (
            <View style={styles.runningDot} />
          ) : task.status === "canceled" ? (
            <View style={styles.canceledDot} />
          ) : (
            <Icon
              name={isError ? "alert-circle" : "check"}
              size={14}
              color={isError ? colors.danger : colors.text}
            />
          )}
        </View>
        <View style={styles.taskText}>
          {running ? (
            <ShimmerText
              text={task.title}
              active
              color={colors.text}
              textStyle={styles.taskTitle}
              durationMs={SHIMMER_MS}
              dimAlpha={0.3}
            />
          ) : (
            <Text
              style={styles.taskTitle}
              numberOfLines={1}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {task.title}
            </Text>
          )}
          <Text
            style={styles.taskSub}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {subtitle}
          </Text>
          {reasoningSummary ? (
            <Text
              style={styles.taskReasoning}
              numberOfLines={2}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {reasoningSummary}
            </Text>
          ) : null}
        </View>
      </View>
      {artifacts.length > 0 ? (
        <View style={styles.nestedFiles}>
          {artifacts.map((artifact) => (
            <ArtifactCard
              key={artifact.id}
              artifact={artifact}
              colors={colors}
              onPress={onOpenArtifact}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A top-level agent row plus the subagents it spawned, grouped the way the
 * desktop activity workspace does: the parent is always visible, its owned
 * subagents collapse into a single "N subagents · M done" summary, and a tap
 * expands them into the normal subagent list. Collapsed by default so a
 * subagent-heavy run (e.g. a 16-child research fleet) stays quiet.
 */
export function TaskGroupRow({
  owner,
  ownerArtifacts,
  subagents,
  expanded,
  onToggle,
  onOpenArtifact,
  colors,
  styles,
}: {
  owner: MobileTask;
  ownerArtifacts: readonly ChatArtifact[];
  subagents: readonly GroupSubagent[];
  expanded: boolean;
  onToggle: (ownerId: string) => void;
  onOpenArtifact: (artifact: ChatArtifact) => void;
  colors: Colors;
  styles: ActivityRowStyles;
}) {
  const tPlural = useTPlural();
  const summary = useMemo(
    () => summarizeHubSubagents(subagents.map((entry) => entry.task)),
    [subagents],
  );
  const countLabel = tPlural(
    "mobile.activityHub.subagents.count",
    summary.total,
  );
  const doneLabel = tPlural("mobile.activityHub.subagents.done", summary.done);
  return (
    <View style={styles.taskGroup}>
      <TaskRow
        task={owner}
        artifacts={ownerArtifacts}
        onOpenArtifact={onOpenArtifact}
        colors={colors}
        styles={styles}
      />
      {subagents.length > 0 ? (
        <>
          <Pressable
            onPress={() => onToggle(owner.id)}
            style={styles.groupToggle}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`${countLabel}, ${doneLabel}`}
          >
            <Icon
              name={expanded ? "chevron-down" : "chevron-right"}
              size={13}
              color={colors.textMuted}
            />
            <Text
              style={styles.groupToggleText}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {countLabel}
            </Text>
            {summary.running > 0 ? <View style={styles.runningDot} /> : null}
            <Text
              style={styles.groupToggleMeta}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {doneLabel}
            </Text>
          </Pressable>
          {expanded ? (
            <View style={styles.groupChildren}>
              {subagents.map((entry) => (
                <TaskRow
                  key={entry.task.id}
                  task={entry.task}
                  artifacts={entry.artifacts}
                  onOpenArtifact={onOpenArtifact}
                  colors={colors}
                  styles={styles}
                />
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export function ConversationFilesRow({
  artifacts,
  colors,
  styles,
  onOpenArtifact,
}: {
  artifacts: readonly ChatArtifact[];
  colors: Colors;
  styles: ActivityRowStyles;
  onOpenArtifact: (artifact: ChatArtifact) => void;
}) {
  const t = useT();
  if (artifacts.length === 0) return null;
  return (
    <View style={styles.taskGroup}>
      <View style={styles.taskRow}>
        <View style={styles.taskGlyph}>
          <Icon name="message-square" size={14} color={colors.text} />
        </View>
        <View style={styles.taskText}>
          <Text
            style={styles.taskTitle}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {t("mobile.activityHub.conversation.title")}
          </Text>
          <Text
            style={styles.taskSub}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {t("mobile.activityHub.conversation.subtitle")}
          </Text>
        </View>
      </View>
      <View style={styles.nestedFiles}>
        {artifacts.map((artifact) => (
          <ArtifactCard
            key={artifact.id}
            artifact={artifact}
            colors={colors}
            onPress={onOpenArtifact}
          />
        ))}
      </View>
    </View>
  );
}

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
  styles: ActivityRowStyles;
  colors: Colors;
  onAction: (action: MobileScheduleAction) => void;
}) {
  const t = useT();
  const cadence =
    scheduleCadence(schedule) || t("mobile.activityHub.schedule.customCadence");
  const badge = scheduleRowBadge(schedule, nowMs);
  const paused = badge.kind === "paused";

  return (
    <View style={[styles.taskGroup, busy && styles.scheduleRowBusy]}>
      <View style={styles.taskRow}>
        <View style={styles.taskGlyph}>
          <Icon
            name={schedule.kind === "heartbeat" ? "waveform" : "clock"}
            size={14}
            color={paused ? colors.textMuted : colors.accent}
          />
        </View>
        <View style={styles.taskText}>
          <Text
            style={styles.taskTitle}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {schedule.title}
          </Text>
          <Text
            style={[
              styles.taskSub,
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
              style={styles.taskReasoning}
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
              accessibilityLabel={t("mobile.activityHub.schedule.deleteSchedule")}
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

export const makeActivityRowStyles = (colors: Colors) =>
  StyleSheet.create({
    taskGroup: {
      gap: 2,
    },
    // Collapsed subagent summary bar; sits under the parent's text column.
    groupToggle: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      marginLeft: 30,
      paddingVertical: 5,
    },
    groupToggleText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 11,
      letterSpacing: -0.1,
    },
    groupToggleMeta: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
      letterSpacing: -0.1,
      marginLeft: "auto",
    },
    // Expanded subagent list: indented + a hairline rail to read as nested.
    groupChildren: {
      borderLeftColor: colors.border,
      borderLeftWidth: StyleSheet.hairlineWidth,
      gap: 2,
      marginLeft: 8,
      marginTop: 2,
      paddingLeft: 11,
    },
    taskRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 2,
      paddingVertical: 7,
    },
    taskGlyph: {
      alignItems: "center",
      height: 20,
      justifyContent: "center",
      width: 20,
    },
    runningDot: {
      backgroundColor: colors.accent,
      borderRadius: 999,
      height: 7,
      width: 7,
    },
    canceledDot: {
      backgroundColor: colors.textMuted,
      borderRadius: 999,
      height: 7,
      width: 7,
    },
    taskText: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
    },
    nestedFiles: {
      gap: 6,
      marginBottom: 6,
      marginLeft: 30,
    },
    taskTitle: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.2,
    },
    taskSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11.5,
      letterSpacing: -0.1,
      marginTop: 1,
    },
    taskReasoning: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11.5,
      letterSpacing: -0.1,
      lineHeight: 15,
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
