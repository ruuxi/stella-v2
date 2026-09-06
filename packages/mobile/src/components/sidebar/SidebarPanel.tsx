import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
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
import Animated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
} from "react-native-reanimated";
import { GlassSurface } from "../glass";
import { Icon, type IconName } from "../Icon";
import {
  ConversationFilesRow,
  ScheduleRow,
  TaskGroupRow,
  TaskRow,
  makeActivityRowStyles,
  type GroupSubagent,
} from "./activity-rows";
import { SidebarTabBar } from "./SidebarTabBar";
import {
  SIDEBAR_TAB_BAR_HEIGHT,
  type SidebarTabItem,
} from "./sidebar-tab-bar-types";
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

/**
 * Bottom tab bar entries. Activity carries the conversation's files too (they
 * nest under the agent that produced them, with a "This conversation" row for
 * the main thread's own), so there is no separate Files tab. Search is a mode
 * rather than a list of its own: selecting it reveals the search field and
 * narrows the activity + files list to matches.
 */
type SidebarTab = "activity" | "schedule" | "search";

const TAB_ORDER: SidebarTab[] = ["activity", "schedule", "search"];

const TAB_META: Record<SidebarTab, { labelKey: string; icon: IconName }> = {
  activity: { labelKey: "mobile.activityHub.tabs.activity", icon: "waveform" },
  schedule: { labelKey: "mobile.activityHub.tabs.schedule", icon: "clock" },
  search: { labelKey: "mobile.activityHub.tabs.search", icon: "search" },
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

const activityListRowKey = (row: ActivityListRow): string => {
  if (row.kind === "group") return activityHubGroupRowKey(row);
  if (row.kind === "task") return activityHubTaskRowKey(row.task);
  return "conversation";
};

const EMPTY_TASKS: MobileTask[] = [];
const EMPTY_ARTIFACTS: ChatArtifact[] = [];
const EMPTY_BY_TASK: ReadonlyMap<string, ChatArtifact[]> = new Map();

/** Height of the glass search field that rides above the tab bar. */
const SEARCH_HEIGHT = 44;
/** Gap between the search field and the tab bar. */
const DOCK_GAP = 10;
/** Height of the Settings / Account pill on the brand row. */
const HEADER_PILL_HEIGHT = 40;

/**
 * Settled keyboard height as JS state, for the list's bottom inset. The dock's
 * own motion is driven on the UI thread by `useAnimatedKeyboard`; this only
 * needs the resting value so results can scroll clear of the keyboard.
 */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(
      showEvent,
      (e: { endCoordinates: { height: number } }) => {
        setHeight(e.endCoordinates.height);
      },
    );
    const hideSub = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  return height;
}

