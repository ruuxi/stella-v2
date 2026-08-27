import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactViewerContent } from "./ArtifactViewer";
import { Icon, type IconName } from "./Icon";
import { ShimmerText } from "./ShimmerText";
import { TopSheet } from "./TopSheet";
import { filterHubArtifacts, filterHubTasks } from "../lib/activity-hub-search";
import {
  activityHubGroupRowKey,
  activityHubTaskRowKey,
  groupActivityHubTasks,
  initialActivityWindow,
  loadNewerActivityWindow,
  loadOlderActivityWindow,
  rebaseActivityWindow,
  sortHubTasksByRecency,
  summarizeHubSubagents,
} from "../lib/activity-hub-model";
import {
  fetchMobileSchedules,
  mutateMobileSchedule,
  scheduleCadence,
  scheduleRowBadge,
  subscribeMobileScheduleUpdates,
  type MobileSchedule,
  type MobileScheduleAction,
} from "../lib/desktop-schedules";
import { tapLight } from "../lib/haptics";
import { useT, useTPlural } from "../i18n";
import type { StoredPhoneAccess } from "../lib/phone-access";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import type { ChatArtifact, MobileTask } from "../types";

const SHIMMER_MS = 1900;

type HubTab = "activity" | "schedule" | "search" | "files";

const TAB_ORDER: HubTab[] = ["activity", "schedule", "search", "files"];

const TAB_META: Record<HubTab, { labelKey: string; icon: IconName }> = {
  activity: { labelKey: "mobile.activityHub.tabs.activity", icon: "waveform" },
  schedule: { labelKey: "mobile.activityHub.tabs.schedule", icon: "clock" },
  search: { labelKey: "mobile.activityHub.tabs.search", icon: "search" },
  files: { labelKey: "mobile.activityHub.tabs.files", icon: "file-text" },
};

const TERMINAL_SUBTITLE_KEY: Record<
  Exclude<MobileTask["status"], "running">,
  string
> = {
  completed: "mobile.activityHub.task.finished",
  error: "mobile.activityHub.task.failed",
  canceled: "mobile.activityHub.task.stopped",
};

