import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "../../i18n";
import {
  activityHubGroupRowKey,
  groupActivityHubTasks,
  initialActivityWindow,
  loadNewerActivityWindow,
  loadOlderActivityWindow,
  rebaseActivityWindow,
  sortHubTasksByRecency,
} from "../../lib/activity-hub-model";
import { authClient } from "../../lib/auth-client";
import { isGuest } from "../../lib/guest-mode";
import { tapLight } from "../../lib/haptics";
import { useActivityHub } from "../../lib/main-shell-store";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import { useColors } from "../../theme/theme-context";
import type { ChatArtifact, MobileTask } from "../../types";
import {
  ConversationFilesRow,
  TaskGroupRow,
  makeActivityRowStyles,
  type GroupSubagent,
} from "./activity-rows";

type ActivityListRow =
  | {
      kind: "group";
      owner: MobileTask;
      ownerArtifacts: ChatArtifact[];
      subagents: GroupSubagent[];
    }
  | { kind: "conversation"; artifacts: ChatArtifact[] };

const activityListRowKey = (row: ActivityListRow): string =>
  row.kind === "group" ? activityHubGroupRowKey(row) : "conversation";

const EMPTY_TASKS: MobileTask[] = [];
const EMPTY_ARTIFACTS: ChatArtifact[] = [];
const EMPTY_BY_TASK: ReadonlyMap<string, ChatArtifact[]> = new Map();

/**
 * The left sidebar: the conversation's background work. Each agent is a row
 * with the files it made nested underneath (subagents fold under their
 * parent), and the main thread's own files close the list. Navigation lives
 * in the shell's bottom tab bar, so the panel is only this list.
 *
 * Data arrives through the shell store the chat route publishes into, so the
 * panel needs no props from the router.
 */
export function SidebarPanel({
  width,
  contentInsetRight = 0,
  onOpenArtifact,
}: {
  width: number;
  /**
   * Portion of the panel the foreground still covers when the drawer is
   * open (the rounded content edge overlaps it). Content stays clear of it.
   */
  contentInsetRight?: number;
  onOpenArtifact: (artifact: ChatArtifact) => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const rowStyles = useMemo(() => makeActivityRowStyles(colors), [colors]);

  const hub = useActivityHub();
  const tasks = hub?.tasks ?? EMPTY_TASKS;
  const artifactsByTaskId = hub?.artifactsByTaskId ?? EMPTY_BY_TASK;
  const conversationArtifacts = hub?.conversationArtifacts ?? EMPTY_ARTIFACTS;

  const session = authClient.useSession();
  const signedIn = Boolean(session.data?.user) && !isGuest();

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

  useEffect(() => {
    setActivityWindow((current) =>
      current.end === 0
        ? initialActivityWindow(groupCount)
        : rebaseActivityWindow(current, groupCount),
    );
  }, [groupCount]);

  // One windowed page of grouped top-level rows, then the thread's own files.
  const listRows = useMemo<ActivityListRow[]>(() => {
    const rows: ActivityListRow[] = hubGroups
      .slice(activityWindow.start, activityWindow.end)
      .map((group) => ({
        kind: "group",
        owner: group.owner,
        ownerArtifacts: artifactsByTaskId.get(group.owner.id) ?? [],
        subagents: group.subagents.map((task) => ({
          task,
          artifacts: artifactsByTaskId.get(task.id) ?? [],
        })),
      }));
    if (conversationArtifacts.length > 0) {
      rows.push({ kind: "conversation", artifacts: conversationArtifacts });
    }
    return rows;
  }, [
    hubGroups,
    activityWindow.start,
    activityWindow.end,
    artifactsByTaskId,
    conversationArtifacts,
  ]);

  const releasePagingLock = () => {
    setTimeout(() => {
      pagingLockedRef.current = false;
    }, 180);
  };
  const loadNewer = () => {
    if (pagingLockedRef.current) return;
    if (activityWindow.start <= 0) return;
    pagingLockedRef.current = true;
    setActivityWindow((current) => loadNewerActivityWindow(current));
    releasePagingLock();
  };
  const loadOlder = () => {
    if (pagingLockedRef.current) return;
    if (activityWindow.end >= hubGroups.length) return;
    pagingLockedRef.current = true;
    setActivityWindow((current) =>
      loadOlderActivityWindow(current, hubGroups.length),
    );
    releasePagingLock();
  };

  const openArtifact = useCallback(
    (artifact: ChatArtifact) => {
      tapLight();
      onOpenArtifact(artifact);
    },
    [onOpenArtifact],
  );

  const listContentStyle = useMemo(
    () => [styles.listContent, { paddingBottom: insets.bottom + 28 }],
    [styles.listContent, insets.bottom],
  );
  const emptyActivityText =
    hub || signedIn
      ? t("mobile.activityHub.activity.empty")
      : t("mobile.sidebar.signedOutHint");

  return (
    <View style={[styles.root, { width }]}>
      {/* The panel itself is deliberately NOT glass. Apple suppresses Liquid
          Glass layered over another glass surface (nested or merely beneath)
          and renders the upper one flat, so a glass panel would strip any
          glass above it of its material. A translucent surface tint over the
          app backdrop keeps the same legible look. */}
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
        <Text
          style={styles.heading}
          accessibilityRole="header"
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {t("mobile.activityHub.tabs.activity")}
        </Text>
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
            <Text
              style={styles.empty}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {emptyActivityText}
            </Text>
          }
          ItemSeparatorComponent={() => <View style={styles.rowSeparator} />}
          showsVerticalScrollIndicator={false}
          maintainVisibleContentPosition={{ data: true, size: true }}
          onStartReached={loadNewer}
          onStartReachedThreshold={0.15}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.15}
          estimatedItemSize={64}
          recycleItems
        />
      </View>
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
    heading: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: 0.3,
      paddingBottom: 10,
      paddingHorizontal: 20,
      paddingTop: 8,
      textTransform: "uppercase",
    },
    list: {
      flexGrow: 1,
      flexShrink: 1,
    },
    listContent: {
      paddingHorizontal: 16,
      paddingTop: 4,
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
  });