/**
 * The left sidebar. The brand row sits at the top with Settings and Account
 * in one glass pill on its right; the conversation's activity (files nested
 * under the agents that made them) and schedules fill the middle; and a
 * floating glass tab bar (Activity · Schedule · Search) rides the bottom so
 * every control is within thumb reach. The Search tab reveals a glass search
 * field above the tab bar, which lifts with the keyboard.
 *
 * Data arrives through the shell store the chat route publishes into, so the
 * panel needs no props from the router.
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
  const searchOpen = tab === "search";

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

  // Closing the drawer leaves search mode, clears the query and drops the
  // keyboard, so the next reveal always starts from the plain overview.
  useEffect(() => {
    if (open) return;
    setQuery("");
    searchInputRef.current?.blur();
    setTab((current) => (current === "search" ? "activity" : current));
  }, [open]);

  // The search field mounts when the Search tab is chosen; focus it as soon
  // as it exists so the keyboard comes up in the same gesture.
  useEffect(() => {
    if (!searchOpen || !open) return;
    const handle = setTimeout(() => searchInputRef.current?.focus(), 40);
    return () => clearTimeout(handle);
  }, [searchOpen, open]);

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

  const searching = searchOpen && query.trim().length > 0;

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

  // Search is a toggle: tapping it again puts the search field away and
  // returns to the overview. Leaving search for another tab does the same.
  const selectTab = (next: SidebarTab) => {
    tapLight();
    if (next === "search" && tab === "search") {
      closeSearch();
      return;
    }
    if (next === tab) return;
    if (tab === "search") {
      setQuery("");
      searchInputRef.current?.blur();
    }
    setTab(next);
  };
  const closeSearch = () => {
    setQuery("");
    searchInputRef.current?.blur();
    setTab("activity");
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

  // The dock rests `insets.bottom + 14` above the screen bottom. When the
  // keyboard is up (only the search field summons it here), lift the dock by
  // the keyboard height minus that already-reserved band so the search field
  // lands a constant gap above the keyboard, tracked frame-for-frame.
  const keyboard = useAnimatedKeyboard();
  const dockKeyboardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -Math.max(0, keyboard.height.value - insets.bottom) },
    ],
  }));
  const keyboardHeight = useKeyboardHeight();
  const keyboardExtra = Math.max(0, keyboardHeight - insets.bottom);

  // The bar's height is the platform control's own; it reports it back.
  const [tabBarHeight, setTabBarHeight] = useState(SIDEBAR_TAB_BAR_HEIGHT);
  const dockHeight =
    tabBarHeight + (searchOpen ? SEARCH_HEIGHT + DOCK_GAP : 0);
  const listBottomPadding = dockHeight + insets.bottom + 28 + keyboardExtra;
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
    // Activity (and Search, which narrows the same list): agents with their
    // files nested underneath, plus the main thread's own files.
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

  const accountLabel = signedIn ? t("mobile.nav.account") : t("mobile.nav.signIn");
  const tabItems = useMemo<SidebarTabItem<SidebarTab>[]>(
    () =>
      TAB_ORDER.map((entry) => {
        const label = t(TAB_META[entry].labelKey);
        return {
          key: entry,
          label,
          accessibilityLabel:
            entry === "search" && searchOpen
              ? t("mobile.activityHub.search.close")
              : label,
          icon: TAB_META[entry].icon,
        };
      }),
    [t, searchOpen],
  );

  return (
    <View style={[styles.root, { width }]}>
      {/* The panel itself is deliberately NOT glass. Apple suppresses Liquid
          Glass layered over another glass surface (nested or merely beneath)
          and renders the upper one flat, so a glass panel would strip the
          pills below of their material. A translucent surface tint over the
          app backdrop keeps the same legible look and leaves the pills as
          the only glass here, like the top bar's buttons over the chat. */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.panelFill]}
      />
      <View
        style={[
          styles.body,
          { paddingRight: contentInsetRight, paddingTop: insets.top + 10 },
        ]}
      >
        {/* Brand row: the wordmark on the left (tap: back to the chat) and
            Settings + Account together in one glass pill on the right. Both
            are low-frequency, so they live at the top, out of thumb range. */}
        <View style={styles.header}>
          <Pressable
            onPress={() => onNavigate("/chat")}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.nav.chat")}
            hitSlop={8}
            style={({ pressed }) => [styles.brand, pressed && styles.pressed]}
          >
            <Text style={styles.wordmark}>{t("common.appName")}</Text>
          </Pressable>
          {/* One interactive glass capsule holding both buttons, the way the
              system groups bar buttons: a single shape, so there is no seam
              to blend, and a touch anywhere draws the glow inside it. */}
          <GlassSurface
            glass="regular"
            interactive
            radius={HEADER_PILL_HEIGHT / 2}
            fallbackColor={colors.surface}
            style={styles.headerPill}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("mobile.nav.settings")}
              hitSlop={4}
              onPress={() => onNavigate("/settings")}
              style={({ pressed }) => [
                styles.headerIconButton,
                pressed && styles.pressed,
              ]}
            >
              <Icon name="settings" size={18} color={colors.text} weight="semibold" />
            </Pressable>
            <View style={styles.headerDivider} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={accountLabel}
              hitSlop={4}
              onPress={() => onNavigate(signedIn ? "/account" : "/login")}
              style={({ pressed }) => [
                styles.headerAccountButton,
                pressed && styles.pressed,
              ]}
            >
              <Icon name="user" size={15} color={colors.text} weight="semibold" />
              <Text
                style={styles.headerAccountLabel}
                numberOfLines={1}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {accountLabel}
              </Text>
            </Pressable>
          </GlassSurface>
        </View>

        <View style={styles.listArea}>{renderList()}</View>
      </View>

      {/* Floating dock: the search field (Search tab only) over the tab bar,
          both glass, riding the list's bottom edge clear of the home
          indicator and lifting with the keyboard. */}
      <Animated.View
        pointerEvents="box-none"
        style={[
          styles.dock,
          {
            bottom: insets.bottom + 14,
            right: contentInsetRight + 16,
          },
          dockKeyboardStyle,
        ]}
      >
        {searchOpen ? (
          <View style={styles.searchShadow}>
            <GlassSurface
              glass="regular"
              tintColor={fadeHex(colors.surface, 0.5)}
              radius={SEARCH_HEIGHT / 2}
              fallbackColor={colors.surface}
              style={styles.searchGlass}
            >
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.searchRing]} />
              <Icon name="search" size={15} color={colors.textMuted} />
              <TextInput
                ref={searchInputRef}
                value={query}
                onChangeText={setQuery}
                placeholder={t("mobile.sidebar.searchPlaceholder")}
                placeholderTextColor={fadeHex(colors.textMuted, 0.7)}
                selectionColor={colors.accent}
                style={styles.searchInput}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              />
              {query.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile.activityHub.search.clear")}
                  hitSlop={10}
                  onPress={() => setQuery("")}
                  style={({ pressed }) => [pressed && styles.pressed]}
                >
                  <Icon name="x" size={14} color={colors.textMuted} />
                </Pressable>
              ) : null}
            </GlassSurface>
          </View>
        ) : null}

        <SidebarTabBar
          tabs={tabItems}
          value={tab}
          onSelect={selectTab}
          onHeight={setTabBarHeight}
        />
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      flex: 1,
    },
    panelFill: {
      backgroundColor: fadeHex(colors.surface, 0.78),
    },
    body: {
      flex: 1,
      minHeight: 0,
    },
    pressed: {
      opacity: 0.7,
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingBottom: 12,
      paddingHorizontal: 16,
      paddingTop: 4,
    },
    brand: {
      paddingLeft: 4,
      paddingVertical: 6,
    },
    wordmark: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 22,
      letterSpacing: -0.4,
      lineHeight: 24,
    },
    headerPill: {
      alignItems: "center",
      flexDirection: "row",
      height: HEADER_PILL_HEIGHT,
      overflow: "hidden",
    },
    headerIconButton: {
      alignItems: "center",
      height: HEADER_PILL_HEIGHT,
      justifyContent: "center",
      paddingLeft: 14,
      paddingRight: 12,
    },
    headerDivider: {
      backgroundColor: fadeHex(colors.border, 0.9),
      height: 18,
      width: StyleSheet.hairlineWidth,
    },
    headerAccountButton: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      height: HEADER_PILL_HEIGHT,
      paddingLeft: 12,
      paddingRight: 14,
    },
    headerAccountLabel: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 13,
      letterSpacing: -0.2,
    },
    listArea: {
      flex: 1,
      minHeight: 0,
    },
    list: {
      flexGrow: 1,
      flexShrink: 1,
    },
    listContent: {
      paddingHorizontal: 16,
      paddingTop: 4,
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
      gap: DOCK_GAP,
      left: 16,
      position: "absolute",
    },
    searchShadow: {
      height: SEARCH_HEIGHT,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 6,
      elevation: 3,
    },
    searchGlass: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      height: SEARCH_HEIGHT,
      overflow: "hidden",
      paddingHorizontal: 15,
    },
    searchRing: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: SEARCH_HEIGHT / 2,
      borderWidth: StyleSheet.hairlineWidth,
    },
    searchInput: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      padding: 0,
    },
  });