function TaskRow({
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
  styles: ReturnType<typeof makeStyles>;
}) {
  const t = useT();
  const running = task.status === "running";
  const isError = task.status === "error";
  const subtitle =
    task.status === "running"
      ? task.statusText?.trim() || t("mobile.activityHub.task.working")
      : t(TERMINAL_SUBTITLE_KEY[task.status]);

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
              size={15}
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

type GroupSubagent = { task: MobileTask; artifacts: ChatArtifact[] };

function TaskGroupRow({
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
  styles: ReturnType<typeof makeStyles>;
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
              size={14}
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

function ConversationFilesRow({
  artifacts,
  colors,
  styles,
  onOpenArtifact,
}: {
  artifacts: readonly ChatArtifact[];
  colors: Colors;
  styles: ReturnType<typeof makeStyles>;
  onOpenArtifact: (artifact: ChatArtifact) => void;
}) {
  const t = useT();
  if (artifacts.length === 0) return null;
  return (
    <View style={styles.taskGroup}>
      <View style={styles.taskRow}>
        <View style={styles.taskGlyph}>
          <Icon name="message-square" size={15} color={colors.text} />
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

function ScheduleRow({
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
  styles: ReturnType<typeof makeStyles>;
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
            size={15}
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
                size={14}
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
              <Icon name="x" size={14} color={colors.danger} />
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

type ActivityHubSheetProps = {
  visible: boolean;
  onClose: () => void;

  tasks: MobileTask[];

  artifacts: ChatArtifact[];

  artifactsByTaskId: ReadonlyMap<string, ChatArtifact[]>;

  conversationArtifacts: ChatArtifact[];

  access: StoredPhoneAccess | null;
};

type ActivityHubListRow =
  | {
      kind: "group";
      owner: MobileTask;
      ownerArtifacts: ChatArtifact[];
      subagents: GroupSubagent[];
    }
  | { kind: "task"; task: MobileTask; artifacts: ChatArtifact[] }
  | { kind: "conversation"; artifacts: ChatArtifact[] };

type FileRow = { kind: "file"; artifact: ChatArtifact };

const activityHubListRowKey = (row: ActivityHubListRow): string => {
  if (row.kind === "group") return activityHubGroupRowKey(row);
  if (row.kind === "task") return activityHubTaskRowKey(row.task);
  return "conversation";
};

export function ActivityHubSheet({
  visible,
  onClose,
  tasks,
  artifacts,
  artifactsByTaskId,
  conversationArtifacts,
  access,
}: ActivityHubSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => makeStyles(colors, insets.top),
    [colors, insets.top],
  );
  const t = useT();

  const [tab, setTab] = useState<HubTab>("activity");
  const [query, setQuery] = useState("");

  const [searchFocusedMode, setSearchFocusedMode] = useState(false);
  const [openArtifact, setOpenArtifact] = useState<ChatArtifact | null>(null);

  const [schedules, setSchedules] = useState<MobileSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [schedulesError, setSchedulesError] = useState<string | null>(null);
  const [busyScheduleKey, setBusyScheduleKey] = useState<string | null>(null);

  const hubTasks = useMemo(() => sortHubTasksByRecency(tasks), [tasks]);

  const hubGroups = useMemo(() => groupActivityHubTasks(hubTasks), [hubTasks]);
  const groupCount = hubGroups.length;

  const [activityWindow, setActivityWindow] = useState(() =>
    initialActivityWindow(groupCount),
  );
  const pagingLockedRef = useRef(false);
  const latestGroupCountRef = useRef(groupCount);
  latestGroupCountRef.current = groupCount;

  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleGroup = useCallback((ownerId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(ownerId)) next.delete(ownerId);
      else next.add(ownerId);
      return next;
    });
  }, []);

  const searchInputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!visible) return;
    setTab("activity");
    setSearchFocusedMode(false);
    setQuery("");
    setOpenArtifact(null);
    setExpandedGroups(new Set());
    setActivityWindow(initialActivityWindow(latestGroupCountRef.current));
  }, [visible]);

  useEffect(() => {
    if (searchFocusedMode) {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
    searchInputRef.current?.blur();
  }, [searchFocusedMode]);

  useEffect(() => {
    setActivityWindow((current) =>
      current.end === 0
        ? initialActivityWindow(groupCount)
        : rebaseActivityWindow(current, groupCount),
    );
  }, [groupCount]);

  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  const scheduleLoadEpochRef = useRef(0);

  const loadSchedules = useCallback(async () => {
    const epoch = ++scheduleLoadEpochRef.current;
    const isCurrent = () =>
      aliveRef.current && scheduleLoadEpochRef.current === epoch;
    setSchedulesLoading(true);
    setSchedulesError(null);
    try {
      const rows = await fetchMobileSchedules();
      if (isCurrent()) setSchedules(rows);
    } catch (error) {
      if (isCurrent()) {
        setSchedulesError(
          error instanceof Error
            ? error.message
            : t("mobile.activityHub.schedule.loadFailed"),
        );
      }
    } finally {
      if (isCurrent()) setSchedulesLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!visible || tab !== "schedule") return;
    void loadSchedules();
  }, [visible, tab, loadSchedules]);

  useEffect(() => {
    if (!visible || tab !== "schedule") return;
    const subscription = subscribeMobileScheduleUpdates(() => {
      void loadSchedules();
    });
    return () => subscription.close();
  }, [visible, tab, loadSchedules]);

  const applyScheduleAction = useCallback(
    async (schedule: MobileSchedule, action: MobileScheduleAction) => {
      const key = `${schedule.kind}:${schedule.id}`;
      setBusyScheduleKey(key);
      try {
        await mutateMobileSchedule(action, schedule);

        await loadSchedules();
      } catch (error) {
        if (aliveRef.current) {
          Alert.alert(
            t("mobile.activityHub.schedule.alertTitle"),
            error instanceof Error
              ? error.message
              : t("mobile.activityHub.schedule.actionFailed"),
          );
        }
      } finally {
        if (aliveRef.current) setBusyScheduleKey(null);
      }
    },
    [loadSchedules, t],
  );

  const onScheduleAction = useCallback(
    (schedule: MobileSchedule, action: MobileScheduleAction) => {
      if (busyScheduleKey) return;
      if (action === "remove") {

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
                void applyScheduleAction(schedule, action);
              },
            },
          ],
        );
        return;
      }
      void applyScheduleAction(schedule, action);
    },
    [busyScheduleKey, applyScheduleAction, t],
  );

  const searching =
    (tab === "search" || searchFocusedMode) && query.trim().length > 0;

  const matchingTasks = useMemo(
    () => filterHubTasks(hubTasks, query),
    [hubTasks, query],
  );
  const matchingArtifacts = useMemo(
    () => filterHubArtifacts(artifacts, query),
    [artifacts, query],
  );

  const viewerOpen = openArtifact !== null;
  const matchingTaskIds = useMemo(
    () => new Set(matchingTasks.map((task) => task.id)),
    [matchingTasks],
  );
  const matchingArtifactIds = useMemo(
    () => new Set(matchingArtifacts.map((artifact) => artifact.id)),
    [matchingArtifacts],
  );

  const shownGroups = useMemo(
    () =>
      searching
        ? []
        : hubGroups.slice(activityWindow.start, activityWindow.end),
    [searching, hubGroups, activityWindow.start, activityWindow.end],
  );

  const shownTasks = useMemo(() => {
    if (!searching) return [];
    return hubTasks.filter(
      (task) =>
        matchingTaskIds.has(task.id) ||
        (artifactsByTaskId.get(task.id) ?? []).some((artifact) =>
          matchingArtifactIds.has(artifact.id),
        ),
    );
  }, [
    searching,
    hubTasks,
    matchingTaskIds,
    matchingArtifactIds,
    artifactsByTaskId,
  ]);
  const shownConversationArtifacts = useMemo(
    () =>
      searching
        ? conversationArtifacts.filter((artifact) =>
            matchingArtifactIds.has(artifact.id),
          )
        : conversationArtifacts,
    [conversationArtifacts, matchingArtifactIds, searching],
  );
  const listRows = useMemo<ActivityHubListRow[]>(() => {
    const rows: ActivityHubListRow[] = [];
    if (searching) {
      for (const task of shownTasks) {
        rows.push({
          kind: "task",
          task,
          artifacts: (artifactsByTaskId.get(task.id) ?? []).filter((artifact) =>
            matchingArtifactIds.has(artifact.id),
          ),
        });
      }
    } else {
      for (const group of shownGroups) {
        rows.push({
          kind: "group",
          owner: group.owner,
          ownerArtifacts: artifactsByTaskId.get(group.owner.id) ?? [],
          subagents: group.subagents.map((task) => ({
            task,
            artifacts: artifactsByTaskId.get(task.id) ?? [],
          })),
        });
      }
    }
    if (shownConversationArtifacts.length > 0) {
      rows.push({
        kind: "conversation",
        artifacts: shownConversationArtifacts,
      });
    }
    return rows;
  }, [
    searching,
    shownTasks,
    shownGroups,
    artifactsByTaskId,
    matchingArtifactIds,
    shownConversationArtifacts,
  ]);

  const fileRows = useMemo<FileRow[]>(() => {
    const source = searching ? matchingArtifacts : artifacts;
    return source.map((artifact) => ({ kind: "file" as const, artifact }));
  }, [artifacts, matchingArtifacts, searching]);

  const releasePagingLock = () => {
    setTimeout(() => {
      pagingLockedRef.current = false;
    }, 180);
  };
  const loadNewer = () => {
    if (searching || pagingLockedRef.current) return;
    if (activityWindow.start <= 0) return;
    pagingLockedRef.current = true;
    setActivityWindow((current) => loadNewerActivityWindow(current));
    releasePagingLock();
  };
  const loadOlder = () => {
    if (searching || pagingLockedRef.current) return;
    if (activityWindow.end >= hubGroups.length) return;
    pagingLockedRef.current = true;
    setActivityWindow((current) =>
      loadOlderActivityWindow(current, hubGroups.length),
    );
    releasePagingLock();
  };

  const selectTab = (next: HubTab) => {
    tapLight();
    if (next === "search") {

      setSearchFocusedMode(true);
      setTab("search");
    } else {
      if (searchFocusedMode) searchInputRef.current?.blur();
      setSearchFocusedMode(false);
      setQuery("");
      setTab(next);
    }
  };

  const renderSearchField = () => (
    <View style={styles.searchWrap}>
      <Icon name="search" size={15} color={colors.textMuted} />
      <TextInput
        ref={searchInputRef}
        value={query}
        onChangeText={setQuery}
        placeholder={t("mobile.activityHub.search.placeholder")}
        placeholderTextColor={colors.textMuted}
        style={styles.searchInput}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
      />
      {query.length > 0 ? (
        <Pressable
          accessibilityLabel={t("mobile.activityHub.search.clear")}
          hitSlop={8}
          onPress={() => setQuery("")}
        >
          <Icon name="x" size={14} color={colors.textMuted} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityLabel={t("mobile.activityHub.search.close")}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => selectTab("activity")}
      >
        <Icon name="x" size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  );

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [schedules]);

  return (
    <TopSheet visible={visible} onClose={onClose}>
      {viewerOpen ? (

        <View style={styles.sheetFill}>
          <ArtifactViewerContent
            artifact={openArtifact}
            access={access}
            onBack={() => setOpenArtifact(null)}
          />
        </View>
      ) : (
        <View style={styles.sheetFill}>
          {searchFocusedMode ? renderSearchField() : null}

          {tab === "schedule" ? (
            schedulesLoading && schedules.length === 0 ? (
              <View style={styles.centeredState}>
                <ActivityIndicator color={colors.textMuted} />
              </View>
            ) : schedulesError && schedules.length === 0 ? (
              <Text style={styles.empty}>{schedulesError}</Text>
            ) : schedules.length === 0 ? (
              <Text style={styles.empty}>
                {t("mobile.activityHub.schedule.empty")}
              </Text>
            ) : (
              <LegendList<MobileSchedule>
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                data={schedules}
                keyExtractor={(row) => `${row.kind}:${row.id}`}
                renderItem={({
                  item,
                }: LegendListRenderItemProps<MobileSchedule>) => (
                  <ScheduleRow
                    schedule={item}
                    nowMs={nowMs}
                    busy={busyScheduleKey === `${item.kind}:${item.id}`}
                    styles={styles}
                    colors={colors}
                    onAction={(action) => onScheduleAction(item, action)}
                  />
                )}
                ItemSeparatorComponent={() => (
                  <View style={styles.rowSeparator} />
                )}
                showsVerticalScrollIndicator={false}
                estimatedItemSize={64}
                recycleItems
              />
            )
          ) : tab === "files" ? (
            fileRows.length === 0 ? (
              <Text style={styles.empty}>
                {searching
                  ? t("mobile.activityHub.files.emptyFiltered")
                  : t("mobile.activityHub.files.empty")}
              </Text>
            ) : (
              <LegendList<FileRow>
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                data={fileRows}
                keyExtractor={(row) => row.artifact.id}
                renderItem={({ item }: LegendListRenderItemProps<FileRow>) => (
                  <ArtifactCard
                    artifact={item.artifact}
                    colors={colors}
                    onPress={setOpenArtifact}
                  />
                )}
                ItemSeparatorComponent={() => (
                  <View style={styles.rowSeparator} />
                )}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}
                estimatedItemSize={62}
                recycleItems
              />
            )
          ) : (
            <LegendList<ActivityHubListRow>
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              data={listRows}
              keyExtractor={activityHubListRowKey}
              renderItem={({
                item,
              }: LegendListRenderItemProps<ActivityHubListRow>) =>
                item.kind === "group" ? (
                  <TaskGroupRow
                    owner={item.owner}
                    ownerArtifacts={item.ownerArtifacts}
                    subagents={item.subagents}
                    expanded={expandedGroups.has(item.owner.id)}
                    onToggle={toggleGroup}
                    onOpenArtifact={setOpenArtifact}
                    colors={colors}
                    styles={styles}
                  />
                ) : item.kind === "task" ? (
                  <TaskRow
                    task={item.task}
                    artifacts={item.artifacts}
                    onOpenArtifact={setOpenArtifact}
                    colors={colors}
                    styles={styles}
                  />
                ) : (
                  <ConversationFilesRow
                    artifacts={item.artifacts}
                    colors={colors}
                    styles={styles}
                    onOpenArtifact={setOpenArtifact}
                  />
                )
              }
              ListHeaderComponent={
                !searching ? (
                  <Text
                    style={styles.sectionLabel}
                    maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                  >
                    {t("mobile.activityHub.tabs.activity")}
                  </Text>
                ) : null
              }
              ListEmptyComponent={
                <Text
                  style={styles.empty}
                  maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                >
                  {searching
                    ? t("mobile.activityHub.activity.emptyFiltered")
                    : t("mobile.activityHub.activity.empty")}
                </Text>
              }
              ItemSeparatorComponent={() => <View style={styles.rowSeparator} />}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
              maintainVisibleContentPosition={{ data: true, size: true }}
              onStartReached={loadNewer}
              onStartReachedThreshold={0.15}
              onEndReached={loadOlder}
              onEndReachedThreshold={0.15}
              estimatedItemSize={76}
              recycleItems
            />
          )}

          {

}
          <View style={styles.tabBar}>
            <View style={styles.tabBarHairline} pointerEvents="none" />
            {TAB_ORDER.map((entry) => {
              const meta = TAB_META[entry];
              const label = t(meta.labelKey);
              const active = tab === entry;
              return (
                <Pressable
                  key={entry}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={label}
                  onPress={() => selectTab(entry)}
                  style={({ pressed }) => [
                    styles.tabButton,
                    pressed && styles.tabButtonPressed,
                  ]}
                >
                  <Icon
                    name={meta.icon}
                    size={19}
                    color={active ? colors.accent : colors.textMuted}
                  />
                  <Text
                    style={[
                      styles.tabLabel,
                      active ? styles.tabLabelActive : null,
                    ]}
                    maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
    </TopSheet>
  );
}

const makeStyles = (colors: Colors, topInset: number) =>
  StyleSheet.create({
    sheetFill: {
      flex: 1,

      paddingTop: topInset + 10,
    },

    searchWrap: {
      alignItems: "center",
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 8,
      marginBottom: 10,
      marginHorizontal: 16,
      marginTop: 12,
      paddingHorizontal: 11,
    },
    searchInput: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      paddingVertical: 10,
    },

    scroll: {
      flexGrow: 1,
      flexShrink: 1,
    },
    scrollContent: {
      paddingBottom: 24,
      paddingHorizontal: 16,
      paddingTop: 14,
    },
    centeredState: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },
    sectionLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.semiBold,
      fontSize: 12,
      letterSpacing: 0.2,
      marginBottom: 6,
      paddingHorizontal: 2,
      textTransform: "uppercase",
    },
    empty: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      padding: 24,
      textAlign: "center",
      textAlignVertical: "center",
    },
    rowSeparator: {
      height: 4,
    },
    taskGroup: {
      gap: 2,
    },

    groupToggle: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      marginLeft: 33,
      paddingVertical: 6,
    },
    groupToggleText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
    },
    groupToggleMeta: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      letterSpacing: -0.1,
      marginLeft: "auto",
    },

    groupChildren: {
      borderLeftColor: colors.border,
      borderLeftWidth: StyleSheet.hairlineWidth,
      gap: 2,
      marginLeft: 9,
      marginTop: 2,
      paddingLeft: 12,
    },
    taskRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 11,
      paddingHorizontal: 2,
      paddingVertical: 8,
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
      height: 8,
      width: 8,
    },
    canceledDot: {
      backgroundColor: colors.textMuted,
      borderRadius: 999,
      height: 8,
      width: 8,
    },
    taskText: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
    },
    nestedFiles: {
      gap: 8,
      marginBottom: 8,
      marginLeft: 33,
    },
    taskTitle: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    taskSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      letterSpacing: -0.1,
      marginTop: 1,
    },
    taskReasoning: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
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
      borderRadius: 13,
      borderWidth: StyleSheet.hairlineWidth,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
    scheduleActionButtonPressed: {
      backgroundColor: fadeHex(colors.text, 0.08),
    },

    tabBar: {
      flexDirection: "row",
      paddingBottom: 10,
      paddingHorizontal: 8,
      paddingTop: 8,
    },
    tabBarHairline: {
      backgroundColor: fadeHex(colors.border, 0.7),
      height: StyleSheet.hairlineWidth,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    tabButton: {
      alignItems: "center",
      borderRadius: 10,
      flex: 1,
      gap: 3,
      paddingVertical: 4,
    },
    tabButtonPressed: {
      opacity: 0.7,
    },
    tabLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 11,
      letterSpacing: -0.1,
    },
    tabLabelActive: {
      color: colors.accent,
    },
  });
