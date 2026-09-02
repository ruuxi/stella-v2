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
import { ArtifactCard } from "../ArtifactCard";
import { GlassCard, GlassSurface } from "../glass";
import { GlassIconButton } from "../GlassIconButton";
import { Icon, type IconName } from "../Icon";
import { StellaBrandMark } from "../StellaBrandMark";
import {
  ConversationFilesRow,
  ScheduleRow,
  TaskGroupRow,
  TaskRow,
  makeActivityRowStyles,
  type GroupSubagent,
} from "./activity-rows";
import { filterHubArtifacts, filterHubTasks } from "../../lib/activity-hub-search";
import {
  activityHubGroupRowKey,
  activityHubTaskRowKey,
  groupActivityHubTasks,
  initialActivityWindow,
  loadNewerActivityWindow,
  loadOlderActivityWindow,
  rebaseActivityWindow,
  sortHubTasksByRecency,
} from "../../lib/activity-hub-model";
import { authClient } from "../../lib/auth-client";
import {
  fetchMobileSchedules,
  mutateMobileSchedule,
  subscribeMobileScheduleUpdates,
  type MobileSchedule,
  type MobileScheduleAction,
} from "../../lib/desktop-schedules";
import { isGuest } from "../../lib/guest-mode";
import { tapLight } from "../../lib/haptics";
import { useActivityHub } from "../../lib/main-shell-store";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import { useT } from "../../i18n";
import type { Colors } from "../../theme/colors";
import { useColors } from "../../theme/theme-context";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import type { ChatArtifact, MobileTask } from "../../types";

type SidebarTab = "activity" | "schedule" | "files";

const TAB_ORDER: SidebarTab[] = ["activity", "schedule", "files"];

const TAB_META: Record<SidebarTab, { labelKey: string; icon: IconName }> = {
  activity: { labelKey: "mobile.activityHub.tabs.activity", icon: "waveform" },
  schedule: { labelKey: "mobile.activityHub.tabs.schedule", icon: "clock" },
  files: { labelKey: "mobile.activityHub.tabs.files", icon: "file-text" },
};

export type SidebarDestination = "/chat" | "/settings" | "/account" | "/login";

type ActivityListRow =
  | {
      kind: "group";
      owner: MobileTask;
      ownerArtifacts: ChatArtifact[];
      subagents: GroupSubagent[];
    }
  | { kind: "task"; task: MobileTask; artifacts: ChatArtifact[] }
  | { kind: "conversation"; artifacts: ChatArtifact[] };

type FileRow = { kind: "file"; artifact: ChatArtifact };

const activityListRowKey = (row: ActivityListRow): string => {
  if (row.kind === "group") return activityHubGroupRowKey(row);
  if (row.kind === "task") return activityHubTaskRowKey(row.task);
  return "conversation";
};

const EMPTY_TASKS: MobileTask[] = [];
const EMPTY_ARTIFACTS: ChatArtifact[] = [];
const EMPTY_BY_TASK: ReadonlyMap<string, ChatArtifact[]> = new Map();

/** Height reserved under the lists for the floating dock. */
const DOCK_HEIGHT = 44;

/**
 * The left sidebar: the conversation's background activity, schedules and
 * files under a search field, with Settings and Account docked at the
 * bottom as floating glass controls.
 *
 * This replaces both the old two-item nav (Chat / Settings — the app has one
 * chat, so it navigated nowhere) and the activity-hub sheet, whose lists now
 * live here at sidebar scale. Data arrives through the shell store the chat
 * route publishes into, so the panel needs no props from the router.
 */
