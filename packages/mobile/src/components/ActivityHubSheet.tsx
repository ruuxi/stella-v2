import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactViewerContent } from "./ArtifactViewer";
import { Icon } from "./Icon";
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
import type { StoredPhoneAccess } from "../lib/phone-access";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import type { ChatArtifact, MobileTask } from "../types";

const SHIMMER_MS = 1900;

const TERMINAL_SUBTITLE: Record<
  Exclude<MobileTask["status"], "running">,
  string
> = {
  completed: "Finished",
  error: "Couldn’t finish",
  canceled: "Stopped",
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
  const running = task.status === "running";
  const isError = task.status === "error";
  const subtitle =
    task.status === "running"
      ? task.statusText?.trim() || "Working in background"
      : TERMINAL_SUBTITLE[task.status];
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

/**
 * A top-level agent row plus the subagents it spawned, grouped the way the
 * desktop activity workspace does: the parent is always visible, its owned
 * subagents collapse into a single "N subagents · M done" summary, and a tap
 * expands them into the normal subagent list. Collapsed by default so a
 * subagent-heavy run (e.g. a 16-child research fleet) stays quiet.
 */
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
  const summary = useMemo(
    () => summarizeHubSubagents(subagents.map((entry) => entry.task)),
    [subagents],
  );
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
            accessibilityLabel={`${summary.total} ${
              summary.total === 1 ? "subagent" : "subagents"
            }, ${summary.done} done`}
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
              {summary.total} {summary.total === 1 ? "subagent" : "subagents"}
            </Text>
            {summary.running > 0 ? <View style={styles.runningDot} /> : null}
            <Text
              style={styles.groupToggleMeta}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {summary.done} done
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
            This conversation
          </Text>
          <Text
            style={styles.taskSub}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            Files created by the main thread
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

type ActivityHubSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Background tasks in the conversation (running + settled). */
  tasks: MobileTask[];
  /** Artifacts in the conversation, newest first. */
  artifacts: ChatArtifact[];
  /** Exact desktop-style agent/thread ownership for nested files. */
  artifactsByTaskId: ReadonlyMap<string, ChatArtifact[]>;
  /** Direct orchestrator artifacts owned by the main conversation thread. */
  conversationArtifacts: ChatArtifact[];
  /** Desktop pairing used to load artifact contents for the inline viewer. */
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

const activityHubListRowKey = (row: ActivityHubListRow): string => {
  if (row.kind === "group") return activityHubGroupRowKey(row);
  if (row.kind === "task") return activityHubTaskRowKey(row.task);
  return "conversation";
};

/**
 * The activity hub — the unified top sheet the floating activity pill opens.
 * One searchable overview of the conversation's background work (running /
 * recent tasks with reasoning summaries) and its files (the artifacts list
 * that used to hide behind the settings menu). Tapping a file opens the
 * artifact viewer within the sheet. Content-sized: hugs sparse content, caps
 * at the same max height as the other top sheets.
 *
 * No schedule section: desktop schedules aren't synced into mobile (the only
 * schedule surface is the WebView shim's IPC passthrough for the desktop
 * frontend), so there's nothing native to list yet.
 */
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

  const [query, setQuery] = useState("");
  const [openArtifact, setOpenArtifact] = useState<ChatArtifact | null>(null);

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
  const latestGroupCountRef = useRef(groupCount);
  latestGroupCountRef.current = groupCount;
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

  // Fresh overview each open: clear search, any in-sheet artifact, the paging
  // window, and every expanded subagent group.
  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setOpenArtifact(null);
    setActivityWindow(initialActivityWindow(latestGroupCountRef.current));
    setExpandedGroups(new Set());
  }, [visible]);

  useEffect(() => {
    setActivityWindow((current) =>
      current.end === 0
        ? initialActivityWindow(groupCount)
        : rebaseActivityWindow(current, groupCount),
    );
  }, [groupCount]);

  const matchingTasks = useMemo(
    () => filterHubTasks(hubTasks, query),
    [hubTasks, query],
  );
  const matchingArtifacts = useMemo(
    () => filterHubArtifacts(artifacts, query),
    [artifacts, query],
  );

  const searching = query.trim().length > 0;
  const viewerOpen = openArtifact !== null;
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
  // subagents alike), preserving the pre-existing flat search behavior.
  const searchTaskRows = useMemo(() => {
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
      for (const task of searchTaskRows) {
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
    searchTaskRows,
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

  return (
    <TopSheet visible={visible} onClose={onClose} contentSized={!viewerOpen}>
      {viewerOpen ? (
        // Artifact open in-sheet: full-height viewer (WebViews and media need
        // real space), with a back chevron returning to the overview.
        <ArtifactViewerContent
          artifact={openArtifact}
          access={access}
          onBack={() => setOpenArtifact(null)}
        />
      ) : (
        <View style={styles.root}>
          <View style={styles.searchWrap}>
            <Icon name="search" size={15} color={colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search activity and files"
              placeholderTextColor={colors.textMuted}
              style={styles.searchInput}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            />
          </View>
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
              <Text
                style={styles.sectionLabel}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                Activity
              </Text>
            }
            ListEmptyComponent={
              <Text
                style={styles.empty}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {searching
                  ? "No matching activity or files."
                  : "No background work yet."}
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
        </View>
      )}
    </TopSheet>
  );
}

const makeStyles = (colors: Colors, topInset: number) =>
  StyleSheet.create({
    root: {
      flexShrink: 1,
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
      marginHorizontal: 16,
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
    // Hug content when sparse; shrink (and scroll) once the sheet hits its
    // max-height cap.
    scroll: {
      flexGrow: 0,
      flexShrink: 1,
    },
    scrollContent: {
      paddingBottom: 24,
      paddingHorizontal: 16,
      paddingTop: 14,
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
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      paddingBottom: 10,
      paddingHorizontal: 2,
      paddingVertical: 6,
    },
    rowSeparator: {
      height: 4,
    },
    taskGroup: {
      gap: 2,
    },
    // Collapsed subagent summary bar; sits under the parent's text column.
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
    // Expanded subagent list: indented + a hairline rail to read as nested.
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
  });
