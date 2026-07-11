import { useEffect, useMemo, useRef, useState } from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactViewerContent } from "./ArtifactViewer";
import { Icon } from "./Icon";
import { ShimmerText } from "./ShimmerText";
import { TopSheet } from "./TopSheet";
import { filterHubArtifacts, filterHubTasks } from "../lib/activity-hub-search";
import {
  initialActivityWindow,
  loadNewerActivityWindow,
  loadOlderActivityWindow,
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
  const [activityWindow, setActivityWindow] = useState(() =>
    initialActivityWindow(tasks.length),
  );
  const pagingLockedRef = useRef(false);
  const latestTaskCountRef = useRef(tasks.length);
  latestTaskCountRef.current = tasks.length;

  // Fresh overview each open: clear the search and any in-sheet artifact.
  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setOpenArtifact(null);
    setActivityWindow(initialActivityWindow(latestTaskCountRef.current));
  }, [visible]);

  useEffect(() => {
    setActivityWindow((current) =>
      current.end === 0
        ? initialActivityWindow(tasks.length)
        : {
            start: Math.min(current.start, Math.max(0, tasks.length - 1)),
            end: Math.min(tasks.length, current.end),
          },
    );
  }, [tasks.length]);

  const matchingTasks = useMemo(
    () => filterHubTasks(tasks, query),
    [tasks, query],
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
  const shownTasks = useMemo(() => {
    if (!searching)
      return tasks.slice(activityWindow.start, activityWindow.end);
    return tasks.filter(
      (task) =>
        matchingTaskIds.has(task.id) ||
        (artifactsByTaskId.get(task.id) ?? []).some((artifact) =>
          matchingArtifactIds.has(artifact.id),
        ),
    );
  }, [
    activityWindow.end,
    activityWindow.start,
    artifactsByTaskId,
    matchingArtifactIds,
    matchingTaskIds,
    searching,
    tasks,
  ]);
  const shownConversationArtifacts = searching
    ? conversationArtifacts.filter((artifact) =>
        matchingArtifactIds.has(artifact.id),
      )
    : conversationArtifacts;
  const hasResults =
    shownTasks.length > 0 || shownConversationArtifacts.length > 0;

  const handleActivityScroll = (
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ) => {
    if (searching || pagingLockedRef.current) return;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    if (contentSize.height <= layoutMeasurement.height + 48) return;
    const nearTop = contentOffset.y <= 48;
    const nearBottom =
      contentOffset.y + layoutMeasurement.height >= contentSize.height - 48;
    if (nearTop && activityWindow.start > 0) {
      pagingLockedRef.current = true;
      setActivityWindow((current) => loadNewerActivityWindow(current));
    } else if (nearBottom && activityWindow.end < tasks.length) {
      pagingLockedRef.current = true;
      setActivityWindow((current) =>
        loadOlderActivityWindow(current, tasks.length),
      );
    } else {
      return;
    }
    setTimeout(() => {
      pagingLockedRef.current = false;
    }, 180);
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
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onScroll={handleActivityScroll}
            scrollEventThrottle={16}
          >
            <Text
              style={styles.sectionLabel}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              Activity
            </Text>
            {!hasResults ? (
              <Text
                style={styles.empty}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {searching
                  ? "No matching activity or files."
                  : "No background work yet."}
              </Text>
            ) : (
              <View style={styles.taskList}>
                {shownTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    artifacts={(artifactsByTaskId.get(task.id) ?? []).filter(
                      (artifact) =>
                        !searching || matchingArtifactIds.has(artifact.id),
                    )}
                    onOpenArtifact={setOpenArtifact}
                    colors={colors}
                    styles={styles}
                  />
                ))}
                <ConversationFilesRow
                  artifacts={shownConversationArtifacts}
                  colors={colors}
                  styles={styles}
                  onOpenArtifact={setOpenArtifact}
                />
              </View>
            )}
          </ScrollView>
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
    taskList: {
      gap: 4,
    },
    taskGroup: {
      gap: 2,
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