export function SidebarPanel({
  open,
  width,
  contentInsetRight = 0,
  onNavigate,
  onOpenArtifact,
}: {
  /** Whether the panel is revealed; gates schedule loading and resets. */
  open: boolean;
  width: number;
  /**
   * Portion of the panel the foreground still covers when the drawer is
   * open (the rounded content edge overlaps it). Content stays clear of it.
   */
  contentInsetRight?: number;
  onNavigate: (destination: SidebarDestination) => void;
  onOpenArtifact: (artifact: ChatArtifact) => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const rowStyles = useMemo(() => makeActivityRowStyles(colors), [colors]);

  const hub = useActivityHub();
  const tasks = hub?.tasks ?? EMPTY_TASKS;
  const artifacts = hub?.artifacts ?? EMPTY_ARTIFACTS;
  const artifactsByTaskId = hub?.artifactsByTaskId ?? EMPTY_BY_TASK;
  const conversationArtifacts = hub?.conversationArtifacts ?? EMPTY_ARTIFACTS;

  const session = authClient.useSession();
  const signedIn = Boolean(session.data?.user) && !isGuest();

  const [tab, setTab] = useState<SidebarTab>("activity");
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<TextInput>(null);

  const [schedules, setSchedules] = useState<MobileSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [schedulesError, setSchedulesError] = useState<string | null>(null);
  const [busyScheduleKey, setBusyScheduleKey] = useState<string | null>(null);

  const hubTasks = useMemo(() => sortHubTasksByRecency(tasks), [tasks]);
  // Group subagents under their parent agent (desktop-parity association):
  // each top-level group is one visual unit, so the paging window counts
  // groups, not raw tasks — a 16-child fleet collapses to a single row here.
  const hubGroups = useMemo(() => groupActivityHubTasks(hubTasks), [hubTasks]);
  const groupCount = hubGroups.length;

  const [activityWindow, setActivityWindow] = useState(() =>
    initialActivityWindow(groupCount),
  );
  const pagingLockedRef = useRef(false);
  // Collapsed by default: only groups the user taps open expand into their
  // subagent list. Keyed by owner id so LegendList recycling can't leak state.
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

  // Closing the drawer clears the search and drops the keyboard, so the next
  // reveal always starts from the plain overview.
  useEffect(() => {
    if (open) return;
    setQuery("");
    searchInputRef.current?.blur();
  }, [open]);

  useEffect(() => {
    setActivityWindow((current) =>
      current.end === 0
        ? initialActivityWindow(groupCount)
        : rebaseActivityWindow(current, groupCount),
    );
  }, [groupCount]);

  // True until unmount; loads and mutations check it before touching state
  // so a slow bridge round-trip can't set state on a torn-down panel.
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );
  // Monotonic load epoch: a response only lands if it is still the newest
  // request, so overlapping loads can't interleave into last-write-wins.
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

  // Schedules load whenever the Schedule tab is on screen in an open drawer —
  // a cheap authenticated read through the desktop bridge — and stay live via
  // the desktop's `schedule:updated` broadcast for as long as that holds.
  const scheduleTabLive = open && tab === "schedule" && hub !== null;
  useEffect(() => {
    if (!scheduleTabLive) return;
    void loadSchedules();
    const subscription = subscribeMobileScheduleUpdates(() => {
      void loadSchedules();
    });
    return () => subscription.close();
  }, [scheduleTabLive, loadSchedules]);

  const applyScheduleAction = useCallback(
    async (schedule: MobileSchedule, action: MobileScheduleAction) => {
      const key = `${schedule.kind}:${schedule.id}`;
      setBusyScheduleKey(key);
      try {
        await mutateMobileSchedule(action, schedule);
        // Re-read so enabled/nextRunAtMs come back authoritative.
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

  const searching = query.trim().length > 0;

  const matchingTasks = useMemo(
    () => filterHubTasks(hubTasks, query),
    [hubTasks, query],
  );
  const matchingArtifacts = useMemo(
    () => filterHubArtifacts(artifacts, query),
    [artifacts, query],
  );
  const matchingTaskIds = useMemo(
    () => new Set(matchingTasks.map((task) => task.id)),
    [matchingTasks],
  );
  const matchingArtifactIds = useMemo(
    () => new Set(matchingArtifacts.map((artifact) => artifact.id)),
    [matchingArtifacts],
  );
  // Non-search: one windowed page of grouped top-level rows.
  const shownGroups = useMemo(
    () =>
      searching
        ? []
        : hubGroups.slice(activityWindow.start, activityWindow.end),
    [searching, hubGroups, activityWindow.start, activityWindow.end],
  );
  // Search flattens grouping back to individual matching rows (parents and
  // subagents alike).
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
  const listRows = useMemo<ActivityListRow[]>(() => {
    const rows: ActivityListRow[] = [];
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

  // Files tab: everything the conversation produced, newest first, noise
  // already filtered by the collector. Search narrows it; otherwise show all.
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

  const selectTab = (next: SidebarTab) => {
    if (next === tab) return;
    tapLight();
    setTab(next);
  };

  const openArtifact = useCallback(
    (artifact: ChatArtifact) => {
      tapLight();
      onOpenArtifact(artifact);
    },
    [onOpenArtifact],
  );

  // Frozen per render pass so relative badges ("in 5m") don't flicker as the
  // list re-renders; refreshed each time the schedule list reloads.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [schedules]);

  const listBottomPadding = DOCK_HEIGHT + insets.bottom + 28;
  const listContentStyle = useMemo(
    () => [styles.listContent, { paddingBottom: listBottomPadding }],
    [styles.listContent, listBottomPadding],
  );
  const emptyActivityText = hub
    ? searching
      ? t("mobile.activityHub.activity.emptyFiltered")
      : t("mobile.activityHub.activity.empty")
    : signedIn
      ? t("mobile.activityHub.activity.empty")
      : t("mobile.sidebar.signedOutHint");

  const renderList = () => {
    if (tab === "schedule") {
      if (schedulesLoading && schedules.length === 0) {
        return (
          <View style={styles.centeredState}>
            <ActivityIndicator color={colors.textMuted} />
          </View>
        );
      }
      if (schedulesError && schedules.length === 0) {
        return <Text style={styles.empty}>{schedulesError}</Text>;
      }
      if (schedules.length === 0) {
        return (
          <Text style={styles.empty}>
            {t("mobile.activityHub.schedule.empty")}
          </Text>
        );
      }
      return (
        <LegendList<MobileSchedule>
          style={styles.list}
          contentContainerStyle={listContentStyle}
          data={schedules}
          keyExtractor={(row) => `${row.kind}:${row.id}`}
          renderItem={({ item }: LegendListRenderItemProps<MobileSchedule>) => (
            <ScheduleRow
              schedule={item}
              nowMs={nowMs}
              busy={busyScheduleKey === `${item.kind}:${item.id}`}
              styles={rowStyles}
              colors={colors}
              onAction={(action) => onScheduleAction(item, action)}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.rowSeparator} />}
          showsVerticalScrollIndicator={false}
          estimatedItemSize={60}
          recycleItems
        />
      );
    }
    if (tab === "files") {
      if (fileRows.length === 0) {
        return (
          <Text style={styles.empty}>
            {searching
              ? t("mobile.activityHub.files.emptyFiltered")
              : t("mobile.activityHub.files.empty")}
          </Text>
        );
      }
      return (
        <LegendList<FileRow>
          style={styles.list}
          contentContainerStyle={listContentStyle}
          data={fileRows}
          keyExtractor={(row) => row.artifact.id}
          renderItem={({ item }: LegendListRenderItemProps<FileRow>) => (
            <ArtifactCard
              artifact={item.artifact}
              colors={colors}
              onPress={openArtifact}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.rowSeparator} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          estimatedItemSize={62}
          recycleItems
        />
      );
    }
    return (
      <LegendList<ActivityListRow>
        style={styles.list}
        contentContainerStyle={listContentStyle}
        data={listRows}
        keyExtractor={activityListRowKey}
        renderItem={({ item }: LegendListRenderItemProps<ActivityListRow>) =>
          item.kind === "group" ? (
            <TaskGroupRow
              owner={item.owner}
              ownerArtifacts={item.ownerArtifacts}
              subagents={item.subagents}
              expanded={expandedGroups.has(item.owner.id)}
              onToggle={toggleGroup}
              onOpenArtifact={openArtifact}
              colors={colors}
              styles={rowStyles}
            />
          ) : item.kind === "task" ? (
            <TaskRow
              task={item.task}
              artifacts={item.artifacts}
              onOpenArtifact={openArtifact}
              colors={colors}
              styles={rowStyles}
            />
          ) : (
            <ConversationFilesRow
              artifacts={item.artifacts}
              colors={colors}
              styles={rowStyles}
              onOpenArtifact={openArtifact}
            />
          )
        }
        ListEmptyComponent={
          <Text style={styles.empty} maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}>
            {emptyActivityText}
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
        estimatedItemSize={64}
        recycleItems
      />
    );
  };

  return (
    <GlassCard
      radius={0}
      legible
      style={[styles.root, { width, paddingTop: insets.top + 10 }]}
    >
      <View style={[styles.body, { paddingRight: contentInsetRight }]}>
        <Pressable
          onPress={() => onNavigate("/chat")}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.nav.chat")}
          hitSlop={8}
          style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        >
          <StellaBrandMark compact />
        </Pressable>

        <View style={styles.searchWrap}>
          <Icon name="search" size={14} color={colors.textMuted} />
          <TextInput
            ref={searchInputRef}
            value={query}
            onChangeText={setQuery}
            placeholder={t("mobile.sidebar.searchPlaceholder")}
            placeholderTextColor={fadeHex(colors.textMuted, 0.7)}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          />
          {query.length > 0 ? (
            <Pressable
              accessibilityLabel={t("mobile.activityHub.search.clear")}
              hitSlop={8}
              onPress={() => setQuery("")}
            >
              <Icon name="x" size={13} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>

        <View style={styles.segments}>
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
                  styles.segment,
                  active && styles.segmentActive,
                  pressed && !active && styles.pressed,
                ]}
              >
                <Icon
                  name={meta.icon}
                  size={13}
                  color={active ? colors.text : colors.textMuted}
                  weight={active ? "semibold" : "medium"}
                />
                <Text
                  style={[styles.segmentLabel, active && styles.segmentLabelActive]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.listArea}>{renderList()}</View>
      </View>

      {/* Floating dock: Settings and Account ride over the list's bottom
          edge as glass, clear of the home indicator. */}
      <View
        pointerEvents="box-none"
        style={[
          styles.dock,
          {
            bottom: insets.bottom + 14,
            right: contentInsetRight + 16,
          },
        ]}
      >
        <GlassIconButton
          icon="settings"
          size={DOCK_HEIGHT}
          iconSize={20}
          accessibilityLabel={t("mobile.nav.settings")}
          onPress={() => onNavigate("/settings")}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={signedIn ? t("mobile.nav.account") : t("mobile.nav.signIn")}
          onPress={() => onNavigate(signedIn ? "/account" : "/login")}
          style={({ pressed }) => [styles.accountPressable, pressed && styles.pressed]}
        >
          <GlassSurface
            glass="clear"
            interactive
            radius={DOCK_HEIGHT / 2}
            fallbackColor={colors.surface}
            style={styles.accountGlass}
          >
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.accountRing]} />
            <Icon
              name="user"
              size={17}
              color={colors.text}
              weight="semibold"
            />
            <Text
              style={styles.accountLabel}
              numberOfLines={1}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {signedIn ? t("mobile.nav.account") : t("mobile.nav.signIn")}
            </Text>
          </GlassSurface>
        </Pressable>
      </View>
    </GlassCard>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      flex: 1,
    },
    body: {
      flex: 1,
      minHeight: 0,
    },
    pressed: {
      opacity: 0.7,
    },
    header: {
      alignSelf: "flex-start",
      paddingBottom: 14,
      paddingHorizontal: 20,
      paddingTop: 6,
    },
    searchWrap: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.text, 0.06),
      borderRadius: 10,
      flexDirection: "row",
      gap: 7,
      height: 34,
      marginHorizontal: 16,
      paddingHorizontal: 10,
    },
    searchInput: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      letterSpacing: -0.2,
      padding: 0,
    },
    // iOS-style segmented control: a soft track with the active segment lifted
    // onto a surface tile.
    segments: {
      backgroundColor: fadeHex(colors.text, 0.06),
      borderRadius: 10,
      flexDirection: "row",
      marginHorizontal: 16,
      marginTop: 10,
      padding: 2,
    },
    segment: {
      alignItems: "center",
      borderRadius: 8,
      flex: 1,
      flexDirection: "row",
      gap: 5,
      height: 28,
      justifyContent: "center",
      paddingHorizontal: 6,
    },
    segmentActive: {
      backgroundColor: colors.surface,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 2,
      elevation: 1,
    },
    segmentLabel: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
    },
    segmentLabelActive: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
    },
    listArea: {
      flex: 1,
      minHeight: 0,
      marginTop: 6,
    },
    list: {
      flexGrow: 1,
      flexShrink: 1,
    },
    listContent: {
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    centeredState: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 19,
      paddingHorizontal: 20,
      paddingVertical: 28,
      textAlign: "center",
    },
    rowSeparator: {
      height: 2,
    },
    dock: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      left: 16,
      position: "absolute",
    },
    accountPressable: {
      flex: 1,
      height: DOCK_HEIGHT,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 5,
      elevation: 2,
    },
    accountGlass: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: 8,
      justifyContent: "center",
      overflow: "hidden",
      paddingHorizontal: 16,
    },
    accountRing: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: DOCK_HEIGHT / 2,
      borderWidth: StyleSheet.hairlineWidth,
    },
    accountLabel: {
      color: colors.text,
      flexShrink: 1,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14,
      letterSpacing: -0.2,
    },
  });
